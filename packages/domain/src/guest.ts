import type { BusinessType, CounterLineInput, CounterStage, ProductOptionGroup } from './cafe.ts';
import { validateCounterLines } from './cafe.ts';
import type { Minor } from './money.ts';

/**
 * «Страница гостя по QR»: a sticker on a billiard table (or one at the counter of a
 * coffee shop) opens `#/g/<token>` on the club Wi-Fi. The guest sees their own table
 * or order and sends requests to the staff; nothing a guest does changes money — a
 * waiter or the cashier turns a request into an order the usual way.
 */

/** What a guest may ask for. PREORDER — a coffee-shop order ahead, paid at the counter. */
export const GUEST_REQUEST_KINDS = ['WAITER', 'BAR', 'EXTEND', 'BILL', 'PREORDER'] as const;
export type GuestRequestKind = (typeof GUEST_REQUEST_KINDS)[number];

export const GUEST_REQUEST_STATUSES = ['PENDING', 'ACCEPTED', 'REJECTED'] as const;
export type GuestRequestStatus = (typeof GUEST_REQUEST_STATUSES)[number];

export const GUEST_REQUEST_LABEL: Record<GuestRequestKind, string> = {
  WAITER: 'Позвать официанта',
  BAR: 'Заказ из бара',
  EXTEND: 'Продлить игру',
  BILL: 'Попросить счёт',
  PREORDER: 'Заказ гостя',
};

/** «Продлить на 30/60 мин». */
export const GUEST_EXTEND_MINUTES = [30, 60] as const;

/** Tokens are 24 url-safe characters (18 random bytes); anything else is not looked up at all. */
export const GUEST_TOKEN_BYTES = 18;
export const GUEST_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export function isGuestToken(value: unknown): value is string {
  return typeof value === 'string' && GUEST_TOKEN_RE.test(value);
}

/**
 * Limits on what one QR can send: per phone (token + address) and per token in all,
 * over a sliding window. A coffee shop has one QR for everybody, so its token limit
 * is wider. Pending requests are capped too: staff are not buried under a prank.
 */
export const GUEST_RATE = {
  windowMs: 5 * 60_000,
  perClient: 6,
  perTable: 20,
  perCounter: 120,
  pendingPerTable: 6,
  pendingPerCounter: 40,
} as const;

export const GUEST_NOTE_MAX = 120;

/** How long a resolved request stays on the guest page and in the staff list. */
export const GUEST_RECENT_MS = 3 * 60 * 60_000;

/** A game stopped this recently is still shown on the table page («к оплате»), so guests see their bill. */
export const GUEST_STOPPED_SHOWN_MS = 20 * 60_000;

/**
 * Sliding window: the times of earlier hits (oldest first) → whether one more is
 * allowed now and, if not, how long until the oldest hit leaves the window.
 */
export function rateCheck(
  hits: readonly number[],
  now: number,
  windowMs: number,
  max: number,
): { allowed: boolean; retryAfterMs: number; hits: number[] } {
  const recent = hits.filter((t) => t > now - windowMs);
  if (recent.length >= max) {
    return { allowed: false, retryAfterMs: Math.max(1, recent[0]! + windowMs - now), hits: recent };
  }
  return { allowed: true, retryAfterMs: 0, hits: [...recent, now] };
}

