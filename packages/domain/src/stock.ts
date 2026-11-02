import type { Minor } from './money.ts';

/**
 * «Склад» of a coffee shop: raw materials (сырьё — coffee beans, milk, cups), the recipe of
 * every drink (тех. карта, граммовка per one unit sold, with changes per option: size L takes
 * more milk, «Овсяное» swaps milk for oat milk), deliveries (поставки), counts (инвентаризация),
 * write-offs (списание) and a log of every movement.
 *
 * Quantities travel as plain numbers in the ingredient's unit with up to three decimals
 * (18.5 г); the HUB stores them as integer thousandths so sums never drift. Money is in
 * minor units like everywhere else; the cost of an ingredient is minor units per one unit
 * (per 1 г, 1 мл, 1 шт). Stock may go below zero: a sale is never blocked by the stock.
 */

// ── Units and quantities ────────────────────────────────────────────────────

export const INGREDIENT_UNITS = ['г', 'мл', 'шт'] as const;
export type IngredientUnit = (typeof INGREDIENT_UNITS)[number];

export const INGREDIENT_NAME_MAX = 60;
/** Quantities are kept to a thousandth of the unit (0,001 г). */
export const QTY_SCALE = 1000;
/** One line or one stock level: up to 10 000 000 units (10 t of coffee). */
export const QTY_LIMIT = 10_000_000;
/** Cost per one unit, minor units (a cup at 30 ₸ = 3000). */
export const UNIT_COST_LIMIT = 100_000_000;
export const SUPPLIER_MAX = 80;
export const STOCK_NOTE_MAX = 300;
export const WRITE_OFF_REASON_MIN = 3;
export const SUPPLY_MAX_LINES = 100;
export const RECIPE_MAX_LINES = 30;
export const RECIPE_MAX_OPTION_LINES = 120;
/** Days of sales «хватит на N дней» looks back over. */
export const STOCK_USAGE_DAYS = 14;

export function isIngredientUnit(v: unknown): v is IngredientUnit {
  return typeof v === 'string' && (INGREDIENT_UNITS as readonly string[]).includes(v);
}

/** 18.5 → 18500 (thousandths). */
export function toMilli(quantity: number): number {
  return Math.round(quantity * QTY_SCALE);
}

/** 18500 → 18.5. */
export function fromMilli(milli: number): number {
  return milli / QTY_SCALE;
}

/** A quantity as a screen sends it: finite, within the limit, `positive` → above 0, else ≥ 0. */
export function isQuantity(v: unknown, positive = false): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (v < 0 || v > QTY_LIMIT) return false;
  return positive ? toMilli(v) > 0 : true;
}

/** Value of a quantity at a unit cost, minor units, rounded; null when the cost is unknown. */
export function costOf(quantity: number, costPerUnit: Minor | null | undefined): Minor | null {
  if (costPerUnit === null || costPerUnit === undefined) return null;
  return Math.round((toMilli(quantity) * costPerUnit) / QTY_SCALE);
}

const qtyFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

/** «1 250 г», «0,5 шт», «−40 мл»: the number as people write it, with the unit. */
export function formatQty(quantity: number, unit: IngredientUnit): string {
  const text = qtyFormat.format(fromMilli(toMilli(quantity))).replace('-', '−');
  return `${text} ${unit}`;
}

/** Weighted average cost after a delivery: what is left at the old cost plus what came at its price. */
export function averageCost(
  stock: number,
  costPerUnit: Minor | null,
  delivered: number,
  amount: Minor,
): Minor {
  const d = toMilli(delivered);
  if (d <= 0) return costPerUnit ?? 0;
  const s = toMilli(stock);
  // Nothing (or less than nothing) left, or no cost known: the new price is the delivery's.
  if (s <= 0 || costPerUnit === null) return Math.round((amount * QTY_SCALE) / d);
  return Math.round((s * costPerUnit + amount * QTY_SCALE) / (s + d));
}

/**
 * The cost per unit as it would be without one delivery line — the line is deleted or corrected.
 * `stock` and `costPerUnit` are the ingredient now, `delivered` and `amount` the line. The line's
 * value comes off at its own price; a free line (amount 0) never changed the price, so it stays.
 * When nothing (or less than nothing) would be left, or the value would turn negative (the stock
 * was used and re-priced since), the price stays as it is: a guess would be worse than no change.
 */
