import type { ArchiveEntry, ArchiveView, DayCheckOrder, DayChecksView, OrderStatus } from '@bills/domain';
import { sortArchive, summarizeCancelled, summarizeRefunds, WORKDAY_START_HOUR, workingDay } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { all, one } from './db.ts';
import { HubError } from './errors.ts';
import { addDays, localMidnightUtc, parseLocalDate } from './reports.ts';
import { loadChecksWhere } from './views.ts';

/**
 * «Архив» (GET /api/archive) and the checks of a day (GET /api/checks/day). Read-only:
 * nothing in TS is erased, so the archive is a view over what the commands left behind —
 * cancelled orders and games (with who and why), refunds, checks emptied before payment.
 */

const HOUR_MS = 60 * 60 * 1000;

interface OrderRow {
  id: string;
  counter_number: number | null;
  table_name: string | null;
  total: number;
  created_at: number;
  created_by: string;
  cancelled_at: number;
  cancelled_by: string | null;
  cancel_reason: string | null;
  check_id: string | null;
}

interface GameRow {
  id: string;
  table_name: string | null;
  amount: number | null;
  requested_at: number;
  started_at: number | null;
  opened_by: string;
  cancelled_at: number;
  cancelled_by: string | null;
  cancel_approved_by: string | null;
  cancel_reason: string | null;
}

interface RefundRow {
  id: string;
  operation_id: string;
  check_id: string;
  check_number: number;
  method: string;
  amount: number;
  reason: string | null;
  approved_by: string | null;
  at: number;
  actor: string;
}

const METHOD_WORD: Record<string, string> = { CASH: 'наличными', CARD: 'картой', QR: 'по QR' };

/** «Капучино ×2, Круассан» — the lines of each order. */
function orderLines(db: Db, orderIds: string[]): Map<string, string> {
  const out = new Map<string, string[]>();
  if (orderIds.length === 0) return new Map();
  for (const r of all<{ order_id: string; title: string; qty: number }>(
    db,
    `SELECT order_id, title, qty FROM bar_order_items
     WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`,
    JSON.stringify(orderIds),
  )) {
    const list = out.get(r.order_id) ?? [];
    list.push(r.qty > 1 ? `${r.title} ×${r.qty}` : r.title);
    out.set(r.order_id, list);
  }
  return new Map([...out].map(([id, lines]) => [id, lines.join(', ')]));
}

