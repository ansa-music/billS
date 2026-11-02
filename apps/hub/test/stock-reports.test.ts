import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  CatalogView,
  CreateCounterOrderResponse,
  IngredientsView,
  IngredientView,
  ProductView,
  ProfitReport,
  PurchaseListView,
  RecipeView,
  RemoveSampleResponse,
  SalesReport,
  StockAlertsView,
  StockSampleView,
  SupplyView,
} from '@bills/domain';
import { averageCost } from '@bills/domain';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { all, openDb } from '../src/db.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import type { SampleStockPreview, SampleStockResult } from '../src/stock-sample.ts';
import { seedSampleStock } from '../src/stock-sample.ts';
import type { TestHub } from './helpers.ts';
import { Harness, post } from './helpers.ts';

/**
 * Reports on top of «Склад»: «Заполнить примером» for a coffee shop that started without the
 * sample, «Докупить на неделю», the staff's «Заканчивается», «Себестоимость и прибыль» (with
 * deliveries deleted or corrected later) and «Что продаётся» — and who may see them.
 */

const DAY = 24 * 60 * 60 * 1000;
type ErrorBody = { error?: { code: string; message: string } };
const COFFEES = ['Эспрессо', 'Американо', 'Капучино', 'Латте', 'Раф', 'Флэт уайт'];
const DIRECTOR = 'Марат Директор';

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

/** The demo coffee shop's menu, but an empty «Склад» — like a client who started without the sample. */
async function emptyCafe(h: Harness, options: Parameters<Harness['start']>[1] = {}): Promise<TestHub> {
  const db = openDb(h.dbPath, h.clock.now());
  seedDemo(db, h.clock.now(), 'Asia/Almaty', 'cafe');
  db.close();
  return h.start(new SimulatorLampDriver({ latencyMs: 5 }), options);
}

async function get<T>(hub: TestHub, url: string): Promise<{ status: number; body: T & ErrorBody }> {
  const res = await hub.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T & ErrorBody };
}

async function send<T = unknown>(hub: TestHub, url: string, body: object = {}) {
  const res = await post(hub, url, body);
  return { status: res.status, body: res.body as unknown as T & ErrorBody };
}

async function products(hub: TestHub): Promise<ProductView[]> {
  return (await get<CatalogView>(hub, '/api/bar/catalog')).body.products;
}

async function productId(hub: TestHub, name: string): Promise<string> {
  const p = (await products(hub)).find((x) => x.name === name);
  if (!p) throw new Error(`No product ${name}`);
  return p.id;
}

async function ingredients(hub: TestHub): Promise<IngredientView[]> {
  return (await get<IngredientsView>(hub, '/api/stock/ingredients')).body.ingredients;
}

async function ingredient(hub: TestHub, name: string): Promise<IngredientView> {
  const found = (await ingredients(hub)).find((i) => i.name === name && !i.isArchived);
  if (!found) throw new Error(`No ingredient ${name}`);
  return found;
}

async function sell(hub: TestHub, lines: Array<{ product: string; qty?: number; options?: string[] }>, pay?: 'CASH' | 'CARD') {
  const items = await Promise.all(
    lines.map(async (l) => ({ productId: await productId(hub, l.product), qty: l.qty ?? 1, ...(l.options ? { options: l.options } : {}) })),
  );
  let payment = null;
  if (pay) {
    const total = (await products(hub))
      .filter((p) => items.some((i) => i.productId === p.id))
      .reduce((s, p) => s + p.price * items.find((i) => i.productId === p.id)!.qty, 0);
    payment = { parts: [{ method: pay, amount: total }] };
  }
  const res = await send<CreateCounterOrderResponse>(hub, '/api/counter/orders', { items, service: 'TAKEAWAY', payment });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.order;
}

async function tokenAs(hub: TestHub, name: string) {
  const staff = hub.hub.staff.list().find((s) => s.name === name);
  if (!staff) throw new Error(`No staff ${name}`);
  const { key } = hub.hub.auth.issueKey({ staffId: staff.id, actor: SYSTEM_ACTOR });
  const res = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'тест' } });
  const token = (res.json() as { token: string }).token;
  return {
    get: async (url: string) => {
      const r = await hub.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
      return { status: r.statusCode, body: r.json() as unknown };
    },
    post: async (url: string, payload: object) =>
      (await hub.app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } }))
        .statusCode,
  };
}

