import type { AlertView, HubState, SessionStatus, SessionView, TableView, TariffConfig } from '@bills/domain';
import { calculateCharge } from '@bills/domain';
import type { Db } from './db.ts';
import { all, one } from './db.ts';
import { HubError } from './errors.ts';
import { getManualMode } from './settings.ts';

export type { AlertView, HubState, SessionView, TableView };

export interface SessionRow {
  id: string;
  club_id: string;
  table_id: string;
  tariff_id: string;
  tariff_name: string;
  tariff_snapshot: string;
  timezone: string;
  status: SessionStatus;
  requested_at: number;
  started_at: number | null;
  stopped_at: number | null;
  played_seconds: number | null;
  billed_seconds: number | null;
  amount: number | null;
  failure_reason: string | null;
  opened_by: string;
  stopped_by: string | null;
  manual: number;
}

export function toSessionView(row: SessionRow, now: number): SessionView {
  const tariff = JSON.parse(row.tariff_snapshot) as TariffConfig;
  let amount = row.amount;
  if (row.status === 'ACTIVE' && row.started_at !== null) {
    amount = calculateCharge(row.started_at, Math.max(now, row.started_at), tariff, row.timezone).amount;
  }
  return {
    id: row.id,
    tableId: row.table_id,
    status: row.status,
    tariffId: row.tariff_id,
    tariffName: row.tariff_name,
    tariff,
    timezone: row.timezone,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    playedSeconds: row.played_seconds,
    billedSeconds: row.billed_seconds,
    amount,
    failureReason: row.failure_reason,
    openedBy: row.opened_by,
    stoppedBy: row.stopped_by,
    manual: row.manual === 1,
  };
}

export function loadSession(db: Db, id: string, now: number): SessionView {
  const row = one<SessionRow>(db, 'SELECT * FROM table_sessions WHERE id = ?', id);
  if (!row) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
  return toSessionView(row, now);
}

export function buildState(db: Db, now: number): HubState {
  const club = one<HubState['club']>(db, 'SELECT id, name, timezone, currency FROM clubs ORDER BY created_at LIMIT 1');
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');

  const tariffs = all<{ id: string; name: string; config: string }>(
    db,
    'SELECT id, name, config FROM tariffs WHERE club_id = ? AND is_active = 1 ORDER BY name',
    club.id,
  ).map((t) => ({ id: t.id, name: t.name, config: JSON.parse(t.config) as TariffConfig }));

  const live = new Map(
    all<SessionRow>(db, "SELECT * FROM table_sessions WHERE club_id = ? AND status IN ('OPENING', 'ACTIVE')", club.id).map(
      (r) => [r.table_id, toSessionView(r, now)],
    ),
  );

  const tables = all<{
    id: string;
    name: string;
    kind: TableView['kind'];
    default_tariff_id: string;
    desired: 'ON' | 'OFF' | null;
    reported: 'ON' | 'OFF' | 'UNKNOWN' | null;
    current_on: number | null;
    polled_at: number | null;
  }>(
    db,
    `SELECT t.id, t.name, t.kind, t.default_tariff_id, l.desired, l.reported, l.current_on, l.polled_at
     FROM billiard_tables t LEFT JOIN lamp_states l ON l.table_id = t.id
     WHERE t.club_id = ? AND t.is_active = 1
     ORDER BY t.sort_order, t.name`,
    club.id,
  ).map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    defaultTariffId: t.default_tariff_id,
    lamp: {
      desired: t.desired ?? 'OFF',
      reported: t.reported ?? 'UNKNOWN',
      currentOn: t.current_on === null ? null : t.current_on === 1,
      polledAt: t.polled_at,
    },
    session: live.get(t.id) ?? null,
  }));

  const unpaid = all<SessionRow>(
    db,
    "SELECT * FROM table_sessions WHERE club_id = ? AND status = 'AWAITING_PAYMENT' ORDER BY stopped_at",
    club.id,
  ).map((r) => toSessionView(r, now));

  const alerts = all<AlertView>(
    db,
    `SELECT id, at, kind, table_id AS tableId, message FROM alerts
     WHERE resolved_at IS NULL ORDER BY at DESC LIMIT 20`,
  );

  return { serverNow: now, club, tariffs, tables, unpaid, alerts, manualMode: getManualMode(db) };
}
