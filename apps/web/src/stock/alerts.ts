import { useMemo } from 'react';
import type { StockAlertLevel, StockAlertsView } from '@bills/domain';
import { stockHint } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { useHub, useLive } from '../useHub.tsx';
import './alerts.css';

/**
 * «Заканчивается» for the staff (GET /api/stock/alerts, catalog.view): which raw materials ran out
 * or are below their minimum, and which products they hold up. Names and levels only — a barista
 * sees no prices. One request per change for the whole screen, never one per tile, and only a
 * hint: nothing here ever blocks a sale.
 */
export function useStockAlerts(enabled = true): StockAlertsView | null {
  const { version, can, business } = useHub();
  const allowed = enabled && business === 'cafe' && can('catalog.view');
  const { data } = useLive(
    () => (allowed ? fetchJson<StockAlertsView>('/api/stock/alerts').catch(() => null) : Promise.resolve(null)),
    [allowed],
    version,
  );
  return allowed ? (data ?? null) : null;
}

export interface StockTileHint {
  level: StockAlertLevel;
  /** «закончилось: молоко» / «мало: стакан 0,3». */
  text: string;
}

/** productId → the hint for its POS tile. */
export function useStockHints(enabled = true): ReadonlyMap<string, StockTileHint> {
  const alerts = useStockAlerts(enabled);
  return useMemo(() => new Map((alerts?.products ?? []).map((p) => [p.productId, { level: p.level, text: stockHint(p) }])), [alerts]);
}
