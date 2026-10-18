import type { LampDesired, LampReported, TableKind } from './api.ts';

/**
 * Floor plan of a hall in centimetres: x to the right, y down, origin in the
 * top-left corner. Positions are centres, so rotating keeps a table in place.
 */

export type Rotation = 0 | 90;

export const LANDMARK_KINDS = ['bar', 'cashier', 'entrance', 'lounge', 'wc', 'column'] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];

export const LANDMARK_LABEL: Record<LandmarkKind, string> = {
  bar: 'Бар',
  cashier: 'Касса',
  entrance: 'Вход',
  lounge: 'Зона отдыха',
  wc: 'Туалет',
  column: 'Колонна',
};

/** Default size of a new landmark, cm. */
export const LANDMARK_SIZE: Record<LandmarkKind, { w: number; h: number }> = {
  bar: { w: 400, h: 120 },
  cashier: { w: 180, h: 100 },
  entrance: { w: 160, h: 60 },
  lounge: { w: 300, h: 200 },
  wc: { w: 160, h: 160 },
  column: { w: 50, h: 50 },
};

export interface TablePlacement {
  tableId: string;
  x: number;
  y: number;
  rotation: Rotation;
}

export interface Landmark {
  id: string;
  kind: LandmarkKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface HallLayout {
  width: number;
  height: number;
  tables: TablePlacement[];
  landmarks: Landmark[];
}

export interface HallLayoutView {
  layout: HallLayout;
  /** False while the club has not arranged its plan yet: the layout is generated. */
  saved: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** Outer size with rails, cm: pool 9 ft, Russian pyramid 12 ft, snooker 12 ft. */
export const TABLE_FOOTPRINT: Record<TableKind, { length: number; width: number }> = {
  pool: { length: 285, width: 160 },
  russian: { length: 400, width: 220 },
  snooker: { length: 390, width: 205 },
};

/** Room a player needs between a rail and a wall or another table for a full stroke. */
export const CUE_CLEARANCE_CM = 140;

export const HALL_LIMITS = { min: 300, max: 10_000 } as const;

export function footprint(kind: TableKind, rotation: Rotation): { w: number; h: number } {
  const f = TABLE_FOOTPRINT[kind];
  return rotation === 0 ? { w: f.length, h: f.width } : { w: f.width, h: f.length };
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function tableRect(p: TablePlacement, kind: TableKind): Rect {
  const { w, h } = footprint(kind, p.rotation);
  return { x0: p.x - w / 2, y0: p.y - h / 2, x1: p.x + w / 2, y1: p.y + h / 2 };
}

function landmarkRect(l: Landmark): Rect {
  return { x0: l.x - l.w / 2, y0: l.y - l.h / 2, x1: l.x + l.w / 2, y1: l.y + l.h / 2 };
}

/** Shortest distance between two rectangles; 0 when they touch or overlap. */
function gap(a: Rect, b: Rect): number {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1, 0);
  const dy = Math.max(b.y0 - a.y1, a.y0 - b.y1, 0);
  return Math.hypot(dx, dy);
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

export type LayoutIssue =
  | { type: 'overlap'; tableId: string; withId: string }
  | { type: 'tight'; tableId: string; withId: string; gapCm: number }
  | { type: 'wall'; tableId: string; gapCm: number }
  | { type: 'outside'; tableId: string };

/**
 * What is wrong with a plan: tables on top of each other or a landmark,
 * too little room for a cue next to another table or a wall.
 */
export function layoutIssues(layout: HallLayout, kinds: ReadonlyMap<string, TableKind>): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const placed = layout.tables
    .map((p) => {
      const kind = kinds.get(p.tableId);
      return kind ? { p, r: tableRect(p, kind) } : null;
    })
    .filter((x) => x !== null);

  placed.forEach(({ p, r }, i) => {
    if (r.x0 < 0 || r.y0 < 0 || r.x1 > layout.width || r.y1 > layout.height) {
      issues.push({ type: 'outside', tableId: p.tableId });
    } else {
      const wallGap = Math.min(r.x0, r.y0, layout.width - r.x1, layout.height - r.y1);
      if (wallGap < CUE_CLEARANCE_CM) issues.push({ type: 'wall', tableId: p.tableId, gapCm: Math.round(wallGap) });
    }
    for (const other of placed.slice(i + 1)) {
      if (intersects(r, other.r)) {
        issues.push({ type: 'overlap', tableId: p.tableId, withId: other.p.tableId });
        issues.push({ type: 'overlap', tableId: other.p.tableId, withId: p.tableId });
        continue;
      }
      const g = gap(r, other.r);
      if (g < CUE_CLEARANCE_CM) {
        issues.push({ type: 'tight', tableId: p.tableId, withId: other.p.tableId, gapCm: Math.round(g) });
        issues.push({ type: 'tight', tableId: other.p.tableId, withId: p.tableId, gapCm: Math.round(g) });
      }
    }
    for (const l of layout.landmarks) {
      if (l.kind !== 'entrance' && intersects(r, landmarkRect(l))) {
        issues.push({ type: 'overlap', tableId: p.tableId, withId: l.id });
      }
    }
  });
  return issues;
}

/** Tables in rows with room for a cue between them, rows centred. */
export function autoLayout(tables: ReadonlyArray<{ id: string; kind: TableKind }>, width = 1500): HallLayout {
  const m = CUE_CLEARANCE_CM;
  const rows: Array<{ items: Array<{ id: string; w: number; h: number }>; w: number; h: number }> = [];
  for (const t of tables) {
    const { w, h } = footprint(t.kind, 0);
    let row = rows.at(-1);
    if (!row || (row.items.length > 0 && m + row.w + w + m > width)) {
      row = { items: [], w: 0, h: 0 };
      rows.push(row);
    }
    row.w += (row.items.length > 0 ? m : 0) + w;
    row.h = Math.max(row.h, h);
    row.items.push({ id: t.id, w, h });
  }
  const hallWidth = Math.max(width, ...rows.map((r) => r.w + 2 * m));
  const placements: TablePlacement[] = [];
  let y = m;
  let bottom = 0;
  for (const row of rows) {
    let x = (hallWidth - row.w) / 2;
    for (const item of row.items) {
      const cy = Math.round(y + row.h / 2);
      placements.push({ tableId: item.id, x: Math.round(x + item.w / 2), y: cy, rotation: 0 });
      bottom = Math.max(bottom, cy + item.h / 2);
      x += item.w + m;
    }
    y += row.h + m;
  }
  // Whole 10 cm: the hall size shows up in the editor as metres.
  const ceil10 = (v: number) => Math.ceil(v / 10) * 10;
  return { width: ceil10(hallWidth), height: Math.max(ceil10(bottom + m), 900), tables: placements, landmarks: [] };
}

/**
 * The saved plan, brought up to date with the club's tables: removed tables
 * disappear, new ones are put in the first free spot (the hall grows if needed).
 */
export function mergeLayout(saved: HallLayout | null, tables: ReadonlyArray<{ id: string; kind: TableKind }>): HallLayout {
  if (!saved) return autoLayout(tables);
  const kinds = new Map(tables.map((t) => [t.id, t.kind]));
  const layout: HallLayout = {
    ...saved,
    tables: saved.tables.filter((p) => kinds.has(p.tableId)),
    landmarks: [...saved.landmarks],
  };
  for (const t of tables) {
    if (layout.tables.some((p) => p.tableId === t.id)) continue;
    layout.tables.push(findFreeSpot(layout, kinds, t));
  }
  return layout;
}

function findFreeSpot(
  layout: HallLayout,
  kinds: ReadonlyMap<string, TableKind>,
  table: { id: string; kind: TableKind },
): TablePlacement {
  const { w, h } = footprint(table.kind, 0);
  const m = CUE_CLEARANCE_CM;
  const blocked = [
    ...layout.tables.map((p) => {
      const kind = kinds.get(p.tableId);
      return kind ? tableRect(p, kind) : null;
    }),
    ...layout.landmarks.map(landmarkRect),
  ].filter((r) => r !== null);
  for (let y = m + h / 2; y + h / 2 + m <= layout.height; y += 20) {
    for (let x = m + w / 2; x + w / 2 + m <= layout.width; x += 20) {
      const r = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
      if (blocked.every((b) => !intersects(r, b) && gap(r, b) >= m)) return { tableId: table.id, x, y, rotation: 0 };
    }
  }
  const bottom = Math.max(0, ...blocked.map((b) => b.y1));
  layout.height = Math.min(HALL_LIMITS.max, Math.round(bottom + m + h + m));
  return { tableId: table.id, x: Math.round(m + w / 2), y: Math.round(bottom + m + h / 2), rotation: 0 };
}

/** Structural checks the HUB enforces before saving a plan. */
export function validateLayout(layout: unknown, tableIds: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const l = layout as Partial<HallLayout> | null;
  if (!l || typeof l !== 'object') return ['layout must be an object'];
  const inRange = (n: unknown, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  const size = (n: unknown) =>
    typeof n === 'number' && Number.isInteger(n) && n >= HALL_LIMITS.min && n <= HALL_LIMITS.max;
  if (!size(l.width) || !size(l.height)) {
    errors.push(`width and height must be whole centimetres ${HALL_LIMITS.min}..${HALL_LIMITS.max}`);
    return errors;
  }
  const width = l.width as number;
  const height = l.height as number;

  if (!Array.isArray(l.tables)) errors.push('tables must be an array');
  else {
    const seen = new Set<string>();
    l.tables.forEach((p, i) => {
      if (!p || typeof p.tableId !== 'string' || !tableIds.has(p.tableId)) errors.push(`tables[${i}]: unknown table`);
      else if (seen.has(p.tableId)) errors.push(`tables[${i}]: table placed twice`);
      else seen.add(p.tableId);
      if (!inRange(p?.x, width) || !inRange(p?.y, height)) errors.push(`tables[${i}]: position outside the hall`);
      if (p?.rotation !== 0 && p?.rotation !== 90) errors.push(`tables[${i}]: rotation must be 0 or 90`);
    });
    for (const id of tableIds) if (!seen.has(id)) errors.push(`table ${id} is not placed`);
  }

  if (!Array.isArray(l.landmarks)) errors.push('landmarks must be an array');
  else {
    if (l.landmarks.length > 50) errors.push('at most 50 landmarks');
    const seen = new Set<string>();
    l.landmarks.forEach((m, i) => {
      if (!m || typeof m.id !== 'string' || m.id.length < 1 || m.id.length > 64 || seen.has(m.id)) {
        errors.push(`landmarks[${i}]: id must be unique, 1..64 characters`);
      } else seen.add(m.id);
      if (!(LANDMARK_KINDS as readonly string[]).includes(m?.kind as string)) errors.push(`landmarks[${i}]: unknown kind`);
      if (!inRange(m?.x, width) || !inRange(m?.y, height)) errors.push(`landmarks[${i}]: position outside the hall`);
      if (!inRange(m?.w, HALL_LIMITS.max) || !inRange(m?.h, HALL_LIMITS.max) || (m?.w ?? 0) < 30 || (m?.h ?? 0) < 30) {
        errors.push(`landmarks[${i}]: size must be 30..${HALL_LIMITS.max} cm`);
      }
    });
  }
  return errors;
}

/* Read models for the journal and equipment screens. */

export const JOURNAL_CATEGORIES = ['games', 'lamps', 'alerts', 'system'] as const;
export type JournalCategory = (typeof JOURNAL_CATEGORIES)[number];

export interface JournalEntry {
  id: number;
  at: number;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
  tableId: string | null;
}

export interface JournalPage {
  entries: JournalEntry[];
  /** Pass as `before` to load older entries; null when there are none. */
  nextBefore: number | null;
}

export interface LampDetail {
  tableId: string;
  tableName: string;
  channel: string;
  desired: LampDesired;
  reported: LampReported;
  reportedAt: number | null;
  lastCommand: {
    action: LampDesired;
    status: 'PENDING' | 'ACKED' | 'FAILED' | 'SUPERSEDED';
    attempts: number;
    lastError: string | null;
    createdAt: number;
    finishedAt: number | null;
  } | null;
}
