import { randomUUID } from 'node:crypto';
import type {
  CreateIngredientRequest,
  CreateStockCountRequest,
  CreateSupplyRequest,
  IngredientsView,
  IngredientUnit,
  IngredientView,
  ProductOptionGroup,
  PurchaseListView,
  StockAlertsView,
  Recipe,
  RecipeOptionLine,
  RecipesView,
  RecipeView,
  SetRecipeRequest,
  StockCountsView,
  StockCountView,
  StockMovementKind,
  StockMovementsView,
  SuppliesView,
  SupplyView,
  UpdateIngredientRequest,
  WriteOffRequest,
} from '@bills/domain';
import {
  averageCost,
  costOf,
  daysLeftOf,
  fromMilli,
  ingredientPurchaseList,
  INGREDIENT_NAME_MAX,
  isIngredientUnit,
  isQuantity,
  recipeCost,
  recipeUsage,
  STOCK_NOTE_MAX,
  stockAlerts,
  STOCK_USAGE_DAYS,
  SUPPLIER_MAX,
  SUPPLY_MAX_LINES,
  toMilli,
  UNIT_COST_LIMIT,
  validateRecipe,
  WRITE_OFF_REASON_MIN,
} from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db, Param } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record, SYSTEM } from './journal.ts';

/**
 * «Склад» of a coffee shop (packages/domain stock.ts): raw materials, recipes, deliveries,
 * counts, write-offs and the movement log. Quantities are integer thousandths in the
 * database (`*_milli` below) and plain numbers in the API.
 *
 * Sales: `consumeForOrder` and `returnForOrder` are called by order-lines.ts inside the
 * transaction that takes or cancels a bar/counter order — the same moment tracked product
 * stock goes down or comes back. Both are idempotent per order: the movement log is the
 * record of what was taken, so a cancel returns exactly that, even if the recipe changed since.
 */

const DAY = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 200;
const MOVEMENTS_LIMIT = 1000;

interface IngredientRow {
  id: string;
  name: string;
  unit: IngredientUnit;
  quantity: number;
  cost_per_unit: number | null;
  min_level: number | null;
  is_archived: number;
  created_at: number;
  updated_at: number;
}

interface RecipeRow {
  id: number;
  product_id: string;
  choice_id: string | null;
  mode: 'base' | 'add' | 'set' | 'swap';
  ingredient_id: string;
  replaces_id: string | null;
  quantity: number;
  sort_order: number;
  updated_at: number;
}

interface MovementInput {
  ingredientId: string;
  /** Signed change, thousandths. */
  deltaMilli: number;
  kind: StockMovementKind;
  actor: string;
  /** Value of the change; omitted → at the ingredient's cost. */
  cost?: number | null;
  orderId?: string | null;
  productId?: string | null;
  supplyId?: string | null;
  countId?: string | null;
  reason?: string | null;
}

// ── Plain functions: used inside other services' transactions ──────────────