// ─── «Заполнить примером» ───────────────────────────────────────────────────

test('«Заполнить примером» on an empty stock: the sample for the coffees, marked as the example, never twice', async (t) => {
  const h = harness(t);
  const hub = await emptyCafe(h);
  assert.equal((await ingredients(hub)).length, 0);

  const preview = await get<SampleStockPreview>(hub, '/api/stock/sample/fill');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.ingredients, 10);
  assert.deepEqual(preview.body.products.map((p) => p.name), COFFEES, 'matcha latte and tea are not coffee');

  const filled = await send<SampleStockResult>(hub, '/api/stock/sample/fill', {});
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  assert.deepEqual(filled.body, { ingredients: 10, recipes: 6 });
  assert.ok((await ingredients(hub)).every((i) => i.isSample), 'every raw material is marked «пример»');

  // The recipe moved onto the product's choices: L takes 350 мл of milk and the 0,5 cup.
  const latte = (await get<RecipeView>(hub, `/api/stock/recipes/${await productId(hub, 'Латте')}`)).body;
  const milk = await ingredient(hub, 'Молоко 3,2%');
  const cupL = await ingredient(hub, 'Стакан 0,5');
  assert.ok(latte.options.some((o) => o.choiceId === 'l' && o.mode === 'set' && o.ingredientId === milk.id && o.quantity === 350));
  assert.ok(latte.options.some((o) => o.choiceId === 'l' && o.mode === 'swap' && o.ingredientId === cupL.id));
  assert.equal(latte.cost, 18 * 1200 + 200 * 60 + 3000);

  // Again: nothing new — no second milk, no second recipe.
  assert.deepEqual((await send<SampleStockResult>(hub, '/api/stock/sample/fill', {})).body, { ingredients: 0, recipes: 0 });
  assert.deepEqual((await get<SampleStockPreview>(hub, '/api/stock/sample/fill')).body, { ingredients: 0, products: [] });
  assert.equal((await ingredients(hub)).length, 10);
  assert.equal(all(hub.db, "SELECT id FROM stock_movements WHERE kind = 'initial'").length, 10);

  // «Убрать пример» sees all of it and takes it all away: nothing happened to it yet.
  const plan = (await get<StockSampleView>(hub, '/api/stock/sample')).body;
  assert.equal(plan.ingredients.length, 10);
  assert.deepEqual(plan.recipes.map((r) => r.name).sort(), [...COFFEES].sort());
  const removed = await send<RemoveSampleResponse>(hub, '/api/stock/sample/remove', {});
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.deleted.length, 10);
  assert.equal((await ingredients(hub)).length, 0);
  assert.equal(hub.hub.stock.recipes().recipes.length, 0);
});

