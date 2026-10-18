import { useCallback, useEffect, useState } from 'react';
import type { CatalogView, CategoryView, ProductView } from '@bills/domain';
import { fetchJson } from '../../api.ts';
import { useHub } from '../../useHub.tsx';

/**
 * The club's menu, inactive rows included. Loaded on mount and again on every
 * HUB state change (catalog edits raise a `catalog` change event, so the
 * waiter's screen follows the admin's edits live).
 */
export function useCatalog(): {
  catalog: CatalogView | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const { state } = useHub();
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setCatalog(await fetchJson<CatalogView>('/api/bar/catalog'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, state]);

  return { catalog, error, reload };
}

/** Categories by sort order, then products by category order and their own order. */
export function sortCatalog(catalog: CatalogView): { categories: CategoryView[]; products: ProductView[] } {
  const categories = [...catalog.categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ru'));
  const rank = new Map(categories.map((c, i) => [c.id, i]));
  const products = [...catalog.products].sort(
    (a, b) =>
      (rank.get(a.categoryId) ?? 0) - (rank.get(b.categoryId) ?? 0) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name, 'ru'),
  );
  return { categories, products };
}

/** Products a waiter may sell right now: active, in an active category. */
export function sellable(catalog: CatalogView): ProductView[] {
  const active = new Set(catalog.categories.filter((c) => c.isActive).map((c) => c.id));
  return sortCatalog(catalog).products.filter((p) => p.isActive && active.has(p.categoryId));
}
