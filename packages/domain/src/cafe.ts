import type { CheckView, OrderStatus, PayRequest, PayResponse } from './api.ts';
import type { CheckLoyaltyView, LoyaltyApplyRequest } from './loyalty.ts';
import type { Minor } from './money.ts';
import { ORDER_MAX_LINES, ORDER_MAX_QTY } from './orders.ts';

/**
 * Coffee shop mode: the same HUB, money, shifts and reports as a billiard club,
 * but instead of tables and lamps — a counter. The cashier takes an order from
 * the menu (with options: size, milk, syrup), the guest pays at once and gets a
 * number; the barista moves the order NEW → PREPARING → READY, the guest screen
 * shows the numbers, the order is ISSUED when handed over.
 *
 * Pure rules here; the HUB keeps counter orders in bar_orders without a game
 * (session_id NULL) so checks, payments, X/Z reports and refunds work unchanged.
 */

// ── Business type (club setting) ────────────────────────────────────────────

export const BUSINESS_TYPES = ['billiards', 'cafe'] as const;
/** What the club is: billiards — tables, time and lamps; cafe — a counter with orders. */
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BUSINESS_TYPE_LABEL: Record<BusinessType, string> = {
  billiards: 'Бильярдный клуб',
  cafe: 'Кофейня',
};

// ── Product options (modifiers) ─────────────────────────────────────────────

export const OPTION_GROUPS_MAX = 8;
export const OPTION_CHOICES_MAX = 12;
export const OPTION_NAME_MAX = 40;
/** A choice may make the drink cheaper (e.g. «S» −100) but never the line negative. */
export const OPTION_DELTA_LIMIT = 10_000_000;

export interface ProductOptionChoice {
  /** Stable within the product: lines refer to choices by id. */
  id: string;
  name: string;
  /** Added to the product price, minor units; may be negative or 0. */
  priceDelta: Minor;
}