test('«Заполнить примером» fits the coffee shop\'s own names and options and reuses its own raw materials', async (t) => {
  const h = harness(t);
  const hub = await emptyCafe(h);
  // The client's own milk, under its own name.
  const own = await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Молоко', unit: 'мл', quantity: 5000, costPerUnit: 55 });
  assert.equal(own.status, 201);
  // A drink of their own: «Флэт Уайт двойной» with sizes typed by hand and their own ids.
  const category = (await get<CatalogView>(hub, '/api/bar/catalog')).body.categories[0]!.id;
  const flat = await send<ProductView>(hub, '/api/bar/products', {
    categoryId: category,
    name: 'Флэт Уайт двойной',
    price: 1600_00,
    options: [
      { id: 'gsz', name: 'Объём', required: true, multiple: false, choices: [{ id: 'c03', name: '0,3', priceDelta: 0 }, { id: 'c04', name: '0,4', priceDelta: 200_00 }] },
      { id: 'gml', name: 'Молоко', required: false, multiple: false, choices: [{ id: 'coat', name: 'На овсяном', priceDelta: 300_00 }] },
    ],
  });
  assert.equal(flat.status, 201, JSON.stringify(flat.body));

  // One product only: just what its recipe needs, the client's milk reused (and still theirs).
  const one = await send<SampleStockResult>(hub, '/api/stock/sample/fill', { productIds: [flat.body.id] });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.recipes, 1);
  const names = (await ingredients(hub)).map((i) => i.name);
  assert.ok(!names.includes('Молоко 3,2%'), names.join());
  assert.ok(!names.includes('Сироп карамельный'), 'syrups are not on this drink');
  assert.equal((await ingredient(hub, 'Молоко')).isSample, false);
  assert.equal((await ingredient(hub, 'Овсяное молоко')).isSample, true);
  const recipe = (await get<RecipeView>(hub, `/api/stock/recipes/${flat.body.id}`)).body;
  const oat = await ingredient(hub, 'Овсяное молоко');
  const cupM = await ingredient(hub, 'Стакан 0,4');
  assert.deepEqual(
    recipe.options.map((o) => [o.choiceId, o.mode, o.ingredientId]),
    [
      ['c04', 'set', own.body.id],
      ['c04', 'swap', cupM.id],
      ['coat', 'swap', oat.id],
    ],
  );
  assert.equal(recipe.items.find((i) => i.ingredientId === own.body.id)?.quantity, 120);

  // Selling it takes the client's milk: 0,4 → 160 мл.
  await sell(hub, [{ product: 'Флэт Уайт двойной', options: ['c04'] }]);
  assert.equal((await ingredient(hub, 'Молоко')).quantity, 5000 - 160);

  // An unknown product is refused; the rest of the menu is still offered.
  assert.equal((await send(hub, '/api/stock/sample/fill', { productIds: [randomUUID()] })).status, 404);
  assert.deepEqual((await get<SampleStockPreview>(hub, '/api/stock/sample/fill')).body.products.map((p) => p.name), COFFEES);

  // «Убрать пример»: the client's milk stays theirs; the sample recipe they never saved goes.
  const removed = (await send<RemoveSampleResponse>(hub, '/api/stock/sample/remove', {})).body;
  assert.deepEqual(removed.recipes, ['Флэт Уайт двойной']);
  assert.ok((await ingredients(hub)).some((i) => i.name === 'Молоко' && !i.isArchived));
});

// ─── «Докупить на неделю» ───────────────────────────────────────────────────

test('«Докупить на неделю»: use per day × 7 + minimum − stock, rounded, priced, without archived raw materials', async (t) => {
  const h = harness(t);
  const hub = await emptyCafe(h);
  seedSampleStock(hub.hub, DIRECTOR);
  // Four days of ten lattes S: 2 000 мл of milk, 180 г of coffee, ten 0,3 cups a day.
  for (let day = 0; day < 4; day++) {
    await sell(hub, [{ product: 'Латте', qty: 10, options: ['s'] }]);
    h.clock.advance(DAY);
  }
  // Something archived below its minimum is not bought.
  const old = await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Сироп мятный', unit: 'мл', quantity: 10, minLevel: 500 });
  await send(hub, `/api/stock/ingredients/${old.body.id}/remove`, {});
  hub.hub.stock.writeOff({ ingredientId: old.body.id, quantity: 1, reason: 'Пролили', actor: DIRECTOR });

  const list = (await get<PurchaseListView>(hub, '/api/stock/purchase')).body;
  assert.equal(list.days, 7);
  assert.equal(list.usageDays, 4);
  const line = (name: string) => list.lines.find((l) => l.name === name);
  // Milk: 12 000 − 8 000 = 4 000 left, minimum 4 000: 2 000 × 7 + 4 000 − 4 000.
  assert.deepEqual([line('Молоко 3,2%')?.perDay, line('Молоко 3,2%')?.need, line('Молоко 3,2%')?.cost], [2000, 14_000, 14_000 * 60]);
  // Coffee: 3 000 − 720 = 2 280 left, minimum 1 000: ⌈180 × 7 + 1 000 − 2 280⌉ = −20 → nothing to buy.
  assert.equal(line('Кофе в зёрнах'), undefined);
  // Cups 0,3: 200 − 40 = 160, minimum 50: 10 × 7 + 50 − 160 < 0.
  assert.equal(line('Стакан 0,3'), undefined);
  assert.equal(line('Сироп мятный'), undefined);
  assert.equal(list.total, list.lines.reduce((s, l) => s + (l.cost ?? 0), 0));
});

// ─── «Заканчивается» for the staff ──────────────────────────────────────────

