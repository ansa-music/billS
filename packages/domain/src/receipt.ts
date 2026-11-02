import type { CheckItemKind, CheckItemView, CheckStatus, CheckView, OrderStatus } from './api.ts';
import type { PaymentMethod } from './billing.ts';
import type { BusinessType, CounterService } from './cafe.ts';
import { COUNTER_SERVICE_LABEL } from './cafe.ts';
import type { Minor } from './money.ts';
import { minorPerMajor } from './money.ts';
import type { Role } from './permissions.ts';
import { isPlatformRole, isRole, roleLabel } from './permissions.ts';

/**
 * The guest receipt («чек») on a 58 or 80 mm thermal printer, printed through the browser.
 *
 * Two halves:
 *  - ReceiptSettings: what the venue may put on it (club settings JSON, key `receipt`) — its
 *    name, address, phone, BIN/IIN, a black-and-white logo, a header line, the footer text,
 *    Wi-Fi, Instagram, one QR link, which of cashier / guest / «Здесь · С собой» to show, the
 *    paper width and the number of copies. Nothing else: amounts, lines, payments, the order
 *    number, the date and the non-fiscal note are never theirs to change.
 *  - buildReceipt: the one function that turns a check (with its counter orders) and those
 *    settings into what is printed. The print after payment, the reprint from «Счета», the
 *    archive and the preview in «Настройки» all go through it, so they cannot differ.
 */

// ── Settings ────────────────────────────────────────────────────────────────

export const RECEIPT_PAPERS = ['58', '80'] as const;
/** Thermal roll width, mm. */
export type ReceiptPaper = (typeof RECEIPT_PAPERS)[number];

export const RECEIPT_COPIES = [1, 2] as const;
export type ReceiptCopies = (typeof RECEIPT_COPIES)[number];

export interface ReceiptSettings {
  /** Venue name on the receipt; null — the club's name. */
  title: string | null;
  address: string | null;
  phone: string | null;
  /** БИН or ИИН: 12 digits. */
  taxId: string | null;
  /** A small black-and-white PNG (data URL), converted on upload; null — no logo. */
  logo: string | null;
  /** One line under the venue details: «Кофе с собой с 8:00». */
  header: string | null;
  /** The thank-you text, up to RECEIPT_LIMITS.footerLines lines; null — the default for the venue. */
  footer: string | null;
  wifiName: string | null;
  wifiPassword: string | null;
  /** Instagram account without «@». */
  instagram: string | null;
  /** One link printed as a QR code (Instagram, 2GIS, a menu…). */
  qrUrl: string | null;
  showCashier: boolean;
  showGuest: boolean;
  /** «Здесь / С собой» of a counter order. */
  showService: boolean;
  /** The club's roll width; a till may pick its own printer's width on its device. */
  paper: ReceiptPaper;
  copies: ReceiptCopies;
}

export const DEFAULT_RECEIPT_SETTINGS: ReceiptSettings = {
  title: null,
  address: null,
  phone: null,
  taxId: null,
  logo: null,
  header: null,
  footer: null,
  wifiName: null,
  wifiPassword: null,
  instagram: null,
  qrUrl: null,
  showCashier: true,
  showGuest: true,
  showService: true,
  paper: '80',
  copies: 1,
};

export const RECEIPT_LIMITS = {
  title: 40,
  address: 80,
  phone: 20,
  taxId: 12,
  header: 60,
  footer: 120,
  footerLines: 3,
  wifiName: 32,
  wifiPassword: 63,
  instagram: 30,
  qrUrl: 300,
  /** Characters of the logo's data URL: a converted 384 × 160 px black-and-white PNG is a few KB. */
  logo: 24_000,
} as const;

/** Printed on every receipt until fiscalization (stage 7). Not a setting. */
export const RECEIPT_NOTICE = 'Не является фискальным чеком';

/** The footer when the venue wrote none. */
export function defaultThanks(business: BusinessType | null | undefined): string {
  return business === 'cafe' ? 'Спасибо! Ждём снова' : 'Спасибо за игру!';
}

export type ReceiptTextField = 'title' | 'address' | 'phone' | 'taxId' | 'header' | 'footer' | 'wifiName' | 'wifiPassword' | 'instagram' | 'qrUrl';
export type ReceiptField = keyof ReceiptSettings;

export interface ReceiptProblem {
  field: ReceiptField;
  message: string;
}