export function costWithout(stock: number, costPerUnit: Minor | null, delivered: number, amount: Minor): Minor | null {
  if (costPerUnit === null) return null;
  if (amount <= 0) return costPerUnit;
  const s = toMilli(stock);
  const remaining = s - toMilli(delivered);
  const value = s * costPerUnit - amount * QTY_SCALE;
  if (remaining <= 0 || value <= 0) return costPerUnit;
  return Math.round(value / remaining);
}

// ── Typing amounts the way an invoice says them ─────────────────────────────

/** A unit an amount may be typed in, and how many base units (г, мл, шт) one of it is. */
export interface QtyInputUnit {
  label: string;
  factor: number;
}

/**
 * Invoices count coffee in kilograms and milk in litres, recipes in grams and millilitres:
 * the screens offer both and send the base unit (2 кг → 2 000 г).
 */
export const QTY_INPUT_UNITS: Record<IngredientUnit, readonly QtyInputUnit[]> = {
  г: [
    { label: 'г', factor: 1 },
    { label: 'кг', factor: 1000 },
  ],
  мл: [
    { label: 'мл', factor: 1 },
    { label: 'л', factor: 1000 },
  ],
  шт: [{ label: 'шт', factor: 1 }],
};

/** The unit deliveries and stock levels are usually counted in: кг, л, шт. */
export function bigUnitOf(unit: IngredientUnit): QtyInputUnit {
  const list = QTY_INPUT_UNITS[unit];
  return list[list.length - 1]!;
}

/** 1,5 (кг, factor 1000) → 1 500 (г), to the thousandth, without float drift. */
export function toBaseQty(value: number, factor: number): number {
  return fromMilli(Math.round(value * factor * QTY_SCALE));
}

/** «3 кг», «12,5 л», «850 г», «−1,5 кг», «1 200 шт»: a stock level the way people say it. */
export function formatStock(quantity: number, unit: IngredientUnit): string {
  const q = fromMilli(toMilli(quantity));
  if (unit !== 'шт' && Math.abs(q) >= 1000) {
    const big = bigUnitOf(unit);
    return `${qtyFormat.format(q / big.factor).replace('-', '−')} ${big.label}`;
  }
  return formatQty(q, unit);
}

/** «хватит на N дней»: whole days the stock lasts at `perDay`; 0 when nothing is left; null without sales. */
export function daysLeftOf(quantity: number, perDay: number | null): number | null {
  if (quantity <= 0) return 0;
  if (perDay === null || perDay <= 0) return null;
  return Math.floor(quantity / perDay);
}

// ── Recipes (тех. карты) ────────────────────────────────────────────────────

/** One ingredient of a drink for one unit sold (граммовка). */
export interface RecipeLine {
  ingredientId: string;
  quantity: number;
}

export const RECIPE_OPTION_MODES = ['add', 'set', 'swap'] as const;
/**
 * What a chosen option does to the recipe:
 *  - add  — adds `quantity` of an ingredient (syrup +20 мл, extra shot +9 г);
 *  - set  — the ingredient takes exactly `quantity` instead (size L: milk 300 мл, cup 0,4); 0 removes it;
 *  - swap — the amount of `replacesId` goes to `ingredientId` («Овсяное»: milk → oat milk);
 *           a `quantity` above 0 is taken instead of the replaced amount.
 * Sets apply first, then adds, then swaps — so «L + Овсяное» swaps the L amount of milk.
 */
export type RecipeOptionMode = (typeof RECIPE_OPTION_MODES)[number];

export const RECIPE_OPTION_MODE_LABEL: Record<RecipeOptionMode, string> = {
  add: 'добавить сверху',
  set: 'другое количество',
  swap: 'заменить одно на другое',
};

export interface RecipeOptionLine {
  /** The option choice of the product (ProductOptionChoice.id). */
  choiceId: string;
  mode: RecipeOptionMode;
  ingredientId: string;
  quantity: number;
  /** For `swap`: the ingredient of the base recipe it replaces. */
  replacesId?: string | null;
}

export interface Recipe {
  items: RecipeLine[];
  options: RecipeOptionLine[];
}

/**
 * Ingredients one unit of the product takes with the chosen option choices. Lines of
 * the same ingredient are added up; ingredients that end at 0 are left out.
 */