test('alerts: raw materials at zero or below the minimum flag their products; everyone at the counter sees them, without money', async (t) => {
  const h = harness(t);
  const hub = await emptyCafe(h, { secure: true });
  seedSampleStock(hub.hub, DIRECTOR);
  const milk = hub.hub.stock.ingredients().ingredients.find((i) => i.name === 'Молоко 3,2%')!;
  const coffee = hub.hub.stock.ingredients().ingredients.find((i) => i.name === 'Кофе в зёрнах')!;
  hub.hub.stock.writeOff({ ingredientId: milk.id, quantity: 12000, reason: 'Скисло', actor: DIRECTOR });
  // Coffee 3 000 → 900, below its minimum of 1 000.
  hub.hub.stock.writeOff({ ingredientId: coffee.id, quantity: 2100, reason: 'Рассыпали', actor: DIRECTOR });

  const barista = await tokenAs(hub, 'Данияр Бариста');
  const res = await barista.get('/api/stock/alerts');
  assert.equal(res.status, 200);
  const view = res.body as StockAlertsView;
  assert.deepEqual(
    view.low.map((l) => [l.name, l.out]),
    [
      ['Молоко 3,2%', true],
      ['Кофе в зёрнах', false],
    ],
  );
  const byId = new Map(hub.hub.bar.catalog().products.map((p) => [p.id, p.name]));
  const flagged = Object.fromEntries(view.products.map((p) => [byId.get(p.productId), `${p.level}: ${p.names.join(', ')}`]));
  assert.deepEqual(flagged, {
    Капучино: 'out: Молоко 3,2%',
    Латте: 'out: Молоко 3,2%',
    Раф: 'out: Молоко 3,2%',
    'Флэт уайт': 'out: Молоко 3,2%',
    Эспрессо: 'low: Кофе в зёрнах',
    Американо: 'low: Кофе в зёрнах',
  });
  assert.ok(!/cost|value|price/i.test(JSON.stringify(view)), 'no money');

  // The sale still goes through: the stock goes below zero.
  const latte = hub.hub.bar.catalog().products.find((p) => p.name === 'Латте')!;
  const cashier = await tokenAs(hub, 'Айгерим Кассир');
  assert.equal(await cashier.post('/api/counter/orders', { items: [{ productId: latte.id, qty: 1, options: ['s'] }], service: 'HERE', payment: null }), 201);
  assert.ok(hub.hub.stock.ingredients().ingredients.find((i) => i.id === milk.id)!.quantity < 0);
});

// ─── «Себестоимость и прибыль» ──────────────────────────────────────────────

