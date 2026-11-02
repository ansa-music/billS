import type { PaymentMethod } from './billing.ts';
import type { Minor } from './money.ts';
import type { IngredientUnit, Recipe } from './stock.ts';
import { costOf, fromMilli, marginPercent, recipeUsage, toMilli } from './stock.ts';
import { STOCK_BUY_DAYS } from './stock-forecast.ts';
import { zonedParts } from './time.ts';

/**
 * Reports on top of «Склад» and sales of a coffee shop: what to buy for the week, which
 * raw materials are running out (for the staff, without money), cost of goods sold and
 * gross profit, and what sells. The HUB gathers the numbers (apps/hub stock.ts,
 * reports.ts); the arithmetic is here so it is the same everywhere and tested once.
 */

// ── «Докупить на неделю» ────────────────────────────────────────────────────

export interface PurchaseInput {
  id: string;
  name: string;
  unit: IngredientUnit;
  /** In stock now, units (may be below zero). */
  quantity: number;
  minLevel: number | null;
  costPerUnit: Minor | null;
  /** Used by sales (sales minus cancellations) over the usage window, units. */
  used: number;
}

export interface PurchaseLine {
  ingredientId: string;
  name: string;
  unit: IngredientUnit;
  quantity: number;
  minLevel: number | null;
  /** Average use per day, units (to the thousandth); 0 — no sales. */
  perDay: number;
  /** What to buy: ⌈per day × days + minimum − stock⌉, whole units. */
  need: number;
  costPerUnit: Minor | null;
  /** Approximate cost of `need` at the average price; null without a price. */
  cost: Minor | null;
}

/** GET /api/stock/purchase */
export interface PurchaseListView {
  /** Days the list covers (7). */
  days: number;
  /** Days of sales the pace is taken from (up to 14; fewer for a new coffee shop). */
  usageDays: number;
  lines: PurchaseLine[];
  /** Sum of the known line costs. */
  total: Minor;
  /** Lines without a price: `total` is without them. */
  unpriced: number;
}

/** need = max(0, ⌈usage per day × days + min level − stock⌉). */
export function purchaseNeed(perDay: number, minLevel: number | null, quantity: number, days: number = STOCK_BUY_DAYS): number {
  const milli = toMilli(perDay) * days + toMilli(minLevel ?? 0) - toMilli(quantity);
  if (milli <= 0) return 0;
  return Math.ceil(milli / 1000);
}

/** What to buy for `days` at the pace of the last `usageDays` days; only lines with something to buy, by name. */
export function ingredientPurchaseList(items: readonly PurchaseInput[], usageDays: number, days: number = STOCK_BUY_DAYS): PurchaseListView {
  const window = Math.max(1, usageDays);
  const lines: PurchaseLine[] = [];
  for (const i of items) {
    const perDay = i.used > 0 ? fromMilli(Math.round(toMilli(i.used) / window)) : 0;
    const need = purchaseNeed(perDay, i.minLevel, i.quantity, days);
    if (need <= 0) continue;
    lines.push({
      ingredientId: i.id,
      name: i.name,
      unit: i.unit,
      quantity: i.quantity,
      minLevel: i.minLevel,
      perDay,
      need,
      costPerUnit: i.costPerUnit,
      cost: costOf(need, i.costPerUnit),
    });
  }
  lines.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return {
    days,
    usageDays: window,
    lines,
    total: lines.reduce((s, l) => s + (l.cost ?? 0), 0),
    unpriced: lines.filter((l) => l.cost === null).length,
  };
}

// ── «Заканчивается» for the staff ───────────────────────────────────────────

export interface StockAlertInput {
  id: string;
  name: string;
  unit: IngredientUnit;
  quantity: number;
  minLevel: number | null;
  isArchived: boolean;
}

/** GET /api/stock/alerts — for everyone at the counter: no prices or sums. */
export interface StockAlertsView {
  /** Raw materials at or below zero, or below their minimum; those at zero first. */
  low: Array<{ id: string; name: string; unit: IngredientUnit; quantity: number; out: boolean }>;
  /** Products whose plain portion takes a raw material that is at or below zero. */
  products: Array<{ productId: string; out: string[] }>;
}