// Control, format, private-use and lone surrogate characters, and emoji: a thermal printer
// prints those as empty boxes (or not at all).
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Extended_Pictographic}]/u;
const PHONE = /^\+?[\d\s()-]+$/;
const TAX_ID = /^\d{12}$/;
const INSTAGRAM = /^[A-Za-z0-9._]+$/;
const LOGO = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

const TEXT_LABEL: Record<ReceiptTextField, string> = {
  title: 'Название',
  address: 'Адрес',
  phone: 'Телефон',
  taxId: 'БИН/ИИН',
  header: 'Строка вверху',
  footer: 'Текст внизу',
  wifiName: 'Wi-Fi',
  wifiPassword: 'Пароль Wi-Fi',
  instagram: 'Instagram',
  qrUrl: 'Ссылка для QR',
};

/** Trims a text value; blank → null. Line breaks are kept only where `multiline` (the footer). */
export function cleanReceiptText(value: string, multiline = false): string | null {
  const t = multiline
    ? value
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((l) => l.trim().replace(/[ \t]+/g, ' '))
        .join('\n')
        .replace(/\n{2,}/g, '\n')
        .trim()
    : value.trim().replace(/\s+/g, ' ');
  return t.length ? t : null;
}

function textProblem(field: ReceiptTextField, value: string): string | null {
  const label = TEXT_LABEL[field];
  const max = RECEIPT_LIMITS[field];
  if (value.length > max) return `${label}: не длиннее ${max} символов`;
  if (field === 'footer') {
    if (value.split('\n').length > RECEIPT_LIMITS.footerLines) return `${label}: не больше ${RECEIPT_LIMITS.footerLines} строк`;
    if (UNPRINTABLE.test(value.replace(/\n/g, ''))) return `${label}: уберите эмодзи и служебные символы — принтер их не печатает`;
    return null;
  }
  if (UNPRINTABLE.test(value)) return `${label}: уберите эмодзи и служебные символы — принтер их не печатает`;
  switch (field) {
    case 'phone': {
      const digits = value.replace(/\D/g, '').length;
      if (!PHONE.test(value) || digits < 5 || digits > 15) return 'Телефон: цифры, пробелы, «+», скобки и дефис, например +7 777 123 45 67';
      return null;
    }
    case 'taxId':
      return TAX_ID.test(value) ? null : 'БИН/ИИН: ровно 12 цифр';
    case 'instagram':
      return INSTAGRAM.test(value.replace(/^@/, '')) ? null : 'Instagram: латинские буквы, цифры, точка и «_», например coffee.almaty';
    case 'qrUrl':
      return isQrUrl(value) ? null : 'Ссылка для QR: полный адрес, начинается с https://';
    default:
      return null;
  }
}

function isQrUrl(value: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.includes('.');
  } catch {
    return false;
  }
}

function normalizedText(field: ReceiptTextField, value: string): string | null {
  const t = cleanReceiptText(value, field === 'footer');
  if (t === null) return null;
  if (field === 'instagram') return t.replace(/^@/, '');
  if (field === 'phone') return t.replace(/\s+/g, ' ');
  return t;
}

const TEXT_FIELDS: readonly ReceiptTextField[] = [
  'title',
  'address',
  'phone',
  'taxId',
  'header',
  'footer',
  'wifiName',
  'wifiPassword',
  'instagram',
  'qrUrl',
];
const FLAGS = ['showCashier', 'showGuest', 'showService'] as const;

/**
 * What is wrong with a patch from the «Чек» form, field by field, in words for people. The HUB
 * refuses a patch with any problem (422); the form shows the same messages next to the fields.
 * Unknown keys are not this function's business: the HUB schema refuses them.
 */
