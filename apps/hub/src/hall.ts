import type {
  HallLayout,
  HallLayoutView,
  JournalCategory,
  JournalEntry,
  JournalPage,
  LampDetail,
  SessionView,
  TableKind,
} from '@bills/domain';
import { mergeLayout, validateLayout } from '@bills/domain';
import type { Db, Param } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import type { SessionRow } from './views.ts';
import { loadPauseSpansByIds, SESSION_SQL, toSessionView } from './views.ts';

/** Read models and the floor plan for the hall screens. */

function clubId(db: Db): string {
  const club = one<{ id: string }>(db, 'SELECT id FROM clubs ORDER BY created_at LIMIT 1');
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
  return club.id;
}

function activeTables(db: Db, club: string): Array<{ id: string; kind: TableKind }> {
  return all(db, 'SELECT id, kind FROM billiard_tables WHERE club_id = ? AND is_active = 1 ORDER BY sort_order, name', club);
}

export function getHallLayout(db: Db): HallLayoutView {
  const club = clubId(db);
  const row = one<{ layout: string; updated_at: number; updated_by: string }>(
    db,
    'SELECT layout, updated_at, updated_by FROM hall_layouts WHERE club_id = ?',
    club,
  );
  const saved = row ? (JSON.parse(row.layout) as HallLayout) : null;
  return {
    layout: mergeLayout(saved, activeTables(db, club)),
    saved: row !== undefined,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

export function saveHallLayout(db: Db, events: HubEvents, now: number, actor: string, input: unknown): HallLayoutView {
  return transaction(db, () => {
    const club = clubId(db);
    const ids = new Set(activeTables(db, club).map((t) => t.id));
    const errors = validateLayout(input, ids);
    if (errors.length) throw new HubError(422, 'LAYOUT_INVALID', `План не сохранён: ${errors.join('; ')}`);
    const l = input as HallLayout;
    // Store exactly the known fields: the plan is shown to every screen.
    const layout: HallLayout = {
      width: l.width,
      height: l.height,
      tables: l.tables.map(({ tableId, x, y, rotation }) => ({ tableId, x, y, rotation })),
      landmarks: l.landmarks.map(({ id, kind, x, y, w, h }) => ({ id, kind, x, y, w, h })),
    };
    run(
      db,
      `INSERT INTO hall_layouts (club_id, layout, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (club_id) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      club,
      JSON.stringify(layout),
      now,
      actor,
    );
    record(db, now, {
      actor,
      action: 'hall.layout_saved',
      entityType: 'club',
      entityId: club,
      data: { width: layout.width, height: layout.height, tables: layout.tables.length, landmarks: layout.landmarks.length },
    });
    afterCommit(db, () => events.changed({ kind: 'layout' }));
    return getHallLayout(db);
  });
}

const CATEGORY_FILTER: Record<JournalCategory, string> = {
  games: "a.action LIKE 'session.%'",
  money: "(a.action LIKE 'check.%' OR a.action LIKE 'payment.%' OR a.action LIKE 'shift.%')",
  lamps: "a.action LIKE 'lamp.%'",
  alerts: "a.action LIKE 'alert.%'",
  bar: "(a.action LIKE 'order.%' OR a.action LIKE 'product.%' OR a.action LIKE 'category.%')",
  club: "(a.action LIKE 'club.%' OR a.action LIKE 'table.%' OR a.action LIKE 'tables.%' OR a.action LIKE 'tariff.%' OR a.action LIKE 'staff.%' OR a.action LIKE 'key.%' OR a.action LIKE 'auth.%')",
  system: "(a.action LIKE 'hub.%' OR a.action LIKE 'hall.%' OR a.action LIKE 'power.%' OR a.action LIKE 'cloud.%')",
};

export function journalPage(
  db: Db,
  query: { before?: number | undefined; limit: number; category?: JournalCategory | undefined; tableId?: string | undefined },
): JournalPage {
  const where: string[] = [];
  const params: Param[] = [];
  if (query.before !== undefined) {
    where.push('a.id < ?');
    params.push(query.before);
  }
  if (query.category) where.push(CATEGORY_FILTER[query.category]);
  const tableExpr = "COALESCE(CASE WHEN a.entity_type = 'table' THEN a.entity_id END, json_extract(a.data, '$.tableId'))";
  if (query.tableId) {
    where.push(`${tableExpr} = ?`);
    params.push(query.tableId);
  }
  const rows = all<{
    id: number;
    at: number;
    actor: string;
    action: string;
    entity_type: string;
    entity_id: string;
    data: string;
    table_id: string | null;
  }>(
    db,
    `SELECT a.id, a.at, a.actor, a.action, a.entity_type, a.entity_id, a.data, ${tableExpr} AS table_id
     FROM audit_log a
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.id DESC
     LIMIT ?`,
    ...params,
    query.limit + 1,
  );
  const more = rows.length > query.limit;
  const entries: JournalEntry[] = rows.slice(0, query.limit).map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    data: JSON.parse(r.data) as Record<string, unknown>,
    tableId: r.table_id,
  }));
  return { entries, nextBefore: more ? (entries.at(-1)?.id ?? null) : null };
}

const MAX_RANGE_MS = 93 * 24 * 60 * 60 * 1000;

/** Games that overlap [from, to): started before `to` and not finished before `from`. */
export function sessionsBetween(db: Db, now: number, from: number, to: number): SessionView[] {
  if (!(from < to) || to - from > MAX_RANGE_MS) {
    throw new HubError(400, 'BAD_RANGE', 'Период: начало раньше конца и не больше 93 дней');
  }
  const rows = all<SessionRow>(
    db,
    `${SESSION_SQL}
     WHERE s.requested_at < ? AND COALESCE(s.stopped_at, ?) >= ?
     ORDER BY s.requested_at DESC
     LIMIT 5000`,
    to,
    now,
    from,
  );
  // Pauses of the listed games only: finished games keep their spans, so the day's history shows them too.
  const pauses = loadPauseSpansByIds(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toSessionView(r, pauses.get(r.id) ?? [], now));
}

export function lampDetails(db: Db): LampDetail[] {
  return all<{
    table_id: string;
    name: string;
    lamp_channel: string;
    desired: LampDetail['desired'] | null;
    reported: LampDetail['reported'] | null;
    reported_at: number | null;
    action: LampDetail['desired'] | null;
    status: NonNullable<LampDetail['lastCommand']>['status'] | null;
    attempts: number | null;
    last_error: string | null;
    created_at: number | null;
    finished_at: number | null;
  }>(
    db,
    `SELECT t.id AS table_id, t.name, t.lamp_channel, l.desired, l.reported, l.reported_at,
            c.action, c.status, c.attempts, c.last_error, c.created_at, c.finished_at
     FROM billiard_tables t
     LEFT JOIN lamp_states l ON l.table_id = t.id
     LEFT JOIN lamp_commands c ON c.id = (
       SELECT id FROM lamp_commands WHERE table_id = t.id ORDER BY created_at DESC, rowid DESC LIMIT 1
     )
     WHERE t.is_active = 1
     ORDER BY t.sort_order, t.name`,
  ).map((r) => ({
    tableId: r.table_id,
    tableName: r.name,
    channel: r.lamp_channel,
    desired: r.desired ?? 'OFF',
    reported: r.reported ?? 'UNKNOWN',
    reportedAt: r.reported_at,
    lastCommand:
      r.action && r.status && r.created_at !== null
        ? {
            action: r.action,
            status: r.status,
            attempts: r.attempts ?? 0,
            lastError: r.last_error,
            createdAt: r.created_at,
            finishedAt: r.finished_at,
          }
        : null,
  }));
}
