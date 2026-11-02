import type { IngredientUnit, PurchaseListView, Recipe, StockAlertsView } from '@bills/domain';
import { fromMilli, ingredientPurchaseList, stockAlerts, STOCK_USAGE_DAYS } from '@bills/domain';
import type { Db } from './db.ts';
import { all, one } from './db.ts';
import type { Hub } from './hub.ts';
import type { RecipeRow } from './stock.ts';
import { toRecipe } from './stock.ts';

/**
 * Two reads on top of «Склад» (packages/domain stock-reports.ts): «Докупить на неделю» for senior
 * staff, and «Заканчивается» for everyone at the counter (the POS tile hints, the barista's strip).
 * Archived ingredients are left out of both; deleted ones are gone from the table anyway.
 */

const DAY = 24 * 60 * 60 * 1000;

/**
 * «Докупить на неделю»: for every active ingredient ⌈use per day × 7 + minimum − stock⌉ at the pace
 * the levels already show («хватит на N дней», the last two weeks of sales — fewer days for a new
 * coffee shop), rounded the way it is bought, with the approximate cost at the average price.
 */
export function purchaseList(hub: Hub): PurchaseListView {
  const active = hub.stock.ingredients().ingredients.filter((i) => !i.isArchived);
  return ingredientPurchaseList(
    active.map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      quantity: i.quantity,
      minLevel: i.minLevel,
      costPerUnit: i.costPerUnit,
      perDay: i.perDay,
    })),
    usageDays(hub.db, hub.clock.now()),
  );
}

/** The days the use per day is averaged over (as StockService.ingredients counts them). */
function usageDays(db: Db, now: number): number {
  const first = one<{ at: number | null }>(db, "SELECT MIN(at) AS at FROM stock_movements WHERE kind = 'sale'")?.at ?? null;
  return first === null ? 1 : Math.min(STOCK_USAGE_DAYS, Math.max(1, Math.ceil((now - first) / DAY)));
}

/**
 * What runs out, for everyone at the counter: names and levels only — no prices. Cheap on purpose
 * (every POS and barista screen reads it after each change): two small queries, no history.
 */
export function stockAlertsOf(db: Db): StockAlertsView {
  const ingredients = all<{ id: string; name: string; unit: IngredientUnit; quantity: number; min_level: number | null }>(
    db,
    'SELECT id, name, unit, quantity, min_level FROM ingredients WHERE is_archived = 0',
  );
  const byProduct = new Map<string, RecipeRow[]>();
  for (const r of all<RecipeRow>(
    db,
    `SELECT ri.* FROM recipe_items ri JOIN products p ON p.id = ri.product_id
     WHERE p.is_active = 1 ORDER BY ri.product_id, ri.sort_order, ri.id`,
  )) {
    const list = byProduct.get(r.product_id);
    if (list) list.push(r);
    else byProduct.set(r.product_id, [r]);
  }
  const recipes = new Map<string, Recipe>([...byProduct].map(([productId, rows]) => [productId, toRecipe(rows)]));
  return stockAlerts(
    ingredients.map((i) => ({
      id: i.id,
      name: i.name,
      unit: i.unit,
      quantity: fromMilli(i.quantity),
      minLevel: i.min_level === null ? null : fromMilli(i.min_level),
    })),
    recipes,
  );
}