export function receiptSettingsProblems(patch: Partial<Record<ReceiptField, unknown>>, base: ReceiptSettings = DEFAULT_RECEIPT_SETTINGS): ReceiptProblem[] {
  const problems: ReceiptProblem[] = [];
  for (const field of TEXT_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const raw = patch[field];
    if (raw === null) continue;
    if (typeof raw !== 'string') {
      problems.push({ field, message: `${TEXT_LABEL[field]}: нужен текст` });
      continue;
    }
    const value = normalizedText(field, raw);
    const problem = value === null ? null : textProblem(field, value);
    if (problem) problems.push({ field, message: problem });
  }
  if (Object.hasOwn(patch, 'logo') && patch.logo !== null) {
    const logo = patch.logo;
    if (typeof logo !== 'string' || !LOGO.test(logo)) problems.push({ field: 'logo', message: 'Логотип: загрузите картинку ещё раз' });
    else if (logo.length > RECEIPT_LIMITS.logo) problems.push({ field: 'logo', message: 'Логотип слишком сложный для чека — возьмите картинку проще или меньше' });
  }
  for (const flag of FLAGS) {
    if (Object.hasOwn(patch, flag) && typeof patch[flag] !== 'boolean') problems.push({ field: flag, message: 'Нужно «показывать» или «не показывать»' });
  }
  if (Object.hasOwn(patch, 'paper') && !(RECEIPT_PAPERS as readonly unknown[]).includes(patch.paper)) {
    problems.push({ field: 'paper', message: 'Ширина ленты: 58 или 80 мм' });
  }
  if (Object.hasOwn(patch, 'copies') && !(RECEIPT_COPIES as readonly unknown[]).includes(patch.copies)) {
    problems.push({ field: 'copies', message: 'Копий: 1 или 2' });
  }
  // A password alone says nothing to a guest.
  const next = { ...base, ...patch };
  const wifiName = typeof next.wifiName === 'string' ? cleanReceiptText(next.wifiName) : null;
  const wifiPassword = typeof next.wifiPassword === 'string' ? cleanReceiptText(next.wifiPassword) : null;
  if (wifiPassword && !wifiName && !problems.some((p) => p.field === 'wifiName')) {
    problems.push({ field: 'wifiName', message: 'Wi-Fi: укажите название сети — пароль без неё не печатается' });
  }
  return problems;
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Complete receipt settings from whatever is stored or sent: missing keys keep `base`, a value
 * that fails receiptSettingsProblems keeps `base` too (stored JSON is never trusted blindly).
 */
export function normalizeReceiptSettings(input: unknown, base: ReceiptSettings = DEFAULT_RECEIPT_SETTINGS): ReceiptSettings {
  const src = obj(input);
  const out: ReceiptSettings = { ...DEFAULT_RECEIPT_SETTINGS, ...base };
  const has = (k: string) => Object.hasOwn(src, k);
  for (const field of TEXT_FIELDS) {
    if (!has(field)) continue;
    const raw = src[field];
    if (raw === null) out[field] = null;
    else if (typeof raw === 'string') {
      const value = normalizedText(field, raw);
      if (value === null) out[field] = null;
      else if (!textProblem(field, value)) out[field] = value;
    }
  }
  if (has('logo')) {
    const logo = src.logo;
    if (logo === null) out.logo = null;
    else if (typeof logo === 'string' && LOGO.test(logo) && logo.length <= RECEIPT_LIMITS.logo) out.logo = logo;
  }
  for (const flag of FLAGS) if (typeof src[flag] === 'boolean') out[flag] = src[flag];
  if ((RECEIPT_PAPERS as readonly unknown[]).includes(src.paper)) out.paper = src.paper as ReceiptPaper;
  if ((RECEIPT_COPIES as readonly unknown[]).includes(src.copies)) out.copies = src.copies as ReceiptCopies;
  return out;
}

// ── Receipt data ────────────────────────────────────────────────────────────

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Наличные',
  CARD: 'Карта',
  QR: 'QR',
};

/** A counter order as the receipt needs it (CheckCounterOrderView, CounterOrderView both fit). */
export interface ReceiptOrderInfo {
  id: string;
  number: number;
  service: CounterService;
  guestName: string | null;
}

/** A game line and the bar lines ordered at that game; `game` is null for bar lines whose game is not on the check. */
export interface CheckLineGroup {
  key: string;
  game: CheckItemView | null;
  orders: CheckItemView[];
  /** The table the game (or the orders) were on. */
  tableId: string | null;
}

/**
 * The HUB lists each GAME line followed by its ORDER lines, then the bar lines whose game is not on
 * the check. Groups by game (ORDER lines carry the sessionId of the game they were made at) and
 * keeps that order. A coffee shop check is one group of bar lines.
 */