/** Writes one movement and moves the level; returns the level after it (thousandths). */
function move(db: Db, now: number, m: MovementInput): number {
  const ing = one<{ quantity: number; cost_per_unit: number | null }>(
    db,
    'SELECT quantity, cost_per_unit FROM ingredients WHERE id = ?',
    m.ingredientId,
  );
  if (!ing) throw new HubError(404, 'INGREDIENT_NOT_FOUND', 'Сырьё не найдено');
  const balance = ing.quantity + m.deltaMilli;
  const cost = m.cost !== undefined ? m.cost : costOf(fromMilli(m.deltaMilli), ing.cost_per_unit);
  run(db, 'UPDATE ingredients SET quantity = ?, updated_at = ? WHERE id = ?', balance, now, m.ingredientId);
  run(
    db,
    `INSERT INTO stock_movements
       (at, ingredient_id, kind, quantity, balance, cost, order_id, product_id, supply_id, count_id, reason, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    now,
    m.ingredientId,
    m.kind,
    m.deltaMilli,
    balance,
    cost,
    m.orderId ?? null,
    m.productId ?? null,
    m.supplyId ?? null,
    m.countId ?? null,
    m.reason ?? null,
    m.actor,
  );
  return balance;
}

function recipeRows(db: Db, productId: string): RecipeRow[] {
  return all<RecipeRow>(db, 'SELECT * FROM recipe_items WHERE product_id = ? ORDER BY sort_order, id', productId);
}

function toRecipe(rows: readonly RecipeRow[]): Recipe {
  const items = rows
    .filter((r) => r.mode === 'base')
    .map((r) => ({ ingredientId: r.ingredient_id, quantity: fromMilli(r.quantity) }));
  const options = rows
    .filter((r) => r.mode !== 'base')
    .map((r): RecipeOptionLine => ({
      choiceId: r.choice_id!,
      mode: r.mode as RecipeOptionLine['mode'],
      ingredientId: r.ingredient_id,
      quantity: fromMilli(r.quantity),
      ...(r.mode === 'swap' ? { replacesId: r.replaces_id } : {}),
    }));
  return { items, options };
}

/** One line of an order as order-lines.ts priced it. */
export interface ConsumedLine {
  productId: string;
  qty: number;
  /** Chosen option choice ids. */
  choiceIds: readonly string[];
}

/**
 * Takes the recipe amounts of a new order off the stock: recipe × quantity with the options,
 * one movement per ingredient and product. Products without a recipe take nothing; the level
 * may go below zero (the sale is never refused). A second call for the same order does nothing.
 */
export function consumeForOrder(db: Db, orderId: string, lines: readonly ConsumedLine[], now: number): void {
  if (one(db, "SELECT id FROM stock_movements WHERE order_id = ? AND kind = 'sale' LIMIT 1", orderId)) return;
  const totals = new Map<string, { ingredientId: string; productId: string; milli: number }>();
  const recipes = new Map<string, Recipe | null>();
  for (const line of lines) {
    let recipe = recipes.get(line.productId);
    if (recipe === undefined) {
      const rows = recipeRows(db, line.productId);
      recipe = rows.length ? toRecipe(rows) : null;
      recipes.set(line.productId, recipe);
    }
    if (!recipe) continue;
    for (const use of recipeUsage(recipe, line.choiceIds)) {
      const key = `${use.ingredientId}\n${line.productId}`;
      const t = totals.get(key) ?? { ingredientId: use.ingredientId, productId: line.productId, milli: 0 };
      t.milli += toMilli(use.quantity) * line.qty;
      totals.set(key, t);
    }
  }
  if (totals.size === 0) return;
  const actor = one<{ created_by: string }>(db, 'SELECT created_by FROM bar_orders WHERE id = ?', orderId)?.created_by ?? SYSTEM;
  for (const t of totals.values()) {
    if (t.milli <= 0) continue;
    move(db, now, { ingredientId: t.ingredientId, deltaMilli: -t.milli, kind: 'sale', actor, orderId, productId: t.productId });
  }
}

/**
 * A cancelled order gives back what its sale took (from the movement log, not today's
 * recipe). A second call for the same order does nothing.
 */
export function returnForOrder(db: Db, orderId: string, now: number, actor: string = SYSTEM): void {
  if (one(db, "SELECT id FROM stock_movements WHERE order_id = ? AND kind = 'return' LIMIT 1", orderId)) return;
  const taken = all<{ ingredient_id: string; product_id: string | null; q: number; c: number | null }>(
    db,
    `SELECT ingredient_id, product_id, SUM(quantity) AS q, SUM(cost) AS c FROM stock_movements
     WHERE order_id = ? AND kind = 'sale' GROUP BY ingredient_id, product_id ORDER BY MIN(id)`,
    orderId,
  );
  for (const t of taken) {
    if (t.q === 0) continue;
    // Back at the cost it left with, so a sale and its cancellation add up to zero.
    move(db, now, {
      ingredientId: t.ingredient_id,
      deltaMilli: -t.q,
      kind: 'return',
      actor,
      cost: t.c === null ? null : -t.c,
      orderId,
      productId: t.product_id,
    });
  }
}

// ── Validation helpers ──────────────────────────────────────────────────────

function cleanText(raw: unknown, max: number, code: string, what: string, required: boolean): string | null {
  const text = (typeof raw === 'string' ? raw : '').trim().replace(/\s+/g, ' ');
  if (required && text.length === 0) throw new HubError(422, code, `Укажите ${what}`);
  if (text.length > max) throw new HubError(422, code, `${what[0]!.toUpperCase()}${what.slice(1)} — не длиннее ${max} символов`);
  return text.length ? text : null;
}

function checkQty(v: unknown, positive: boolean, what: string): number {
  if (!isQuantity(v, positive)) {
    throw new HubError(422, 'QUANTITY_INVALID', `${what}: ${positive ? 'число больше нуля' : 'число не меньше нуля'}`);
  }
  return toMilli(v);
}

function checkCost(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > UNIT_COST_LIMIT) {
    throw new HubError(422, 'COST_INVALID', 'Цена за единицу — целое число не меньше нуля');
  }
  return v as number;
}

function checkMin(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return checkQty(v, false, 'Минимальный остаток');
}

function checkUnit(v: unknown): IngredientUnit {
  if (!isIngredientUnit(v)) throw new HubError(422, 'UNIT_INVALID', 'Единица — г, мл или шт');
  return v;
}

function optionChoiceIds(raw: string | null): Set<string> {
  const ids = new Set<string>();
  try {
    const groups = JSON.parse(raw ?? '[]') as ProductOptionGroup[];
    if (Array.isArray(groups)) for (const g of groups) for (const c of g.choices ?? []) ids.add(c.id);
  } catch {
    // A damaged value reads as no options, like the menu does.
  }
  return ids;
}

// ── The service ─────────────────────────────────────────────────────────────

export interface StockServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

/** The HUB exposes it as `hub.stock`; every command is one transaction with an audit record. */
export class StockService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #events: HubEvents;

  constructor(deps: StockServiceDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#events = deps.events;
  }

  // ── Ingredients ─────────────────────────────────────────────────────────

  /** Every ingredient, archived ones included, by name; with «хватит на N дней» from the last two weeks of sales. */
  ingredients(): IngredientsView {
    const db = this.#db;
    const rows = all<IngredientRow>(db, 'SELECT * FROM ingredients');
    const { used, days } = this.#usage();
    const usedIn = new Map(
      all<{ id: string; n: number }>(
        db,
        `SELECT id, COUNT(DISTINCT product_id) AS n FROM (
           SELECT ingredient_id AS id, product_id FROM recipe_items
           UNION SELECT replaces_id AS id, product_id FROM recipe_items WHERE replaces_id IS NOT NULL
         ) GROUP BY id`,
      ).map((r) => [r.id, r.n]),
    );
    const ingredients = rows
      .map((r) => {
        const u = used.get(r.id) ?? 0;
        const perDay = u > 0 ? fromMilli(Math.round(u / days)) : null;
        return this.#view(r, perDay, usedIn.get(r.id) ?? 0);
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return { ingredients };
  }

  /**
   * «Докупить на неделю»: for every active ingredient ⌈use per day × 7 + minimum − stock⌉ at the
   * pace of the last two weeks of sales (fewer days for a new coffee shop), with the approximate
   * cost at the average price. Only what needs buying.
   */
  purchaseList(): PurchaseListView {
    const { used, days } = this.#usage();
    const rows = all<IngredientRow>(this.#db, 'SELECT * FROM ingredients WHERE is_archived = 0');
    return ingredientPurchaseList(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        unit: r.unit,
        quantity: fromMilli(r.quantity),
        minLevel: r.min_level === null ? null : fromMilli(r.min_level),
        costPerUnit: r.cost_per_unit,
        used: fromMilli(used.get(r.id) ?? 0),
      })),
      days,
    );
  }

  /**
   * What runs out, for everyone at the counter (POS hints, the barista's strip): names and
   * levels only — no prices. Cheap: two small queries.
   */
  alerts(): StockAlertsView {
    const db = this.#db;
    const rows = all<IngredientRow>(db, 'SELECT * FROM ingredients WHERE is_archived = 0');
    const recipes = new Map<string, Recipe>();
    const byProduct = new Map<string, RecipeRow[]>();
    for (const r of all<RecipeRow>(
      db,
      `SELECT ri.* FROM recipe_items ri JOIN products p ON p.id = ri.product_id
       WHERE p.is_active = 1 ORDER BY ri.product_id, ri.sort_order, ri.id`,
    )) {
      byProduct.set(r.product_id, [...(byProduct.get(r.product_id) ?? []), r]);
    }
    for (const [productId, list] of byProduct) recipes.set(productId, toRecipe(list));
    return stockAlerts(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        unit: r.unit,
        quantity: fromMilli(r.quantity),
        minLevel: r.min_level === null ? null : fromMilli(r.min_level),
        isArchived: false,
      })),
      recipes,
    );
  }

  createIngredient(input: CreateIngredientRequest & { actor: string }): IngredientView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const name = cleanText(input.name, INGREDIENT_NAME_MAX, 'NAME_REQUIRED', 'название сырья', true)!;
      const unit = checkUnit(input.unit);
      const quantity = input.quantity === undefined || input.quantity === null ? 0 : checkQty(input.quantity, false, 'Остаток');
      const cost = checkCost(input.costPerUnit);
      const minLevel = checkMin(input.minLevel);
      this.#assertNameFree(name, null);
      const id = randomUUID();
      run(
        db,
        `INSERT INTO ingredients (id, name, unit, quantity, cost_per_unit, min_level, is_archived, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, 0, ?, ?)`,
        id,
        name,
        unit,
        cost,
        minLevel,
        now,
        now,
      );
      if (quantity > 0) move(db, now, { ingredientId: id, deltaMilli: quantity, kind: 'initial', actor: input.actor });
      record(db, now, {
        actor: input.actor,
        action: 'stock.ingredient_created',
        entityType: 'ingredient',
        entityId: id,
        data: { name, unit, quantity: fromMilli(quantity), costPerUnit: cost, minLevel: minLevel === null ? null : fromMilli(minLevel) },
      });
      this.#changed();
      return this.#one(id);
    });
  }

  updateIngredient(input: UpdateIngredientRequest & { id: string; actor: string }): IngredientView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const current = this.#row(input.id);
      const name =
        input.name === undefined ? current.name : cleanText(input.name, INGREDIENT_NAME_MAX, 'NAME_REQUIRED', 'название сырья', true)!;
      const unit = input.unit === undefined ? current.unit : checkUnit(input.unit);
      if (unit !== current.unit && one(db, 'SELECT id FROM stock_movements WHERE ingredient_id = ? LIMIT 1', current.id)) {
        throw new HubError(409, 'UNIT_LOCKED', 'Единицу нельзя менять: по этому сырью уже есть движения. Заведите новое сырьё');
      }
      const cost = input.costPerUnit === undefined ? current.cost_per_unit : checkCost(input.costPerUnit);
      const minLevel = input.minLevel === undefined ? current.min_level : checkMin(input.minLevel);
      const archived = input.isArchived === undefined ? current.is_archived === 1 : input.isArchived === true;
      if (!archived && (name !== current.name || current.is_archived === 1)) this.#assertNameFree(name, current.id);
      run(
        db,
        `UPDATE ingredients SET name = ?, unit = ?, cost_per_unit = ?, min_level = ?, is_archived = ?, updated_at = ?
         WHERE id = ?`,
        name,
        unit,
        cost,
        minLevel,
        archived ? 1 : 0,
        now,
        current.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'stock.ingredient_updated',
        entityType: 'ingredient',
        entityId: current.id,
        data: {
          name,
          unit,
          costPerUnit: cost,
          minLevel: minLevel === null ? null : fromMilli(minLevel),
          isArchived: archived,
          was: { name: current.name, unit: current.unit, costPerUnit: current.cost_per_unit, isArchived: current.is_archived === 1 },
        },
      });
      this.#changed();
      return this.#one(current.id);
    });
  }

  // ── Recipes ─────────────────────────────────────────────────────────────

  recipe(productId: string): RecipeView {
    this.#product(productId);
    return this.#recipeView(productId);
  }

  /** Products that have a recipe, with the cost of a plain portion. */
  recipes(): RecipesView {
    const db = this.#db;
    const rows = all<RecipeRow>(db, 'SELECT * FROM recipe_items ORDER BY product_id, sort_order, id');
    const costs = this.#costs();
    const byProduct = new Map<string, RecipeRow[]>();
    for (const r of rows) byProduct.set(r.product_id, [...(byProduct.get(r.product_id) ?? []), r]);
    return {
      recipes: [...byProduct].map(([productId, list]) => {
        const recipe = toRecipe(list);
        const { cost, complete } = recipeCost(recipeUsage(recipe), costs);
        return { productId, lines: recipe.items.length, optionLines: recipe.options.length, cost, complete };
      }),
    };
  }

  /** Replaces the recipe of a product (base lines and option changes); empty lists remove it. */
  setRecipe(input: SetRecipeRequest & { productId: string; actor: string }): RecipeView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const product = this.#product(input.productId);
      const recipe: Recipe = { items: input.items ?? [], options: input.options ?? [] };
      const ingredientIds = new Set(all<{ id: string }>(db, 'SELECT id FROM ingredients').map((r) => r.id));
      const problems = validateRecipe(recipe, { ingredientIds, choiceIds: optionChoiceIds(product.options) });
      if (problems.length) throw new HubError(422, 'RECIPE_INVALID', problems.join('; '));
      run(db, 'DELETE FROM recipe_items WHERE product_id = ?', product.id);
      let order = 0;
      const insert = (choiceId: string | null, mode: RecipeRow['mode'], ingredientId: string, replacesId: string | null, quantity: number) =>
        run(
          db,
          `INSERT INTO recipe_items (product_id, choice_id, mode, ingredient_id, replaces_id, quantity, sort_order, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          product.id,
          choiceId,
          mode,
          ingredientId,
          replacesId,
          toMilli(quantity),
          ++order,
          now,
        );
      for (const line of recipe.items) insert(null, 'base', line.ingredientId, null, line.quantity);
      for (const o of recipe.options) {
        insert(o.choiceId, o.mode, o.ingredientId, o.mode === 'swap' ? (o.replacesId ?? null) : null, o.quantity);
      }
      record(db, now, {
        actor: input.actor,
        action: 'stock.recipe_set',
        entityType: 'product',
        entityId: product.id,
        data: { name: product.name, items: recipe.items, options: recipe.options },
      });
      this.#changed();
      return this.#recipeView(product.id);
    });
  }

  // ── Supplies ────────────────────────────────────────────────────────────

  supplies(range: { from?: number | undefined; to?: number | undefined } = {}): SuppliesView {
    const db = this.#db;
    const { where, params } = rangeOf(range, 's.at');
    const rows = all<{ id: string; at: number; supplier: string; note: string | null; total: number; created_by: string }>(
      db,
      `SELECT s.* FROM supplies s ${where} ORDER BY s.at DESC, s.rowid DESC LIMIT ${LIST_LIMIT}`,
      ...params,
    );
    const lines = this.#linesOf<{
      supply_id: string;
      ingredient_id: string;
      name: string;
      unit: IngredientUnit;
      quantity: number;
      amount: number;
    }>(
      `SELECT l.supply_id, l.ingredient_id, i.name, i.unit, l.quantity, l.amount FROM supply_lines l
       JOIN ingredients i ON i.id = l.ingredient_id WHERE l.supply_id IN`,
      rows.map((r) => r.id),
      'l.id',
    );
    return {
      supplies: rows.map((r): SupplyView => ({
        id: r.id,
        at: r.at,
        supplier: r.supplier,
        note: r.note,
        total: r.total,
        createdBy: r.created_by,
        lines: lines
          .filter((l) => l.supply_id === r.id)
          .map((l) => ({ ingredientId: l.ingredient_id, name: l.name, unit: l.unit, quantity: fromMilli(l.quantity), amount: l.amount })),
      })),
    };
  }

  /** A delivery: every line adds to the stock and updates the ingredient's cost (weighted average). */
  createSupply(input: CreateSupplyRequest & { actor: string }): SupplyView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const supplier = cleanText(input.supplier, SUPPLIER_MAX, 'SUPPLIER_REQUIRED', 'поставщика', true)!;
      const note = cleanText(input.note, STOCK_NOTE_MAX, 'NOTE_TOO_LONG', 'комментарий', false);
      const lines = Array.isArray(input.lines) ? input.lines : [];
      if (lines.length === 0) throw new HubError(422, 'SUPPLY_EMPTY', 'Добавьте хотя бы одну строку');
      if (lines.length > SUPPLY_MAX_LINES) throw new HubError(422, 'SUPPLY_TOO_LONG', `Не больше ${SUPPLY_MAX_LINES} строк`);
      const checked = lines.map((l, i) => {
        const ing = this.#row(l.ingredientId);
        if (ing.is_archived) throw new HubError(422, 'INGREDIENT_ARCHIVED', `Строка ${i + 1}: «${ing.name}» в архиве`);
        const milli = checkQty(l.quantity, true, `Строка ${i + 1}, количество`);
        if (!Number.isInteger(l.amount) || l.amount < 0) {
          throw new HubError(422, 'AMOUNT_INVALID', `Строка ${i + 1}: сумма — целое число не меньше нуля`);
        }
        return { ing, milli, amount: l.amount };
      });
      const total = checked.reduce((s, l) => s + l.amount, 0);
      const id = randomUUID();
      run(
        db,
        'INSERT INTO supplies (id, at, supplier, note, total, created_by) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        now,
        supplier,
        note,
        total,
        input.actor,
      );
      for (const l of checked) {
        run(
          db,
          'INSERT INTO supply_lines (supply_id, ingredient_id, quantity, amount) VALUES (?, ?, ?, ?)',
          id,
          l.ing.id,
          l.milli,
          l.amount,
        );
        const before = this.#row(l.ing.id);
        // A line at 0 (a free sample) adds stock but leaves the known price as it is.
        if (l.amount > 0) {
          const cost = averageCost(fromMilli(before.quantity), before.cost_per_unit, fromMilli(l.milli), l.amount);
          run(db, 'UPDATE ingredients SET cost_per_unit = ? WHERE id = ?', cost, l.ing.id);
        }
        move(db, now, { ingredientId: l.ing.id, deltaMilli: l.milli, kind: 'supply', actor: input.actor, cost: l.amount, supplyId: id });
      }
      record(db, now, {
        actor: input.actor,
        action: 'stock.supply',
        entityType: 'supply',
        entityId: id,
        data: {
          supplier,
          note,
          total,
          lines: checked.map((l) => ({ ingredientId: l.ing.id, name: l.ing.name, quantity: fromMilli(l.milli), amount: l.amount })),
        },
      });
      this.#changed();
      return this.supplies().supplies.find((s) => s.id === id)!;
    });
  }

  // ── Inventory counts ────────────────────────────────────────────────────

  counts(range: { from?: number | undefined; to?: number | undefined } = {}): StockCountsView {
    const db = this.#db;
    const { where, params } = rangeOf(range, 'c.at');
    const rows = all<{ id: string; at: number; note: string | null; diff_cost: number; created_by: string }>(
      db,
      `SELECT c.* FROM stock_counts c ${where} ORDER BY c.at DESC, c.rowid DESC LIMIT ${LIST_LIMIT}`,
      ...params,
    );
    const lines = this.#linesOf<{
      count_id: string;
      ingredient_id: string;
      name: string;
      unit: IngredientUnit;
      expected: number;
      counted: number;
      difference: number;
      cost: number | null;
    }>(
      `SELECT l.count_id, l.ingredient_id, i.name, i.unit, l.expected, l.counted, l.difference, l.cost
       FROM stock_count_lines l JOIN ingredients i ON i.id = l.ingredient_id WHERE l.count_id IN`,
      rows.map((r) => r.id),
      'l.id',
    );
    return {
      counts: rows.map((r): StockCountView => ({
        id: r.id,
        at: r.at,
        note: r.note,
        createdBy: r.created_by,
        diffCost: r.diff_cost,
        lines: lines
          .filter((l) => l.count_id === r.id)
          .map((l) => ({
            ingredientId: l.ingredient_id,
            name: l.name,
            unit: l.unit,
            expected: fromMilli(l.expected),
            counted: fromMilli(l.counted),
            difference: fromMilli(l.difference),
            cost: l.cost,
          })),
      })),
    };
  }

  /**
   * An inventory count: for every counted ingredient the expected amount is the HUB's level
   * right now, the level becomes the counted amount, the difference and its cost are kept.
   */
  createCount(input: CreateStockCountRequest & { actor: string }): StockCountView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const note = cleanText(input.note, STOCK_NOTE_MAX, 'NOTE_TOO_LONG', 'комментарий', false);
      const lines = Array.isArray(input.lines) ? input.lines : [];
      if (lines.length === 0) throw new HubError(422, 'COUNT_EMPTY', 'Введите хотя бы одно посчитанное количество');
      const seen = new Set<string>();
      const checked = lines.map((l, i) => {
        const ing = this.#row(l.ingredientId);
        if (seen.has(ing.id)) throw new HubError(422, 'COUNT_REPEATED', `«${ing.name}» указано дважды`);
        seen.add(ing.id);
        return { ing, counted: checkQty(l.counted, false, `Строка ${i + 1}, посчитано`) };
      });
      const id = randomUUID();
      // The count row first (lines refer to it); its total is filled in below.
      run(db, 'INSERT INTO stock_counts (id, at, note, diff_cost, created_by) VALUES (?, ?, ?, 0, ?)', id, now, note, input.actor);
      let diffCost = 0;
      const audit: Array<Record<string, unknown>> = [];
      for (const { ing, counted } of checked) {
        const expected = ing.quantity;
        const difference = counted - expected;
        const cost = costOf(fromMilli(difference), ing.cost_per_unit);
        if (cost !== null) diffCost += cost;
        run(
          db,
          `INSERT INTO stock_count_lines (count_id, ingredient_id, expected, counted, difference, cost)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          ing.id,
          expected,
          counted,
          difference,
          cost,
        );
        if (difference !== 0) {
          move(db, now, { ingredientId: ing.id, deltaMilli: difference, kind: 'inventory', actor: input.actor, cost, countId: id });
        }
        audit.push({ ingredientId: ing.id, name: ing.name, expected: fromMilli(expected), counted: fromMilli(counted), cost });
      }
      run(db, 'UPDATE stock_counts SET diff_cost = ? WHERE id = ?', diffCost, id);
      record(db, now, {
        actor: input.actor,
        action: 'stock.count',
        entityType: 'stock_count',
        entityId: id,
        data: { note, diffCost, lines: audit },
      });
      this.#changed();
      return this.counts().counts.find((c) => c.id === id)!;
    });
  }

  // ── Write-off ───────────────────────────────────────────────────────────

  writeOff(input: WriteOffRequest & { actor: string }): IngredientView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const ing = this.#row(input.ingredientId);
      const milli = checkQty(input.quantity, true, 'Количество');
      const reason = cleanText(input.reason, STOCK_NOTE_MAX, 'REASON_REQUIRED', 'причину', true)!;
      if (reason.length < WRITE_OFF_REASON_MIN) throw new HubError(422, 'REASON_REQUIRED', 'Укажите причину списания');
      const balance = move(db, now, { ingredientId: ing.id, deltaMilli: -milli, kind: 'writeoff', actor: input.actor, reason });
      record(db, now, {
        actor: input.actor,
        action: 'stock.writeoff',
        entityType: 'ingredient',
        entityId: ing.id,
        data: {
          name: ing.name,
          unit: ing.unit,
          quantity: fromMilli(milli),
          reason,
          cost: costOf(fromMilli(milli), ing.cost_per_unit),
          balance: fromMilli(balance),
        },
      });
      this.#changed();
      return this.#one(ing.id);
    });
  }

  // ── Movements ───────────────────────────────────────────────────────────

  movements(query: { from?: number | undefined; to?: number | undefined; ingredientId?: string | undefined } = {}): StockMovementsView {
    const { where, params } = rangeOf(query, 'm.at');
    const clauses = where ? [where] : [];
    if (query.ingredientId) {
      clauses.push(where ? 'AND m.ingredient_id = ?' : 'WHERE m.ingredient_id = ?');
      params.push(query.ingredientId);
    }
    const rows = all<{
      id: number;
      at: number;
      ingredient_id: string;
      name: string;
      unit: IngredientUnit;
      kind: StockMovementKind;
      quantity: number;
      balance: number;
      cost: number | null;
      order_id: string | null;
      supply_id: string | null;
      count_id: string | null;
      product_id: string | null;
      reason: string | null;
      actor: string;
    }>(
      this.#db,
      `SELECT m.*, i.name, i.unit FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id
       ${clauses.join(' ')} ORDER BY m.id DESC LIMIT ${MOVEMENTS_LIMIT}`,
      ...params,
    );
    return {
      movements: rows.map((r) => ({
        id: r.id,
        at: r.at,
        ingredientId: r.ingredient_id,
        name: r.name,
        unit: r.unit,
        kind: r.kind,
        quantity: fromMilli(r.quantity),
        balance: fromMilli(r.balance),
        cost: r.cost,
        orderId: r.order_id,
        supplyId: r.supply_id,
        countId: r.count_id,
        productId: r.product_id,
        reason: r.reason,
        actor: r.actor,
      })),
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Use by sales (sales minus their cancellations) per ingredient over the last
   * STOCK_USAGE_DAYS days, thousandths, and the days to divide by: a coffee shop that
   * started selling 3 days ago divides by 3, not by 14.
   */
  #usage(): { used: Map<string, number>; days: number } {
    const db = this.#db;
    const now = this.#clock.now();
    const since = now - STOCK_USAGE_DAYS * DAY;
    const used = new Map(
      all<{ ingredient_id: string; used: number }>(
        db,
        `SELECT ingredient_id, -SUM(quantity) AS used FROM stock_movements
         WHERE kind IN ('sale', 'return') AND at >= ? GROUP BY ingredient_id`,
        since,
      ).map((r) => [r.ingredient_id, r.used]),
    );
    const first = one<{ at: number | null }>(db, "SELECT MIN(at) AS at FROM stock_movements WHERE kind = 'sale'")?.at ?? null;
    const days = first === null ? 1 : Math.min(STOCK_USAGE_DAYS, Math.max(1, Math.ceil((now - first) / DAY)));
    return { used, days };
  }

  #changed(): void {
    afterCommit(this.#db, () => this.#events.changed({ kind: 'stock' }));
  }

  #row(id: string): IngredientRow {
    const row = one<IngredientRow>(this.#db, 'SELECT * FROM ingredients WHERE id = ?', id);
    if (!row) throw new HubError(404, 'INGREDIENT_NOT_FOUND', 'Сырьё не найдено');
    return row;
  }

  #one(id: string): IngredientView {
    return this.ingredients().ingredients.find((i) => i.id === id) ?? this.#view(this.#row(id), null, 0);
  }

  #view(r: IngredientRow, perDay: number | null, usedIn: number): IngredientView {
    const quantity = fromMilli(r.quantity);
    const value = costOf(Math.max(0, quantity), r.cost_per_unit);
    return {
      id: r.id,
      name: r.name,
      unit: r.unit,
      quantity,
      costPerUnit: r.cost_per_unit,
      minLevel: r.min_level === null ? null : fromMilli(r.min_level),
      isArchived: r.is_archived === 1,
      low: r.quantity < 0 || (r.min_level !== null && r.quantity < r.min_level),
      perDay,
      daysLeft: daysLeftOf(quantity, perDay),
      value,
      usedIn,
    };
  }

  #assertNameFree(name: string, exceptId: string | null): void {
    const wanted = name.toLocaleLowerCase('ru');
    const clash = all<{ id: string; name: string }>(this.#db, 'SELECT id, name FROM ingredients WHERE is_archived = 0').find(
      (r) => r.id !== exceptId && r.name.toLocaleLowerCase('ru') === wanted,
    );
    if (clash) throw new HubError(409, 'INGREDIENT_EXISTS', `Сырьё «${name}» уже есть`);
  }

  #product(id: string): { id: string; name: string; options: string | null } {
    const p = one<{ id: string; name: string; options: string | null }>(this.#db, 'SELECT id, name, options FROM products WHERE id = ?', id);
    if (!p) throw new HubError(404, 'PRODUCT_NOT_FOUND', 'Товар не найден');
    return p;
  }

  #costs(): Map<string, number | null> {
    return new Map(
      all<{ id: string; cost_per_unit: number | null }>(this.#db, 'SELECT id, cost_per_unit FROM ingredients').map((r) => [
        r.id,
        r.cost_per_unit,
      ]),
    );
  }

  #recipeView(productId: string): RecipeView {
    const rows = recipeRows(this.#db, productId);
    const recipe = toRecipe(rows);
    const usage = recipeUsage(recipe);
    const { cost, complete } = recipeCost(usage, this.#costs());
    return {
      productId,
      ...recipe,
      cost: rows.length ? cost : null,
      complete,
      updatedAt: rows.length ? Math.max(...rows.map((r) => r.updated_at)) : null,
    };
  }

  #linesOf<T>(sqlPrefix: string, ids: readonly string[], orderBy: string): T[] {
    if (ids.length === 0) return [];
    return all<T>(this.#db, `${sqlPrefix} (${ids.map(() => '?').join(', ')}) ORDER BY ${orderBy}`, ...ids);
  }
}

function rangeOf(range: { from?: number | undefined; to?: number | undefined }, column: string): { where: string; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  if (range.from !== undefined && Number.isFinite(range.from)) {
    parts.push(`${column} >= ?`);
    params.push(range.from);
  }
  if (range.to !== undefined && Number.isFinite(range.to)) {
    parts.push(`${column} < ?`);
    params.push(range.to);
  }
  return { where: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}
