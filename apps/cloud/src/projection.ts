import type { SyncEvent } from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { localDay } from './localtime.ts';

/**
 * Applies one HUB event to the read model (sessions, alerts, daily_stats).
 * Called inside the transaction that stored the raw event, once per event:
 * duplicates are filtered before. Unknown topics are ignored, out-of-order
 * or missing events still leave a usable row.
 */
export interface ProjectionContext {
  clubId: string;
  timezone: string;
  /** tariffId → name from the club settings. */
  tariffNames: Map<string, string>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

interface DayDelta {
  revenue?: number;
  games?: number;
  playedSeconds?: number;
  alerts?: number;
  lampFailures?: number;
}

async function bumpDay(tx: SqlDriver, clubId: string, day: string, d: DayDelta): Promise<void> {
  await tx.run(
    `INSERT INTO daily_stats (club_id, day, revenue, games, played_seconds, alerts, lamp_failures)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (club_id, day) DO UPDATE SET
       revenue = daily_stats.revenue + excluded.revenue,
       games = daily_stats.games + excluded.games,
       played_seconds = daily_stats.played_seconds + excluded.played_seconds,
       alerts = daily_stats.alerts + excluded.alerts,
       lamp_failures = daily_stats.lamp_failures + excluded.lamp_failures`,
    [clubId, day, d.revenue ?? 0, d.games ?? 0, d.playedSeconds ?? 0, d.alerts ?? 0, d.lampFailures ?? 0],
  );
}

export async function projectEvent(tx: SqlDriver, ctx: ProjectionContext, event: SyncEvent): Promise<void> {
  const { at, topic, payload } = event;
  const data: Record<string, unknown> = payload.data ?? {};
  const actor = payload.actor || 'unknown';
  const sessionId = payload.entityId;
  const tableId = str(data.tableId) ?? '';

  switch (topic) {
    case 'session.open_requested': {
      const tariffId = str(data.tariffId);
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, tariff_id, tariff_name, opened_by, requested_at, updated_at)
         VALUES (?, ?, ?, 'OPENING', ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           table_id = excluded.table_id, tariff_id = excluded.tariff_id, tariff_name = excluded.tariff_name,
           opened_by = excluded.opened_by, requested_at = excluded.requested_at, updated_at = excluded.updated_at`,
        [sessionId, ctx.clubId, tableId, tariffId, tariffId ? (ctx.tariffNames.get(tariffId) ?? null) : null, actor, at, at],
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
        [sessionId, ctx.clubId, tableId, startedAt, startedAt, at],
      );
      return;
    }
    case 'session.stopped': {
      const startedAt = num(data.startedAt);
      const stoppedAt = num(data.stoppedAt) ?? at;
      const playedSeconds = num(data.playedSeconds) ?? 0;
      const billedSeconds = num(data.billedSeconds) ?? 0;
      const amount = num(data.amount) ?? 0;
      await tx.run(
        `INSERT INTO sessions (id, club_id, table_id, status, opened_by, stopped_by, requested_at, started_at, stopped_at,
                               played_seconds, billed_seconds, amount, updated_at)
         VALUES (?, ?, ?, 'AWAITING_PAYMENT', 'unknown', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = 'AWAITING_PAYMENT', table_id = excluded.table_id, stopped_by = excluded.stopped_by,
           started_at = COALESCE(excluded.started_at, sessions.started_at), stopped_at = excluded.stopped_at,
           played_seconds = excluded.played_seconds, billed_seconds = excluded.billed_seconds, amount = excluded.amount,
           updated_at = excluded.updated_at`,
        [
          sessionId,
          ctx.clubId,
          tableId,
          actor,
          startedAt ?? stoppedAt,
          startedAt,
          stoppedAt,
          playedSeconds,
          billedSeconds,
          amount,
          at,
        ],
      );
      await bumpDay(tx, ctx.clubId, localDay(stoppedAt, ctx.timezone), { revenue: amount, games: 1, playedSeconds });
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
           failure_reason = excluded.failure_reason, updated_at = excluded.updated_at`,
        [sessionId, ctx.clubId, tableId, status, actor, at, at, reason, at],
      );
      return;
    }
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
          payload.entityId,
          ctx.clubId,
          at,
          str(data.kind) ?? 'UNKNOWN',
          str(data.tableId),
          str(data.sessionId),
          str(data.message) ?? '',
        ],
      );
      if (inserted > 0) await bumpDay(tx, ctx.clubId, localDay(at, ctx.timezone), { alerts: 1 });
      return;
    }
    case 'alert.resolved': {
      await tx.run('UPDATE alerts SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL', [
        at,
        actor,
        payload.entityId,
      ]);
      return;
    }
    default:
      // lamp.on, lamp.off, hub.recovered, cloud.settings_applied, future topics: raw journal only.
      return;
  }
}