export function groupCheckLines(items: readonly CheckItemView[]): CheckLineGroup[] {
  const groups: CheckLineGroup[] = [];
  const bySession = new Map<string, CheckLineGroup>();
  for (const item of items) {
    const known = item.sessionId != null ? bySession.get(item.sessionId) : undefined;
    if (item.kind === 'GAME') {
      if (known && known.game === null) {
        known.game = item;
        known.key = item.id;
        continue;
      }
      const group: CheckLineGroup = { key: item.id, game: item, orders: [], tableId: item.tableId };
      groups.push(group);
      if (item.sessionId != null) bySession.set(item.sessionId, group);
    } else if (known) {
      known.orders.push(item);
    } else {
      const group: CheckLineGroup = { key: `bar:${item.id}`, game: null, orders: [item], tableId: item.tableId };
      groups.push(group);
      if (item.sessionId != null) bySession.set(item.sessionId, group);
    }
  }
  return groups;
}

export interface ReceiptItem {
  id: string;
  kind: CheckItemKind;
  /** «Капучино», «Стол 1». */
  name: string;
  /** Chosen options, printed indented under the name: «L · Овсяное». */
  options: string[];
  /** Bar lines: quantity and price per unit («2 × 900 ₸» when more than one). */
  qty: number | null;
  unitPrice: Minor | null;
  amount: Minor;
  /** A game: when it ran and how long. */
  span: { from: number; to: number; seconds: number } | null;
}

export interface ReceiptGroup {
  key: string;
  /** «Бар · Стол 2» over bar lines of a game not on the check; null for a coffee shop. */
  heading: string | null;
  items: ReceiptItem[];
}

export interface ReceiptPayment {
  id: string;
  method: PaymentMethod;
  label: string;
  amount: Minor;
  /** When the check was paid in several goes: the time tells the payments apart. */
  at: number | null;
  tendered: Minor | null;
  change: Minor | null;
}

export interface ReceiptRefund {
  id: string;
  label: string;
  amount: Minor;
  reason: string | null;
}

export interface ReceiptData {
  paper: ReceiptPaper;
  copies: ReceiptCopies;
  currency: string;
  timezone: string;
  venue: {
    name: string;
    logo: string | null;
    address: string | null;
    phone: string | null;
    taxId: string | null;
    header: string | null;
  };
  status: CheckStatus;
  /** An OPEN check prints as «Предчек» with what is still due. */
  precheck: boolean;
  checkNumber: number;
  /** «Заказ 17», printed large; several when one check pays several counter orders. */
  orderNumbers: number[];
  /** A settled check is dated by its last payment; anything else by the moment it is printed. */
  at: number;
  /** «Бариста: Данияр» in a coffee shop, «Кассир: …» in a billiard club; null when hidden. */
  cashier: { label: string; name: string } | null;
  /** «Здесь» / «С собой»; null when hidden or not a counter order. */
  service: string | null;
  guestName: string | null;
  groups: ReceiptGroup[];
  subtotal: Minor;
  discount: { label: string; amount: Minor; reason: string | null } | null;
  total: Minor;
  payments: ReceiptPayment[];
  refunds: ReceiptRefund[];
  /** «Оплачено» row: when it says more than the payments above (several, partial, refunds). */
  paid: Minor | null;
  refunded: Minor | null;
  /** «К оплате» of a precheck. */
  due: Minor | null;
  /** Footer lines: the venue's text or the default thank-you. */
  thanks: string[];
  wifi: { name: string; password: string | null } | null;
  /** «@coffee.almaty». */
  instagram: string | null;
  qr: { url: string; caption: string } | null;
  notice: typeof RECEIPT_NOTICE;
}

export interface BuildReceiptInput {
  check: CheckView;
  club: { name: string; currency: string; timezone: string };
  settings: ReceiptSettings;
  business: BusinessType | null | undefined;
  now: number;
  /** Table id → name: titles bar lines whose game is not on the check (billiards). */
  tableNames?: ReadonlyMap<string, string> | undefined;
  /** Counter orders the caller already holds (the counter's fresh order); joined with check.counter. */
  orders?: readonly ReceiptOrderInfo[] | undefined;
}

/** «Капучино · L · Овсяное» with options [L, Овсяное] → «Капучино» and the options. */
export function splitItemTitle(title: string, optionNames: readonly string[] | null | undefined): { name: string; options: string[] } {
  if (!optionNames || optionNames.length === 0) return { name: title, options: [] };
  const suffix = ` · ${optionNames.join(' · ')}`;
  if (title.endsWith(suffix) && title.length > suffix.length) return { name: title.slice(0, -suffix.length), options: [...optionNames] };
  return { name: title, options: [] };
}