test('profit: revenue, cost of goods sold by the recipes with options, cancels left out, no-recipe products flagged, losses apart', async (t) => {
  const h = harness(t);
  const hub = await emptyCafe(h);
  seedSampleStock(hub.hub, DIRECTOR);
  await send(hub, '/api/shifts/open', { openingFloat: 0 });

  await sell(hub, [{ product: 'Латте', qty: 2, options: ['s'] }], 'CASH');
  // L with oat milk: 350 мл of oat milk instead of milk, the 0,5 cup instead of the 0,3.
  await sell(hub, [{ product: 'Капучино', options: ['l', 'oat'] }, { product: 'Круассан', qty: 2 }], 'CARD');
  const cancelled = await sell(hub, [{ product: 'Раф', options: ['s'] }]);
  assert.equal((await send(hub, `/api/counter/orders/${cancelled.id}/cancel`, { reason: 'Гость передумал' })).status, 200);
  const milk = await ingredient(hub, 'Молоко 3,2%');
  const coffee = await ingredient(hub, 'Кофе в зёрнах');
  await send(hub, '/api/stock/writeoffs', { ingredientId: milk.id, quantity: 100, reason: 'Пролили' });
  // Count: 20 г of coffee short.
  await send(hub, '/api/stock/counts', { lines: [{ ingredientId: coffee.id, counted: coffee.quantity - 20 }] });

  const res = await get<ProfitReport>(hub, '/api/reports/profit');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body;
  const latteCost = 18 * 1200 + 200 * 60 + 3000;
  const cappuccinoCost = 18 * 1200 + 280 * 180 + 4000;
  const cappuccinoPrice = 1200_00 + 400_00 + 300_00;
  assert.equal(r.revenue, 2 * 1300_00 + cappuccinoPrice + 2 * 900_00, 'the cancelled raf is not revenue');
  assert.equal(r.cost, 2 * latteCost + cappuccinoCost, 'the raf is not in the cost either');
  assert.equal(r.profit, r.revenue - r.cost);
  assert.equal(r.margin, Math.round((r.profit / r.revenue) * 100));
  assert.equal(r.productsWithoutRecipe, 1);
  assert.equal(r.revenueWithoutRecipe, 2 * 900_00);
  const line = (name: string) => r.lines.find((l) => l.name === name)!;
  assert.deepEqual([line('Латте').qty, line('Латте').revenue, line('Латте').cost, line('Латте').profit], [2, 2 * 1300_00, 2 * latteCost, 2 * (1300_00 - latteCost)]);
  assert.equal(line('Капучино').cost, cappuccinoCost);
  assert.deepEqual([line('Круассан').noRecipe, line('Круассан').cost, line('Круассан').profit], [true, null, null]);
  assert.equal(r.lines.at(-1)!.name, 'Круассан', 'products without a recipe last');
  assert.equal(r.lines.find((l) => l.name === 'Раф'), undefined);
  // Losses: 100 мл of milk written off, 20 г of coffee short.
  assert.equal(r.losses.writeOff, 100 * 60);
  assert.equal(r.losses.shortage, 20 * 1200);
  assert.equal(r.losses.total, 100 * 60 + 20 * 1200);
  assert.equal(r.profitAfterLosses, r.profit - r.losses.total);
  assert.deepEqual(r.losses.lines.map((l) => [l.kind, l.name]).sort(), [['inventory', 'Кофе в зёрнах'], ['writeoff', 'Молоко 3,2%']]);

  // Revenue here is the owner's «Выручка сегодня».
  assert.equal(hub.hub.reports.summary().revenue.today, r.revenue);

  // An archived raw material keeps its cost in the report.
  const before = r.cost;
  await send(hub, `/api/stock/ingredients/${(await ingredient(hub, 'Овсяное молоко')).id}/remove`, { fromRecipes: true });
  assert.equal((await get<ProfitReport>(hub, '/api/reports/profit')).body.cost, before);

  // Yesterday: nothing; a period over several days covers today too.
  const today = r.from;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  assert.equal((await get<ProfitReport>(hub, `/api/reports/profit?from=${yesterday}&to=${yesterday}`)).body.revenue, 0);
  assert.equal((await get<ProfitReport>(hub, `/api/reports/profit?from=${yesterday}&to=${today}`)).body.revenue, r.revenue);
  assert.equal((await get(hub, '/api/reports/profit?from=2026-13-01')).status, 400);
  assert.equal((await get(hub, `/api/reports/profit?from=${today}&to=${yesterday}`)).status, 400);
  assert.equal((await get(hub, '/api/reports/profit?from=2024-01-01&to=2026-01-01')).status, 400);
});

