import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  CatalogView,
  CreateCounterOrderResponse,
  IngredientsView,
  IngredientView,
  RecipesView,
  RecipeView,
  StockCountsView,
  StockCountView,
  StockMovementsView,
  SuppliesView,
  SupplyView,
} from '@bills/domain';
import { ManualClock } from '../src/clock.ts';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { all, one, openDb } from '../src/db.ts';
import { buildApp } from '../src/http/app.ts';
import { Hub } from '../src/hub.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import { consumeForOrder, returnForOrder } from '../src/stock.ts';
import { seedSampleStock } from '../src/stock-sample.ts';
import { setupTrialClub } from '../src/trial.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, FAST_LAMPS, Harness, MONDAY_NOON, post, sessionStatus, tableId, waitFor } from './helpers.ts';

/**
 * «Склад»: raw materials, recipes (граммовка with option changes), sales taking the
 * recipe off the stock and cancellations giving it back, deliveries, inventory counts,
 * write-offs, the movement log and who may do what.
 */

const DAY = 24 * 60 * 60 * 1000;
type ErrorBody = { error?: { code: string; message: string } };

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

/** The demo coffee shop with the sample stock and recipes (what the browser trial gets). */
async function cafe(h: Harness, options: Parameters<Harness['start']>[1] = {}): Promise<TestHub> {
  const db = openDb(h.dbPath, h.clock.now());
  seedDemo(db, h.clock.now(), 'Asia/Almaty', 'cafe');
  db.close();
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), options);
  seedSampleStock(hub.hub, 'Марат Управляющий');
  return hub;
}