function receiptTime(check: CheckView, now: number): number {
  if (check.status !== 'PAID') return now;
  const paidAt = check.payments.reduce((at, p) => (p.kind === 'PAYMENT' ? Math.max(at, p.at) : at), 0);
  return paidAt || check.closedAt || now;
}

/** The word on the cashier line: a coffee shop names the person's role its own way. */
function cashierLabel(role: Role | null | undefined, business: BusinessType | null | undefined): string {
  if (business !== 'cafe' || !role || !isRole(role) || isPlatformRole(role)) return 'Кассир';
  return roleLabel(role, business);
}

function toItem(i: CheckItemView): ReceiptItem {
  const { name, options } = i.kind === 'ORDER' ? splitItemTitle(i.title, i.optionNames) : { name: i.title, options: [] };
  return {
    id: i.id,
    kind: i.kind,
    name,
    options,
    qty: i.kind === 'ORDER' ? i.qty : null,
    unitPrice: i.kind === 'ORDER' ? i.unitPrice : null,
    amount: i.amount,
    span:
      i.kind === 'GAME' && i.startedAt != null && i.stoppedAt != null
        ? { from: i.startedAt, to: i.stoppedAt, seconds: i.playedSeconds ?? 0 }
        : null,
  };
}

/** Under the QR code: where it leads, short enough for a 58 mm line. */
export function qrCaption(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    const text = `${host}${path}`;
    return text.length > 30 ? `${text.slice(0, 29)}…` : text;
  } catch {
    return url.slice(0, 30);
  }
}

/** Everything a receipt prints, from a check and the venue's receipt settings. Pure: no clock, no I/O. */
export function buildReceipt(input: BuildReceiptInput): ReceiptData {
  const { check, club, settings: s, business, now } = input;
  const payments = check.payments.filter((p) => p.kind === 'PAYMENT');
  const refunds = check.payments.filter((p) => p.kind === 'REFUND');
  const timed = new Set(payments.map((p) => p.operationId)).size > 1;
  const precheck = check.status === 'OPEN';

  const orders = new Map<string, ReceiptOrderInfo & { status?: OrderStatus }>();
  for (const o of check.counter ?? []) orders.set(o.id, o);
  for (const o of input.orders ?? []) if (!orders.has(o.id)) orders.set(o.id, o);
  const counter = [...orders.values()];
  // A cancelled order left the check; a check whose every order was cancelled (refunded) still says which.
  const live = counter.filter((o) => o.status !== 'CANCELLED');
  const shown = live.length > 0 ? live : counter;
  const first = shown[0] ?? null;

  const names = [...new Set(payments.map((p) => p.actor))];
  const cashierNames = names.length > 0 ? names : [check.createdBy];
  const cashier = s.showCashier
    ? { label: cashierLabel(check.actorRoles?.[cashierNames[0]!], business), name: cashierNames.join(', ') }
    : null;

  const hasGame = check.items.some((i) => i.kind === 'GAME');
  const groups: ReceiptGroup[] = [];
  let counterGroup: ReceiptGroup | null = null;
  for (const g of groupCheckLines(check.items)) {
    const table = g.tableId != null ? input.tableNames?.get(g.tableId) : undefined;
    const heading = g.game ? null : hasGame || g.tableId != null ? `Бар${table ? ` · ${table}` : ''}` : null;
    const items = [...(g.game ? [g.game] : []), ...g.orders].map(toItem);
    // Counter lines (no game, no table) are one list, however the HUB grouped them.
    if (!g.game && heading === null) {
      if (counterGroup) counterGroup.items.push(...items);
      else groups.push((counterGroup = { key: g.key, heading, items }));
      continue;
    }
    groups.push({ key: g.key, heading, items });
  }

  const discounted = check.discount != null || check.discountAmount > 0;
  const showPaid = (check.status === 'PAID' || check.paid > 0) && (payments.length !== 1 || check.refunded > 0 || check.paid !== check.total);

  const thanks = (s.footer ?? defaultThanks(business)).split('\n').filter((l) => l.trim().length > 0);

  return {
    paper: s.paper,
    copies: s.copies,
    currency: club.currency,
    timezone: club.timezone,
    venue: {
      name: s.title ?? club.name,
      logo: s.logo,
      address: s.address,
      phone: s.phone,
      taxId: s.taxId,
      header: s.header,
    },
    status: check.status,
    precheck,
    checkNumber: check.number,
    orderNumbers: shown.map((o) => o.number),
    at: receiptTime(check, now),
    cashier,
    service: s.showService && first ? COUNTER_SERVICE_LABEL[first.service] : null,
    guestName: s.showGuest && first?.guestName ? first.guestName : null,
    groups,
    subtotal: check.subtotal,
    discount: discounted
      ? {
          label: check.discount?.kind === 'PERCENT' ? `Скидка ${check.discount.value}%` : 'Скидка',
          amount: check.discountAmount,
          reason: check.discount?.reason || null,
        }
      : null,
    total: check.total,
    payments: payments.map((p) => ({
      id: p.id,
      method: p.method,
      label: PAYMENT_METHOD_LABEL[p.method],
      amount: p.amount,
      at: timed ? p.at : null,
      // «Получено / Сдача» only when there was change: exact cash needs no two more lines.
      ...(p.tendered != null && p.tendered > p.amount
        ? { tendered: p.tendered, change: p.change ?? p.tendered - p.amount }
        : { tendered: null, change: null }),
    })),
    refunds: refunds.map((p) => ({ id: p.id, label: `Возврат · ${PAYMENT_METHOD_LABEL[p.method]}`, amount: p.amount, reason: p.reason })),
    paid: showPaid ? check.paid : null,
    refunded: check.refunded > 0 ? check.refunded : null,
    due: precheck ? check.due : null,
    thanks,
    wifi: s.wifiName ? { name: s.wifiName, password: s.wifiPassword } : null,
    instagram: s.instagram ? `@${s.instagram}` : null,
    qr: s.qrUrl ? { url: s.qrUrl, caption: qrCaption(s.qrUrl) } : null,
    notice: RECEIPT_NOTICE,
  };
}