export interface ProductOptionGroup {
  id: string;
  /** «Размер», «Молоко», «Сироп». */
  name: string;
  /** One choice must be picked (size); otherwise the group may be skipped (syrup). */
  required: boolean;
  /** Several choices at once (two syrups); otherwise at most one. */
  multiple: boolean;
  choices: ProductOptionChoice[];
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const isName = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.trim().length <= OPTION_NAME_MAX;

/** Problems with option groups as the menu editor sends them; empty = fine. */
export function validateOptionGroups(groups: unknown): string[] {
  if (groups === undefined || groups === null) return [];
  if (!Array.isArray(groups)) return ['Добавки: ожидается список групп'];
  const errors: string[] = [];
  if (groups.length > OPTION_GROUPS_MAX) errors.push(`Не больше ${OPTION_GROUPS_MAX} групп добавок`);
  const groupIds = new Set<string>();
  groups.forEach((g, gi) => {
    const at = `Группа ${gi + 1}`;
    if (typeof g !== 'object' || g === null) {
      errors.push(`${at}: неверный формат`);
      return;
    }
    const group = g as Partial<ProductOptionGroup>;
    if (!isId(group.id)) errors.push(`${at}: неверный id`);
    else if (groupIds.has(group.id)) errors.push(`${at}: id повторяется`);
    else groupIds.add(group.id);
    if (!isName(group.name)) errors.push(`${at}: название от 1 до ${OPTION_NAME_MAX} символов`);
    if (!Array.isArray(group.choices) || group.choices.length === 0) {
      errors.push(`${at}: нужен хотя бы один вариант`);
      return;
    }
    if (group.choices.length > OPTION_CHOICES_MAX) errors.push(`${at}: не больше ${OPTION_CHOICES_MAX} вариантов`);
    const choiceIds = new Set<string>();
    group.choices.forEach((c, ci) => {
      const cat = `${at}, вариант ${ci + 1}`;
      if (typeof c !== 'object' || c === null) {
        errors.push(`${cat}: неверный формат`);
        return;
      }
      if (!isId(c.id)) errors.push(`${cat}: неверный id`);
      else if (choiceIds.has(c.id)) errors.push(`${cat}: id повторяется`);
      else choiceIds.add(c.id);
      if (!isName(c.name)) errors.push(`${cat}: название от 1 до ${OPTION_NAME_MAX} символов`);
      if (!Number.isInteger(c.priceDelta) || Math.abs(c.priceDelta) > OPTION_DELTA_LIMIT) {
        errors.push(`${cat}: надбавка — целое число`);
      }
    });
  });
  return errors;
}

/** Groups as stored: names trimmed, booleans forced; call after validateOptionGroups. */
export function normalizeOptionGroups(groups: readonly ProductOptionGroup[] | null | undefined): ProductOptionGroup[] {
  return (groups ?? []).map((g) => ({
    id: g.id,
    name: g.name.trim(),
    required: g.required === true,
    multiple: g.multiple === true,
    choices: g.choices.map((c) => ({ id: c.id, name: c.name.trim(), priceDelta: c.priceDelta })),
  }));
}

export interface PricedLine {
  /** Product price plus the chosen deltas, never below 0. */
  unitPrice: Minor;
  /** «Капучино · L · Овсяное». */
  title: string;
  /** Names of the chosen options in group order. */
  optionNames: string[];
}

export class CafeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Unit price and title of a line from the chosen option ids. Throws CafeError
 * on an unknown choice, two choices in a single-choice group or a required
 * group left empty — the cashier screen prevents these, the HUB re-checks.
 */
export function priceLine(
  product: { name: string; price: Minor; options: readonly ProductOptionGroup[] },
  choiceIds: readonly string[] = [],
): PricedLine {
  const wanted = new Set(choiceIds);
  if (wanted.size !== choiceIds.length) throw new CafeError('OPTION_REPEATED', 'Добавка выбрана дважды');
  let unitPrice = product.price;
  const optionNames: string[] = [];
  for (const group of product.options) {
    const picked = group.choices.filter((c) => wanted.has(c.id));
    for (const c of picked) wanted.delete(c.id);
    if (group.required && picked.length === 0) {
      throw new CafeError('OPTION_REQUIRED', `${product.name}: выберите «${group.name}»`);
    }
    if (!group.multiple && picked.length > 1) {
      throw new CafeError('OPTION_SINGLE', `${product.name}: в «${group.name}» — только один вариант`);
    }
    for (const c of picked) {
      unitPrice += c.priceDelta;
      optionNames.push(c.name);
    }
  }
  if (wanted.size > 0) throw new CafeError('OPTION_UNKNOWN', `${product.name}: такой добавки нет в меню`);
  return {
    unitPrice: Math.max(0, unitPrice),
    title: [product.name, ...optionNames].join(' · '),
    optionNames,
  };
}

/** The choices a fresh line starts with: the first choice of every required group. */
export function defaultChoices(options: readonly ProductOptionGroup[]): string[] {
  return options.filter((g) => g.required && g.choices.length > 0).map((g) => g.choices[0]!.id);
}

// ── Counter orders ──────────────────────────────────────────────────────────

export const COUNTER_SERVICES = ['HERE', 'TAKEAWAY'] as const;
/** Here (in a cup) or to take away. */
export type CounterService = (typeof COUNTER_SERVICES)[number];

export const COUNTER_SERVICE_LABEL: Record<CounterService, string> = { HERE: 'Здесь', TAKEAWAY: 'С собой' };

export const COUNTER_STAGES = ['NEW', 'PREPARING', 'READY', 'ISSUED'] as const;
/** Where the order is at the bar, apart from money (OrderStatus). */
export type CounterStage = (typeof COUNTER_STAGES)[number];

export const COUNTER_STAGE_LABEL: Record<CounterStage, string> = {
  NEW: 'Новый',
  PREPARING: 'Готовится',
  READY: 'Готов',
  ISSUED: 'Выдан',
};

/** Order numbers on the guest screen run 1…COUNTER_NUMBER_MAX and start over every working day. */
export const COUNTER_NUMBER_MAX = 999;
export const GUEST_NAME_MAX = 30;

/** The club's working day starts at this local hour: an order at 01:30 belongs to the day before. */
export const WORKDAY_START_HOUR = 6;

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The working day an instant belongs to, YYYY-MM-DD in the club's time zone, the day
 * starting at WORKDAY_START_HOUR. Counter numbers restart with it.
 */
export function workingDay(at: number, timeZone: string): string {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
    });
    dayFormatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(at))) p[part.type] = Number(part.value);
  // Before the start hour it is still yesterday's working day: step back on the calendar.
  const d = new Date(Date.UTC(p.year!, p.month! - 1, p.day! - (p.hour! < WORKDAY_START_HOUR ? 1 : 0)));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The next order number after `last` (null = first of the day). */
export function nextCounterNumber(last: number | null | undefined): number {
  if (!last || !Number.isInteger(last) || last < 1 || last >= COUNTER_NUMBER_MAX) return 1;
  return last + 1;
}

/**
 * Whether the barista may move an order from one stage to another. Forward one
 * step or straight to ISSUED (handed over at once); back one step to fix a tap
 * by mistake. ISSUED is final.
 */
export function canMoveStage(from: CounterStage, to: CounterStage): boolean {
  if (from === to || from === 'ISSUED') return false;
  const a = COUNTER_STAGES.indexOf(from);
  const b = COUNTER_STAGES.indexOf(to);
  return b === a + 1 || b === a - 1 || to === 'ISSUED';
}

