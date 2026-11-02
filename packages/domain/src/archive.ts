import type { CheckView, OrderStatus } from './api.ts';
import type { Minor } from './money.ts';

/**
 * «Архив» of «Счета» and the «Отменённые» block of the X and Z reports. Nothing is erased in
 * TS: a cancelled order stays CANCELLED with who and why, a refund is a payment back with a
 * reason and an approver, an emptied check stays VOID. This is how those rows are shown.
 *
 *  - ORDER — a bar or counter order cancelled (its amount did not reach the till);
 *  - GAME — an unpaid game voided with an approval (billiards);
 *  - REFUND — money paid back on a check;
 *  - VOID — a check emptied before any payment (when no cancelled order explains it).
 */
export const ARCHIVE_KINDS = ['ORDER', 'GAME', 'REFUND', 'VOID'] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

export const ARCHIVE_KIND_LABEL: Record<ArchiveKind, string> = {
  ORDER: 'Заказ отменён',
  GAME: 'Игра отменена',
  REFUND: 'Возврат',
  VOID: 'Счёт аннулирован',
};

export interface ArchiveEntry {
  kind: ArchiveKind;
  /** The order, game, refund operation or check. */
  id: string;
  /** When it was cancelled, refunded or voided. */
  at: number;
  /** «Заказ №17», «Стол 3 · бар», «Стол 3 · игра», «Счёт №12». */
  title: string;
  /** What was in it: «Капучино ×2, Круассан» or the refund method; null when nothing to add. */
  detail: string | null;
  /** The counter number of the order or the check number, for search; null for a game. */
  number: number | null;
  /** The check the order or refund belongs to, when known. */
  checkNumber: number | null;
  /** That check's id: «Чек» reprints it. Absent from Z reports saved before it was added. */
  checkId?: string | null;
  amount: Minor;
  /** Who cancelled, refunded or voided it. */
  by: string | null;
  /** Who approved it (a voided game, a refund). */
  approvedBy: string | null;
  reason: string | null;
  /** When the order or game was made and by whom. */
  createdAt: number | null;
  createdBy: string | null;
}

/** GET /api/archive?date=YYYY-MM-DD — the working day (from 06:00) of the club, newest first. */
export interface ArchiveView {
  date: string;
  from: number;
  /** Exclusive. */
  to: number;
  entries: ArchiveEntry[];
  /** Cancelled orders and games: count and their sum (what did not reach the till). */
  cancelled: CancelledSummary;
  /** Refunds: count and the money paid back. */
  refunds: { count: number; total: Minor };
}

/** An order on a check of the day: a counter order has its number of the day, a bar order its table. */
export interface DayCheckOrder {
  id: string;
  /** «Заказ 17» at the counter; null for a bar order at a table. */
  number: number | null;
  status: OrderStatus;
  tableId: string | null;
}

/**
 * GET /api/checks/day?date=YYYY-MM-DD — the checks of the working day one by one, newest first:
 * no day or shift totals (those are `stats.view`), so the barista sees them too.
 */
export interface DayChecksView {
  date: string;
  from: number;
  /** Exclusive. */
  to: number;
  checks: Array<{ check: CheckView; orders: DayCheckOrder[] }>;
}

/** Cancelled orders and games of a period: the X and Z reports show this. */
export interface CancelledSummary {
  count: number;
  total: Minor;
  /** Newest first. */
  items: ArchiveEntry[];
}

/** Kinds that are a cancellation (not a refund, not an empty check). */
export function isCancellation(entry: Pick<ArchiveEntry, 'kind'>): boolean {
  return entry.kind === 'ORDER' || entry.kind === 'GAME';
}

/** Newest first; the same moment keeps a stable order by id. */
export function sortArchive<T extends Pick<ArchiveEntry, 'at' | 'id'>>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The «Отменённые» block: cancelled orders and games only, newest first, with their sum. */
export function summarizeCancelled(entries: readonly ArchiveEntry[]): CancelledSummary {
  const items = sortArchive(entries.filter(isCancellation));
  return { count: items.length, total: items.reduce((sum, e) => sum + e.amount, 0), items };
}

/** Refunds of the list: how many operations and how much went back. */
export function summarizeRefunds(entries: readonly ArchiveEntry[]): { count: number; total: Minor } {
  const refunds = entries.filter((e) => e.kind === 'REFUND');
  return { count: refunds.length, total: refunds.reduce((sum, e) => sum + e.amount, 0) };
}
