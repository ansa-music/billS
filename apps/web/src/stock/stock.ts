import type { IngredientUnit, IngredientsView, IngredientView, Minor } from '@bills/domain';
import { formatMoney, formatQty, toMilli } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { useHub, useLive } from '../useHub.tsx';

/**
 * Shared bits of «Склад» (packages/domain stock.ts): loading the ingredients, typing
 * quantities («1,5», «1 500») and prices the way people think of them — per kilogram,
 * per litre or per piece — while the HUB keeps a cost per gram, millilitre or piece.
 */

/** Lines «Докупить на неделю» hands to the delivery form: what to buy and roughly for how much. */
export type SupplyDraft = Array<{ ingredientId: string; quantity: number; approx: Minor | null }>;

export function useIngredients() {
  const { version } = useHub();
  return useLive(() => fetchJson<IngredientsView>('/api/stock/ingredients'), [], version);
}

/** «1,5» / «1 500» / «2.25» → number; null when it is not a number ≥ 0. Empty → null. */
export function parseQty(text: string): number | null {
  const cleaned = text.replace(/[\s ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

/** A number for an input: «18,5». */
export function qtyText(n: number): string {
  return String(Math.round(n * 1000) / 1000).replace('.', ',');
}

/** How many units a price is typed for: a kilogram of grams, a litre of millilitres, one piece. */
export function packOf(unit: IngredientUnit): { size: number; label: string } {
  if (unit === 'г') return { size: 1000, label: 'кг' };
  if (unit === 'мл') return { size: 1000, label: 'л' };
  return { size: 1, label: 'шт' };
}

/** Cost per unit (minor) → «12 000 ₸ / кг». */
export function packPrice(costPerUnit: Minor | null, unit: IngredientUnit, currency: string): string {
  if (costPerUnit === null) return 'цена не известна';
  const pack = packOf(unit);
  return `${formatMoney(costPerUnit * pack.size, currency)} / ${pack.label}`;
}

/** Quantity with its unit, big amounts of grams and millilitres in kilograms and litres too. */
export function qtyLabel(quantity: number, unit: IngredientUnit): string {
  return formatQty(quantity, unit);
}

/** Money of a quantity at a cost per unit, rounded; null without a cost. */
export function valueOf(quantity: number, costPerUnit: Minor | null): Minor | null {
  if (costPerUnit === null) return null;
  return Math.round((toMilli(quantity) * costPerUnit) / 1000);
}

/** «хватит на 3 дня» / «закончилось» / null. */
export function daysLabel(i: IngredientView): string | null {
  if (i.quantity <= 0) return i.quantity < 0 ? 'ушло в минус' : 'закончилось';
  if (i.daysLeft === null) return null;
  if (i.daysLeft === 0) return 'меньше чем на день';
  return `хватит на ${i.daysLeft} ${plural(i.daysLeft, 'день', 'дня', 'дней')}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Case-insensitive search by any word of the name. */
export function matches(name: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase('ru');
  if (!q) return true;
  return name.toLocaleLowerCase('ru').includes(q);
}

export function byName<T extends { name: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