async function get<T>(hub: TestHub, url: string, token?: string): Promise<{ status: number; body: T & ErrorBody }> {
  const res = await hub.app.inject({ method: 'GET', url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  return { status: res.statusCode, body: res.json() as T & ErrorBody };
}

async function send<T = unknown>(hub: TestHub, url: string, body: object = {}, key?: string) {
  const res = await post(hub, url, body, key);
  return { status: res.status, body: res.body as unknown as T & ErrorBody };
}

function assertError(res: { status: number; body: ErrorBody }, status: number, code: string): void {
  assert.deepEqual({ status: res.status, code: res.body.error?.code }, { status, code }, JSON.stringify(res.body));
}

async function ingredients(hub: TestHub): Promise<IngredientView[]> {
  return (await get<IngredientsView>(hub, '/api/stock/ingredients')).body.ingredients;
}

async function ingredient(hub: TestHub, name: string): Promise<IngredientView> {
  const found = (await ingredients(hub)).find((i) => i.name === name && !i.isArchived);
  if (!found) throw new Error(`No ingredient ${name}`);
  return found;
}

/** Levels by name, for before/after comparisons. */
async function levels(hub: TestHub): Promise<Record<string, number>> {
  return Object.fromEntries((await ingredients(hub)).map((i) => [i.name, i.quantity]));
}

async function productId(hub: TestHub, name: string): Promise<string> {
  const catalog = (await get<CatalogView>(hub, '/api/bar/catalog')).body;
  const p = catalog.products.find((x) => x.name === name);
  if (!p) throw new Error(`No product ${name}`);
  return p.id;
}

async function sell(hub: TestHub, lines: Array<{ product: string; qty?: number; options?: string[] }>) {
  const items = await Promise.all(
    lines.map(async (l) => ({ productId: await productId(hub, l.product), qty: l.qty ?? 1, ...(l.options ? { options: l.options } : {}) })),
  );
  const res = await send<CreateCounterOrderResponse>(hub, '/api/counter/orders', { items, service: 'TAKEAWAY', payment: null });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.order;
}

/** b − a for every ingredient that changed, rounded to the thousandth. */
function diff(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(b)) {
    const d = Math.round(((b[k] ?? 0) - (a[k] ?? 0)) * 1000) / 1000;
    if (d !== 0) out[k] = d;
  }
  return out;
}

// ─── Ingredients ────────────────────────────────────────────────────────────

test('ingredients: create with a starting level, names unique, the unit locked once stock has moved', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);

  const created = await send<IngredientView>(hub, '/api/stock/ingredients', {
    name: '  Корица   молотая ',
    unit: 'г',
    quantity: 250.5,
    costPerUnit: 900,
    minLevel: 100,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.name, 'Корица молотая');
  assert.equal(created.body.quantity, 250.5);
  assert.equal(created.body.value, Math.round(250.5 * 900));
  assert.equal(created.body.low, false);
  assert.equal(created.body.daysLeft, null, 'no sales yet');
  const initial = (await get<StockMovementsView>(hub, `/api/stock/movements?ingredientId=${created.body.id}`)).body.movements;
  assert.deepEqual(
    initial.map((m) => [m.kind, m.quantity, m.balance]),
    [['initial', 250.5, 250.5]],
  );

  assertError(await send(hub, '/api/stock/ingredients', { name: 'корица МОЛОТАЯ', unit: 'г' }), 409, 'INGREDIENT_EXISTS');
  assertError(await send(hub, '/api/stock/ingredients', { name: 'Мёд', unit: 'кг' }), 422, 'UNIT_INVALID');
  assertError(await send(hub, '/api/stock/ingredients', { name: '   ', unit: 'г' }), 422, 'NAME_REQUIRED');
  assertError(await send(hub, '/api/stock/ingredients', { name: 'Мёд', unit: 'г', quantity: -1 }), 422, 'QUANTITY_INVALID');
  assertError(await send(hub, '/api/stock/ingredients', { name: 'Мёд', unit: 'г', costPerUnit: 1.5 }), 422, 'COST_INVALID');

  const updated = await send<IngredientView>(hub, `/api/stock/ingredients/${created.body.id}/update`, { minLevel: 300, name: 'Корица' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Корица');
  assert.equal(updated.body.low, true, 'below the new minimum');
  assertError(await send(hub, `/api/stock/ingredients/${created.body.id}/update`, { unit: 'мл' }), 409, 'UNIT_LOCKED');

  // A fresh one without movements may still change its unit; archived ones free their name.
  const fresh = await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Мёд', unit: 'г' });
  assert.equal((await send<IngredientView>(hub, `/api/stock/ingredients/${fresh.body.id}/update`, { unit: 'мл' })).body.unit, 'мл');
  const archived = await send<IngredientView>(hub, `/api/stock/ingredients/${fresh.body.id}/update`, { isArchived: true });
  assert.equal(archived.body.isArchived, true);
  assert.equal((await send(hub, '/api/stock/ingredients', { name: 'Мёд', unit: 'мл' })).status, 201);
  assertError(await send(hub, `/api/stock/ingredients/${fresh.body.id}/update`, { isArchived: false }), 409, 'INGREDIENT_EXISTS');
  assertError(await send(hub, `/api/stock/ingredients/${randomUUID()}/update`, { name: 'x' }), 404, 'INGREDIENT_NOT_FOUND');

  const actions = auditActions(hub);
  assert.ok(actions.includes('stock.ingredient_created'));
  assert.ok(actions.includes('stock.ingredient_updated'));
});

// ─── Recipes ────────────────────────────────────────────────────────────────

test('recipes: set, read back with the cost of a portion, validated against the menu options', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const latte = await productId(hub, 'Латте');
  const coffee = await ingredient(hub, 'Кофе в зёрнах');
  const milk = await ingredient(hub, 'Молоко 3,2%');
  const oat = await ingredient(hub, 'Овсяное молоко');

  const sample = (await get<RecipeView>(hub, `/api/stock/recipes/${latte}`)).body;
  assert.deepEqual(sample.items.slice(0, 2), [
    { ingredientId: coffee.id, quantity: 18 },
    { ingredientId: milk.id, quantity: 200 },
  ]);
  // 18 г × 12 ₸ + 200 мл × 0,60 ₸ + a 0,3 cup at 30 ₸.
  assert.equal(sample.cost, 18 * 1200 + 200 * 60 + 3000);
  assert.equal(sample.complete, true);

  const set = await send<RecipeView>(hub, `/api/stock/recipes/${latte}`, {
    items: [
      { ingredientId: coffee.id, quantity: 17.5 },
      { ingredientId: milk.id, quantity: 210 },
    ],
    options: [{ choiceId: 'oat', mode: 'swap', ingredientId: oat.id, replacesId: milk.id, quantity: 0 }],
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.cost, 17.5 * 1200 + 210 * 60);
  assert.deepEqual(set.body.options, [{ choiceId: 'oat', mode: 'swap', ingredientId: oat.id, replacesId: milk.id, quantity: 0 }]);
  assert.deepEqual((await get<RecipeView>(hub, `/api/stock/recipes/${latte}`)).body.items, set.body.items);

  const bad = await send(hub, `/api/stock/recipes/${latte}`, {
    items: [
      { ingredientId: coffee.id, quantity: 0 },
      { ingredientId: randomUUID(), quantity: 1 },
    ],
    options: [{ choiceId: 'xxl', mode: 'add', ingredientId: milk.id, quantity: 10 }],
  });
  assertError(bad, 422, 'RECIPE_INVALID');
  assert.match(bad.body.error!.message, /Строка 1.*Строка 2.*Добавка 1/s);
  assertError(await send(hub, `/api/stock/recipes/${randomUUID()}`, { items: [] }), 404, 'PRODUCT_NOT_FOUND');

  const list = (await get<RecipesView>(hub, '/api/stock/recipes')).body.recipes;
  assert.ok(list.some((r) => r.productId === latte && r.lines === 2 && r.optionLines === 1));
  // Empty lists remove the recipe.
  assert.equal((await send<RecipeView>(hub, `/api/stock/recipes/${latte}`, { items: [], options: [] })).body.cost, null);
  assert.ok(!(await get<RecipesView>(hub, '/api/stock/recipes')).body.recipes.some((r) => r.productId === latte));
  assert.ok(auditActions(hub).includes('stock.recipe_set'));
});

// ─── Sales and cancellations ────────────────────────────────────────────────

test('a sale takes the recipe off the stock with its options; a cancel gives exactly that back', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const before = await levels(hub);

  const order = await sell(hub, [
    { product: 'Латте', options: ['s'] },
    { product: 'Латте', qty: 2, options: ['l', 'oat', 'caramel'] },
    { product: 'Капучино', options: ['m', 'extra-shot'] },
    { product: 'Круассан' }, // no recipe: nothing but its own counted stock
  ]);
  const after = await levels(hub);
  assert.deepEqual(diff(before, after), {
    // 18 + 2 × 18 + (18 + 9 extra shot)
    'Кофе в зёрнах': -81,
    // latte S 200; cappuccino M 200; the two L oat lattes take no cow's milk
    'Молоко 3,2%': -400,
    // 2 × latte L 350 → oat
    'Овсяное молоко': -700,
    'Сироп карамельный': -40,
    'Стакан 0,3': -1,
    'Стакан 0,4': -1,
    'Стакан 0,5': -2,
  });

  const sales = all<{ kind: string; order_id: string; product_id: string; actor: string }>(
    hub.db,
    "SELECT kind, order_id, product_id, actor FROM stock_movements WHERE kind = 'sale'",
  );
  assert.ok(sales.length > 0 && sales.every((m) => m.order_id === order.id && m.actor === 'Кассир Айгерим'));
  assert.ok(sales.every((m) => m.product_id !== null));

  // Taking the same order again (a retry inside the HUB) does nothing.
  consumeForOrder(hub.db, order.id, [{ productId: await productId(hub, 'Латте'), qty: 5, choiceIds: [] }], h.clock.now());
  assert.deepEqual(await levels(hub), after);

  const cancelled = await send(hub, `/api/counter/orders/${order.id}/cancel`, { reason: 'Гость передумал' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual(await levels(hub), before);
  const returns = all<{ actor: string; cost: number | null }>(hub.db, "SELECT actor, cost FROM stock_movements WHERE kind = 'return'");
  assert.equal(returns.length, sales.length);
  assert.ok(returns.every((r) => r.actor === 'Кассир Айгерим'));
  // At cost, a sale and its cancellation add up to zero.
  assert.equal(one<{ c: number }>(hub.db, "SELECT SUM(cost) AS c FROM stock_movements WHERE kind IN ('sale', 'return')")!.c, 0);

  // Cancelling twice changes nothing; nor does a second return inside the HUB.
  assertError(await send(hub, `/api/counter/orders/${order.id}/cancel`, { reason: 'ещё раз' }), 409, 'ORDER_NOT_OPEN');
  returnForOrder(hub.db, order.id, h.clock.now());
  assert.deepEqual(await levels(hub), before);
});

test('a cancel gives back what the sale took even after the recipe changed', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const before = await levels(hub);
  const order = await sell(hub, [{ product: 'Латте', options: ['s'] }]);
  const milk = await ingredient(hub, 'Молоко 3,2%');
  await send(hub, `/api/stock/recipes/${await productId(hub, 'Латте')}`, { items: [{ ingredientId: milk.id, quantity: 999 }] });
  await send(hub, `/api/counter/orders/${order.id}/cancel`, { reason: 'Ошибка кассира' });
  assert.deepEqual(await levels(hub), before);
});

test('stock may go below zero: the sale goes through and the ingredient is flagged', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%');
  await send(hub, '/api/stock/counts', { lines: [{ ingredientId: milk.id, counted: 50 }] });
  await sell(hub, [{ product: 'Латте', options: ['s'] }]);
  const now = await ingredient(hub, 'Молоко 3,2%');
  assert.equal(now.quantity, -150);
  assert.equal(now.low, true);
  assert.equal(now.daysLeft, 0);
  assert.equal(now.value, 0, 'nothing in stock is worth nothing');
});

test('orders on a billiard game take the recipe too, and their cancel returns it', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const created = hub.hub.stock.createIngredient({ name: 'Кофе', unit: 'г', quantity: 1000, actor: 'test' });
  const americano = (await get<CatalogView>(hub, '/api/bar/catalog')).body.products.find((p) => p.name === 'Кофе американо')!;
  hub.hub.stock.setRecipe({ productId: americano.id, items: [{ ingredientId: created.id, quantity: 16 }], options: [], actor: 'test' });

  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  const order = await send<{ id: string }>(hub, `/api/sessions/${opened.body.id}/orders`, {
    items: [{ productId: americano.id, qty: 3 }],
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal((await ingredient(hub, 'Кофе')).quantity, 1000 - 48);
  await send(hub, `/api/orders/${order.body.id}/cancel`, { reason: 'Не тот стол' });
  assert.equal((await ingredient(hub, 'Кофе')).quantity, 1000);
});

test('«хватит на N дней» from the last two weeks of sales', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  // Four days of selling five lattes S a day: 1 000 мл of milk a day.
  for (let day = 0; day < 4; day++) {
    await sell(hub, [{ product: 'Латте', qty: 5, options: ['s'] }]);
    h.clock.advance(DAY);
  }
  const milk = await ingredient(hub, 'Молоко 3,2%');
  assert.equal(milk.quantity, 12000 - 4000);
  assert.equal(milk.perDay, 1000);
  assert.equal(milk.daysLeft, 8);
  assert.equal((await ingredient(hub, 'Сахар')).perDay, null, 'not used by a latte');
});

// ─── Deliveries ─────────────────────────────────────────────────────────────

test('a delivery adds stock, keeps the invoice amounts and averages the cost', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%'); // 12 000 мл at 0,60 ₸
  const cups = await ingredient(hub, 'Стакан 0,4');

  const res = await send<SupplyView>(hub, '/api/stock/supplies', {
    supplier: ' Молочная  ферма ',
    note: 'накладная 118',
    lines: [
      { ingredientId: milk.id, quantity: 12000, amount: 9600_00 }, // 0,80 ₸ per мл
      { ingredientId: cups.id, quantity: 50, amount: 0 }, // a free sample: the price stays
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.supplier, 'Молочная ферма');
  assert.equal(res.body.total, 9600_00);
  assert.deepEqual(
    res.body.lines.map((l) => [l.name, l.quantity, l.amount]),
    [
      ['Молоко 3,2%', 12000, 9600_00],
      ['Стакан 0,4', 50, 0],
    ],
  );

  const milkNow = await ingredient(hub, 'Молоко 3,2%');
  assert.equal(milkNow.quantity, 24000);
  assert.equal(milkNow.costPerUnit, 70, '(12 000 × 0,60 + 9 600) / 24 000 = 0,70 ₸');
  const cupsNow = await ingredient(hub, 'Стакан 0,4');
  assert.equal(cupsNow.quantity, 200);
  assert.equal(cupsNow.costPerUnit, 3500);

  const moves = (await get<StockMovementsView>(hub, `/api/stock/movements?ingredientId=${milk.id}`)).body.movements;
  assert.deepEqual([moves[0]!.kind, moves[0]!.quantity, moves[0]!.balance, moves[0]!.cost, moves[0]!.supplyId], [
    'supply',
    12000,
    24000,
    9600_00,
    res.body.id,
  ]);
  const list = (await get<SuppliesView>(hub, '/api/stock/supplies')).body.supplies;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.note, 'накладная 118');
  assert.equal(list[0]!.createdBy, 'Кассир Айгерим');
  assert.equal((await get<SuppliesView>(hub, `/api/stock/supplies?from=${h.clock.now() + 1}`)).body.supplies.length, 0);
  assert.ok(auditActions(hub).includes('stock.supply'));

  // Validation: nothing is written.
  assertError(await send(hub, '/api/stock/supplies', { supplier: 'Ферма', lines: [] }), 422, 'SUPPLY_EMPTY');
  assertError(await send(hub, '/api/stock/supplies', { supplier: '', lines: [{ ingredientId: milk.id, quantity: 1, amount: 1 }] }), 422, 'SUPPLIER_REQUIRED');
  assertError(
    await send(hub, '/api/stock/supplies', { supplier: 'Ферма', lines: [{ ingredientId: milk.id, quantity: 0, amount: 1 }] }),
    422,
    'QUANTITY_INVALID',
  );
  assertError(
    await send(hub, '/api/stock/supplies', {
      supplier: 'Ферма',
      lines: [
        { ingredientId: milk.id, quantity: 5, amount: 100 },
        { ingredientId: milk.id, quantity: 1, amount: -1 },
      ],
    }),
    422,
    'AMOUNT_INVALID',
  );
  // The 0,4 cup is in the size options of the sample recipes: removing it takes it out of them too.
  await send(hub, `/api/stock/ingredients/${cups.id}/remove`, { fromRecipes: true });
  assertError(
    await send(hub, '/api/stock/supplies', { supplier: 'Ферма', lines: [{ ingredientId: cups.id, quantity: 1, amount: 1 }] }),
    422,
    'INGREDIENT_ARCHIVED',
  );
  assert.equal((await ingredient(hub, 'Молоко 3,2%')).quantity, 24000);
  assert.equal(one<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM supplies')!.n, 1);
});

// ─── Inventory ──────────────────────────────────────────────────────────────

test('an inventory count sets the stock to what was counted and keeps the difference and its cost', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%'); // 12 000 at 0,60 ₸
  const coffee = await ingredient(hub, 'Кофе в зёрнах'); // 3 000 at 12 ₸
  const cups = await ingredient(hub, 'Стакан 0,3'); // 200
  await sell(hub, [{ product: 'Латте', options: ['s'] }]); // milk 11 800, coffee 2 982, cups 199

  const res = await send<StockCountView>(hub, '/api/stock/counts', {
    note: 'конец месяца',
    lines: [
      { ingredientId: milk.id, counted: 11500 },
      { ingredientId: coffee.id, counted: 3000.5 },
      { ingredientId: cups.id, counted: 199 },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.lines.map((l) => [l.name, l.expected, l.counted, l.difference, l.cost]),
    [
      ['Молоко 3,2%', 11800, 11500, -300, -300 * 60],
      ['Кофе в зёрнах', 2982, 3000.5, 18.5, 18.5 * 1200],
      ['Стакан 0,3', 199, 199, 0, 0],
    ],
  );
  assert.equal(res.body.diffCost, -300 * 60 + 18.5 * 1200);
  assert.equal(res.body.note, 'конец месяца');

  const now = await levels(hub);
  assert.equal(now['Молоко 3,2%'], 11500);
  assert.equal(now['Кофе в зёрнах'], 3000.5);
  assert.equal(now['Сахар'], 2000, 'not counted — not touched');
  const moves = all<{ ingredient_id: string; quantity: number; count_id: string }>(
    hub.db,
    "SELECT ingredient_id, quantity, count_id FROM stock_movements WHERE kind = 'inventory'",
  );
  assert.equal(moves.length, 2, 'no movement where nothing differed');
  assert.ok(moves.every((m) => m.count_id === res.body.id));

  const history = (await get<StockCountsView>(hub, '/api/stock/counts')).body.counts;
  assert.equal(history.length, 1);
  assert.equal(history[0]!.createdBy, 'Кассир Айгерим');
  assert.ok(auditActions(hub).includes('stock.count'));

  assertError(await send(hub, '/api/stock/counts', { lines: [] }), 422, 'COUNT_EMPTY');
  assertError(
    await send(hub, '/api/stock/counts', {
      lines: [
        { ingredientId: milk.id, counted: 1 },
        { ingredientId: milk.id, counted: 2 },
      ],
    }),
    422,
    'COUNT_REPEATED',
  );
  assertError(await send(hub, '/api/stock/counts', { lines: [{ ingredientId: milk.id, counted: -1 }] }), 422, 'QUANTITY_INVALID');
});

// ─── Write-off and movements ────────────────────────────────────────────────

test('a write-off takes stock down with its reason; the movement log tells the whole story', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%');

  const res = await send<IngredientView>(hub, '/api/stock/writeoffs', { ingredientId: milk.id, quantity: 500, reason: 'Пролили' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.quantity, 11500);
  assertError(await send(hub, '/api/stock/writeoffs', { ingredientId: milk.id, quantity: 5, reason: ' ' }), 422, 'REASON_REQUIRED');
  assertError(await send(hub, '/api/stock/writeoffs', { ingredientId: milk.id, quantity: 0, reason: 'Пролили' }), 422, 'QUANTITY_INVALID');
  assertError(await send(hub, '/api/stock/writeoffs', { ingredientId: randomUUID(), quantity: 1, reason: 'Пролили' }), 404, 'INGREDIENT_NOT_FOUND');
  const entry = one<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'stock.writeoff'")!;
  assert.deepEqual(JSON.parse(entry.data), { name: 'Молоко 3,2%', unit: 'мл', quantity: 500, reason: 'Пролили', cost: 500 * 60, balance: 11500 });

  h.clock.advance(60_000);
  const order = await sell(hub, [{ product: 'Латте', options: ['s'] }]);
  await send(hub, '/api/stock/supplies', { supplier: 'Ферма', lines: [{ ingredientId: milk.id, quantity: 1000, amount: 600_00 }] });

  const moves = (await get<StockMovementsView>(hub, `/api/stock/movements?ingredientId=${milk.id}`)).body.movements;
  assert.deepEqual(
    moves.map((m) => [m.kind, m.quantity, m.balance]),
    [
      ['supply', 1000, 12300],
      ['sale', -200, 11300],
      ['writeoff', -500, 11500],
      ['initial', 12000, 12000],
    ],
  );
  assert.equal(moves[1]!.orderId, order.id);
  assert.equal(moves[2]!.reason, 'Пролили');
  assert.equal(moves[2]!.cost, -500 * 60);

  // A period: only what happened after the write-off.
  const later = (await get<StockMovementsView>(hub, `/api/stock/movements?from=${h.clock.now()}`)).body.movements;
  assert.ok(later.length > 0 && later.every((m) => m.kind === 'sale' || m.kind === 'supply'));
  const before = (await get<StockMovementsView>(hub, `/api/stock/movements?to=${h.clock.now()}`)).body.movements;
  assert.ok(before.every((m) => m.kind === 'initial' || m.kind === 'writeoff'));
});

// ─── Who may do what ────────────────────────────────────────────────────────

test('permissions: a barista receives deliveries; recipes, counts and write-offs are for senior staff', async (t) => {
  const h = harness(t);
  const hub = await cafe(h, { secure: true });
  const tokenOf = async (name: string) => {
    const staff = hub.hub.staff.list().find((s) => s.name === name)!;
    const { key } = hub.hub.auth.issueKey({ staffId: staff.id, actor: SYSTEM_ACTOR });
    const res = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'тест' } });
    return (res.json() as { token: string }).token;
  };
  const as = (token: string) => ({
    get: async (url: string) => (await hub.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })).statusCode,
    post: async (url: string, payload: object) => {
      const res = await hub.app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      });
      return { status: res.statusCode, code: (res.json() as ErrorBody).error?.code };
    },
  });
  const milk = hub.hub.stock.ingredients().ingredients.find((i) => i.name === 'Молоко 3,2%')!;
  const latte = hub.hub.bar.catalog().products.find((p) => p.name === 'Латте')!;
  const supply = { supplier: 'Ферма', lines: [{ ingredientId: milk.id, quantity: 1000, amount: 600_00 }] };

  assert.equal((await hub.app.inject({ method: 'GET', url: '/api/stock/ingredients' })).statusCode, 401);

  for (const name of ['Данияр Бариста', 'Айгерим Кассир']) {
    const who = as(await tokenOf(name));
    assert.equal(await who.get('/api/stock/ingredients'), 200, name);
    assert.equal(await who.get('/api/stock/supplies'), 200, name);
    assert.equal((await who.post('/api/stock/supplies', supply)).status, 201, name);
    assert.equal(await who.get('/api/stock/recipes'), 403, name);
    assert.equal(await who.get(`/api/stock/recipes/${latte.id}`), 403, name);
    assert.equal(await who.get('/api/stock/counts'), 403, name);
    assert.equal(await who.get('/api/stock/movements'), 403, name);
    assert.deepEqual(await who.post(`/api/stock/recipes/${latte.id}`, { items: [] }), { status: 403, code: 'FORBIDDEN' }, name);
    assert.deepEqual(await who.post('/api/stock/counts', { lines: [{ ingredientId: milk.id, counted: 1 }] }), { status: 403, code: 'FORBIDDEN' }, name);
    assert.deepEqual(await who.post('/api/stock/writeoffs', { ingredientId: milk.id, quantity: 1, reason: 'Пролили' }), { status: 403, code: 'FORBIDDEN' }, name);
    assert.deepEqual(await who.post('/api/stock/ingredients', { name: 'Сливки', unit: 'мл' }), { status: 403, code: 'FORBIDDEN' }, name);
  }

  const admin = as(await tokenOf('Асель Управляющая'));
  assert.equal(await admin.get('/api/stock/movements'), 200);
  assert.equal((await admin.post('/api/stock/counts', { lines: [{ ingredientId: milk.id, counted: 5000 }] })).status, 201);
  assert.equal((await admin.post('/api/stock/writeoffs', { ingredientId: milk.id, quantity: 100, reason: 'Скисло' })).status, 201);
  assert.equal((await admin.post(`/api/stock/recipes/${latte.id}`, { items: [{ ingredientId: milk.id, quantity: 180 }] })).status, 200);
  assert.equal((await admin.post('/api/stock/ingredients', { name: 'Сливки', unit: 'мл' })).status, 201);

  // Who did it is the signed-in person, in the movement log and the journal.
  const supplies = all<{ created_by: string }>(hub.db, 'SELECT created_by FROM supplies ORDER BY at, rowid');
  assert.deepEqual(supplies.map((s) => s.created_by), ['Данияр Бариста', 'Айгерим Кассир']);
});