export function recipeUsage(recipe: Recipe, choiceIds: readonly string[] = []): RecipeLine[] {
  const amounts = new Map<string, number>();
  const bump = (id: string, milli: number) => amounts.set(id, (amounts.get(id) ?? 0) + milli);
  for (const line of recipe.items) bump(line.ingredientId, toMilli(line.quantity));
  const chosen = new Set(choiceIds);
  const lines = recipe.options.filter((o) => chosen.has(o.choiceId));
  for (const o of lines) if (o.mode === 'set') amounts.set(o.ingredientId, toMilli(o.quantity));
  for (const o of lines) if (o.mode === 'add') bump(o.ingredientId, toMilli(o.quantity));
  for (const o of lines) {
    if (o.mode !== 'swap' || !o.replacesId || o.replacesId === o.ingredientId) continue;
    const moved = amounts.get(o.replacesId) ?? 0;
    amounts.delete(o.replacesId);
    bump(o.ingredientId, toMilli(o.quantity) > 0 ? toMilli(o.quantity) : moved);
  }
  return [...amounts]
    .filter(([, milli]) => milli > 0)
    .map(([ingredientId, milli]) => ({ ingredientId, quantity: fromMilli(milli) }));
}

/**
 * What an option line does, in plain words for the recipe screen: «Молоко +100 мл»,
 * «Молоко 350 мл вместо 200 мл», «без «Сахар»», «Овсяное молоко вместо «Молоко»».
 * `ingredient` looks a name and unit up; `base` is the plain portion (for «вместо 200 мл»).
 */
export function describeOptionLine(
  line: RecipeOptionLine,
  ingredient: (id: string) => { name: string; unit: IngredientUnit } | undefined,
  base: readonly RecipeLine[] = [],
): string {
  const ing = ingredient(line.ingredientId);
  const name = ing?.name ?? '—';
  const qty = (q: number) => (ing ? formatQty(q, ing.unit) : qtyFormat.format(q));
  if (line.mode === 'add') return `${name} +${qty(line.quantity)}`;
  if (line.mode === 'set') {
    if (toMilli(line.quantity) === 0) return `без «${name}»`;
    const was = base.find((b) => b.ingredientId === line.ingredientId);
    return was ? `${name} ${qty(line.quantity)} вместо ${qty(was.quantity)}` : `${name} ${qty(line.quantity)}`;
  }
  const replaced = line.replacesId ? (ingredient(line.replacesId)?.name ?? '—') : '—';
  return `${name} вместо «${replaced}»${toMilli(line.quantity) > 0 ? `, ${qty(line.quantity)}` : ''}`;
}

/** Cost of the lines at the ingredients' costs; `complete` is false when some cost is unknown. */
export function recipeCost(
  lines: readonly RecipeLine[],
  costs: ReadonlyMap<string, Minor | null>,
): { cost: Minor; complete: boolean } {
  let cost = 0;
  let complete = true;
  for (const line of lines) {
    const c = costOf(line.quantity, costs.get(line.ingredientId) ?? null);
    if (c === null) complete = false;
    else cost += c;
  }
  return { cost, complete };
}

/** Share of the price that is margin, whole percent; null without a price. */
export function marginPercent(price: Minor, cost: Minor): number | null {
  if (price <= 0) return null;
  return Math.round(((price - cost) / price) * 100);
}

/**
 * Problems with a recipe as the editor sends it; empty = fine. `ingredientIds` are the
 * known ingredients, `choiceIds` the option choices of the product.
 */