test('profit: a delivery deleted or corrected later gives its sales the price as the deliveries stand now', async (t) => {
  const h = harness(t);
  const hub = await emptyCafe(h);
  // Milk at 60 per мл (6 000 ₸ per 10 л); coffee and cups priced too.
  const milk = (await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Молоко', unit: 'мл', quantity: 1000, costPerUnit: 60 })).body;
  const coffee = (await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Кофе', unit: 'г', quantity: 1000, costPerUnit: 1200 })).body;
  const latte = await productId(hub, 'Латте');
  assert.equal((await send(hub, `/api/stock/recipes/${latte}`, { items: [{ ingredientId: coffee.id, quantity: 18 }, { ingredientId: milk.id, quantity: 200 }], options: [] })).status, 200);

  // A delivery typed at 600 000 instead of 60 000: milk jumps to 330 per мл.
  const wrong = (await send<SupplyView>(hub, '/api/stock/supplies', { supplier: 'Ферма', lines: [{ ingredientId: milk.id, quantity: 1000, amount: 600_000 }] })).body;
  assert.equal((await ingredient(hub, 'Молоко')).costPerUnit, averageCost(1000, 60, 1000, 600_000));
  await sell(hub, [{ product: 'Латте', options: ['s'] }]);
  const coffeeCost = 18 * 1200;
  const report = async () => (await get<ProfitReport>(hub, '/api/reports/profit')).body;
  assert.equal((await report()).cost, coffeeCost + 200 * 330, 'as recorded at the sale');

  // Corrected: the latte is at the price that delivery really gave.
  assert.equal((await send(hub, `/api/stock/supplies/${wrong.id}/update`, { supplier: 'Ферма', lines: [{ ingredientId: milk.id, quantity: 1000, amount: 60_000 }] })).status, 200);
  assert.equal((await report()).cost, coffeeCost + 200 * averageCost(1000, 60, 1000, 60_000));

  // Deleted: the price before it; the next latte at the price the HUB gave back.
  assert.equal((await send(hub, `/api/stock/supplies/${wrong.id}/delete`, { reason: 'Ввели дважды' })).status, 200);
  assert.equal((await ingredient(hub, 'Молоко')).costPerUnit, 60);
  await sell(hub, [{ product: 'Латте', options: ['s'] }]);
  const r = await report();
  assert.equal(r.cost, 2 * (coffeeCost + 200 * 60));
  assert.equal(r.costIncomplete, false);
});

// ─── «Что продаётся» ────────────────────────────────────────────────────────

test('sales: tops, orders by hour, checks and the average check, money by payment method', async (t) => {
  const h = harness(t);
  const hub = await emptyCafe(h);
  await send(hub, '/api/shifts/open', { openingFloat: 0 });
  await sell(hub, [{ product: 'Эспрессо', qty: 3, options: ['s'] }], 'CASH');
  h.clock.advance(60 * 60 * 1000);
  await sell(hub, [{ product: 'Латте', options: ['s'] }, { product: 'Печенье', qty: 2 }], 'CARD');
  await sell(hub, [{ product: 'Латте', options: ['s'] }]); // not paid yet

  const r = (await get<SalesReport>(hub, '/api/reports/sales')).body;
  assert.equal(r.orders, 3);
  assert.equal(r.revenue, 3 * 800_00 + 1300_00 + 2 * 500_00 + 1300_00);
  assert.equal(r.items, 7);
  assert.deepEqual(r.topByQty.slice(0, 2).map((x) => [x.name, x.qty]), [['Эспрессо', 3], ['Латте', 2]]);
  assert.deepEqual(r.topByRevenue[0]!.name, 'Латте');
  assert.equal(r.checks, 2);
  assert.equal(r.avgCheck, Math.round((3 * 800_00 + 1300_00 + 2 * 500_00) / 2));
  assert.deepEqual(r.byMethod, { CASH: 3 * 800_00, CARD: 1300_00 + 2 * 500_00, QR: 0 });
  // MONDAY_NOON is 12:00 in Almaty (UTC+5): one order at 12, two at 13.
  assert.deepEqual([r.byHour[12]!.orders, r.byHour[13]!.orders], [1, 2]);
});

test('profit and sales are money: the director, the administrator and the senior — not the barista or the cashier', async (t) => {
  const h = harness(t);
  const hub = await emptyCafe(h, { secure: true });
  for (const name of ['Данияр Бариста', 'Айгерим Кассир']) {
    const who = await tokenAs(hub, name);
    assert.equal((await who.get('/api/reports/profit')).status, 403, name);
    assert.equal((await who.get('/api/reports/sales')).status, 403, name);
    assert.equal((await who.get('/api/stock/purchase')).status, 403, name);
    assert.equal((await who.get('/api/stock/sample/fill')).status, 403, name);
    assert.equal(await who.post('/api/stock/sample/fill', {}), 403, name);
    assert.equal((await who.get('/api/stock/alerts')).status, 200, name);
  }
  const admin = await tokenAs(hub, 'Асель Управляющая');
  assert.equal((await admin.get('/api/reports/profit')).status, 200);
  assert.equal((await admin.get('/api/reports/sales')).status, 200);
  assert.equal((await admin.get('/api/stock/purchase')).status, 200);
  assert.equal(await admin.post('/api/stock/sample/fill', {}), 200);
  const director = await tokenAs(hub, DIRECTOR);
  assert.equal((await director.get('/api/reports/profit')).status, 200);
});