test('without the bar module in the license the stock is closed like the menu', async () => {
  const { decide } = await import('@bills/domain');
  const gate = { readOnly: false, modules: { bar: false, cloud: true, hardware: true } };
  assert.equal(decide(['manager'], 'stock.view', gate), 'module_off');
  assert.equal(decide(['manager'], 'stock.supply', { ...gate, modules: { ...gate.modules, bar: true }, readOnly: true }), 'read_only');
  assert.equal(decide(['manager'], 'stock.view', { ...gate, modules: { ...gate.modules, bar: true }, readOnly: true }), 'ok');
});

// ─── The browser trial ──────────────────────────────────────────────────────

test('the trial coffee shop with the sample menu starts with sample stock and recipes', async (t) => {
  const clock = new ManualClock(MONDAY_NOON);
  const db = openDb(':memory:', clock.now());
  const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 5 }), lampOptions: FAST_LAMPS });
  const app = buildApp(hub, {});
  await app.ready();
  await hub.license.init();
  t.after(async () => {
    await app.close();
    hub.close();
    db.close();
  });
  assert.equal(setupTrialClub(hub, { venue: 'Утро', managerName: 'Айгерим', key: '482913', timezone: 'Asia/Almaty', withMenu: true, now: clock.now() }), true);
  const names = hub.stock.ingredients().ingredients.map((i) => i.name);
  assert.ok(['Кофе в зёрнах', 'Молоко 3,2%', 'Овсяное молоко', 'Стакан 0,3', 'Стакан 0,4'].every((n) => names.includes(n)), names.join());
  const withRecipe = new Set(hub.stock.recipes().recipes.map((r) => r.productId));
  const coffees = hub.bar.catalog().products.filter((p) => ['Эспрессо', 'Американо', 'Капучино', 'Латте', 'Раф', 'Флэт уайт'].includes(p.name));
  assert.equal(coffees.length, 6);
  assert.ok(coffees.every((p) => withRecipe.has(p.id)));
  // Running it again adds nothing.
  assert.deepEqual(seedSampleStock(hub, 'Айгерим'), { ingredients: 0, recipes: 0 });

  // Without the sample menu: no sample stock either.
  const db2 = openDb(':memory:', clock.now());
  const hub2 = new Hub({ db: db2, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 5 }), lampOptions: FAST_LAMPS });
  t.after(() => {
    hub2.close();
    db2.close();
  });
  setupTrialClub(hub2, { venue: 'Пусто', managerName: 'Айгерим', key: '482913', timezone: 'Asia/Almaty', withMenu: false, now: clock.now() });
  assert.equal(hub2.stock.ingredients().ingredients.length, 0);
});
