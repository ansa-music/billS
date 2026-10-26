import type { FastifyInstance } from 'fastify';
import type { ArriveBookingResponse, BookingStatus, HubBookingsResponse, HubBookingView, SyncBookingsResponse, TableKind } from '@bills/domain';
import { BOOKING_KINDS, can, isBookingActive, isNoShowDue, maskPhone, planBookingTables } from '@bills/domain';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import type { Hub } from './hub.ts';
import { actorOf, emptyBody, guard, runCommand } from './http/command.ts';
import { record, SYSTEM } from './journal.ts';

/**
 * «Онлайн-бронь столов» on the HUB (migration 018, rules in packages/domain booking.ts).
 *
 * - The sync worker (sync.ts) pulls GET /sync/bookings when /sync/events reports a new
 *   bookingsVersion and calls `applyBookings`: bookings are kept here, so the hall works offline.
 * - The hall reads GET /api/bookings: today's bookings with the table each one is shown on
 *   (assigned on arrival, else planned: a free table of the right type).
 * - «Гость пришёл» (POST /api/bookings/:id/arrive) fixes the table; the screen then opens the game
 *   with the normal open flow. A guest late by `holdMinutes` becomes «не пришёл» by itself
 *   (a timer and every read sweep it). Both go to the cloud as outbox events
 *   `booking.arrived` { tableId } and `booking.no_show` — never the guest's name or phone.
 */

/** Change events of bookings: the hall refetches on any change event. */
const CHANGED = { kind: 'club' } as const;
const SWEEP_MS = 30_000;
const HOUR = 3_600_000;
/** Bookings older than this are deleted on the next apply. */
const KEEP_MS = 30 * 24 * HOUR;

interface BookingRow {
  id: string;
  starts_at: number;
  minutes: number;
  table_kind: string | null;
  guest_name: string;
  phone: string;
  cloud_status: string;
  local_status: string | null;
  table_id: string | null;
  arrived_at: number | null;
  no_show_at: number | null;
}

interface SyncRow {
  version: number | null;
  enabled: number;
  hold_minutes: number;
}

const STATUSES = new Set<string>(['PENDING', 'CONFIRMED', 'CANCELLED', 'ARRIVED', 'NO_SHOW']);
const kindOf = (v: string | null): TableKind | null => ((BOOKING_KINDS as readonly string[]).includes(v ?? '') ? (v as TableKind) : null);
const statusOf = (r: BookingRow): BookingStatus => (r.local_status ?? r.cloud_status) as BookingStatus;

function syncRow(db: Db): SyncRow {
  return one<SyncRow>(db, 'SELECT version, enabled, hold_minutes FROM booking_sync WHERE id = 1') ?? { version: null, enabled: 0, hold_minutes: 15 };
}

/** The bookings version this HUB applied; null = never. */
export function appliedBookingsVersion(db: Db): number | null {
  return syncRow(db).version;
}

/**
 * Applies GET /sync/bookings in one transaction: upserts every booking (the hall's own
 * «пришёл» / «не пришёл» and the table stay), stores the version, on/off and the hold time.
 * A broken package is refused as a whole.
 */