/**
 * Which raw materials run out and which products they hold up. A raw material counts when
 * it is at or below zero (and some recipe uses it or it has a minimum), or below its minimum.
 */
export function stockAlerts(ingredients: readonly StockAlertInput[], recipes: ReadonlyMap<string, Recipe>): StockAlertsView {
  const used = new Set<string>();
  for (const r of recipes.values()) {
    for (const l of r.items) used.add(l.ingredientId);
    for (const o of r.options) {
      used.add(o.ingredientId);
      if (o.replacesId) used.add(o.replacesId);
    }
  }
  const active = ingredients.filter((i) => !i.isArchived);
  const out = new Map(active.filter((i) => toMilli(i.quantity) <= 0).map((i) => [i.id, i]));
  const low = active
    .filter((i) => {
      const q = toMilli(i.quantity);
      if (q <= 0) return used.has(i.id) || i.minLevel !== null;
      return i.minLevel !== null && q < toMilli(i.minLevel);
    })
    .map((i) => ({ id: i.id, name: i.name, unit: i.unit, quantity: i.quantity, out: toMilli(i.quantity) <= 0 }))
    .sort((a, b) => Number(b.out) - Number(a.out) || a.name.localeCompare(b.name, 'ru'));
  const products: StockAlertsView['products'] = [];
  for (const [productId, recipe] of recipes) {
    const names = recipeUsage(recipe)
      .map((l) => out.get(l.ingredientId)?.name)
      .filter((n): n is string => n !== undefined);
    if (names.length) products.push({ productId, out: names });
  }
  return { low, products };
}

/** «молоко 3,2%» for a hint next to a product: the name with a small first letter. */
export function hintName(name: string): string {
  return name ? name.charAt(0).toLocaleLowerCase('ru') + name.slice(1) : name;
}

// ── Periods ─────────────────────────────────────────────────────────────────

/** A report covers whole local days, `from` to `to` inclusive (YYYY-MM-DD). */
export interface ReportRange {
  from: string;
  to: string;
}

/** Longest period one report covers, days. */
export const REPORT_MAX_DAYS = 366;

// ── «Себестоимость и прибыль» ───────────────────────────────────────────────

export interface ProfitProductInput {
  productId: string;
  name: string;
  qty: number;
  revenue: Minor;
  /** Units sold in orders that took nothing off the stock (sold before the тех. карта, or without one). */
  qtyWithoutRecipe: number;
}

export interface ProfitCostInput {
  productId: string;
  /** Cost of what the sales took, minus what their cancellations gave back; ≥ 0 normally. */
  cost: Minor;
  /** Some ingredient had no price when it was sold: the cost is too low. */
  incomplete: boolean;
}

export interface LossInput {
  kind: 'writeoff' | 'inventory';
  ingredientId: string;
  name: string;
  unit: IngredientUnit;
  /** Signed change of the stock, units (a write-off is below zero, a surplus above). */
  quantity: number;
  /** Signed value of the change; null without a price. */
  cost: Minor | null;
}

export interface ProfitLine {
  productId: string;
  name: string;
  qty: number;
  revenue: Minor;
  /** null — no тех. карта: the cost is not known. */
  cost: Minor | null;
  profit: Minor | null;
  /** Whole percent of the revenue; null without a cost or a revenue. */
  margin: number | null;
  /** «нет тех. карты»: none of these sales took anything off the stock. */
  noRecipe: boolean;
  /** Some of these sales were made without a тех. карта: cost and profit cover only the rest. */
  partlyWithoutRecipe: boolean;
  /** Some ingredient had no price: the cost is too low. */
  costIncomplete: boolean;
}

export interface LossLine {
  kind: 'writeoff' | 'inventory';
  ingredientId: string;
  name: string;
  unit: IngredientUnit;
  quantity: number;
  /** Money lost: above zero a loss, below zero a surplus (inventory); null without a price. */
  loss: Minor | null;
}