/** The stage the barista's big button leads to; null when ISSUED. */
export function nextStage(stage: CounterStage): CounterStage | null {
  const i = COUNTER_STAGES.indexOf(stage);
  return i >= 0 && i < COUNTER_STAGES.length - 1 ? COUNTER_STAGES[i + 1]! : null;
}

// ── HTTP API (HUB) ──────────────────────────────────────────────────────────

/** One line as the cashier screen sends it. */
export interface CounterLineInput {
  productId: string;
  qty: number;
  /** Chosen option choice ids (see priceLine). */
  options?: string[];
}

/**
 * Problems with the lines of an order as a screen sends them (counter orders and
 * orders on a game alike); empty = fine. Unlike validateOrderItems a product may
 * repeat with different options (one cappuccino S, one L); the very same product
 * with the same options is one line with a larger quantity.
 */
export function validateCounterLines(items: ReadonlyArray<CounterLineInput> | null | undefined): string[] {
  if (!Array.isArray(items) || items.length === 0) return ['В заказе нет позиций'];
  const errors: string[] = [];
  if (items.length > ORDER_MAX_LINES) errors.push(`Не больше ${ORDER_MAX_LINES} позиций в одном заказе`);
  const seen = new Set<string>();
  items.forEach((it, i) => {
    const n = i + 1;
    if (!it || typeof it.productId !== 'string' || it.productId.length === 0) {
      errors.push(`Позиция ${n}: не указан товар`);
      return;
    }
    const options: unknown = it.options;
    if (options !== undefined && (!Array.isArray(options) || options.some((o: unknown) => typeof o !== 'string'))) {
      errors.push(`Позиция ${n}: неверный список добавок`);
      return;
    }
    const key = `${it.productId}\n${[...(it.options ?? [])].sort().join('\n')}`;
    if (seen.has(key)) errors.push(`Позиция ${n}: товар повторяется — увеличьте количество`);
    seen.add(key);
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > ORDER_MAX_QTY) {
      errors.push(`Позиция ${n}: количество должно быть от 1 до ${ORDER_MAX_QTY}`);
    }
  });
  return errors;
}

/** POST /api/counter/orders */
export interface CreateCounterOrderRequest {
  items: CounterLineInput[];
  service: CounterService;
  /** Shown on the guest screen next to the number, e.g. «Аня»; optional. */
  guestName?: string;
  note?: string;
  /** Pay right away (the usual case); null — the check stays open, paid later in «Счета». */
  payment: PayRequest | null;
  /** «Гость» (loyalty.ts): applied to the check before the payment; the payment is for what is left. */
  loyalty?: LoyaltyApplyRequest | null;
}

export interface CounterOrderItemView {
  id: string;
  productId: string;
  /** Snapshot: «Капучино · L · Овсяное». */
  title: string;
  optionNames: string[];
  unitPrice: Minor;
  qty: number;
  amount: Minor;
}

export interface CounterOrderView {
  id: string;
  /** For people: «Заказ 17». */
  number: number;
  service: CounterService;
  stage: CounterStage;
  /** Money: OPEN (check not paid yet), CLOSED (paid), CANCELLED. */
  status: OrderStatus;
  guestName: string | null;
  note: string | null;
  items: CounterOrderItemView[];
  total: Minor;
  createdAt: number;
  createdBy: string;
  readyAt: number | null;
  issuedAt: number | null;
  checkId: string | null;
}

export interface CreateCounterOrderResponse {
  order: CounterOrderView;
  check: CheckView;
  /** null when the order was taken without payment. */
  payment: PayResponse | null;
  /** The guest's side when `loyalty` was sent: what was applied and earned. */
  loyalty?: CheckLoyaltyView | null;
}

/** GET /api/counter/orders — the working day's orders not yet issued, plus the last issued ones. */
export interface CounterOrdersView {
  orders: CounterOrderView[];
}

/** POST /api/counter/orders/:id/stage */
export interface CounterStageRequest {
  stage: CounterStage;
}

/**
 * POST /api/counter/orders/:id/cancel — reason of at least CANCEL_REASON_MIN characters.
 * An unpaid order: its check is voided (or loses the lines), stock comes back. A paid
 * one is refused (409 ORDER_PAID) until the money is refunded in «Счета».
 */
export interface CounterCancelRequest {
  reason: string;
}

/** GET /api/counter/board — public, numbers only: for the guest screen. */
export interface CounterBoardView {
  preparing: Array<{ number: number; guestName: string | null }>;
  ready: Array<{ number: number; guestName: string | null }>;
  /** HUB time, for the screen's clock. */
  now: number;
  /** Shown on top: settings.display.title, else the club name. */
  title?: string | null;
  /** settings.display.logoUrl; null = none. */
  logoUrl?: string | null;
  /** Club time zone, for the clock on the screen. */
  timezone?: string;
}