export function validateRecipe(
  recipe: unknown,
  known: { ingredientIds: ReadonlySet<string>; choiceIds: ReadonlySet<string> },
): string[] {
  if (typeof recipe !== 'object' || recipe === null) return ['Тех. карта: неверный формат'];
  const r = recipe as Partial<Recipe>;
  const errors: string[] = [];
  const items: unknown[] = Array.isArray(r.items) ? r.items : [];
  const options: unknown[] = Array.isArray(r.options) ? r.options : [];
  if (r.items !== undefined && !Array.isArray(r.items)) errors.push('Состав: ожидается список');
  if (r.options !== undefined && !Array.isArray(r.options)) errors.push('Добавки: ожидается список');
  if (items.length > RECIPE_MAX_LINES) errors.push(`Не больше ${RECIPE_MAX_LINES} строк в составе`);
  if (options.length > RECIPE_MAX_OPTION_LINES) errors.push(`Не больше ${RECIPE_MAX_OPTION_LINES} строк для добавок`);
  const seen = new Set<string>();
  items.forEach((raw, i) => {
    const at = `Строка ${i + 1}`;
    const line = (raw ?? {}) as Partial<RecipeLine>;
    if (typeof line.ingredientId !== 'string' || !known.ingredientIds.has(line.ingredientId)) {
      errors.push(`${at}: выберите сырьё`);
      return;
    }
    if (seen.has(line.ingredientId)) errors.push(`${at}: это сырьё уже есть в составе`);
    seen.add(line.ingredientId);
    if (!isQuantity(line.quantity, true)) errors.push(`${at}: количество больше нуля`);
  });
  options.forEach((raw, i) => {
    const at = `Добавка ${i + 1}`;
    const line = (raw ?? {}) as Partial<RecipeOptionLine>;
    if (typeof line.choiceId !== 'string' || !known.choiceIds.has(line.choiceId)) {
      errors.push(`${at}: такого варианта нет у товара`);
      return;
    }
    if (!(RECIPE_OPTION_MODES as readonly string[]).includes(line.mode as string)) {
      errors.push(`${at}: неизвестное действие`);
      return;
    }
    if (typeof line.ingredientId !== 'string' || !known.ingredientIds.has(line.ingredientId)) {
      errors.push(`${at}: выберите сырьё`);
      return;
    }
    if (line.mode === 'swap') {
      if (typeof line.replacesId !== 'string' || !known.ingredientIds.has(line.replacesId)) {
        errors.push(`${at}: укажите, что заменить`);
      } else if (line.replacesId === line.ingredientId) {
        errors.push(`${at}: сырьё заменяет само себя`);
      }
      if (!isQuantity(line.quantity)) errors.push(`${at}: количество не меньше нуля`);
    } else if (!isQuantity(line.quantity, line.mode === 'add')) {
      errors.push(`${at}: ${line.mode === 'add' ? 'количество больше нуля' : 'количество не меньше нуля'}`);
    }
  });
  return errors;
}

// ── Movements ───────────────────────────────────────────────────────────────

export const STOCK_MOVEMENT_KINDS = [
  'initial',
  'sale',
  'return',
  'supply',
  'supply_undo',
  'supply_fix',
  'inventory',
  'adjust',
  'writeoff',
] as const;
/**
 * Why a stock level changed: every change leaves one movement per ingredient. The log is never
 * rewritten: a deleted delivery takes its stock back with `supply_undo`, a corrected one moves
 * the difference with `supply_fix`, a level put right by hand is an `adjust` with its reason.
 */
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

export const STOCK_MOVEMENT_LABEL: Record<StockMovementKind, string> = {
  initial: 'Начальный остаток',
  sale: 'Продажа',
  return: 'Отмена заказа',
  supply: 'Поставка',
  supply_undo: 'Поставка удалена',
  supply_fix: 'Поставка исправлена',
  inventory: 'Инвентаризация',
  adjust: 'Остаток исправлен',
  writeoff: 'Списание',
};

// ── Deleting or correcting a delivery ───────────────────────────────────────

/** Whoever entered a delivery may delete or correct it themselves for this long. */
export const SUPPLY_CHANGE_WINDOW_MS = 30 * 60 * 1000;

/**
 * May this person delete or correct this delivery now? The director and the administrator
 * (`stock.edit`) — always; the one who entered it — within SUPPLY_CHANGE_WINDOW_MS (`until`).
 * A deleted delivery is final.
 */
export function canChangeSupply(
  supply: { at: number; createdById: string | null; deletedAt: number | null },
  viewer: { id: string | null; mayEditStock: boolean },
  now: number,
): { ok: boolean; until: number | null } {
  if (supply.deletedAt !== null) return { ok: false, until: null };
  if (viewer.mayEditStock) return { ok: true, until: null };
  const until = supply.at + SUPPLY_CHANGE_WINDOW_MS;
  if (supply.createdById !== null && supply.createdById === viewer.id && now <= until) return { ok: true, until };
  return { ok: false, until: null };
}

export interface SupplyAmount {
  quantity: number;
  amount: Minor;
}

export interface SupplyChange {
  ingredientId: string;
  before: SupplyAmount;
  after: SupplyAmount;
}

/**
 * What a correction changes, per ingredient (lines of the same ingredient add up): only the
 * ingredients whose quantity or amount differ, in the order they appear (old lines first).
 */
