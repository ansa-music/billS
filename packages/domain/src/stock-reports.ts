import type { PaymentMethod } from './billing.ts';
import type { Minor } from './money.ts';
import type { IngredientUnit, Recipe } from './stock.ts';
import { averageCost, costOf, fromMilli, marginPercent, recipeUsage, toMilli } from './stock.ts';
import { STOCK_BUY_DAYS } from './stock-forecast.ts';
import { zonedParts } from './time.ts';

/**
 * Reports on top of «Склад» and the sales of a coffee shop: what to buy for the week, which raw
 * materials are running out (for the staff, without money), the cost of what was sold and the
 * gross profit, and what sells. The HUB gathers the numbers (apps/hub stock-reports.ts,
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
  /** Average use per day by sales over the last days (IngredientView.perDay); null — no sales yet. */
  perDay: number | null;
}

export interface PurchaseLine {
  ingredientId: string;
  name: string;
  unit: IngredientUnit;
  quantity: number;
  minLevel: number | null;
  /** Average use per day, units (to the thousandth); 0 — no sales. */
  perDay: number;
  /** What to buy, units: purchaseNeed rounded up the way it is bought (roundPurchase). */
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

/** need = max(0, ⌈use per day × days + minimum − stock⌉) in whole units (г, мл, шт). */
export function purchaseNeed(perDay: number, minLevel: number | null, quantity: number, days: number = STOCK_BUY_DAYS): number {
  const milli = toMilli(perDay) * days + toMilli(minLevel ?? 0) - toMilli(quantity);
  if (milli <= 0) return 0;
  return Math.ceil(milli / 1000);
}

/**
 * An amount the way it is bought: pieces whole; grams and millilitres up to 10 below a kilogram
 * or a litre, up to 100 (0,1 кг, 0,1 л) from there — «3 417 мл» becomes «3,5 л».
 */
export function roundPurchase(need: number, unit: IngredientUnit): number {
  if (need <= 0) return 0;
  const step = unit === 'шт' || need < 100 ? 1 : need < 1000 ? 10 : 100;
  return Math.ceil(need / step) * step;
}

/**
 * What to buy for `days` at the pace of the last `usageDays` days of sales; only lines with
 * something to buy, by name. The caller passes active ingredients only (no archived or deleted ones).
 */
export function ingredientPurchaseList(items: readonly PurchaseInput[], usageDays: number, days: number = STOCK_BUY_DAYS): PurchaseListView {
  const lines: PurchaseLine[] = [];
  for (const i of items) {
    const perDay = i.perDay !== null && i.perDay > 0 ? i.perDay : 0;
    const need = roundPurchase(purchaseNeed(perDay, i.minLevel, i.quantity, days), i.unit);
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
    usageDays: Math.max(1, usageDays),
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
}

export type StockAlertLevel = 'out' | 'low';

/** GET /api/stock/alerts — for everyone at the counter: names and levels, no prices or sums. */
export interface StockAlertsView {
  /** Raw materials at or below zero («закончилось»), or below their minimum («мало»); the ones at zero first. */
  low: Array<{ id: string; name: string; unit: IngredientUnit; quantity: number; out: boolean }>;
  /**
   * Products whose plain portion takes such a raw material: `out` when one is at zero, else `low`;
   * `names` — those raw materials. A hint only: the sale is never refused.
   */
  products: Array<{ productId: string; level: StockAlertLevel; names: string[] }>;
}

/**
 * Which raw materials run out and which products they hold up. A raw material counts when it is
 * at or below zero (and some recipe uses it or it has a minimum), or below its minimum. The caller
 * passes active ingredients only and the recipes of active products.
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
  const state = new Map<string, { name: string; out: boolean }>();
  const low: StockAlertsView['low'] = [];
  for (const i of ingredients) {
    const q = toMilli(i.quantity);
    const out = q <= 0;
    if (out ? !(used.has(i.id) || i.minLevel !== null) : !(i.minLevel !== null && q < toMilli(i.minLevel))) continue;
    state.set(i.id, { name: i.name, out });
    low.push({ id: i.id, name: i.name, unit: i.unit, quantity: i.quantity, out });
  }
  low.sort((a, b) => Number(b.out) - Number(a.out) || a.name.localeCompare(b.name, 'ru'));
  const products: StockAlertsView['products'] = [];
  for (const [productId, recipe] of recipes) {
    const hit = recipeUsage(recipe)
      .map((l) => state.get(l.ingredientId))
      .filter((s): s is { name: string; out: boolean } => s !== undefined);
    if (hit.length === 0) continue;
    const out = hit.filter((s) => s.out);
    products.push({ productId, level: out.length ? 'out' : 'low', names: (out.length ? out : hit).map((s) => s.name) });
  }
  return { low, products };
}

/** «молоко 3,2%» for a hint next to a product: the name with a small first letter. */
export function hintName(name: string): string {
  return name ? name.charAt(0).toLocaleLowerCase('ru') + name.slice(1) : name;
}

/** «закончилось: молоко» / «мало: молоко, стакан 0,3» for a POS tile. */
export function stockHint(p: { level: StockAlertLevel; names: readonly string[] }): string {
  return `${p.level === 'out' ? 'закончилось' : 'мало'}: ${p.names.map(hintName).join(', ')}`;
}

// ── Periods ─────────────────────────────────────────────────────────────────

/** A report covers whole local days, `from` to `to` inclusive (YYYY-MM-DD). */
export interface ReportRange {
  from: string;
  to: string;
}

/** Longest period one report covers, days. */
export const REPORT_MAX_DAYS = 366;

// ── The cost of what left the stock, as the deliveries stand now ────────────

/**
 * One delivery of one ingredient, for `costsAsDeliveriesStand`. `seq` values are stock movement
 * ids: they order deliveries, their deletions or corrections and the uses of the ingredient.
 */
export interface DeliveryReceipt {
  /** Its first «Поставка» movement. */
  seq: number;
  /** Level of the ingredient just before it, units (as the HUB recorded it). */
  stockBefore: number;
  /** What it added when it was received, units (0 — a line added by a correction later). */
  received: number;
  /** The price just before it, minor per unit; undefined — not known (kept by an older HUB). */
  costBefore: Minor | null | undefined;
  /** Its lines of this ingredient as they stand now, in order; none when it was deleted. */
  lines: ReadonlyArray<{ quantity: number; amount: Minor }>;
  /** Its last deletion or correction touching this ingredient; null — never changed. */
  changedSeq: number | null;
}

/** Something that took the ingredient off (or put it back): a sale, a write-off, a count difference. */
export interface StockUse {
  seq: number;
  /** Signed change of the level, units. */
  quantity: number;
  /** Value the HUB recorded at the moment (at the price it had then); null without a price. */
  cost: Minor | null;
}

/**
 * The value of each use at the price the ingredient had then **as the deliveries stand now**.
 * The HUB records a use at the price of the moment; a delivery deleted or corrected afterwards
 * gives the price back from then on (deleteSupply, updateSupply), but the uses made while it was
 * wrong keep the wrong price. Those — between such a delivery and its last deletion or correction
 * — are valued again: the deliveries from there on are replayed with their lines as they are now
 * (a deleted one adds nothing, a corrected one its new lines, the level shifted by the difference)
 * from the price just before the first of them. Every other use keeps the value the HUB recorded.
 * When that starting price is not known, the uses keep their recorded value too.
 * Returns the values in the order of `uses`.
 */
export function costsAsDeliveriesStand(receipts: readonly DeliveryReceipt[], uses: readonly StockUse[]): Array<Minor | null> {
  type Event = { seq: number; order: number } & (
    | { kind: 'receipt'; r: DeliveryReceipt }
    | { kind: 'fixed'; r: DeliveryReceipt }
    | { kind: 'use'; index: number }
  );
  const events: Event[] = [];
  for (const r of receipts) {
    events.push({ seq: r.seq, order: 0, kind: 'receipt', r });
    if (r.changedSeq !== null && r.changedSeq > r.seq) events.push({ seq: r.changedSeq, order: 1, kind: 'fixed', r });
  }
  uses.forEach((u, index) => events.push({ seq: u.seq, order: 2, kind: 'use', index }));
  events.sort((a, b) => a.seq - b.seq || a.order - b.order);

  const out: Array<Minor | null> = uses.map((u) => u.cost);
  const pending = new Set<DeliveryReceipt>();
  /** The replayed price; undefined — the recorded one is right. */
  let price: Minor | null | undefined;
  /** How far the replayed level is from the recorded one, thousandths. */
  let shift = 0;
  let unknown = false;
  for (const e of events) {
    if (e.kind === 'receipt') {
      const r = e.r;
      const changed = r.changedSeq !== null && r.changedSeq > r.seq;
      if (changed) pending.add(r);
      if (pending.size === 0 || unknown) continue;
      const base = price !== undefined ? price : r.costBefore;
      if (base === undefined) {
        unknown = true;
        continue;
      }
      let cost: Minor | null = base;
      let stock = toMilli(r.stockBefore) + shift;
      for (const line of r.lines) {
        if (line.amount > 0) cost = averageCost(fromMilli(stock), cost, line.quantity, line.amount);
        stock += toMilli(line.quantity);
      }
      if (changed) shift += r.lines.reduce((s, l) => s + toMilli(l.quantity), 0) - toMilli(r.received);
      price = cost;
    } else if (e.kind === 'fixed') {
      pending.delete(e.r);
      // Every wrong delivery is put right: from here the HUB's own price and level are right again.
      if (pending.size === 0) {
        price = undefined;
        shift = 0;
        unknown = false;
      }
    } else if (pending.size > 0 && !unknown && price !== undefined) {
      out[e.index] = costOf(uses[e.index]!.quantity, price);
    }
  }
  return out;
}

// ── «Себестоимость и прибыль» ───────────────────────────────────────────────

export interface ProfitProductInput {
  productId: string;
  name: string;
  qty: number;
  revenue: Minor;
  /** Units sold in orders that took nothing off the stock (sold before the recipe, or without one). */
  qtyWithoutRecipe: number;
}

export interface ProfitCostInput {
  productId: string;
  /** Cost of what its sales took off the stock. */
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
  /** null — no recipe: the cost is not known. */
  cost: Minor | null;
  profit: Minor | null;
  /** Whole percent of the revenue; null without a cost or a revenue. */
  margin: number | null;
  /** «нет состава»: none of these sales took anything off the stock. */
  noRecipe: boolean;
  /** Some of these sales were made without a recipe: cost and profit cover only the rest. */
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
  /** Sum of the orders of the period (cancelled ones excluded), as «Выручка» counts it. */
  revenue: Minor;
  /** What the sales of the period took off the stock, at the prices of the day (costsAsDeliveriesStand). */
  cost: Minor;
  /** revenue − cost. */
  profit: Minor;
  margin: number | null;
  /** Revenue of products sold without a recipe: their cost is not in `cost`. */
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
  /** Best profit first; products without a recipe at the end by revenue. */
  lines: ProfitLine[];
}

/** Revenue of the units sold with a recipe: part of the units sold without one are left out. */
function coveredRevenue(p: ProfitProductInput): Minor {
  if (p.qtyWithoutRecipe <= 0 || p.qty <= 0) return p.revenue;
  return Math.round((p.revenue * Math.max(0, p.qty - p.qtyWithoutRecipe)) / p.qty);
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
  let revenueWithoutRecipe = 0;
  const lines: ProfitLine[] = input.products
    .filter((p) => p.qty > 0 || p.revenue > 0)
    .map((p) => {
      const c = costs.get(p.productId);
      const noRecipe = !c && p.qtyWithoutRecipe >= p.qty;
      const cost = noRecipe ? null : (c?.cost ?? 0);
      const covered = noRecipe ? p.revenue : coveredRevenue(p);
      revenueWithoutRecipe += p.revenue - (noRecipe ? 0 : covered);
      const profit = cost === null ? null : covered - cost;
      return {
        productId: p.productId,
        name: p.name,
        qty: p.qty,
        revenue: p.revenue,
        cost,
        profit,
        margin: cost === null ? null : marginPercent(covered, cost),
        noRecipe,
        partlyWithoutRecipe: !noRecipe && p.qtyWithoutRecipe > 0,
        costIncomplete: c?.incomplete === true,
      };
    });
  // The costs belong to the orders of the period, so they add up with the revenue.
  const cost = input.costs.reduce((s, c) => s + c.cost, 0);
  const revenue = input.products.reduce((s, p) => s + p.revenue, 0);
  const profit = revenue - cost;

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
    productsWithoutRecipe: lines.filter((l) => l.noRecipe).length,
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
