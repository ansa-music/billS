import type {
  AlertView,
  HubState,
  PauseReason,
  PauseSpan,
  SessionStatus,
  SessionView,
  TableView,
  TariffConfig,
} from '@bills/domain';
import { calculateChargeWithPauses, unpaidSpans } from '@bills/domain';
import type { Db } from './db.ts';
import { all, one } from './db.ts';
import { HubError } from './errors.ts';

export type { AlertView, HubState, SessionView, TableView };

/** Status as stored: PAUSED is ACTIVE plus an open pause (see migration 007). */
export type StoredSessionStatus = Exclude<SessionStatus, 'PAUSED'>;

export interface SessionRow {
  id: string;
  club_id: string;
  table_id: string;
  tariff_id: string;
  tariff_name: string;
  tariff_snapshot: string;
  timezone: string;
  status: StoredSessionStatus;
  requested_at: number;
  started_at: number | null;
  stopped_at: number | null;
  played_seconds: number | null;
  billed_seconds: number | null;
  amount: number | null;
  paused_seconds: number | null;
  failure_reason: string | null;
  opened_by: string;
  stopped_by: string | null;
  /** The open pause, if any (joined from session_pauses). */
  pause_id: string | null;
  pause_reason: PauseReason | null;
  pause_started_at: number | null;
  resume_requested_at: number | null;
}

export interface PauseRow {
  id: string;
  session_id: string;
  reason: PauseReason;
  paused_at: number;
  resume_requested_at: number | null;
  resumed_at: number | null;
  paused_by: string;
  resumed_by: string | null;
  from_table_id: string | null;
  to_table_id: string | null;
}

/** A game with its open pause. Append `WHERE s.…` conditions. */
export const SESSION_SQL = `
  SELECT s.*, p.id AS pause_id, p.reason AS pause_reason, p.paused_at AS pause_started_at, p.resume_requested_at
  FROM table_sessions s
  LEFT JOIN session_pauses p ON p.session_id = s.id AND p.resumed_at IS NULL`;

export function effectiveStatus(row: Pick<SessionRow, 'status' | 'pause_id'>): SessionStatus {
  return row.status === 'ACTIVE' && row.pause_id !== null ? 'PAUSED' : row.status;
}

export function loadSessionRow(db: Db, id: string): SessionRow | undefined {
  return one<SessionRow>(db, `${SESSION_SQL} WHERE s.id = ?`, id);
}

export function toPauseSpan(p: PauseRow): PauseSpan {
  return { from: p.paused_at, to: p.resumed_at, reason: p.reason };
}

export function loadPauseSpans(db: Db, sessionId: string): PauseSpan[] {
  return all<PauseRow>(db, 'SELECT * FROM session_pauses WHERE session_id = ? ORDER BY paused_at, rowid', sessionId).map(
    toPauseSpan,
  );
}

/** Pauses of many games at once, keyed by game id. */
function loadPauseSpansFor(db: Db, clubId: string, statuses: readonly StoredSessionStatus[]): Map<string, PauseSpan[]> {
  const marks = statuses.map(() => '?').join(', ');
  const rows = all<PauseRow>(
    db,
    `SELECT p.* FROM session_pauses p
     JOIN table_sessions s ON s.id = p.session_id
     WHERE s.club_id = ? AND s.status IN (${marks})
     ORDER BY p.paused_at, p.rowid`,
    clubId,
    ...statuses,
  );
  const map = new Map<string, PauseSpan[]>();
  for (const r of rows) {
    let list = map.get(r.session_id);
    if (!list) {
      list = [];
      map.set(r.session_id, list);
    }
    list.push(toPauseSpan(r));
  }
  return map;
}