export function applyBookings(db: Db, now: number, payload: SyncBookingsResponse, events?: HubEvents): number {
  if (!payload || !Number.isFinite(payload.version) || !Array.isArray(payload.bookings)) {
    throw new Error('GET /sync/bookings: пакет броней повреждён');
  }
  for (const b of payload.bookings) {
    const ok =
      typeof b?.id === 'string' &&
      b.id.length > 0 &&
      b.id.length <= 100 &&
      Number.isSafeInteger(b.startsAt) &&
      Number.isInteger(b.minutes) &&
      b.minutes > 0 &&
      b.minutes <= 720 &&
      typeof b.guestName === 'string' &&
      typeof b.phone === 'string' &&
      STATUSES.has(b.status) &&
      (b.kind === null || (BOOKING_KINDS as readonly string[]).includes(b.kind));
    if (!ok) throw new Error('GET /sync/bookings: пакет броней повреждён');
  }
  const hold = Number.isInteger(payload.holdMinutes) && payload.holdMinutes >= 1 && payload.holdMinutes <= 240 ? payload.holdMinutes : 15;
  return transaction(db, () => {
    for (const b of payload.bookings) {
      run(
        db,
        `INSERT INTO bookings (id, starts_at, minutes, table_kind, guest_name, phone, cloud_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           starts_at = excluded.starts_at, minutes = excluded.minutes, table_kind = excluded.table_kind,
           guest_name = excluded.guest_name, phone = excluded.phone, cloud_status = excluded.cloud_status,
           updated_at = excluded.updated_at`,
        b.id,
        b.startsAt,
        b.minutes,
        b.kind,
        b.guestName.slice(0, 60),
        b.phone.slice(0, 30),
        b.status,
        Number.isSafeInteger(b.createdAt) ? b.createdAt : now,
        now,
      );
    }
    run(db, 'DELETE FROM bookings WHERE starts_at < ?', now - KEEP_MS);
    run(
      db,
      'UPDATE booking_sync SET version = ?, enabled = ?, hold_minutes = ?, applied_at = ? WHERE id = 1',
      payload.version,
      payload.enabled ? 1 : 0,
      hold,
      now,
    );
    record(db, now, {
      actor: 'cloud',
      action: 'cloud.bookings_applied',
      entityType: 'booking',
      entityId: 'cloud',
      data: { version: payload.version, bookings: payload.bookings.length, enabled: payload.enabled },
    });
    sweepNoShows(db, now);
    if (events) afterCommit(db, () => events.changed(CHANGED));
    return payload.bookings.length;
  });
}

/** Marks every active booking late by the hold time as «не пришёл». Call inside a transaction. Returns how many. */
export function sweepNoShows(db: Db, now: number): number {
  const hold = syncRow(db).hold_minutes;
  const due = all<BookingRow>(
    db,
    `SELECT * FROM bookings WHERE local_status IS NULL AND cloud_status IN ('PENDING', 'CONFIRMED') AND starts_at <= ?`,
    now - hold * 60_000,
  ).filter((r) => isNoShowDue({ startsAt: r.starts_at, status: statusOf(r) }, now, hold));
  for (const r of due) {
    run(db, "UPDATE bookings SET local_status = 'NO_SHOW', no_show_at = ?, updated_at = ? WHERE id = ?", now, now, r.id);
    record(db, now, { actor: SYSTEM, action: 'booking.no_show', entityType: 'booking', entityId: r.id, data: { startsAt: r.starts_at, auto: true } });
  }
  return due.length;
}

interface TableRow {
  id: string;
  name: string;
  kind: TableKind;
  busy: number;
}

function hallTables(db: Db): TableRow[] {
  return all<TableRow>(
    db,
    `SELECT t.id, t.name, t.kind,
            EXISTS (SELECT 1 FROM table_sessions s WHERE s.table_id = t.id AND s.status IN ('OPENING', 'ACTIVE', 'PAUSED')) AS busy
       FROM billiard_tables t WHERE t.is_active = 1 ORDER BY t.sort_order, t.name, t.id`,
  );
}