/** GET /api/reports/profit?from&to */
export interface ProfitReport extends ReportRange {
  generatedAt: number;
  timezone: string;
  currency: string;
  /** Sum of the orders of the period (cancelled ones excluded), like «Выручка». */
  revenue: Minor;
  /** Cost of goods sold by the тех. карты: what the sales took off the stock minus cancellations. */
  cost: Minor;
  /** revenue − cost. */
  profit: Minor;
  margin: number | null;
  /** Revenue of products sold without a тех. карта: their cost is not in `cost`. */
  revenueWithoutRecipe: Minor;
  productsWithoutRecipe: number;
  costIncomplete: boolean;
  losses: {
    /** Written off, at cost. */
    writeOff: Minor;
    /** Inventory counts: shortage (a loss) and surplus, at cost. */
    shortage: Minor;
    surplus: Minor;
    /** writeOff + shortage − surplus. */
    total: Minor;
    /** Lines without a price: their loss is not counted. */
    unpriced: number;
    lines: LossLine[];
  };
  /** profit − losses.total. */
  profitAfterLosses: Minor;
  /** Best profit first; products without a тех. карта at the end by revenue. */
  lines: ProfitLine[];
}

export function buildProfitReport(input: {
  range: ReportRange;
  generatedAt: number;
  timezone: string;
  currency: string;
  products: readonly ProfitProductInput[];
  costs: readonly ProfitCostInput[];
  losses: readonly LossInput[];
}): ProfitReport {
  const costs = new Map(input.costs.map((c) => [c.productId, c]));
  const lines: ProfitLine[] = input.products
    .filter((p) => p.qty > 0 || p.revenue > 0)
    .map((p) => {
      const c = costs.get(p.productId);
      const noRecipe = !c && p.qtyWithoutRecipe >= p.qty;
      const cost = noRecipe ? null : (c?.cost ?? 0);
      // Revenue of the sales the cost covers: part of the units sold without a card are left out.
      const covered = noRecipe || p.qtyWithoutRecipe <= 0 || p.qty <= 0 ? p.revenue : Math.round((p.revenue * (p.qty - p.qtyWithoutRecipe)) / p.qty);
      const profit = cost === null ? null : covered - cost;
      return {
        productId: p.productId,
        name: p.name,
        qty: p.qty,
        revenue: p.revenue,
        cost,
        profit,
        margin: cost === null || profit === null ? null : marginPercent(covered, cost),
        noRecipe,
        partlyWithoutRecipe: !noRecipe && p.qtyWithoutRecipe > 0,
        costIncomplete: c?.incomplete === true,
      };
    });
  // The costs belong to the orders of the period, so they add up with the revenue.
  const cost = input.costs.reduce((s, c) => s + c.cost, 0);
  const revenue = input.products.reduce((s, p) => s + p.revenue, 0);
  const profit = revenue - cost;
  const withoutRecipe = lines.filter((l) => l.noRecipe);
  const revenueWithoutRecipe =
    withoutRecipe.reduce((s, l) => s + l.revenue, 0) +
    lines.filter((l) => l.partlyWithoutRecipe).reduce((s, l) => {
      const p = input.products.find((x) => x.productId === l.productId)!;
      return s + (p.revenue - Math.round((p.revenue * (p.qty - p.qtyWithoutRecipe)) / p.qty));
    }, 0);

  const lossBy = new Map<string, LossLine>();
  let writeOff = 0;
  let shortage = 0;
  let surplus = 0;
  let unpriced = 0;
  for (const l of input.losses) {
    const key = `${l.kind}\n${l.ingredientId}`;
    const line = lossBy.get(key) ?? { kind: l.kind, ingredientId: l.ingredientId, name: l.name, unit: l.unit, quantity: 0, loss: 0 };
    line.quantity = fromMilli(toMilli(line.quantity) + toMilli(l.quantity));
    if (l.cost === null) {
      line.loss = null;
      unpriced++;
    } else {
      if (line.loss !== null) line.loss += -l.cost;
      if (l.kind === 'writeoff') writeOff += -l.cost;
      else if (l.cost < 0) shortage += -l.cost;
      else surplus += l.cost;
    }
    lossBy.set(key, line);
  }
  const lossLines = [...lossBy.values()]
    .filter((l) => toMilli(l.quantity) !== 0)
    .sort((a, b) => (b.loss ?? 0) - (a.loss ?? 0) || a.name.localeCompare(b.name, 'ru'));
  const total = writeOff + shortage - surplus;

  lines.sort((a, b) => {
    if (a.noRecipe !== b.noRecipe) return a.noRecipe ? 1 : -1;
    if (a.noRecipe) return b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru');
    return (b.profit ?? 0) - (a.profit ?? 0) || b.revenue - a.revenue || a.name.localeCompare(b.name, 'ru');
  });

  return {
    from: input.range.from,
    to: input.range.to,
    generatedAt: input.generatedAt,
    timezone: input.timezone,
    currency: input.currency,
    revenue,
    cost,
    profit,
    margin: marginPercent(revenue, cost),
    revenueWithoutRecipe,
    productsWithoutRecipe: withoutRecipe.length,
    costIncomplete: lines.some((l) => l.costIncomplete),
    losses: { writeOff, shortage, surplus, total, unpriced, lines: lossLines },
    profitAfterLosses: profit - total,
    lines,
  };
}

