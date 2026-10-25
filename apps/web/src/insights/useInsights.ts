import { useCallback } from 'react';
import type { InsightsView, StockForecastItem } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { usePolling } from '../cafe/cafe.ts';
import { useHub } from '../useHub.tsx';

/** The HUB caches the answer for a minute: asking more often changes nothing. */
export const INSIGHTS_POLL_MS = 60_000;

/**
 * GET /api/insights: «Умные подсказки» and the stock forecast. Only senior staff see it
 * (the HUB checks `stats.view` + `audit.view`); for everyone else this stays null and
 * nothing is requested.
 */
export function useInsights(): { allowed: boolean; data: InsightsView | null; error: string | null; reload: () => Promise<void> } {
  const { can } = useHub();
  const allowed = can('stats.view') && can('audit.view');
  const load = useCallback(
    () => (allowed ? fetchJson<InsightsView>('/api/insights') : Promise.resolve(null)),
    [allowed],
  );
  const { data, error, reload } = usePolling(load, INSIGHTS_POLL_MS, allowed);
  return { allowed, data, error, reload };
}

const ROUND_MS = 15 * 60_000;

/** «Примерно» honestly: the run-out time rounded down to a quarter of an hour. */
export function roundRunOut(ms: number): number {
  return Math.floor(ms / ROUND_MS) * ROUND_MS;
}

/**
 * A badge for the menu: «закончится к 15:00», «осталось на 2 дня»; null when there is
 * plenty, no forecast, or it is already out (the page says «нет в наличии» itself).
 */
export function stockBadge(
  item: StockForecastItem | undefined,
  now: number,
  clock: (ms: number) => string,
): { text: string; tone: 'danger' | 'warn' | 'muted'; title: string } | null {
  if (!item || item.stock === 0) return null;
  const pace = item.perDay !== null ? `Продаётся примерно ${item.perDay.toLocaleString('ru-RU')} шт. в день` : '';
  if (item.runsOutAt !== null) {
    const left = item.runsOutAt - now;
    if (left < ROUND_MS) return { text: 'вот-вот закончится', tone: 'danger', title: pace };
    return { text: `закончится к ${clock(roundRunOut(item.runsOutAt))}`, tone: 'danger', title: pace };
  }
  if (item.daysLeft === null || item.daysLeft > 7) return null;
  const d = item.daysLeft;
  const days = d % 10 === 1 && d % 100 !== 11 ? 'день' : [2, 3, 4].includes(d % 10) && ![12, 13, 14].includes(d % 100) ? 'дня' : 'дней';
  return { text: `осталось на ${d} ${days}`, tone: d <= 2 ? 'warn' : 'muted', title: pace };
}