/**
 * A made-up paid order for the preview in «Настройки» → «Чек»: a drink with options paid in cash
 * with change, a second item twice, a guest name. Never sent anywhere.
 */
export function sampleReceiptCheck(now: number, currency: string, business: BusinessType | null | undefined): CheckView {
  const per = minorPerMajor(currency);
  const t = (major: number) => major * per;
  const cafe = business === 'cafe';
  const items: CheckItemView[] = cafe
    ? [
        line('s1', 'Капучино · L · Овсяное', ['L', 'Овсяное'], 1, t(1900)),
        line('s2', 'Круассан', [], 2, t(900)),
      ]
    : [
        {
          id: 's0',
          kind: 'GAME',
          title: 'Стол 1',
          amount: t(4500),
          orderId: null,
          qty: null,
          unitPrice: null,
          sessionId: 'sample-game',
          tableId: null,
          startedAt: now - 90 * 60_000,
          stoppedAt: now,
          playedSeconds: 90 * 60,
        },
        { ...line('s1', 'Чай', [], 2, t(600)), sessionId: 'sample-game' },
      ];
  const total = items.reduce((sum, i) => sum + i.amount, 0);
  const tendered = Math.ceil(total / t(1000)) * t(1000) + (total % t(1000) === 0 ? t(1000) : 0);
  return {
    id: 'sample',
    number: 128,
    status: 'PAID',
    items,
    discount: null,
    subtotal: total,
    discountAmount: 0,
    total,
    paid: total,
    refunded: 0,
    due: 0,
    payments: [
      {
        id: 'p1',
        operationId: 'op1',
        kind: 'PAYMENT',
        method: 'CASH',
        amount: total,
        tendered,
        change: tendered - total,
        reason: null,
        approvedBy: null,
        shiftId: 'sample',
        at: now,
        actor: cafe ? 'Данияр' : 'Айгерим',
      },
    ],
    createdAt: now,
    createdBy: cafe ? 'Данияр' : 'Айгерим',
    closedAt: now,
    updatedAt: now,
    counter: cafe ? [{ id: 'sample-order', number: 17, service: 'HERE', guestName: 'Аня', status: 'CLOSED' }] : [],
    actorRoles: { [cafe ? 'Данияр' : 'Айгерим']: cafe ? 'bartender' : 'cashier' },
  };

  function line(id: string, title: string, optionNames: string[], qty: number, unitPrice: Minor): CheckItemView {
    return {
      id,
      kind: 'ORDER',
      title,
      optionNames,
      amount: qty * unitPrice,
      orderId: 'sample-order',
      qty,
      unitPrice,
      sessionId: null,
      tableId: null,
      startedAt: null,
      stoppedAt: null,
      playedSeconds: null,
    };
  }
}