/** Russian plural: 1 позиция, 2 позиции, 5 позиций. */
export function pluralRu(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

export const guestPositions = (n: number) => `${n} ${pluralRu(n, ['позиция', 'позиции', 'позиций'])}`;

/** One line for the staff list: «Заказ гостя: Аня, 2 позиции», «Продлить на 30 мин». */
export function guestRequestSummary(r: {
  kind: GuestRequestKind;
  minutes?: number | null;
  itemCount?: number;
  guestName?: string | null;
}): string {
  const count = r.itemCount ?? 0;
  switch (r.kind) {
    case 'WAITER':
      return 'Позвать официанта';
    case 'BILL':
      return 'Попросить счёт';
    case 'EXTEND':
      return r.minutes ? `Продлить на ${r.minutes} мин` : 'Продлить игру';
    case 'BAR':
      return `Заказ из бара: ${guestPositions(count)}`;
    case 'PREORDER':
      return `Заказ гостя: ${r.guestName ? `${r.guestName}, ` : ''}${guestPositions(count)}`;
  }
}

/** What the guest page says about an order ahead once the cashier took it. */
export function guestStageText(stage: CounterStage, cancelled = false): string {
  if (cancelled) return 'Заказ отменён — подойдите к кассе';
  switch (stage) {
    case 'NEW':
    case 'PREPARING':
      return 'Готовится';
    case 'READY':
      return 'Готово — заберите';
    case 'ISSUED':
      return 'Выдан';
  }
}

/** Problems with a request as a guest page sends it; empty = fine. Lines are checked like counter lines. */
export function validateGuestRequest(input: CreateGuestRequest): string[] {
  const errors: string[] = [];
  if (!(GUEST_REQUEST_KINDS as readonly string[]).includes(input.kind)) return ['Неизвестный запрос'];
  if (input.kind === 'EXTEND' && !(GUEST_EXTEND_MINUTES as readonly number[]).includes(input.minutes ?? 0)) {
    errors.push('Продлить можно на 30 или 60 минут');
  }
  if (input.kind === 'BAR' || input.kind === 'PREORDER') errors.push(...validateCounterLines(input.items ?? []));
  if ((input.note ?? '').length > GUEST_NOTE_MAX) errors.push(`Комментарий — не длиннее ${GUEST_NOTE_MAX} символов`);
  return errors;
}

// ── HTTP API (HUB) ──────────────────────────────────────────────────────────

/** POST /api/guest/:token/requests (public). */
export interface CreateGuestRequest {
  kind: GuestRequestKind;
  /** EXTEND: 30 or 60. */
  minutes?: number;
  /** BAR and PREORDER: lines as the counter sends them (options included). */
  items?: CounterLineInput[];
  /** PREORDER: «Аня», shown on the counter and on the board. */
  guestName?: string;
  note?: string;
  /** A random key from the page: a double tap or a retry is the same request. */
  clientKey?: string;
}

export interface GuestRequestLine {
  title: string;
  qty: number;
  amount: Minor;
}

/** A request as the guest sees it. */
export interface GuestRequestView {
  id: string;
  kind: GuestRequestKind;
  status: GuestRequestStatus;
  createdAt: number;
  resolvedAt: number | null;
  minutes: number | null;
  guestName: string | null;
  items: GuestRequestLine[];
  /** Menu prices at the moment of the request; the order is priced again when staff accept it. */
  total: Minor;
  /** PREORDER once the cashier took it: the number on the board and where it is. */
  order: { number: number; stage: CounterStage; stageText: string; cancelled: boolean } | null;
}

/** A request on the hall and the counter: who, where, what. */
export interface StaffGuestRequestView extends GuestRequestView {
  tableId: string | null;
  tableName: string | null;
  sessionId: string | null;
  note: string | null;
  /** «Заказ гостя: Аня, 2 позиции». */
  summary: string;
  resolvedBy: string | null;
  rejectReason: string | null;
  /** The bar or counter order made from it. */
  orderId: string | null;
  /** BAR and PREORDER: the lines as sent, to load into an order. */
  lines: CounterLineInput[];
}

/** GET /api/guest-requests: pending first (oldest first), then the last resolved ones. */
export interface GuestRequestsResponse {
  enabled: boolean;
  requests: StaffGuestRequestView[];
}

export interface GuestMenuProduct {
  id: string;
  categoryId: string;
  name: string;
  price: Minor;
  options: ProductOptionGroup[];
}

export interface GuestMenu {
  categories: Array<{ id: string; name: string }>;
  products: GuestMenuProduct[];
}

/** The table of a billiard club as the guest sees it. */
export interface GuestTableView {
  name: string;
  status: 'FREE' | 'OPENING' | 'ACTIVE' | 'PAUSED' | 'AWAITING_PAYMENT';
  startedAt: number | null;
  stoppedAt: number | null;
  /** Played time at `now` (pauses excluded). */
  playedSeconds: number | null;
  /** Time charge computed by the HUB, the same as on the hall. */
  amount: Minor | null;
  tariffName: string | null;
  /** The rate in force now. */
  priceLabel: string | null;
  pricePerHour: Minor | null;
  /**
   * A game for N minutes: `minutes` includes extensions («Продлить»), `extendedMinutes` is that
   * added part; `paid` — paid upfront; `extensionDue` — extensions of a paid game not paid yet.
   */
  prepaid: {
    minutes: number;
    until: number | null;
    leftMs: number | null;
    paid: boolean;
    extendedMinutes: number;
    extensionDue: Minor;
  } | null;
  orders: Array<{ id: string; createdAt: number; items: GuestRequestLine[]; total: Minor }>;
  ordersTotal: Minor;
  /** Time (unless prepaid) plus open bar orders. */
  total: Minor;
}

/** GET /api/guest/:token (public). */
export interface GuestPageView {
  business: BusinessType;
  venue: { title: string; logoUrl: string | null; currency: string; timezone: string };
  now: number;
  /** Billiards: the table of this QR. */
  table: GuestTableView | null;
  /** Empty when the bar is not in the license. */
  menu: GuestMenu;
  /** What a guest may send right now. */
  can: Record<GuestRequestKind, boolean>;
  /** Billiards: requests of this table's game; coffee shop: the ones this phone sent (`?mine=`). */
  requests: GuestRequestView[];
}

/** GET /api/guest-links (manager): the QR of every table, or of the counter. */
export interface GuestLinkView {
  id: string;
  tableId: string | null;
  /** «Стол 3»; null — the counter of a coffee shop. */
  tableName: string | null;
  token: string;
  createdAt: number;
  rotatedAt: number | null;
}

export interface GuestLinksResponse {
  enabled: boolean;
  business: BusinessType;
  links: GuestLinkView[];
}

/** POST /api/guest-links/settings */
export interface GuestSettingsRequest {
  enabled: boolean;
}
