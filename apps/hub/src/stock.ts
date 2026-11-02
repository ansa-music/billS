import { randomUUID } from 'node:crypto';
import type {
  AdjustStockRequest,
  CreateIngredientRequest,
  CreateStockCountRequest,
  CreateSupplyRequest,
  IngredientRemovalView,
  IngredientsView,
  IngredientUnit,
  IngredientView,
  ProductOptionGroup,
  Recipe,
  RecipeOptionLine,
  RecipesView,
  RecipeView,
  RemoveIngredientResponse,
  RemoveSampleResponse,
  SetRecipeRequest,
  StockCountsView,
  StockCountView,
  StockMovementKind,
  StockMovementsView,
  StockSampleView,
  StockSetupView,
  SuppliesView,
  SupplyLineInput,
  SupplyView,
  UpdateIngredientRequest,
  WriteOffRequest,
} from '@bills/domain';
import {
  averageCost,
  canChangeSupply,
  costOf,
  costWithout,
  daysLeftOf,
  fromMilli,
  INGREDIENT_DELETED_REASON,
  INGREDIENT_NAME_MAX,
  isIngredientUnit,
  isQuantity,
  recipeCost,
  recipeUsage,
  STOCK_NOTE_MAX,
  STOCK_USAGE_DAYS,
  SUPPLIER_MAX,
  supplyChanges,
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
  is_sample: number;
  /** Deleted for good while it had history (migration 022): the row stays for that history. */
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

interface SupplyRow {
  id: string;
  at: number;
  supplier: string;
  note: string | null;
  total: number;
  created_by: string;
  created_by_id: string | null;
  deleted_at: number | null;
  deleted_by: string | null;
  delete_reason: string | null;
  changed_at: number | null;
  changed_by: string | null;
}

interface SupplyLineRow {
  id: number;
  supply_id: string;
  ingredient_id: string;
  quantity: number;
  amount: number;
  cost_before: number | null;
  has_cost_before: number;
}

/** Who looks at the deliveries or changes one: their staff id and whether they hold `stock.edit`. */
export interface StockViewer {
  id: string | null;
  mayEditStock: boolean;
}

/** Internal calls (tests, the sample) see and may change everything. */
const ANY: StockViewer = { id: null, mayEditStock: true };

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
 * recipe). A second call for the same order does nothing. An ingredient deleted since gets
 * nothing back: its stock went off when it was deleted, and it stays at zero.
 */
