import type { AlertView, TableView } from '@bills/domain';

export type TablePhase = 'free' | 'opening' | 'playing' | 'paused';
export type HallFilter = 'all' | 'free' | 'playing' | 'problem';

export function tablePhase(table: TableView): TablePhase {
  if (table.session?.status === 'ACTIVE') return 'playing';
  if (table.session?.status === 'PAUSED') return 'paused';
  if (table.session?.status === 'OPENING') return 'opening';
  return 'free';
}

/** A table needs attention: an open lamp alert or a lamp that did not answer. */
export function hasProblem(table: TableView, alert: AlertView | undefined): boolean {
  return alert !== undefined || table.lamp.reported === 'UNKNOWN';
}

export function matchesFilter(table: TableView, filter: HallFilter, alert: AlertView | undefined): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'free':
      return tablePhase(table) === 'free';
    case 'playing':
      // Paused and opening games occupy the table too.
      return tablePhase(table) !== 'free';
    case 'problem':
      return hasProblem(table, alert);
  }
}

/** The latest open alert per table. */
export function alertsByTable(alerts: AlertView[]): Map<string, AlertView> {
  const map = new Map<string, AlertView>();
  for (const a of alerts) {
    if (a.tableId && !map.has(a.tableId)) map.set(a.tableId, a);
  }
  return map;
}
