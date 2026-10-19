import type { SyncEvent } from '@bills/domain';
import { pushKindOfAlert } from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { localDay } from './localtime.ts';
import { alertTitle, enqueuePush } from './push.ts';

/**
 * Applies one HUB event to the read model (sessions, checks, payments, shifts,
 * cash_movements, power_outages, alerts, daily_stats).
 * Called inside the transaction that stored the raw event, once per event:
 * duplicates are filtered before by (hub_id, outbox_id). Unknown topics are
 * ignored, out-of-order or missing events still leave a usable row, and every
 * insert that feeds a counter has a deterministic id (hub:outbox[:part]) so a
 * replay of the same logic cannot double the money.
 */
export interface ProjectionContext {
  hubId: string;
  clubId: string;
  /** For push titles. */
  clubName: string;
  timezone: string;
  /** Receive time of the batch: the push queue's created_at. */
  now: number;
  /** tariffId → name from the club settings. */
  tariffNames: Map<string, string>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const SESSION_STATUSES = new Set(['OPENING', 'ACTIVE', 'PAUSED', 'AWAITING_PAYMENT', 'CLOSED', 'CANCELLED', 'FAILED']);
const METHOD_COLUMNS: Record<string, 'paidCash' | 'paidCard' | 'paidQr'> = {
  CASH: 'paidCash',
  CARD: 'paidCard',
  QR: 'paidQr',
};

interface DayDelta {
  /** The `revenue` column: billed on stop (the reports call it `billed`). */
  billed?: number;
  games?: number;
  playedSeconds?: number;
  alerts?: number;
  lampFailures?: number;
  paidTotal?: number;
  paidCash?: number;
  paidCard?: number;
  paidQr?: number;
  refunded?: number;
  checksPaid?: number;
  discounts?: number;
  cancelledGames?: number;
  powerOutages?: number;
}

async function bumpDay(tx: SqlDriver, clubId: string, day: string, d: DayDelta): Promise<void> {
  await tx.run(
    `INSERT INTO daily_stats (club_id, day, revenue, games, played_seconds, alerts, lamp_failures,
                              paid_total, paid_cash, paid_card, paid_qr, refunded, checks_paid, discounts,
                              cancelled_games, power_outages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (club_id, day) DO UPDATE SET
       revenue = daily_stats.revenue + excluded.revenue,
       games = daily_stats.games + excluded.games,
       played_seconds = daily_stats.played_seconds + excluded.played_seconds,
       alerts = daily_stats.alerts + excluded.alerts,
       lamp_failures = daily_stats.lamp_failures + excluded.lamp_failures,
       paid_total = daily_stats.paid_total + excluded.paid_total,
       paid_cash = daily_stats.paid_cash + excluded.paid_cash,
       paid_card = daily_stats.paid_card + excluded.paid_card,
       paid_qr = daily_stats.paid_qr + excluded.paid_qr,
       refunded = daily_stats.refunded + excluded.refunded,
       checks_paid = daily_stats.checks_paid + excluded.checks_paid,
       discounts = daily_stats.discounts + excluded.discounts,
       cancelled_games = daily_stats.cancelled_games + excluded.cancelled_games,
       power_outages = daily_stats.power_outages + excluded.power_outages`,
    [
      clubId,
      day,
      d.billed ?? 0,
      d.games ?? 0,
      d.playedSeconds ?? 0,
      d.alerts ?? 0,
      d.lampFailures ?? 0,
      d.paidTotal ?? 0,
      d.paidCash ?? 0,
      d.paidCard ?? 0,
      d.paidQr ?? 0,
      d.refunded ?? 0,
      d.checksPaid ?? 0,
      d.discounts ?? 0,
      d.cancelledGames ?? 0,
      d.powerOutages ?? 0,
    ],
  );
}

/** A shift row for events that reference a shift the cloud never saw opened. */
async function ensureShift(tx: SqlDriver, ctx: ProjectionContext, shiftId: string, at: number, actor: string): Promise<void> {
  await tx.run(
    `INSERT INTO shifts (id, club_id, number, status, opened_at, opened_by, opening_float)
     VALUES (?, ?, 0, 'OPEN', ?, ?, 0)
     ON CONFLICT (id) DO NOTHING`,
    [shiftId, ctx.clubId, at, actor],
  );
}

/** A check row for events that reference a check the cloud never saw created. */
async function ensureCheck(tx: SqlDriver, ctx: ProjectionContext, checkId: string, at: number, actor: string, number: number | null): Promise<void> {
  await tx.run(
    `INSERT INTO checks (id, club_id, number, status, created_at, created_by, updated_at)
     VALUES (?, ?, ?, 'OPEN', ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [checkId, ctx.clubId, number ?? 0, at, actor, at],
  );
}

async function latestOpenOutage(tx: SqlDriver, clubId: string): Promise<string | null> {
  const rows = await tx.all<{ id: string }>(
    'SELECT id FROM power_outages WHERE club_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    [clubId],
  );
  return rows[0]?.id ?? null;
}

/** Inserts an outage row; counts it in daily_stats only when it is new. */
async function insertOutage(
  tx: SqlDriver,
  ctx: ProjectionContext,
  id: string,
  startedAt: number,
  endedAt: number | null,
  critical: boolean,
): Promise<boolean> {
  const inserted = await tx.run(
    `INSERT INTO power_outages (id, club_id, started_at, ended_at, critical, paused_games)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT (id) DO NOTHING`,
    [id, ctx.clubId, startedAt, endedAt, critical ? 1 : 0],
  );
  if (inserted > 0) await bumpDay(tx, ctx.clubId, localDay(startedAt, ctx.timezone), { powerOutages: 1 });
  return inserted > 0;
}

export async function projectEvent(tx: SqlDriver, ctx: ProjectionContext, event: SyncEvent): Promise<void> {
  const { at, topic, payload } = event;
  const data: Record<string, unknown> = payload.data ?? {};
  const actor = payload.actor || 'unknown';
  const entityId = payload.entityId;
  const eventKey = `${ctx.hubId}:${event.id}`;
  const tableId = str(data.tableId) ?? '';

  switch (topic) {
    // ----------------------------------------------------------------------
    // Games
    // ----------------------------------------------------------------------
    case 'session.open_requested': {
      const tariffId = str(data.tariffId);
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, tariff_id, tariff_name, opened_by, requested_at, updated_at)
         VALUES (?, ?, ?, 'OPENING', ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           table_id = excluded.table_id, tariff_id = excluded.tariff_id, tariff_name = excluded.tariff_name,
           opened_by = excluded.opened_by, requested_at = excluded.requested_at, updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, tableId, tariffId, tariffId ? (ctx.tariffNames.get(tariffId) ?? null) : null, actor, at, at],
      );
      return;
    }
    case 'session.started': {
      const startedAt = num(data.startedAt) ?? at;
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, requested_at, started_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', 'unknown', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = CASE WHEN sessions.status IN ('OPENING', 'ACTIVE') THEN 'ACTIVE' ELSE sessions.status END,
           started_at = excluded.started_at, updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, tableId, startedAt, startedAt, at],
      );
      return;
    }
    case 'session.paused': {
      // reason is absent for a manual pause; 'power' and 'transfer' come from the HUB.
      const pausedAt = num(data.pausedAt) ?? at;
      const reason = str(data.reason) ?? 'pause';
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, requested_at, started_at, pause_started_at, pause_reason, updated_at)
         VALUES (?, ?, ?, 'PAUSED', 'unknown', ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = CASE WHEN sessions.status IN ('OPENING', 'ACTIVE', 'PAUSED') THEN 'PAUSED' ELSE sessions.status END,
           pause_started_at = excluded.pause_started_at, pause_reason = excluded.pause_reason,
           updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, tableId, pausedAt, pausedAt, pausedAt, reason, at],
      );
      return;
    }
    case 'session.resumed': {
      const startedAt = num(data.pausedAt) ?? at;
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, requested_at, started_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', 'unknown', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = CASE WHEN sessions.status IN ('OPENING', 'ACTIVE', 'PAUSED') THEN 'ACTIVE' ELSE sessions.status END,
           pause_started_at = NULL, pause_reason = NULL, updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, tableId, startedAt, startedAt, at],
      );
      return;
    }
    case 'session.transferred': {
      const toTableId = str(data.toTableId) ?? tableId;
      const given = str(data.status);
      const status = given !== null && SESSION_STATUSES.has(given) ? given : 'ACTIVE';
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, requested_at, started_at, updated_at)
         VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET table_id = excluded.table_id, updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, toTableId, status, at, at, at],
      );
      return;
    }
    case 'session.stopped': {
      const startedAt = num(data.startedAt);
      const stoppedAt = num(data.stoppedAt) ?? at;
      const playedSeconds = num(data.playedSeconds) ?? 0;
      const pausedSeconds = num(data.pausedSeconds) ?? 0;
      const billedSeconds = num(data.billedSeconds) ?? 0;
      const amount = num(data.amount) ?? 0;
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, stopped_by, requested_at, started_at, stopped_at,
                               played_seconds, paused_seconds, billed_seconds, amount, updated_at)
         VALUES (?, ?, ?, 'AWAITING_PAYMENT', 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = CASE WHEN sessions.status IN ('CLOSED', 'CANCELLED', 'FAILED') THEN sessions.status ELSE 'AWAITING_PAYMENT' END,
           table_id = excluded.table_id, stopped_by = excluded.stopped_by,
           started_at = COALESCE(excluded.started_at, sessions.started_at), stopped_at = excluded.stopped_at,
           played_seconds = excluded.played_seconds, paused_seconds = excluded.paused_seconds,
           billed_seconds = excluded.billed_seconds, amount = excluded.amount,
           pause_started_at = NULL, pause_reason = NULL, updated_at = excluded.updated_at`,
        [
          entityId,
          ctx.clubId,
          tableId,
          actor,
          startedAt ?? stoppedAt,
          startedAt,
          stoppedAt,
          playedSeconds,
          pausedSeconds,
          billedSeconds,
          amount,
          at,
        ],
      );
      await bumpDay(tx, ctx.clubId, localDay(stoppedAt, ctx.timezone), { billed: amount, games: 1, playedSeconds });
      return;
    }
    case 'session.cancelled':
    case 'session.failed': {
      const status = topic === 'session.cancelled' ? 'CANCELLED' : 'FAILED';
      const reason = str(data.reason);
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, stopped_by, requested_at, stopped_at,
                               played_seconds, billed_seconds, amount, failure_reason, updated_at)
         VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?, 0, 0, 0, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status, table_id = excluded.table_id, stopped_by = excluded.stopped_by,
           stopped_at = excluded.stopped_at, played_seconds = 0, billed_seconds = 0, amount = 0,
           failure_reason = excluded.failure_reason, cancel_reason = excluded.failure_reason,
           pause_started_at = NULL, pause_reason = NULL, updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, tableId, status, actor, at, at, reason, at],
      );
      return;
    }
    case 'session.voided': {
      // A stopped, unpaid game voided with a manager's approval: its billed amount leaves the day of the stop.
      const amount = num(data.amount) ?? 0;
      const reason = str(data.reason);
      const approvedBy = str(data.approvedBy);
      const existing = await tx.all<{ status: string; stopped_at: number | null }>(
        'SELECT status, stopped_at FROM sessions WHERE id = ?',
        [entityId],
      );
      const row = existing[0];
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, stopped_by, requested_at, stopped_at,
                               played_seconds, billed_seconds, amount, cancel_reason, cancel_approved_by, updated_at)
         VALUES (?, ?, ?, 'CANCELLED', 'unknown', ?, ?, ?, 0, 0, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = 'CANCELLED', table_id = excluded.table_id,
           stopped_at = COALESCE(sessions.stopped_at, excluded.stopped_at),
           cancel_reason = excluded.cancel_reason, cancel_approved_by = excluded.cancel_approved_by,
           check_id = NULL, pause_started_at = NULL, pause_reason = NULL, updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, tableId, actor, at, at, amount, reason, approvedBy, at],
      );
      if (row?.status === 'CANCELLED') return; // already voided: nothing more to take out
      const stoppedAt = row?.stopped_at === null || row?.stopped_at === undefined ? at : Number(row.stopped_at);
      await bumpDay(tx, ctx.clubId, localDay(stoppedAt, ctx.timezone), { billed: -amount, cancelledGames: 1 });
      return;
    }
    case 'session.closed': {
      const checkId = str(data.checkId);
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, requested_at, check_id, paid_at, updated_at)
         VALUES (?, ?, ?, 'CLOSED', 'unknown', ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = 'CLOSED', check_id = COALESCE(excluded.check_id, sessions.check_id), paid_at = excluded.paid_at,
           pause_started_at = NULL, pause_reason = NULL, updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, tableId, at, checkId, at, at],
      );
      return;
    }
    case 'session.prepaid': {
      const minutes = num(data.minutes);
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, requested_at, prepaid_minutes, updated_at)
         VALUES (?, ?, ?, 'OPENING', 'unknown', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET prepaid_minutes = excluded.prepaid_minutes, updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, tableId, at, minutes, at],
      );
      return;
    }
    case 'session.prepaid_ended': {
      // The HUB recorded session.stopped just before; only remember the minutes if session.prepaid was lost.
      const minutes = num(data.minutes);
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, requested_at, prepaid_minutes, updated_at)
         VALUES (?, ?, ?, 'AWAITING_PAYMENT', 'unknown', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET prepaid_minutes = COALESCE(sessions.prepaid_minutes, excluded.prepaid_minutes)`,
        [entityId, ctx.clubId, tableId, at, minutes, at],
      );
      return;
    }

    // ----------------------------------------------------------------------
    // Checks and payments (entityId = check id)
    // ----------------------------------------------------------------------
    case 'check.created': {
      const items = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
      const subtotal = items.reduce((s, i) => s + (num(i.amount) ?? 0), 0);
      await tx.run(
        `INSERT INTO checks (id, club_id, number, status, created_at, created_by, subtotal, total, updated_at)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           number = excluded.number, created_at = excluded.created_at, created_by = excluded.created_by,
           updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, num(data.number) ?? 0, at, actor, subtotal, subtotal, at],
      );
      for (const item of items) {
        const sessionId = str(item.sessionId);
        if (sessionId) await tx.run('UPDATE sessions SET check_id = ?, updated_at = ? WHERE id = ?', [entityId, at, sessionId]);
      }
      return;
    }
    case 'check.item_added': {
      const sessionId = str(data.sessionId);
      const amount = num(data.amount) ?? 0;
      await ensureCheck(tx, ctx, entityId, at, actor, null);
      await tx.run(
        'UPDATE checks SET subtotal = subtotal + ?, total = total + ?, updated_at = ? WHERE id = ?',
        [amount, amount, at, entityId],
      );
      if (sessionId) await tx.run('UPDATE sessions SET check_id = ?, updated_at = ? WHERE id = ?', [entityId, at, sessionId]);
      return;
    }
    case 'check.item_removed': {
      const sessionId = str(data.sessionId);
      const amount = num(data.amount) ?? 0;
      await tx.run(
        'UPDATE checks SET subtotal = subtotal - ?, total = total - ?, updated_at = ? WHERE id = ?',
        [amount, amount, at, entityId],
      );
      if (sessionId) {
        await tx.run('UPDATE sessions SET check_id = NULL, updated_at = ? WHERE id = ? AND check_id = ?', [at, sessionId, entityId]);
      }
      return;
    }
    case 'check.discount_set': {
      const amount = num(data.amount) ?? 0;
      await ensureCheck(tx, ctx, entityId, at, actor, null);
      await tx.run(
        'UPDATE checks SET discount = ?, discount_reason = ?, total = subtotal - ?, updated_at = ? WHERE id = ?',
        [amount, str(data.reason), amount, at, entityId],
      );
      return;
    }
    case 'check.discount_removed': {
      await tx.run('UPDATE checks SET discount = 0, discount_reason = NULL, total = subtotal, updated_at = ? WHERE id = ?', [
        at,
        entityId,
      ]);
      return;
    }
    case 'payment.accepted': {
      const shiftId = str(data.shiftId);
      const operationId = str(data.operationId) ?? eventKey;
      const parts = Array.isArray(data.parts) ? data.parts.filter(isRecord) : [];
      await ensureCheck(tx, ctx, entityId, at, actor, num(data.number));
      if (shiftId) await ensureShift(tx, ctx, shiftId, at, actor);
      const delta: DayDelta = {};
      let applied = 0;
      let inserted = 0;
      for (const [index, part] of parts.entries()) {
        const method = str(part.method) ?? 'CASH';
        // part.amount is what was applied to the check; change handed back is not money taken.
        const amount = num(part.amount) ?? 0;
        const changes = await tx.run(
          `INSERT INTO payments (id, club_id, check_id, shift_id, operation_id, kind, method, amount, at, actor)
           VALUES (?, ?, ?, ?, ?, 'PAYMENT', ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          [`${eventKey}:${index}`, ctx.clubId, entityId, shiftId, operationId, method, amount, at, actor],
        );
        if (changes === 0) continue;
        inserted++;
        applied += amount;
        const column = METHOD_COLUMNS[method];
        if (column) delta[column] = (delta[column] ?? 0) + amount;
      }
      if (inserted === 0) return; // replay: every part was already there (or nothing to apply)
      delta.paidTotal = applied;
      const number = num(data.number);
      await tx.run('UPDATE checks SET paid = paid + ?, shift_id = COALESCE(?, shift_id), updated_at = ? WHERE id = ?', [
        applied,
        shiftId,
        at,
        entityId,
      ]);
      if (number !== null && number > 0) await tx.run('UPDATE checks SET number = ? WHERE id = ? AND number = 0', [number, entityId]);
      await bumpDay(tx, ctx.clubId, localDay(at, ctx.timezone), delta);
      return;
    }
    case 'payment.refunded': {
      const shiftId = str(data.shiftId);
      const method = str(data.method) ?? 'CASH';
      const amount = num(data.amount) ?? 0;
      await ensureCheck(tx, ctx, entityId, at, actor, num(data.number));
      if (shiftId) await ensureShift(tx, ctx, shiftId, at, actor);
      const inserted = await tx.run(
        `INSERT INTO payments (id, club_id, check_id, shift_id, operation_id, kind, method, amount, at, actor, reason)
         VALUES (?, ?, ?, ?, ?, 'REFUND', ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [eventKey, ctx.clubId, entityId, shiftId, eventKey, method, amount, at, actor, str(data.reason)],
      );
      if (inserted === 0) return;
      await tx.run('UPDATE checks SET refunded = refunded + ?, updated_at = ? WHERE id = ?', [amount, at, entityId]);
      await bumpDay(tx, ctx.clubId, localDay(at, ctx.timezone), { refunded: amount });
      return;
    }
    case 'check.paid': {
      const shiftId = str(data.shiftId);
      const discount = num(data.discount) ?? 0;
      const existing = await tx.all<{ status: string }>('SELECT status FROM checks WHERE id = ?', [entityId]);
      const wasPaid = existing[0]?.status === 'PAID';
      if (shiftId) await ensureShift(tx, ctx, shiftId, at, actor);
      await tx.run(
        `INSERT INTO checks (id, club_id, number, status, created_at, created_by, closed_at, shift_id, subtotal, discount, total, paid, updated_at)
         VALUES (?, ?, ?, 'PAID', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = 'PAID', closed_at = excluded.closed_at, shift_id = COALESCE(excluded.shift_id, checks.shift_id),
           number = CASE WHEN excluded.number > 0 THEN excluded.number ELSE checks.number END,
           subtotal = excluded.subtotal, discount = excluded.discount, total = excluded.total, paid = excluded.paid,
           updated_at = excluded.updated_at`,
        [
          entityId,
          ctx.clubId,
          num(data.number) ?? 0,
          at,
          actor,
          at,
          shiftId,
          num(data.subtotal) ?? 0,
          discount,
          num(data.total) ?? 0,
          num(data.paid) ?? 0,
          at,
        ],
      );
      const sessionIds = Array.isArray(data.sessionIds) ? data.sessionIds.filter((s): s is string => typeof s === 'string') : [];
      for (const sessionId of sessionIds) {
        await tx.run('UPDATE sessions SET check_id = COALESCE(check_id, ?) WHERE id = ?', [entityId, sessionId]);
      }
      if (!wasPaid) await bumpDay(tx, ctx.clubId, localDay(at, ctx.timezone), { checksPaid: 1, discounts: discount });
      return;
    }
    case 'check.voided': {
      await tx.run(
        `INSERT INTO checks (id, club_id, number, status, created_at, created_by, closed_at, updated_at)
         VALUES (?, ?, 0, 'VOID', ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = 'VOID', closed_at = excluded.closed_at, updated_at = excluded.updated_at`,
        [entityId, ctx.clubId, at, actor, at, at],
      );
      return;
    }

    // ----------------------------------------------------------------------
    // Cash shifts (entityId = shift id)
    // ----------------------------------------------------------------------
    case 'shift.opened': {
      await tx.run(
        `INSERT INTO shifts (id, club_id, number, status, opened_at, opened_by, opening_float)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           number = excluded.number, opened_at = excluded.opened_at, opened_by = excluded.opened_by,
           opening_float = excluded.opening_float`,
        [entityId, ctx.clubId, num(data.number) ?? 0, at, actor, num(data.openingFloat) ?? 0],
      );
      return;
    }
    case 'shift.cash_deposited':
    case 'shift.cash_withdrawn': {
      const kind = topic === 'shift.cash_deposited' ? 'DEPOSIT' : 'WITHDRAWAL';
      await ensureShift(tx, ctx, entityId, at, actor);
      await tx.run(
        `INSERT INTO cash_movements (id, shift_id, club_id, kind, amount, reason, at, actor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [str(data.movementId) ?? eventKey, entityId, ctx.clubId, kind, num(data.amount) ?? 0, str(data.reason), at, actor],
      );
      return;
    }
    case 'shift.closed': {
      const net = isRecord(data.net) ? data.net : {};
      await tx.run(
        `INSERT INTO shifts (id, club_id, number, status, opened_at, opened_by, opening_float, closed_at, closed_by,
                             expected_cash, counted_cash, difference, note, net_total, net_cash, net_card, net_qr)
         VALUES (?, ?, ?, 'CLOSED', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = 'CLOSED', number = CASE WHEN excluded.number > 0 THEN excluded.number ELSE shifts.number END,
           closed_at = excluded.closed_at, closed_by = excluded.closed_by,
           expected_cash = excluded.expected_cash, counted_cash = excluded.counted_cash, difference = excluded.difference,
           note = excluded.note, net_total = excluded.net_total, net_cash = excluded.net_cash,
           net_card = excluded.net_card, net_qr = excluded.net_qr`,
        [
          entityId,
          ctx.clubId,
          num(data.number) ?? 0,
          at,
          actor,
          at,
          actor,
          num(data.expectedCash),
          num(data.countedCash),
          num(data.difference),
          str(data.note),
          num(net.total),
          num(net.CASH),
          num(net.CARD),
          num(net.QR),
        ],
      );
      return;
    }

    // ----------------------------------------------------------------------
    // Power (UPS monitor of the HUB)
    // ----------------------------------------------------------------------
    case 'power.on_battery': {
      await insertOutage(tx, ctx, eventKey, at, null, false);
      return;
    }
    case 'power.critical': {
      const open = await latestOpenOutage(tx, ctx.clubId);
      if (open) await tx.run('UPDATE power_outages SET critical = 1 WHERE id = ?', [open]);
      else await insertOutage(tx, ctx, eventKey, num(data.since) ?? at, null, true);
      return;
    }
    case 'power.auto_paused': {
      const ids = Array.isArray(data.sessionIds) ? data.sessionIds : [];
      const open = await latestOpenOutage(tx, ctx.clubId);
      if (open) await tx.run('UPDATE power_outages SET paused_games = ? WHERE id = ?', [ids.length, open]);
      return;
    }
    case 'power.restored': {
      const critical = data.critical === true;
      const open = await latestOpenOutage(tx, ctx.clubId);
      if (open) {
        await tx.run('UPDATE power_outages SET ended_at = ?, critical = CASE WHEN ? = 1 THEN 1 ELSE critical END WHERE id = ?', [
          at,
          critical ? 1 : 0,
          open,
        ]);
        return;
      }
      const outageMs = num(data.outageMs);
      const startedAt = num(data.since) ?? (outageMs === null ? at : at - outageMs);
      await insertOutage(tx, ctx, eventKey, startedAt, at, critical);
      return;
    }

    // ----------------------------------------------------------------------
    // Alerts and lamps
    // ----------------------------------------------------------------------
    case 'lamp.failed': {
      await bumpDay(tx, ctx.clubId, localDay(at, ctx.timezone), { lampFailures: 1 });
      return;
    }
    case 'alert.raised': {
      const inserted = await tx.run(
        `INSERT INTO alerts (id, club_id, at, kind, table_id, session_id, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [
          entityId,
          ctx.clubId,
          at,
          str(data.kind) ?? 'UNKNOWN',
          str(data.tableId),
          str(data.sessionId),
          str(data.message) ?? '',
        ],
      );
      if (inserted > 0) {
        await bumpDay(tx, ctx.clubId, localDay(at, ctx.timezone), { alerts: 1 });
        const kind = pushKindOfAlert(str(data.kind) ?? 'UNKNOWN');
        await enqueuePush(tx, ctx.now, {
          dedupeKey: `alert:${entityId}`,
          clubId: ctx.clubId,
          kind,
          alertId: entityId,
          title: alertTitle(ctx.clubName, kind),
          body: str(data.message) ?? '',
          at,
        });
      }
      return;
    }
    case 'alert.resolved': {
      await tx.run('UPDATE alerts SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL', [
        at,
        actor,
        entityId,
      ]);
      return;
    }
    default:
      // session.resume_requested / resume_failed (status stays PAUSED), session.prepaid_warning,
      // session.prepaid_deadline_shifted, power.auto_resumed, power.ups_*, power.settings_changed,
      // lamp.on/off/blink, hub.*, cloud.*, future topics: raw journal only.
      return;
  }
}