// ── «Что продаётся» ─────────────────────────────────────────────────────────

export interface SalesItemInput {
  productId: string;
  name: string;
  qty: number;
  revenue: Minor;
}

export interface SalesOrderInput {
  at: number;
  total: Minor;
}

export interface SalesTopLine {
  productId: string;
  name: string;
  qty: number;
  revenue: Minor;
  /** Share of the period's revenue, whole percent. */
  share: number;
}

/** GET /api/reports/sales?from&to */
export interface SalesReport extends ReportRange {
  generatedAt: number;
  timezone: string;
  currency: string;
  /** Orders of the period (cancelled excluded) and their sum. */
  orders: number;
  revenue: Minor;
  /** Units sold. */
  items: number;
  /** Checks paid in full in the period, and what was paid for them (after discounts and refunds). */
  checks: number;
  avgCheck: Minor;
  /** Money taken in the period by payment method, refunds subtracted. */
  byMethod: Record<PaymentMethod, Minor>;
  /** 24 local hours: orders and their sum. */
  byHour: Array<{ hour: number; orders: number; revenue: Minor }>;
  /** Most units first. */
  topByQty: SalesTopLine[];
  /** Most revenue first. */
  topByRevenue: SalesTopLine[];
}

/** Lines in each top list. */
export const SALES_TOP = 10;

export function buildSalesReport(input: {
  range: ReportRange;
  generatedAt: number;
  timezone: string;
  currency: string;
  items: readonly SalesItemInput[];
  orders: readonly SalesOrderInput[];
  checks: { count: number; paid: Minor };
  byMethod: Partial<Record<PaymentMethod, Minor>>;
}): SalesReport {
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, revenue: 0 }));
  for (const o of input.orders) {
    const h = Math.floor(zonedParts(o.at, input.timezone).minuteOfDay / 60) % 24;
    byHour[h]!.orders++;
    byHour[h]!.revenue += o.total;
  }
  const revenue = input.orders.reduce((s, o) => s + o.total, 0);
  const itemsRevenue = input.items.reduce((s, i) => s + i.revenue, 0);
  const lines = input.items
    .filter((i) => i.qty > 0)
    .map((i) => ({ ...i, share: itemsRevenue > 0 ? Math.round((i.revenue / itemsRevenue) * 100) : 0 }));
  const byName = (a: SalesTopLine, b: SalesTopLine) => a.name.localeCompare(b.name, 'ru');
  return {
    from: input.range.from,
    to: input.range.to,
    generatedAt: input.generatedAt,
    timezone: input.timezone,
    currency: input.currency,
    orders: input.orders.length,
    revenue,
    items: input.items.reduce((s, i) => s + i.qty, 0),
    checks: input.checks.count,
    avgCheck: input.checks.count > 0 ? Math.round(input.checks.paid / input.checks.count) : 0,
    byMethod: { CASH: input.byMethod.CASH ?? 0, CARD: input.byMethod.CARD ?? 0, QR: input.byMethod.QR ?? 0 },
    byHour,
    topByQty: [...lines].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue || byName(a, b)).slice(0, SALES_TOP),
    topByRevenue: [...lines].sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || byName(a, b)).slice(0, SALES_TOP),
  };
}