export function toSessionView(row: SessionRow, pauses: PauseSpan[], now: number): SessionView {
  const tariff = JSON.parse(row.tariff_snapshot) as TariffConfig;
  const status = effectiveStatus(row);
  let { amount, played_seconds: playedSeconds, billed_seconds: billedSeconds, paused_seconds: pausedSeconds } = row;
  if ((status === 'ACTIVE' || status === 'PAUSED') && row.started_at !== null) {
    const end = Math.max(now, row.started_at);
    const charge = calculateChargeWithPauses(row.started_at, end, unpaidSpans(pauses, tariff, end), tariff, row.timezone);
    amount = charge.amount;
    playedSeconds = charge.playedSeconds;
    billedSeconds = charge.billedSeconds;
    pausedSeconds = charge.pausedSeconds;
  }
  return {
    id: row.id,
    tableId: row.table_id,
    status,
    tariffId: row.tariff_id,
    tariffName: row.tariff_name,
    tariff,
    timezone: row.timezone,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    playedSeconds,
    billedSeconds,
    amount,
    pausedSeconds,
    pauses,
    pausedAt: status === 'PAUSED' ? row.pause_started_at : null,
    resumeRequestedAt: status === 'PAUSED' ? row.resume_requested_at : null,
    failureReason: row.failure_reason,
    openedBy: row.opened_by,
    stoppedBy: row.stopped_by,
  };
}

export function loadSession(db: Db, id: string, now: number): SessionView {
  const row = loadSessionRow(db, id);
  if (!row) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
  return toSessionView(row, loadPauseSpans(db, id), now);
}

export function buildState(db: Db, now: number): HubState {
  const club = one<HubState['club']>(db, 'SELECT id, name, timezone, currency FROM clubs ORDER BY created_at LIMIT 1');
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');

  const tariffs = all<{ id: string; name: string; config: string }>(
    db,
    'SELECT id, name, config FROM tariffs WHERE club_id = ? AND is_active = 1 ORDER BY name',
    club.id,
  ).map((t) => ({ id: t.id, name: t.name, config: JSON.parse(t.config) as TariffConfig }));

  const pauses = loadPauseSpansFor(db, club.id, ['OPENING', 'ACTIVE', 'AWAITING_PAYMENT']);
  const view = (r: SessionRow) => toSessionView(r, pauses.get(r.id) ?? [], now);

  const live = new Map(
    all<SessionRow>(db, `${SESSION_SQL} WHERE s.club_id = ? AND s.status IN ('OPENING', 'ACTIVE')`, club.id).map((r) => [
      r.table_id,
      view(r),
    ]),
  );

  const tables = all<{
    id: string;
    name: string;
    kind: TableView['kind'];
    default_tariff_id: string;
    desired: 'ON' | 'OFF' | null;
    reported: 'ON' | 'OFF' | 'UNKNOWN' | null;
    blink: number | null;
  }>(
    db,
    `SELECT t.id, t.name, t.kind, t.default_tariff_id, l.desired, l.reported, l.blink
     FROM billiard_tables t LEFT JOIN lamp_states l ON l.table_id = t.id
     WHERE t.club_id = ? AND t.is_active = 1
     ORDER BY t.sort_order, t.name`,
    club.id,
  ).map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    defaultTariffId: t.default_tariff_id,
    lamp: { desired: t.desired ?? 'OFF', reported: t.reported ?? 'UNKNOWN', blink: (t.desired ?? 'OFF') === 'ON' && t.blink === 1 },
    session: live.get(t.id) ?? null,
  }));

  const unpaid = all<SessionRow>(
    db,
    `${SESSION_SQL} WHERE s.club_id = ? AND s.status = 'AWAITING_PAYMENT' ORDER BY s.stopped_at`,
    club.id,
  ).map(view);

  const alerts = all<AlertView>(
    db,
    `SELECT id, at, kind, table_id AS tableId, message FROM alerts
     WHERE resolved_at IS NULL ORDER BY at DESC LIMIT 20`,
  );

  return { serverNow: now, club, tariffs, tables, unpaid, alerts };
}