export function supplyChanges(
  before: ReadonlyArray<{ ingredientId: string } & SupplyAmount>,
  after: ReadonlyArray<{ ingredientId: string } & SupplyAmount>,
): SupplyChange[] {
  const sums = new Map<string, { before: { q: number; a: number }; after: { q: number; a: number } }>();
  const at = (id: string) => {
    let s = sums.get(id);
    if (!s) sums.set(id, (s = { before: { q: 0, a: 0 }, after: { q: 0, a: 0 } }));
    return s;
  };
  for (const l of before) {
    const s = at(l.ingredientId).before;
    s.q += toMilli(l.quantity);
    s.a += l.amount;
  }
  for (const l of after) {
    const s = at(l.ingredientId).after;
    s.q += toMilli(l.quantity);
    s.a += l.amount;
  }
  return [...sums]
    .filter(([, s]) => s.before.q !== s.after.q || s.before.a !== s.after.a)
    .map(([ingredientId, s]) => ({
      ingredientId,
      before: { quantity: fromMilli(s.before.q), amount: s.before.a },
      after: { quantity: fromMilli(s.after.q), amount: s.after.a },
    }));
}

// ── HTTP API (HUB) ──────────────────────────────────────────────────────────

export interface IngredientView {
  id: string;
  name: string;
  unit: IngredientUnit;
  /** In stock now, in units; may be below zero (sold more than was counted). */
  quantity: number;
  /** Minor units per one unit; null — not known yet (comes with the first delivery). */
  costPerUnit: Minor | null;
  /** Warn below this; null — no warning. */
  minLevel: number | null;
  isArchived: boolean;
  /** Below the minimum or below zero. */
  low: boolean;
  /** Average use per day over the last STOCK_USAGE_DAYS days of sales; null — no sales yet. */
  perDay: number | null;
  /** «хватит на N дней» at that pace; 0 — nothing left; null — no sales yet. */
  daysLeft: number | null;
  /** Value of what is in stock at cost (never below 0); null without a cost. */
  value: Minor | null;
  /** Products whose recipe uses it. */
  usedIn: number;
  /** Something happened to it already (movements, deliveries, counts): removing it archives it. */
  hasHistory: boolean;
  /** Put in by TS as an example (the trial's sample stock): the owner changes or removes it like their own. */
  isSample: boolean;
}

/** GET /api/stock/ingredients — archived ones included (the screen hides them). */
export interface IngredientsView {
  ingredients: IngredientView[];
}

/** POST /api/stock/ingredients */
export interface CreateIngredientRequest {
  name: string;
  unit: IngredientUnit;
  /** What is in stock already (a movement «Начальный остаток»); 0 when omitted. */
  quantity?: number;
  costPerUnit?: Minor | null;
  minLevel?: number | null;
}

/** POST /api/stock/ingredients/:id/update — the unit can change only before any movement. */
export interface UpdateIngredientRequest {
  name?: string;
  unit?: IngredientUnit;
  costPerUnit?: Minor | null;
  minLevel?: number | null;
  isArchived?: boolean;
}

/**
 * GET /api/stock/ingredients/:id/removal — what «Удалить» will do: an ingredient nothing ever
 * happened to is deleted; one with history is archived (hidden from lists and pickers, the
 * history keeps its name). Recipes that use it are named: it leaves them only when asked.
 */
export interface IngredientRemovalView {
  ingredientId: string;
  name: string;
  unit: IngredientUnit;
  quantity: number;
  /** Products whose recipe uses it (also as what an option replaces). */
  recipes: Array<{ productId: string; name: string }>;
  outcome: 'delete' | 'archive';
  history: { movements: number; supplies: number; counts: number };
}

/** POST /api/stock/ingredients/:id/remove */
export interface RemoveIngredientRequest {
  /** Also take it out of the recipes that use it; without it such an ingredient is refused (409). */
  fromRecipes?: boolean;
}

export interface RemoveIngredientResponse {
  outcome: 'deleted' | 'archived';
  /** Recipes it was taken out of. */
  recipes: string[];
}

/** POST /api/stock/ingredients/:id/adjust — «Исправить остаток»: the level as it really is, with why. */
export interface AdjustStockRequest {
  /** The level after the change, in the ingredient's unit (≥ 0). */
  quantity: number;
  reason: string;
}

/** GET /api/stock/sample — the example TS put in, and what «Убрать пример» would do with it. */
export interface StockSampleView {
  ingredients: Array<{ id: string; name: string; outcome: 'delete' | 'archive' | 'keep'; why: string | null }>;
  /** Products whose sample recipe was not changed by the owner: these recipes go. */
  recipes: Array<{ productId: string; name: string }>;
}