export function returnForOrder(db: Db, orderId: string, now: number, actor: string = SYSTEM): void {
  if (one(db, "SELECT id FROM stock_movements WHERE order_id = ? AND kind = 'return' LIMIT 1", orderId)) return;
  const taken = all<{ ingredient_id: string; product_id: string | null; q: number; c: number | null }>(
    db,
    `SELECT m.ingredient_id, m.product_id, SUM(m.quantity) AS q, SUM(m.cost) AS c
     FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id
     WHERE m.order_id = ? AND m.kind = 'sale' AND i.deleted_at IS NULL
     GROUP BY m.ingredient_id, m.product_id ORDER BY MIN(m.id)`,
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

  /**
   * Every ingredient, archived ones included, deleted ones never, by name; with «хватит на N дней»
   * from the last two weeks of sales.
   */
  ingredients(): IngredientsView {
    const db = this.#db;
    const now = this.#clock.now();
    const rows = all<IngredientRow>(db, 'SELECT * FROM ingredients WHERE deleted_at IS NULL');
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
    // A coffee shop that started selling 3 days ago divides by 3, not by 14.
    const days = first === null ? 1 : Math.min(STOCK_USAGE_DAYS, Math.max(1, Math.ceil((now - first) / DAY)));
    const usedIn = new Map(
      all<{ id: string; n: number }>(
        db,
        `SELECT id, COUNT(DISTINCT product_id) AS n FROM (
           SELECT ingredient_id AS id, product_id FROM recipe_items
           UNION SELECT replaces_id AS id, product_id FROM recipe_items WHERE replaces_id IS NOT NULL
         ) GROUP BY id`,
      ).map((r) => [r.id, r.n]),
    );
    const withHistory = this.#withHistory();
    const ingredients = rows
      .map((r) => {
        const u = used.get(r.id) ?? 0;
        const perDay = u > 0 ? fromMilli(Math.round(u / days)) : null;
        return this.#view(r, perDay, usedIn.get(r.id) ?? 0, withHistory.has(r.id));
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return { ingredients };
  }

  /** `sample` — put in by TS (stock-sample.ts), not by the owner. */
  createIngredient(input: CreateIngredientRequest & { actor: string; sample?: boolean }): IngredientView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const name = cleanText(input.name, INGREDIENT_NAME_MAX, 'NAME_REQUIRED', 'название сырья', true)!;
      const unit = checkUnit(input.unit);
      const quantity = input.quantity === undefined || input.quantity === null ? 0 : checkQty(input.quantity, false, 'Остаток');
      const cost = checkCost(input.costPerUnit);
      const minLevel = checkMin(input.minLevel);
      this.#assertNameFree(name, null);
      const id = this.#insertIngredient({ name, unit, cost, minLevel, sample: input.sample === true, now });
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

  /**
   * What «Удалить» will do with an ingredient, active or archived: delete it completely (nothing
   * ever happened to it) or for good with its history kept, how much goes off with it, and which
   * recipes use it.
   */
  removal(id: string): IngredientRemovalView {
    const db = this.#db;
    const ing = this.#live(id);
    const n = (sql: string) => one<{ n: number }>(db, sql, id)?.n ?? 0;
    const history = {
      movements: n('SELECT COUNT(*) AS n FROM stock_movements WHERE ingredient_id = ?'),
      supplies: n('SELECT COUNT(DISTINCT supply_id) AS n FROM supply_lines WHERE ingredient_id = ?'),
      counts: n('SELECT COUNT(DISTINCT count_id) AS n FROM stock_count_lines WHERE ingredient_id = ?'),
    };
    return {
      ingredientId: ing.id,
      name: ing.name,
      unit: ing.unit,
      quantity: fromMilli(ing.quantity),
      recipes: this.#recipesUsing(ing.id),
      outcome: history.movements + history.supplies + history.counts > 0 ? 'history' : 'delete',
      history,
    };
  }

  /**
   * «Удалить», active or archived: an ingredient nothing happened to is deleted outright. One with
   * history is deleted for good, the row kept for that history (`deleted_at`, like a deleted staff
   * member): gone from the levels, the archive, pickers and the sample, no way back, its name free
   * again; what is on hand goes off as «Сырьё удалено» (`writeoff`; below zero — `adjust` up to
   * zero), so the totals stay honest. One that recipes use is refused (409, naming them) unless
   * `fromRecipes`: then it leaves those recipes too (its base lines, the option lines that take it
   * and the swaps that replace it). «В архив» is the way to hide one for a while.
   */
  removeIngredient(input: { id: string; fromRecipes?: boolean; actor: string }): RemoveIngredientResponse {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const plan = this.removal(input.id);
      const recipes = plan.recipes.map((r) => r.name);
      if (recipes.length > 0 && input.fromRecipes !== true) {
        throw new HubError(
          409,
          'INGREDIENT_IN_RECIPES',
          `«${plan.name}» есть в составе: ${recipes.join(', ')}. Уберите его оттуда или удалите вместе с составом`,
        );
      }
      if (recipes.length > 0) {
        run(db, 'DELETE FROM recipe_items WHERE ingredient_id = ? OR replaces_id = ?', plan.ingredientId, plan.ingredientId);
        for (const r of plan.recipes) run(db, 'UPDATE recipe_items SET updated_at = ? WHERE product_id = ?', now, r.productId);
      }
      const historyKept = plan.outcome === 'history';
      let cost: number | null = null;
      if (!historyKept) {
        run(db, 'DELETE FROM ingredients WHERE id = ?', plan.ingredientId);
      } else {
        const ing = this.#row(plan.ingredientId);
        if (ing.quantity !== 0) {
          cost = costOf(fromMilli(-ing.quantity), ing.cost_per_unit);
          move(db, now, {
            ingredientId: ing.id,
            deltaMilli: -ing.quantity,
            kind: ing.quantity > 0 ? 'writeoff' : 'adjust',
            actor: input.actor,
            reason: INGREDIENT_DELETED_REASON,
          });
        }
        run(db, 'UPDATE ingredients SET deleted_at = ?, is_archived = 1, is_sample = 0, updated_at = ? WHERE id = ?', now, now, ing.id);
      }
      const quantity = historyKept ? plan.quantity : 0;
      record(db, now, {
        actor: input.actor,
        action: 'stock.ingredient_removed',
        entityType: 'ingredient',
        entityId: plan.ingredientId,
        data: { name: plan.name, unit: plan.unit, outcome: 'deleted', historyKept, recipes, quantity, cost },
      });
      this.#changed();
      return { historyKept, recipes, quantity };
    });
  }

  /**
   * «Исправить остаток»: the level as it really is (a wrong sale deduction, a miscount, a sample
   * level), with a reason. One `adjust` movement on top — nothing before it changes.
   */
  adjust(input: AdjustStockRequest & { id: string; actor: string }): IngredientView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const ing = this.#live(input.id);
      if (ing.is_archived) throw new HubError(422, 'INGREDIENT_ARCHIVED', `«${ing.name}» в архиве`);
      const target = checkQty(input.quantity, false, 'Остаток');
      const reason = cleanText(input.reason, STOCK_NOTE_MAX, 'REASON_REQUIRED', 'причину', true)!;
      if (reason.length < WRITE_OFF_REASON_MIN) throw new HubError(422, 'REASON_REQUIRED', 'Укажите причину');
      const delta = target - ing.quantity;
      if (delta === 0) throw new HubError(422, 'NOTHING_CHANGED', 'Остаток уже такой');
      move(db, now, { ingredientId: ing.id, deltaMilli: delta, kind: 'adjust', actor: input.actor, reason });
      record(db, now, {
        actor: input.actor,
        action: 'stock.adjusted',
        entityType: 'ingredient',
        entityId: ing.id,
        data: {
          name: ing.name,
          unit: ing.unit,
          from: fromMilli(ing.quantity),
          to: fromMilli(target),
          reason,
          cost: costOf(fromMilli(delta), ing.cost_per_unit),
        },
      });
      this.#changed();
      return this.#one(ing.id);
    });
  }

  // ── The sample TS put in (stock-sample.ts) ──────────────────────────────

  /**
   * The example still on the stock and what «Убрать пример» would do: a sample recipe nobody saved
   * goes; a sample ingredient goes completely when nothing happened to it, is archived when it has
   * real history (sales, deliveries, counts, corrections), stays when the owner's own recipes use it.
   */
  sample(): StockSampleView {
    const db = this.#db;
    const sampleProducts = new Set(
      all<{ product_id: string }>(db, 'SELECT product_id FROM recipe_items GROUP BY product_id HAVING MIN(is_sample) = 1').map((r) => r.product_id),
    );
    const names = this.#productNames();
    const ingredients = all<IngredientRow>(db, 'SELECT * FROM ingredients WHERE is_sample = 1 AND is_archived = 0 AND deleted_at IS NULL')
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      .map((ing) => {
        const own = this.#recipesUsing(ing.id).filter((r) => !sampleProducts.has(r.productId));
        if (own.length > 0) {
          return { id: ing.id, name: ing.name, outcome: 'keep' as const, why: `в составе ${own.map((r) => `«${r.name}»`).join(', ')}` };
        }
        const kinds = new Set(
          all<{ kind: string }>(db, "SELECT DISTINCT kind FROM stock_movements WHERE ingredient_id = ? AND kind <> 'initial'", ing.id).map((r) => r.kind),
        );
        const why =
          kinds.has('sale') || kinds.has('return')
            ? 'уже были продажи'
            : kinds.has('supply') || one(db, 'SELECT id FROM supply_lines WHERE ingredient_id = ? LIMIT 1', ing.id)
              ? 'были поставки'
              : kinds.has('inventory') || one(db, 'SELECT id FROM stock_count_lines WHERE ingredient_id = ? LIMIT 1', ing.id)
                ? 'была инвентаризация'
                : kinds.size > 0
                  ? 'остаток уже исправляли или списывали'
                  : null;
        return { id: ing.id, name: ing.name, outcome: why ? ('archive' as const) : ('delete' as const), why };
      });
    const recipes = [...sampleProducts]
      .map((productId) => ({ productId, name: names.get(productId) ?? '—' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return { ingredients, recipes };
  }

  /** «Убрать пример со склада»: see `sample()`; what stays is the owner's from now on. */
  removeSample(input: { actor: string }): RemoveSampleResponse {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const plan = this.sample();
      for (const r of plan.recipes) run(db, 'DELETE FROM recipe_items WHERE product_id = ?', r.productId);
      const result: RemoveSampleResponse = { deleted: [], archived: [], kept: [], recipes: plan.recipes.map((r) => r.name) };
      for (const ing of plan.ingredients) {
        if (ing.outcome === 'delete') {
          // Only its example starting level was ever written: the example goes with it.
          run(db, "DELETE FROM stock_movements WHERE ingredient_id = ? AND kind = 'initial'", ing.id);
          run(db, 'DELETE FROM ingredients WHERE id = ?', ing.id);
          result.deleted.push(ing.name);
        } else if (ing.outcome === 'archive') {
          run(db, 'UPDATE ingredients SET is_archived = 1, is_sample = 0, updated_at = ? WHERE id = ?', now, ing.id);
          result.archived.push(ing.name);
        } else {
          run(db, 'UPDATE ingredients SET is_sample = 0, updated_at = ? WHERE id = ?', now, ing.id);
          result.kept.push({ name: ing.name, why: ing.why ?? '' });
        }
      }
      record(db, now, { actor: input.actor, action: 'stock.sample_removed', entityType: 'stock', entityId: 'sample', data: { ...result } });
      this.#changed();
      return result;
    });
  }

  /** The first-run checklist of «Склад»: raw materials → recipes → deliveries → sales. */
  setup(): StockSetupView {
    const db = this.#db;
    const n = (sql: string) => one<{ n: number }>(db, sql)?.n ?? 0;
    const products = all<{ id: string; name: string; has: number }>(
      db,
      `SELECT p.id, p.name, EXISTS (SELECT 1 FROM recipe_items r WHERE r.product_id = p.id) AS has
       FROM products p JOIN product_categories c ON c.id = p.category_id
       WHERE p.is_active = 1 AND c.is_active = 1
       ORDER BY c.sort_order, p.sort_order, p.name`,
    );
    return {
      ingredients: n('SELECT COUNT(*) AS n FROM ingredients WHERE is_archived = 0'),
      products: products.length,
      withoutRecipe: products.filter((p) => !p.has).map((p) => ({ productId: p.id, name: p.name })),
      supplies: n('SELECT COUNT(*) AS n FROM supplies WHERE deleted_at IS NULL'),
      sales: n("SELECT COUNT(DISTINCT order_id) AS n FROM stock_movements WHERE kind = 'sale'"),
    };
  }

  updateIngredient(input: UpdateIngredientRequest & { id: string; actor: string }): IngredientView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const current = this.#live(input.id);
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
      // An archived ingredient is hidden: recipes still taking it would move a level nobody sees.
      if (archived && current.is_archived === 0) {
        const recipes = this.#recipesUsing(current.id).map((r) => r.name);
        if (recipes.length > 0) {
          throw new HubError(
            409,
            'INGREDIENT_IN_RECIPES',
            `«${current.name}» есть в составе: ${recipes.join(', ')}. Уберите его оттуда или удалите вместе с составом`,
          );
        }
      }
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

  /**
   * Replaces the recipe of a product (base lines and option changes); empty lists remove it.
   * `sample` — TS's example (stock-sample.ts); a recipe the owner saves is theirs.
   */
  setRecipe(input: SetRecipeRequest & { productId: string; actor: string; sample?: boolean }): RecipeView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const product = this.#product(input.productId);
      const recipe: Recipe = { items: input.items ?? [], options: input.options ?? [] };
      const ingredientIds = new Set(all<{ id: string }>(db, 'SELECT id FROM ingredients WHERE deleted_at IS NULL').map((r) => r.id));
      const problems = validateRecipe(recipe, { ingredientIds, choiceIds: optionChoiceIds(product.options) });
      if (problems.length) throw new HubError(422, 'RECIPE_INVALID', problems.join('; '));
      run(db, 'DELETE FROM recipe_items WHERE product_id = ?', product.id);
      let order = 0;
      const insert = (choiceId: string | null, mode: RecipeRow['mode'], ingredientId: string, replacesId: string | null, quantity: number) =>
        run(
          db,
          `INSERT INTO recipe_items (product_id, choice_id, mode, ingredient_id, replaces_id, quantity, sort_order, updated_at, is_sample)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          product.id,
          choiceId,
          mode,
          ingredientId,
          replacesId,
          toMilli(quantity),
          ++order,
          now,
          input.sample === true ? 1 : 0,
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

  /** Deliveries, newest first, deleted ones included (marked); `viewer` decides `canChange`. */
  supplies(range: { from?: number | undefined; to?: number | undefined } = {}, viewer: StockViewer = ANY): SuppliesView {
    const { where, params } = rangeOf(range, 's.at');
    const rows = all<SupplyRow>(this.#db, `SELECT s.* FROM supplies s ${where} ORDER BY s.at DESC, s.rowid DESC LIMIT ${LIST_LIMIT}`, ...params);
    return { supplies: this.#supplyViews(rows, viewer) };
  }

  #supplyView(id: string, viewer: StockViewer): SupplyView {
    return this.#supplyViews([this.#supplyRow(id)], viewer)[0]!;
  }

  #supplyViews(rows: readonly SupplyRow[], viewer: StockViewer): SupplyView[] {
    const now = this.#clock.now();
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
    return rows.map((r): SupplyView => {
      const may = canChangeSupply({ at: r.at, createdById: r.created_by_id, deletedAt: r.deleted_at }, viewer, now);
      return {
        id: r.id,
        at: r.at,
        supplier: r.supplier,
        note: r.note,
        total: r.total,
        createdBy: r.created_by,
        lines: lines
          .filter((l) => l.supply_id === r.id)
          .map((l) => ({ ingredientId: l.ingredient_id, name: l.name, unit: l.unit, quantity: fromMilli(l.quantity), amount: l.amount })),
        deletedAt: r.deleted_at,
        deletedBy: r.deleted_by,
        deleteReason: r.delete_reason,
        changedAt: r.changed_at,
        changedBy: r.changed_by,
        canChange: may.ok,
        changeUntil: may.until,
      };
    });
  }

  /**
   * A delivery: every line adds to the stock and updates the ingredient's cost (weighted average).
   * A line may bring an ingredient that is not on the stock yet (`newIngredient`): it is created
   * with the delivery — whoever receives deliveries may do that.
   */
  createSupply(input: CreateSupplyRequest & { actor: string; actorId?: string | null; viewer?: StockViewer }): SupplyView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const supplier = cleanText(input.supplier, SUPPLIER_MAX, 'SUPPLIER_REQUIRED', 'поставщика', true)!;
      const note = cleanText(input.note, STOCK_NOTE_MAX, 'NOTE_TOO_LONG', 'комментарий', false);
      const checked = this.#supplyLines(input.lines, input.actor, now);
      const total = checked.reduce((s, l) => s + l.amount, 0);
      const id = randomUUID();
      run(
        db,
        'INSERT INTO supplies (id, at, supplier, note, total, created_by, created_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        now,
        supplier,
        note,
        total,
        input.actor,
        input.actorId ?? null,
      );
      for (const l of checked) {
        const before = this.#row(l.ing.id);
        run(
          db,
          'INSERT INTO supply_lines (supply_id, ingredient_id, quantity, amount, cost_before, has_cost_before) VALUES (?, ?, ?, ?, ?, 1)',
          id,
          l.ing.id,
          l.milli,
          l.amount,
          before.cost_per_unit,
        );
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
      return this.#supplyView(id, input.viewer ?? ANY);
    });
  }

  /**
   * «Удалить поставку»: a delivery typed in by mistake takes back exactly what it added — one
   * `supply_undo` movement per line, at the line's amount — and the price goes back to what it was
   * (see #costWithoutLine). If part of it was used already, the level goes below zero: sales are
   * never undone, and the level shows what is really missing. The delivery stays in the list, marked.
   * A line of an ingredient deleted since takes nothing: its stock went off when it was deleted.
   */
  deleteSupply(input: { id: string; reason?: string | undefined; actor: string; viewer?: StockViewer }): SupplyView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const supply = this.#supplyRow(input.id);
      this.#assertMayChange(supply, input.viewer ?? ANY, now);
      const reason = cleanText(input.reason, STOCK_NOTE_MAX, 'NOTE_TOO_LONG', 'причину', false);
      const text = `Поставка от ${this.#day(supply.at)} «${supply.supplier}» удалена${reason ? `: ${reason}` : ''}`;
      const lines = all<SupplyLineRow>(db, 'SELECT * FROM supply_lines WHERE supply_id = ? ORDER BY id', supply.id);
      const audit: Array<Record<string, unknown>> = [];
      // Last line first: two lines of the same ingredient give their prices back in turn.
      for (const line of [...lines].reverse()) {
        const ing = this.#row(line.ingredient_id);
        if (ing.deleted_at !== null) {
          audit.unshift({ ingredientId: ing.id, name: ing.name, quantity: fromMilli(line.quantity), amount: line.amount, deleted: true });
          continue;
        }
        const cost = this.#costWithoutLine(supply, line, ing.quantity, ing.cost_per_unit);
        run(db, 'UPDATE ingredients SET cost_per_unit = ? WHERE id = ?', cost, ing.id);
        const balance = move(db, now, {
          ingredientId: ing.id,
          deltaMilli: -line.quantity,
          kind: 'supply_undo',
          actor: input.actor,
          cost: -line.amount,
          supplyId: supply.id,
          reason: text,
        });
        audit.unshift({ ingredientId: ing.id, name: ing.name, quantity: fromMilli(line.quantity), amount: line.amount, balance: fromMilli(balance) });
      }
      run(
        db,
        'UPDATE supplies SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE id = ?',
        now,
        input.actor,
        reason,
        supply.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'stock.supply_deleted',
        entityType: 'supply',
        entityId: supply.id,
        data: { supplier: supply.supplier, at: supply.at, total: supply.total, reason, lines: audit },
      });
      this.#changed();
      return this.#supplyView(supply.id, input.viewer ?? ANY);
    });
  }

  /**
   * «Исправить поставку»: the delivery gets the corrected lines; only what differs moves, per
   * ingredient (`supply_fix`: the wrong item goes back, the right one comes in, a quantity or a sum
   * is put right), and each changed price is worked out again without the old lines and with the new.
   * The lines of an ingredient deleted since stay as they were: changing them is refused.
   */
  updateSupply(input: CreateSupplyRequest & { id: string; actor: string; viewer?: StockViewer }): SupplyView {
    const db = this.#db;
    const now = this.#clock.now();
    return transaction(db, () => {
      const supply = this.#supplyRow(input.id);
      this.#assertMayChange(supply, input.viewer ?? ANY, now);
      const supplier = cleanText(input.supplier, SUPPLIER_MAX, 'SUPPLIER_REQUIRED', 'поставщика', true)!;
      const note = cleanText(input.note, STOCK_NOTE_MAX, 'NOTE_TOO_LONG', 'комментарий', false);
      const old = all<SupplyLineRow>(db, 'SELECT * FROM supply_lines WHERE supply_id = ? ORDER BY id', supply.id);
      const checked = this.#supplyLines(input.lines, input.actor, now, new Set(old.map((l) => l.ingredient_id)));
      const changes = supplyChanges(
        old.map((l) => ({ ingredientId: l.ingredient_id, quantity: fromMilli(l.quantity), amount: l.amount })),
        checked.map((l) => ({ ingredientId: l.ing.id, quantity: fromMilli(l.milli), amount: l.amount })),
      );
      for (const c of changes) {
        const ing = this.#row(c.ingredientId);
        if (ing.deleted_at !== null) {
          throw new HubError(422, 'INGREDIENT_DELETED', `«${ing.name}» удалено — его строку в поставке не изменить, оставьте её как была`);
        }
      }
      const text = `Поставка от ${this.#day(supply.at)} «${supplier}» исправлена`;
      const changed = new Set(changes.map((c) => c.ingredientId));
      // The price each new line found: for a changed ingredient, worked out below; else kept as it was.
      const costBefore = new Map<number, { cost: number | null; known: boolean }>();
      checked.forEach((l, i) => {
        if (changed.has(l.ing.id)) return;
        const was = old.find((o) => o.ingredient_id === l.ing.id);
        costBefore.set(i, { cost: was?.cost_before ?? null, known: was?.has_cost_before === 1 });
      });
      const audit: Array<Record<string, unknown>> = [];
      for (const c of changes) {
        const ing = this.#row(c.ingredientId);
        let stock = ing.quantity;
        let cost = ing.cost_per_unit;
        for (const line of old.filter((l) => l.ingredient_id === ing.id).reverse()) {
          cost = this.#costWithoutLine(supply, line, stock, cost);
          stock -= line.quantity;
        }
        checked.forEach((l, i) => {
          if (l.ing.id !== ing.id) return;
          costBefore.set(i, { cost, known: true });
          if (l.amount > 0) cost = averageCost(fromMilli(stock), cost, fromMilli(l.milli), l.amount);
          stock += l.milli;
        });
        run(db, 'UPDATE ingredients SET cost_per_unit = ? WHERE id = ?', cost, ing.id);
        const balance = move(db, now, {
          ingredientId: ing.id,
          deltaMilli: toMilli(c.after.quantity) - toMilli(c.before.quantity),
          kind: 'supply_fix',
          actor: input.actor,
          cost: c.after.amount - c.before.amount,
          supplyId: supply.id,
          reason: text,
        });
        audit.push({ ingredientId: ing.id, name: ing.name, before: c.before, after: c.after, balance: fromMilli(balance) });
      }
      run(db, 'DELETE FROM supply_lines WHERE supply_id = ?', supply.id);
      checked.forEach((l, i) => {
        const before = costBefore.get(i) ?? { cost: null, known: false };
        run(
          db,
          'INSERT INTO supply_lines (supply_id, ingredient_id, quantity, amount, cost_before, has_cost_before) VALUES (?, ?, ?, ?, ?, ?)',
          supply.id,
          l.ing.id,
          l.milli,
          l.amount,
          before.cost,
          before.known ? 1 : 0,
        );
      });
      const total = checked.reduce((s, l) => s + l.amount, 0);
      run(
        db,
        'UPDATE supplies SET supplier = ?, note = ?, total = ?, changed_at = ?, changed_by = ? WHERE id = ?',
        supplier,
        note,
        total,
        now,
        input.actor,
        supply.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'stock.supply_changed',
        entityType: 'supply',
        entityId: supply.id,
        data: {
          supplier,
          note,
          total,
          lines: checked.map((l) => ({ ingredientId: l.ing.id, name: l.ing.name, quantity: fromMilli(l.milli), amount: l.amount })),
          changes: audit,
          was: {
            supplier: supply.supplier,
            note: supply.note,
            total: supply.total,
            lines: old.map((l) => ({ ingredientId: l.ingredient_id, quantity: fromMilli(l.quantity), amount: l.amount })),
          },
        },
      });
      this.#changed();
      return this.#supplyView(supply.id, input.viewer ?? ANY);
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
        const ing = this.#live(l.ingredientId);
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
      const ing = this.#live(input.ingredientId);
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

  #changed(): void {
    afterCommit(this.#db, () => this.#events.changed({ kind: 'stock' }));
  }

  /** Any ingredient row, deleted ones too (the history and old deliveries refer to them). */
  #row(id: string): IngredientRow {
    const row = one<IngredientRow>(this.#db, 'SELECT * FROM ingredients WHERE id = ?', id);
    if (!row) throw new HubError(404, 'INGREDIENT_NOT_FOUND', 'Сырьё не найдено');
    return row;
  }

  /** An ingredient a command may act on: a deleted one reads as not found, by its name. */
  #live(id: string): IngredientRow {
    const row = this.#row(id);
    if (row.deleted_at !== null) throw new HubError(404, 'INGREDIENT_NOT_FOUND', `Сырьё «${row.name}» удалено`);
    return row;
  }

  #one(id: string): IngredientView {
    return this.ingredients().ingredients.find((i) => i.id === id) ?? this.#view(this.#row(id), null, 0, true);
  }

  /** Ingredients something happened to: movements, delivery lines, count lines. */
  #withHistory(): Set<string> {
    return new Set(
      all<{ id: string }>(
        this.#db,
        `SELECT ingredient_id AS id FROM stock_movements
         UNION SELECT ingredient_id FROM supply_lines
         UNION SELECT ingredient_id FROM stock_count_lines`,
      ).map((r) => r.id),
    );
  }

  #insertIngredient(i: { name: string; unit: IngredientUnit; cost: number | null; minLevel: number | null; sample: boolean; now: number }): string {
    const id = randomUUID();
    run(
      this.#db,
      `INSERT INTO ingredients (id, name, unit, quantity, cost_per_unit, min_level, is_archived, is_sample, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, 0, ?, ?, ?)`,
      id,
      i.name,
      i.unit,
      i.cost,
      i.minLevel,
      i.sample ? 1 : 0,
      i.now,
      i.now,
    );
    return id;
  }

  /** Products whose recipe uses the ingredient — taken, or replaced by an option — by name. */
  #recipesUsing(ingredientId: string): Array<{ productId: string; name: string }> {
    return all<{ productId: string; name: string }>(
      this.#db,
      `SELECT DISTINCT p.id AS productId, p.name FROM recipe_items r JOIN products p ON p.id = r.product_id
       WHERE r.ingredient_id = ? OR r.replaces_id = ?`,
      ingredientId,
      ingredientId,
    ).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  #productNames(): Map<string, string> {
    return new Map(all<{ id: string; name: string }>(this.#db, 'SELECT id, name FROM products').map((r) => [r.id, r.name]));
  }

  /**
   * Lines of a delivery as typed: a known ingredient (not archived or deleted) or a new one created
   * on the spot (`newIngredient`; an active one of that name is used instead of a twin), a quantity
   * above 0 and the line's sum. Inside the delivery's transaction: a refused delivery creates nothing.
   */
  #supplyLines(
    raw: readonly SupplyLineInput[] | undefined,
    actor: string,
    now: number,
    /** A correction keeps the lines of an ingredient archived or deleted since the delivery. */
    keptOk: ReadonlySet<string> = new Set(),
  ): Array<{ ing: IngredientRow; milli: number; amount: number }> {
    const lines = Array.isArray(raw) ? raw : [];
    if (lines.length === 0) throw new HubError(422, 'SUPPLY_EMPTY', 'Добавьте хотя бы одну строку');
    if (lines.length > SUPPLY_MAX_LINES) throw new HubError(422, 'SUPPLY_TOO_LONG', `Не больше ${SUPPLY_MAX_LINES} строк`);
    return lines.map((l, i) => {
      let ing: IngredientRow;
      if (typeof l.ingredientId === 'string' && l.ingredientId) {
        ing = this.#row(l.ingredientId);
        if (ing.deleted_at !== null && !keptOk.has(ing.id)) throw new HubError(422, 'INGREDIENT_DELETED', `Строка ${i + 1}: «${ing.name}» удалено`);
        if (ing.is_archived && !keptOk.has(ing.id)) throw new HubError(422, 'INGREDIENT_ARCHIVED', `Строка ${i + 1}: «${ing.name}» в архиве`);
      } else if (l.newIngredient && typeof l.newIngredient === 'object') {
        ing = this.#findOrCreate(l.newIngredient, actor, now, i);
      } else {
        throw new HubError(422, 'LINE_INGREDIENT_REQUIRED', `Строка ${i + 1}: выберите сырьё`);
      }
      const milli = checkQty(l.quantity, true, `Строка ${i + 1}, количество`);
      if (!Number.isInteger(l.amount) || l.amount < 0) {
        throw new HubError(422, 'AMOUNT_INVALID', `Строка ${i + 1}: сумма — целое число не меньше нуля`);
      }
      return { ing, milli, amount: l.amount };
    });
  }

  #findOrCreate(raw: { name: string; unit: IngredientUnit }, actor: string, now: number, index: number): IngredientRow {
    const name = cleanText(raw.name, INGREDIENT_NAME_MAX, 'NAME_REQUIRED', `название сырья в строке ${index + 1}`, true)!;
    const unit = checkUnit(raw.unit);
    const wanted = name.toLocaleLowerCase('ru');
    const existing = all<IngredientRow>(this.#db, 'SELECT * FROM ingredients WHERE is_archived = 0 AND deleted_at IS NULL').find(
      (r) => r.name.toLocaleLowerCase('ru') === wanted,
    );
    if (existing) {
      if (existing.unit !== unit) {
        throw new HubError(422, 'UNIT_MISMATCH', `Строка ${index + 1}: «${existing.name}» уже есть на складе — в ${existing.unit}`);
      }
      return existing;
    }
    const id = this.#insertIngredient({ name, unit, cost: null, minLevel: null, sample: false, now });
    record(this.#db, now, {
      actor,
      action: 'stock.ingredient_created',
      entityType: 'ingredient',
      entityId: id,
      data: { name, unit, quantity: 0, costPerUnit: null, minLevel: null, via: 'supply' },
    });
    return this.#row(id);
  }

  #supplyRow(id: string): SupplyRow {
    const row = one<SupplyRow>(this.#db, 'SELECT * FROM supplies WHERE id = ?', id);
    if (!row) throw new HubError(404, 'SUPPLY_NOT_FOUND', 'Поставка не найдена');
    return row;
  }

  #assertMayChange(supply: SupplyRow, viewer: StockViewer, now: number): void {
    if (supply.deleted_at !== null) throw new HubError(409, 'SUPPLY_DELETED', 'Эта поставка уже удалена');
    if (!canChangeSupply({ at: supply.at, createdById: supply.created_by_id, deletedAt: null }, viewer, now).ok) {
      throw new HubError(
        403,
        'SUPPLY_CHANGE_FORBIDDEN',
        'Удалить или исправить поставку может директор или управляющий. Свою поставку — в течение 30 минут после приёмки',
      );
    }
  }

  /**
   * The price of an ingredient without one delivery line: the price just before it, when no later
   * delivery of that ingredient came since (exact); otherwise the line's value taken out of the
   * average (costWithout). Lines of the delivery being undone do not count as later.
   */
  #costWithoutLine(supply: SupplyRow, line: SupplyLineRow, stockMilli: number, cost: number | null): number | null {
    const later = one(
      this.#db,
      `SELECT l.id FROM supply_lines l JOIN supplies s ON s.id = l.supply_id
       WHERE l.ingredient_id = ? AND s.deleted_at IS NULL AND s.id <> ?
         AND (s.at > ? OR (s.at = ? AND s.rowid > (SELECT rowid FROM supplies WHERE id = ?)))
       LIMIT 1`,
      line.ingredient_id,
      supply.id,
      supply.at,
      supply.at,
      supply.id,
    );
    if (!later && line.has_cost_before === 1) return line.cost_before;
    return costWithout(fromMilli(stockMilli), cost, fromMilli(line.quantity), line.amount);
  }

  /** «2 нояб.» in the club's time zone, for movement reasons. */
  #day(at: number): string {
    const tz = one<{ timezone: string }>(this.#db, 'SELECT timezone FROM clubs ORDER BY created_at LIMIT 1')?.timezone;
    try {
      return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', ...(tz ? { timeZone: tz } : {}) }).format(at);
    } catch {
      return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(at);
    }
  }

  #view(r: IngredientRow, perDay: number | null, usedIn: number, hasHistory: boolean): IngredientView {
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
      hasHistory,
      isSample: r.is_sample === 1,
    };
  }

  #assertNameFree(name: string, exceptId: string | null): void {
    const wanted = name.toLocaleLowerCase('ru');
    const clash = all<{ id: string; name: string }>(this.#db, 'SELECT id, name FROM ingredients WHERE is_archived = 0 AND deleted_at IS NULL').find(
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
