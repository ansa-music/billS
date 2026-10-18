import type { AlertView, SessionView, TableView } from '@bills/domain';
import { calculateChargeWithPauses, unpaidSpans } from '@bills/domain';

export type TablePhase = 'free' | 'opening' | 'playing' | 'paused';
export type HallFilter = 'all' | 'free' | 'playing' | 'problem';

export function tablePhase(table: TableView): TablePhase {
  if (table.session?.status === 'ACTIVE') return 'playing';
  if (table.session?.status === 'PAUSED') return 'paused';
  if (table.session?.status === 'OPENING') return 'opening';
  return 'free';
}

/** A game that occupies a table and is still being billed (pauses included). */
export function isLive(s: SessionView): boolean {
  return s.status === 'ACTIVE' || s.status === 'PAUSED';
}

/** Play time of a game in ms: live games as of `now`, pauses excluded. */
export function playedMsOf(s: SessionView, now: number): number {
  if (s.startedAt == null) return 0;
  if (isLive(s)) return liveCharge(s, now).playedSeconds * 1000;
  return (s.playedSeconds ?? 0) * 1000;
}

/** The bill of a live game as of `now` (pauses within the tariff budget are free). */
export function liveCharge(s: SessionView, now: number) {
  const startedAt = s.startedAt ?? now;
  const end = Math.max(now, startedAt);
  return calculateChargeWithPauses(startedAt, end, unpaidSpans(s.pauses, s.tariff, end), s.tariff, s.timezone);
}

/** Final amount of a stopped game, or the running one of a live game as of `now`. */
export function amountOf(s: SessionView, now: number): number {
  if (isLive(s) && s.startedAt != null) return liveCharge(s, now).amount;
  return s.amount ?? 0;
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
