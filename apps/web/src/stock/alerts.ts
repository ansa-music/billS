import { useMemo } from 'react';
import type { StockAlertsView } from '@bills/domain';
import { hintName } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { useHub, useLive } from '../useHub.tsx';

/**
 * «Заканчивается» for the staff (GET /api/stock/alerts, catalog.view): which raw materials ran
 * out or are below their minimum, and which products they hold up. Names and levels only — a
 * barista sees no prices. Only a hint: nothing here ever blocks a sale.
 */
export function useStockAlerts(enabled = true): StockAlertsView | null {
  const { version, canNow } = useHub();
  const allowed = enabled && canNow('catalog.view');
  const { data } = useLive(
    () => (allowed ? fetchJson<StockAlertsView>('/api/stock/alerts').catch(() => null) : Promise.resolve(null)),
    [allowed],
    version,
  );
  return data ?? null;
}

/** productId → «мало: молоко 3,2%» for the POS tiles. */
export function useStockHints(enabled = true): ReadonlyMap<string, string> {
  const alerts = useStockAlerts(enabled);
  return useMemo(
    () => new Map((alerts?.products ?? []).map((p) => [p.productId, `мало: ${p.out.map(hintName).join(', ')}`])),
    [alerts],
  );
}