/** The check each cancelled order was on: the order keeps it when the check was paid, the journal otherwise. */
function cancelledOrderChecks(db: Db, orderIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (orderIds.length === 0) return out;
  for (const r of all<{ entity_id: string; data: string }>(
    db,
    `SELECT entity_id, data FROM audit_log
     WHERE action = 'order.cancelled' AND entity_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(orderIds),
  )) {
    try {
      const checkId = (JSON.parse(r.data) as { checkId?: unknown }).checkId;
      if (typeof checkId === 'string') out.set(r.entity_id, checkId);
    } catch {
      // A damaged journal row only loses the check number.
    }
  }
  return out;
}

function checkNumbers(db: Db, ids: Iterable<string>): Map<string, number> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  return new Map(
    all<{ id: string; number: number }>(
      db,
      'SELECT id, number FROM checks WHERE id IN (SELECT value FROM json_each(?))',
      JSON.stringify(list),
    ).map((r) => [r.id, r.number]),
  );
}

/**
 * Everything of the archive in [from, to): cancelled orders (bar and counter), voided games,
 * refunds (one entry per operation) and checks emptied before payment that no cancelled order
 * of the period explains. Newest first.
 */
export function archiveEntries(db: Db, clubId: string, from: number, to: number): ArchiveEntry[] {
  const orders = all<OrderRow>(
    db,
    `SELECT o.id, o.counter_number, t.name AS table_name, o.total, o.created_at, o.created_by,
            o.cancelled_at, o.cancelled_by, o.cancel_reason, o.check_id
     FROM bar_orders o LEFT JOIN billiard_tables t ON t.id = o.table_id
     WHERE o.club_id = ? AND o.status = 'CANCELLED' AND o.cancelled_at >= ? AND o.cancelled_at < ?`,
    clubId,
    from,
    to,
  );
  const ids = orders.map((o) => o.id);
  const lines = orderLines(db, ids);
  const fromJournal = cancelledOrderChecks(db, ids);
  const orderCheck = new Map(orders.map((o) => [o.id, o.check_id ?? fromJournal.get(o.id) ?? null]));
  const games = all<GameRow>(
    db,
    `SELECT s.id, t.name AS table_name, s.amount, s.requested_at, s.started_at, s.opened_by,
            s.cancelled_at, s.cancelled_by, s.cancel_approved_by, s.cancel_reason
     FROM table_sessions s LEFT JOIN billiard_tables t ON t.id = s.table_id
     WHERE s.club_id = ? AND s.cancel_reason IS NOT NULL AND s.cancelled_at >= ? AND s.cancelled_at < ?`,
    clubId,
    from,
    to,
  );
  const refunds = all<RefundRow>(
    db,
    `SELECT p.id, p.operation_id, p.check_id, c.number AS check_number, p.method, p.amount, p.reason, p.approved_by, p.at, p.actor
     FROM payments p JOIN checks c ON c.id = p.check_id
     WHERE p.club_id = ? AND p.kind = 'REFUND' AND p.at >= ? AND p.at < ?
     ORDER BY p.at, p.rowid`,
    clubId,
    from,
    to,
  );
  const explained = new Set([...orderCheck.values()].filter((v): v is string => v !== null));
  const voids = all<{ id: string; number: number; closed_at: number; created_at: number; created_by: string }>(
    db,
    `SELECT id, number, closed_at, created_at, created_by FROM checks
     WHERE club_id = ? AND status = 'VOID' AND closed_at >= ? AND closed_at < ?`,
    clubId,
    from,
    to,
  ).filter((c) => !explained.has(c.id));
  const voidedBy = new Map(
    voids.length === 0
      ? []
      : all<{ entity_id: string; actor: string }>(
          db,
          `SELECT entity_id, actor FROM audit_log
           WHERE action = 'check.voided' AND entity_id IN (SELECT value FROM json_each(?)) ORDER BY id`,
          JSON.stringify(voids.map((v) => v.id)),
        ).map((r) => [r.entity_id, r.actor]),
  );
  const numbers = checkNumbers(db, explained);

  const entries: ArchiveEntry[] = [];
  for (const o of orders) {
    const checkId = orderCheck.get(o.id) ?? null;
    entries.push({
      kind: 'ORDER',
      id: o.id,
      at: o.cancelled_at,
      title: o.counter_number !== null ? `Заказ №${o.counter_number}` : `${o.table_name ?? 'Стол'} · бар`,
      detail: lines.get(o.id) ?? null,
      number: o.counter_number,
      checkNumber: checkId ? (numbers.get(checkId) ?? null) : null,
      checkId,
      amount: o.total,
      by: o.cancelled_by,
      approvedBy: null,
      reason: o.cancel_reason,
      createdAt: o.created_at,
      createdBy: o.created_by,
    });
  }
  for (const g of games) {
    entries.push({
      kind: 'GAME',
      id: g.id,
      at: g.cancelled_at,
      title: `${g.table_name ?? 'Стол'} · игра`,
      detail: null,
      number: null,
      checkNumber: null,
      checkId: null,
      amount: g.amount ?? 0,
      by: g.cancelled_by,
      approvedBy: g.cancel_approved_by,
      reason: g.cancel_reason,
      createdAt: g.started_at ?? g.requested_at,
      createdBy: g.opened_by,
    });
  }
  const operations = new Map<string, RefundRow[]>();
  for (const r of refunds) operations.set(r.operation_id, [...(operations.get(r.operation_id) ?? []), r]);
  for (const [operationId, parts] of operations) {
    const first = parts[0]!;
    entries.push({
      kind: 'REFUND',
      id: operationId,
      at: Math.max(...parts.map((p) => p.at)),
      title: `Счёт №${first.check_number}`,
      detail: `Возврат ${[...new Set(parts.map((p) => METHOD_WORD[p.method] ?? p.method))].join(' и ')}`,
      number: first.check_number,
      checkNumber: first.check_number,
      checkId: first.check_id,
      amount: parts.reduce((sum, p) => sum + p.amount, 0),
      by: first.actor,
      approvedBy: first.approved_by,
      reason: first.reason,
      createdAt: null,
      createdBy: null,
    });
  }
  for (const c of voids) {
    entries.push({
      kind: 'VOID',
      id: c.id,
      at: c.closed_at,
      title: `Счёт №${c.number}`,
      detail: 'Все позиции сняты до оплаты',
      number: c.number,
      checkNumber: c.number,
      checkId: c.id,
      amount: 0,
      by: voidedBy.get(c.id) ?? null,
      approvedBy: null,
      reason: null,
      createdAt: c.created_at,
      createdBy: c.created_by,
    });
  }
  return sortArchive(entries);
}

/** The club's working day as a period: from WORKDAY_START_HOUR (06:00) to the same hour next day. */
export function workdayPeriod(date: string, timeZone: string): { from: number; to: number } {
  return {
    from: localMidnightUtc(date, timeZone) + WORKDAY_START_HOUR * HOUR_MS,
    to: localMidnightUtc(addDays(date, 1), timeZone) + WORKDAY_START_HOUR * HOUR_MS,
  };
}

export class ArchiveService {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(deps: { db: Db; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  /** @param dateParam the club's working day YYYY-MM-DD; today by default. */
  day(dateParam?: string): ArchiveView {
    const { club, date, from, to } = this.#period(dateParam);
    const entries = archiveEntries(this.#db, club.id, from, to);
    return { date, from, to, entries, cancelled: summarizeCancelled(entries), refunds: summarizeRefunds(entries) };
  }

  /**
   * The checks made or settled on the working day, newest first, with the orders on them.
   * Today also keeps the checks still open from before (a «счёт потом» left at 05:50).
   */
  checks(dateParam?: string): DayChecksView {
    const { club, date, from, to } = this.#period(dateParam);
    const today = date === workingDay(this.#clock.now(), club.timezone);
    const checks = loadChecksWhere(
      this.#db,
      `c.club_id = ? AND ((c.created_at >= ? AND c.created_at < ?) OR (c.closed_at >= ? AND c.closed_at < ?)
         OR (? = 1 AND c.status = 'OPEN'))
       ORDER BY c.number DESC`,
      club.id,
      from,
      to,
      from,
      to,
      today ? 1 : 0,
    );
    const orders = new Map<string, DayCheckOrder[]>();
    if (checks.length > 0) {
      for (const o of all<{ id: string; check_id: string; counter_number: number | null; status: OrderStatus; table_id: string | null }>(
        this.#db,
        `SELECT id, check_id, counter_number, status, table_id FROM bar_orders
         WHERE check_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`,
        JSON.stringify(checks.map((c) => c.id)),
      )) {
        orders.set(o.check_id, [
          ...(orders.get(o.check_id) ?? []),
          { id: o.id, number: o.counter_number, status: o.status, tableId: o.table_id },
        ]);
      }
    }
    return { date, from, to, checks: checks.map((check) => ({ check, orders: orders.get(check.id) ?? [] })) };
  }

  #period(dateParam: string | undefined): { club: { id: string; timezone: string }; date: string; from: number; to: number } {
    const club = one<{ id: string; timezone: string }>(this.#db, 'SELECT id, timezone FROM clubs ORDER BY created_at LIMIT 1');
    if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
    let date: string;
    if (dateParam === undefined || dateParam === '') date = workingDay(this.#clock.now(), club.timezone);
    else if (!parseLocalDate(dateParam)) throw new HubError(400, 'BAD_DATE', 'Дата должна быть в формате ГГГГ-ММ-ДД');
    else date = dateParam;
    return { club, date, ...workdayPeriod(date, club.timezone) };
  }
}