/** POST /api/stock/sample/remove */
export interface RemoveSampleResponse {
  deleted: string[];
  archived: string[];
  kept: Array<{ name: string; why: string }>;
  recipes: string[];
}

/** GET /api/stock/setup — the first-run checklist of «Склад». */
export interface StockSetupView {
  /** Active raw materials. */
  ingredients: number;
  /** Active products of the menu. */
  products: number;
  /** Active products without a recipe: their sales take nothing off the stock. */
  withoutRecipe: Array<{ productId: string; name: string }>;
  supplies: number;
  sales: number;
}

/** GET /api/stock/recipes/:productId */
export interface RecipeView extends Recipe {
  productId: string;
  /** Cost of one portion without options; null when the recipe is empty. */
  cost: Minor | null;
  /** False when an ingredient has no cost yet: `cost` is then too low. */
  complete: boolean;
  updatedAt: number | null;
}

/** POST /api/stock/recipes/:productId — replaces the whole recipe; empty lists remove it. */
export type SetRecipeRequest = Recipe;

/** GET /api/stock/recipes — which products have a recipe and what a plain portion costs. */
export interface RecipesView {
  recipes: Array<{ productId: string; lines: number; optionLines: number; cost: Minor; complete: boolean }>;
}

export interface SupplyLineInput {
  /** A known ingredient — or `newIngredient`: something not on the stock yet, created with the delivery. */
  ingredientId?: string;
  newIngredient?: { name: string; unit: IngredientUnit };
  /** In the ingredient's unit (г, мл, шт): the screen converts кг and л. */
  quantity: number;
  /** What was paid for the whole line, minor units (from the invoice). */
  amount: Minor;
}

/** POST /api/stock/supplies; POST /api/stock/supplies/:id/update corrects one with the same body. */
export interface CreateSupplyRequest {
  /** Free text: «Молочная ферма», «Метро». */
  supplier: string;
  note?: string;
  lines: SupplyLineInput[];
}

/** POST /api/stock/supplies/:id/delete */
export interface DeleteSupplyRequest {
  reason?: string;
}

export interface SupplyView {
  id: string;
  at: number;
  supplier: string;
  note: string | null;
  total: Minor;
  createdBy: string;
  lines: Array<{ ingredientId: string; name: string; unit: IngredientUnit; quantity: number; amount: Minor }>;
  /** Deleted: its stock was taken back (movements «Поставка удалена»); it stays in the list. */
  deletedAt: number | null;
  deletedBy: string | null;
  deleteReason: string | null;
  /** Last correction. */
  changedAt: number | null;
  changedBy: string | null;
  /** May the person asking delete or correct it now (canChangeSupply)? */
  canChange: boolean;
  /** Their own delivery: until when (else null). */
  changeUntil: number | null;
}

/** GET /api/stock/supplies?from&to — newest first. */
export interface SuppliesView {
  supplies: SupplyView[];
}

/** POST /api/stock/counts — only the ingredients that were counted; the expected amount is the HUB's. */
export interface CreateStockCountRequest {
  note?: string;
  lines: Array<{ ingredientId: string; counted: number }>;
}

export interface StockCountView {
  id: string;
  at: number;
  note: string | null;
  createdBy: string;
  /** Sum of the differences at cost: below 0 — a shortage. */
  diffCost: Minor;
  lines: Array<{
    ingredientId: string;
    name: string;
    unit: IngredientUnit;
    expected: number;
    counted: number;
    /** counted − expected. */
    difference: number;
    cost: Minor | null;
  }>;
}

/** GET /api/stock/counts — newest first. */
export interface StockCountsView {
  counts: StockCountView[];
}

/** POST /api/stock/writeoffs — spilled, spoilt, used for staff; the reason is required. */
export interface WriteOffRequest {
  ingredientId: string;
  quantity: number;
  reason: string;
}

export interface StockMovementView {
  id: number;
  at: number;
  ingredientId: string;
  name: string;
  unit: IngredientUnit;
  kind: StockMovementKind;
  /** Signed change in units. */
  quantity: number;
  /** In stock after the change. */
  balance: number;
  /** Value of the change at cost, signed; null without a cost. */
  cost: Minor | null;
  orderId: string | null;
  supplyId: string | null;
  countId: string | null;
  productId: string | null;
  reason: string | null;
  actor: string;
}

/** GET /api/stock/movements?from&to&ingredientId — newest first. */
export interface StockMovementsView {
  movements: StockMovementView[];
}