export class BookingService {
  readonly #db: Db;
  readonly #hub: Hub;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(hub: Hub) {
    this.#hub = hub;
    this.#db = hub.db;
  }

  /** The «не пришёл» timer. */
  start(intervalMs = SWEEP_MS): void {
    if (this.#timer || intervalMs <= 0) return;
    this.#timer = setInterval(() => this.sweep(), intervalMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One «не пришёл» pass; tells the screens when something changed. */
  sweep(): number {
    if (!this.#db.isOpen) return 0;
    const n = transaction(this.#db, () => sweepNoShows(this.#db, this.#hub.clock.now()));
    if (n) this.#hub.events.changed(CHANGED);
    return n;
  }

  /** Bookings starting in [from, to) with their tables; the full phone only for `fullPhone` (managers). */
  list(options: { from?: number; to?: number; fullPhone?: boolean } = {}): HubBookingsResponse {
    this.sweep();
    const now = this.#hub.clock.now();
    const from = options.from ?? now - 12 * HOUR;
    const to = options.to ?? now + 36 * HOUR;
    const hold = syncRow(this.#db).hold_minutes;
    const rows = all<BookingRow>(this.#db, 'SELECT * FROM bookings WHERE starts_at >= ? AND starts_at < ? ORDER BY starts_at, created_at, id', from, to);
    const plan = this.#plan(rows, hold);
    return {
      holdMinutes: hold,
      serverNow: now,
      bookings: rows.map((r) => this.#view(r, plan, options.fullPhone === true)),
    };
  }

  #plan(rows: BookingRow[], hold: number): Map<string, string | null> {
    const tables = hallTables(this.#db).map((t) => ({ id: t.id, kind: t.kind, busy: Boolean(t.busy) }));
    return planBookingTables(
      rows.map((r) => ({ id: r.id, startsAt: r.starts_at, minutes: r.minutes, kind: kindOf(r.table_kind), status: statusOf(r), tableId: r.table_id })),
      tables,
      hold,
    );
  }

  #view(r: BookingRow, plan: Map<string, string | null>, fullPhone: boolean): HubBookingView {
    return {
      id: r.id,
      startsAt: r.starts_at,
      minutes: r.minutes,
      kind: kindOf(r.table_kind),
      status: statusOf(r),
      tableId: r.table_id,
      plannedTableId: r.table_id ?? plan.get(r.id) ?? null,
      guestName: r.guest_name,
      phone: fullPhone ? r.phone : maskPhone(r.phone),
      arrivedAt: r.arrived_at,
    };
  }

  /**
   * «Гость пришёл»: picks the table (the one asked for, else the planned one, else any free table
   * of the booked type), marks the booking ARRIVED and queues `booking.arrived`. A guest already
   * marked «не пришёл» may still arrive. The game itself is opened by the normal open flow.
   */
  arrive(bookingId: string, actor: string, requested: string | null, fullPhone = false): ArriveBookingResponse {
    const now = this.#hub.clock.now();
    return transaction(this.#db, () => {
      const row = one<BookingRow>(this.#db, 'SELECT * FROM bookings WHERE id = ?', bookingId);
      if (!row) throw new HubError(404, 'BOOKING_NOT_FOUND', 'Бронь не найдена');
      const status = statusOf(row);
      if (status === 'ARRIVED') throw new HubError(409, 'BOOKING_ARRIVED', 'Гость по этой брони уже пришёл');
      if (status === 'CANCELLED') throw new HubError(409, 'BOOKING_CANCELLED', 'Бронь отменена');
      const kind = kindOf(row.table_kind);
      const hold = syncRow(this.#db).hold_minutes;
      const tables = hallTables(this.#db);
      const fits = (t: TableRow) => !t.busy && (kind === null || t.kind === kind);
      let table: TableRow | undefined;
      if (requested) {
        table = tables.find((t) => t.id === requested);
        if (!table) throw new HubError(404, 'TABLE_NOT_FOUND', 'Стол не найден');
        if (table.busy) throw new HubError(409, 'TABLE_BUSY', `${table.name}: на столе идёт игра`);
        if (kind && table.kind !== kind) throw new HubError(409, 'TABLE_KIND', 'Этот стол другого типа, чем в брони');
      } else {
        const around = all<BookingRow>(this.#db, 'SELECT * FROM bookings WHERE starts_at >= ? AND starts_at < ?', now - 12 * HOUR, now + 36 * HOUR);
        const plan = this.#plan(around, hold);
        const planned = tables.find((t) => t.id === plan.get(row.id));
        const claimed = new Set([...plan.entries()].filter(([id]) => id !== row.id).map(([, t]) => t));
        table = (planned && fits(planned) ? planned : undefined) ?? tables.find((t) => fits(t) && !claimed.has(t.id)) ?? tables.find(fits);
        if (!table) throw new HubError(409, 'NO_FREE_TABLE', kind ? 'Свободного стола этого типа сейчас нет' : 'Свободного стола сейчас нет');
      }
      run(
        this.#db,
        "UPDATE bookings SET local_status = 'ARRIVED', table_id = ?, arrived_at = ?, updated_at = ? WHERE id = ?",
        table.id,
        now,
        now,
        row.id,
      );
      record(this.#db, now, { actor, action: 'booking.arrived', entityType: 'booking', entityId: row.id, data: { tableId: table.id, startsAt: row.starts_at } });
      afterCommit(this.#db, () => this.#hub.events.changed({ ...CHANGED, tableId: table.id }));
      const updated = one<BookingRow>(this.#db, 'SELECT * FROM bookings WHERE id = ?', row.id)!;
      return { booking: this.#view(updated, new Map(), fullPhone), tableId: table.id };
    });
  }

  /** «Не пришёл» by hand, before the hold time runs out. */
  noShow(bookingId: string, actor: string): HubBookingView {
    const now = this.#hub.clock.now();
    return transaction(this.#db, () => {
      const row = one<BookingRow>(this.#db, 'SELECT * FROM bookings WHERE id = ?', bookingId);
      if (!row) throw new HubError(404, 'BOOKING_NOT_FOUND', 'Бронь не найдена');
      if (statusOf(row) === 'NO_SHOW') return this.#view(row, new Map(), false);
      if (!isBookingActive(statusOf(row))) throw new HubError(409, 'BOOKING_STATE', 'Бронь уже закрыта');
      run(this.#db, "UPDATE bookings SET local_status = 'NO_SHOW', no_show_at = ?, updated_at = ? WHERE id = ?", now, now, row.id);
      record(this.#db, now, { actor, action: 'booking.no_show', entityType: 'booking', entityId: row.id, data: { startsAt: row.starts_at, auto: false } });
      afterCommit(this.#db, () => this.#hub.events.changed(CHANGED));
      return this.#view({ ...row, local_status: 'NO_SHOW', no_show_at: now }, new Map(), false);
    });
  }
}

const idParam = { type: 'string', minLength: 1, maxLength: 100 } as const;

/**
 * GET  /api/bookings?from=&to=       → HubBookingsResponse (hall.view; the full phone for club.edit)
 * POST /api/bookings/:id/arrive      { tableId? } → ArriveBookingResponse (table.open)
 * POST /api/bookings/:id/no-show     → HubBookingView (table.open)
 */
export function registerBookingRoutes(app: FastifyInstance, hub: Hub): BookingService {
  const bookings = new BookingService(hub);
  bookings.start();
  app.addHook('onClose', async () => bookings.stop());

  app.get<{ Querystring: { from?: number; to?: number } }>(
    '/api/bookings',
    {
      preHandler: guard('hall.view'),
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { from: { type: 'integer' }, to: { type: 'integer' } } },
      },
    },
    async (req) => {
      const from = req.query.from === undefined ? undefined : Number(req.query.from);
      const to = req.query.to === undefined ? undefined : Number(req.query.to);
      return bookings.list({
        ...(Number.isFinite(from) ? { from } : {}),
        ...(Number.isFinite(to) ? { to } : {}),
        fullPhone: can(actorOf(req).roles, 'club.edit'),
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { tableId?: string } }>(
    '/api/bookings/:id/arrive',
    {
      schema: {
        params: { type: 'object', properties: { id: idParam } },
        body: { type: 'object', additionalProperties: false, properties: { tableId: idParam } },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor, by) => ({ status: 200, body: bookings.arrive(req.params.id, actor, req.body?.tableId ?? null, can(by.roles, 'club.edit')) }),
        'table.open',
      ),
  );

  app.post<{ Params: { id: string } }>(
    '/api/bookings/:id/no-show',
    { schema: { params: { type: 'object', properties: { id: idParam } }, body: emptyBody } },
    async (req, reply) => runCommand(req, reply, hub, (actor) => ({ status: 200, body: bookings.noShow(req.params.id, actor) }), 'table.open'),
  );

  return bookings;
}
