import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  CatalogView,
  CreateCounterOrderResponse,
  IngredientRemovalView,
  IngredientsView,
  IngredientView,
  RecipeView,
  RemoveIngredientResponse,
  StockMovementsView,
  StockSetupView,
  SuppliesView,
  SupplyView,
} from '@bills/domain';
import { SUPPLY_CHANGE_WINDOW_MS } from '@bills/domain';
import { ManualClock } from '../src/clock.ts';
import { SYSTEM_ACTOR } from '../src/auth.ts';
import { all, MIGRATIONS_DIR, one, openDb, run } from '../src/db.ts';
import { Hub } from '../src/hub.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import { seedSampleStock } from '../src/stock-sample.ts';
import { setupTrialClub } from '../src/trial.ts';
import type { TestHub } from './helpers.ts';
import { auditActions, FAST_LAMPS, Harness, MONDAY_NOON, post } from './helpers.ts';

/**
 * «Склад», client feedback from a café on the trial: a delivery typed in by mistake is deleted or
 * corrected (counter-movements, never a rewrite), any ingredient — active or archived — can be
 * deleted (for good with its history kept, what is left written off; taken out of recipes when
 * asked), a level is put right by hand with a reason, the
 * example TS put in goes away at once, and a delivery line may bring a new ingredient.
 */

const MIN = 60 * 1000;
type ErrorBody = { error?: { code: string; message: string } };

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function cafe(h: Harness, options: Parameters<Harness['start']>[1] = {}): Promise<TestHub> {
  const db = openDb(h.dbPath, h.clock.now(), h.migrationsDir ? { migrationsDir: h.migrationsDir } : {});
  seedDemo(db, h.clock.now(), 'Asia/Almaty', 'cafe');
  db.close();
  const hub = await h.start(new SimulatorLampDriver({ latencyMs: 5 }), options);
  seedSampleStock(hub.hub, 'Марат Управляющий');
  return hub;
}

async function get<T>(hub: TestHub, url: string): Promise<{ status: number; body: T & ErrorBody }> {
  const res = await hub.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T & ErrorBody };
}

async function send<T = unknown>(hub: TestHub, url: string, body: object = {}) {
  const res = await post(hub, url, body);
  return { status: res.status, body: res.body as unknown as T & ErrorBody };
}

function assertError(res: { status: number; body: ErrorBody }, status: number, code: string): void {
  assert.deepEqual({ status: res.status, code: res.body.error?.code }, { status, code }, JSON.stringify(res.body));
}

async function ingredients(hub: TestHub): Promise<IngredientView[]> {
  return (await get<IngredientsView>(hub, '/api/stock/ingredients')).body.ingredients;
}

async function ingredient(hub: TestHub, name: string): Promise<IngredientView> {
  const found = (await ingredients(hub)).find((i) => i.name === name);
  if (!found) throw new Error(`No ingredient ${name}`);
  return found;
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

async function movements(hub: TestHub, ingredientId: string) {
  return (await get<StockMovementsView>(hub, `/api/stock/movements?ingredientId=${ingredientId}`)).body.movements;
}

// ─── Deleting a delivery ────────────────────────────────────────────────────

test('deleting a delivery takes back exactly what it added, at the old price; the log tells it honestly', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%'); // 12 000 мл at 0,60 ₸
  const cups = await ingredient(hub, 'Стакан 0,4'); // 150 at 35 ₸

  const supply = await send<SupplyView>(hub, '/api/stock/supplies', {
    supplier: 'Молочная ферма',
    lines: [
      { ingredientId: milk.id, quantity: 12000, amount: 9600_00 },
      { ingredientId: cups.id, quantity: 50, amount: 0 },
    ],
  });
  assert.equal(supply.status, 201, JSON.stringify(supply.body));
  assert.equal((await ingredient(hub, 'Молоко 3,2%')).costPerUnit, 70);
  assert.equal(supply.body.deletedAt, null);
  assert.equal(supply.body.canChange, true);

  h.clock.advance(5 * MIN);
  const deleted = await send<SupplyView>(hub, `/api/stock/supplies/${supply.body.id}/delete`, { reason: 'Ввели дважды' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.deletedAt, h.clock.now());
  assert.equal(deleted.body.deletedBy, 'Кассир Айгерим');
  assert.equal(deleted.body.deleteReason, 'Ввели дважды');
  assert.equal(deleted.body.canChange, false);

  const milkNow = await ingredient(hub, 'Молоко 3,2%');
  assert.equal(milkNow.quantity, 12000);
  assert.equal(milkNow.costPerUnit, 60, 'the price as it was before the delivery');
  const cupsNow = await ingredient(hub, 'Стакан 0,4');
  assert.equal(cupsNow.quantity, 150);
  assert.equal(cupsNow.costPerUnit, 3500);

  // Counter-movements: the delivery stays in the log, its undoing comes on top.
  const log = await movements(hub, milk.id);
  assert.deepEqual(
    log.slice(0, 2).map((m) => [m.kind, m.quantity, m.balance, m.cost, m.supplyId]),
    [
      ['supply_undo', -12000, 12000, -9600_00, supply.body.id],
      ['supply', 12000, 24000, 9600_00, supply.body.id],
    ],
  );
  assert.match(log[0]!.reason ?? '', /^Поставка от .+ «Молочная ферма» удалена: Ввели дважды$/);

  // Still in the list, marked; nothing more can be done to it.
  const list = (await get<SuppliesView>(hub, '/api/stock/supplies')).body.supplies;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.deletedAt, h.clock.now());
  assert.equal(list[0]!.lines.length, 2, 'the lines stay readable');
  assert.ok(auditActions(hub).includes('stock.supply_deleted'));
  assertError(await send(hub, `/api/stock/supplies/${supply.body.id}/delete`, {}), 409, 'SUPPLY_DELETED');
  assertError(
    await send(hub, `/api/stock/supplies/${supply.body.id}/update`, { supplier: 'x', lines: [{ ingredientId: milk.id, quantity: 1, amount: 1 }] }),
    409,
    'SUPPLY_DELETED',
  );
  assertError(await send(hub, `/api/stock/supplies/${randomUUID()}/delete`, {}), 404, 'SUPPLY_NOT_FOUND');
});

test('a delivery partly used already: deleting it takes the level below zero, the sale is never undone', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const beans = (await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Зерно Бразилия', unit: 'г' })).body;
  const supply = await send<SupplyView>(hub, '/api/stock/supplies', {
    supplier: 'Обжарщик',
    lines: [{ ingredientId: beans.id, quantity: 1000, amount: 12000_00 }],
  });
  assert.equal((await ingredient(hub, 'Зерно Бразилия')).costPerUnit, 1200);
  await send(hub, `/api/stock/recipes/${await productId(hub, 'Латте')}`, { items: [{ ingredientId: beans.id, quantity: 18 }] });
  await sell(hub, [{ product: 'Латте', qty: 2, options: ['s'] }]);
  assert.equal((await ingredient(hub, 'Зерно Бразилия')).quantity, 964);

  const deleted = await send<SupplyView>(hub, `/api/stock/supplies/${supply.body.id}/delete`, {});
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const now = await ingredient(hub, 'Зерно Бразилия');
  assert.equal(now.quantity, -36, 'the 36 г sold came from that delivery: the level shows it');
  assert.equal(now.low, true);
  assert.equal(now.costPerUnit, null, 'before that delivery the price was not known');
  assert.equal(now.value, null);
  const log = await movements(hub, beans.id);
  assert.deepEqual(
    log.map((m) => [m.kind, m.quantity, m.balance]),
    [
      ['supply_undo', -1000, -36],
      ['sale', -36, 964],
      ['supply', 1000, 1000],
    ],
  );
  assert.match(log[0]!.reason ?? '', /удалена$/);
});

test('deleting an older delivery after a newer one takes its value out of the average price', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%'); // 12 000 at 0,60
  const a = await send<SupplyView>(hub, '/api/stock/supplies', { supplier: 'А', lines: [{ ingredientId: milk.id, quantity: 12000, amount: 9600_00 }] });
  h.clock.advance(MIN);
  await send(hub, '/api/stock/supplies', { supplier: 'Б', lines: [{ ingredientId: milk.id, quantity: 6000, amount: 6000_00 }] });
  assert.equal((await ingredient(hub, 'Молоко 3,2%')).costPerUnit, 76);
  await send(hub, `/api/stock/supplies/${a.body.id}/delete`, {});
  const now = await ingredient(hub, 'Молоко 3,2%');
  assert.equal(now.quantity, 18000);
  // As if only the starting milk and delivery Б had come: (12 000 × 0,60 + 6 000) / 18 000 = 0,733 ₸.
  assert.equal(now.costPerUnit, 73);
});

// ─── Correcting a delivery ──────────────────────────────────────────────────

test('correcting a delivery moves only the differences: wrong item back, right item in, new item created', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const coffee = await ingredient(hub, 'Кофе в зёрнах'); // 3 000 at 12 ₸
  const milk = await ingredient(hub, 'Молоко 3,2%'); // 12 000 at 0,60
  const sugar = await ingredient(hub, 'Сахар'); // 2 000 at 0,60
  const vanilla = await ingredient(hub, 'Сироп ванильный'); // 1 000 at 4 ₸

  const supply = await send<SupplyView>(hub, '/api/stock/supplies', {
    supplier: 'Метро',
    lines: [
      { ingredientId: coffee.id, quantity: 2000, amount: 24000_00 },
      { ingredientId: milk.id, quantity: 12000, amount: 9600_00 },
      { ingredientId: sugar.id, quantity: 1000, amount: 600_00 }, // should have been vanilla syrup
    ],
  });
  assert.equal(supply.status, 201);
  h.clock.advance(3 * MIN);

  const fixed = await send<SupplyView>(hub, `/api/stock/supplies/${supply.body.id}/update`, {
    supplier: 'Метро',
    note: 'накладная 51',
    lines: [
      { ingredientId: coffee.id, quantity: 1000, amount: 12000_00 }, // came 1 kg, not 2
      { ingredientId: milk.id, quantity: 12000, amount: 9600_00 },
      { ingredientId: vanilla.id, quantity: 1000, amount: 6000_00 },
      { newIngredient: { name: 'Сливки 33%', unit: 'мл' }, quantity: 1000, amount: 2500_00 },
    ],
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.total, 12000_00 + 9600_00 + 6000_00 + 2500_00);
  assert.equal(fixed.body.note, 'накладная 51');
  assert.equal(fixed.body.changedAt, h.clock.now());
  assert.equal(fixed.body.changedBy, 'Кассир Айгерим');
  assert.equal(fixed.body.at, supply.body.at, 'still the delivery of that day');
  assert.deepEqual(
    fixed.body.lines.map((l) => [l.name, l.quantity]),
    [
      ['Кофе в зёрнах', 1000],
      ['Молоко 3,2%', 12000],
      ['Сироп ванильный', 1000],
      ['Сливки 33%', 1000],
    ],
  );

  const now = Object.fromEntries((await ingredients(hub)).map((i) => [i.name, i]));
  assert.equal(now['Кофе в зёрнах']!.quantity, 4000);
  assert.equal(now['Кофе в зёрнах']!.costPerUnit, 1200);
  assert.equal(now['Молоко 3,2%']!.quantity, 24000);
  assert.equal(now['Молоко 3,2%']!.costPerUnit, 70, 'the milk line did not change');
  assert.equal(now['Сахар']!.quantity, 2000);
  assert.equal(now['Сахар']!.costPerUnit, 60, 'back to its price before the wrong line');
  assert.equal(now['Сироп ванильный']!.quantity, 2000);
  assert.equal(now['Сироп ванильный']!.costPerUnit, 500, '(1 000 × 4 ₸ + 6 000 ₸) / 2 000');
  assert.equal(now['Сливки 33%']!.quantity, 1000);
  assert.equal(now['Сливки 33%']!.costPerUnit, 250);

  // Only what changed moved, as «Поставка исправлена»; the milk has no new movement.
  const fixes = all<{ ingredient_id: string; quantity: number; reason: string }>(
    hub.db,
    "SELECT ingredient_id, quantity, reason FROM stock_movements WHERE kind = 'supply_fix' ORDER BY id",
  );
  assert.deepEqual(
    fixes.map((f) => [f.ingredient_id, f.quantity / 1000]),
    [
      [coffee.id, -1000],
      [sugar.id, -1000],
      [vanilla.id, 1000],
      [now['Сливки 33%']!.id, 1000],
    ],
  );
  assert.ok(fixes.every((f) => /^Поставка от .+ «Метро» исправлена$/.test(f.reason)), fixes[0]!.reason);
  const entry = one<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'stock.supply_changed'")!;
  const data = JSON.parse(entry.data) as { was: { total: number }; total: number };
  assert.equal(data.was.total, 24000_00 + 9600_00 + 600_00);
  assert.equal(data.total, fixed.body.total);

  assertError(await send(hub, `/api/stock/supplies/${supply.body.id}/update`, { supplier: 'Метро', lines: [] }), 422, 'SUPPLY_EMPTY');
});

// ─── Who may delete or correct ──────────────────────────────────────────────

test('rights: whoever entered a delivery may delete or correct it for 30 minutes; the director and the administrator always', async (t) => {
  const h = harness(t);
  const hub = await cafe(h, { secure: true });
  const tokenOf = async (name: string) => {
    const staff = hub.hub.staff.list().find((s) => s.name === name)!;
    const { key } = hub.hub.auth.issueKey({ staffId: staff.id, actor: SYSTEM_ACTOR });
    const res = await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key, device: 'тест' } });
    return (res.json() as { token: string }).token;
  };
  const as = (token: string) => ({
    get: async <T>(url: string) => (await hub.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })).json() as T,
    post: async <T = unknown>(url: string, payload: object) => {
      const res = await hub.app.inject({
        method: 'POST',
        url,
        payload,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      });
      return { status: res.statusCode, body: res.json() as T & ErrorBody };
    },
  });
  const milk = hub.hub.stock.ingredients().ingredients.find((i) => i.name === 'Молоко 3,2%')!;
  const line = { ingredientId: milk.id, quantity: 1000, amount: 600_00 };
  const barista = as(await tokenOf('Данияр Бариста'));
  const cashier = as(await tokenOf('Айгерим Кассир'));
  const admin = as(await tokenOf('Асель Управляющая'));

  const mine = await barista.post<SupplyView>('/api/stock/supplies', { supplier: 'Ферма', lines: [line] });
  assert.equal(mine.status, 201);
  assert.equal(mine.body.canChange, true);
  assert.equal(mine.body.changeUntil, mine.body.at + SUPPLY_CHANGE_WINDOW_MS);
  const theirs = await cashier.post<SupplyView>('/api/stock/supplies', { supplier: 'Ферма', lines: [line] });

  // The barista's list: their own may be changed, the cashier's may not; the administrator may both.
  const seenByBarista = (await barista.get<SuppliesView>('/api/stock/supplies')).supplies;
  assert.deepEqual(seenByBarista.map((s) => [s.createdBy, s.canChange]), [
    ['Айгерим Кассир', false],
    ['Данияр Бариста', true],
  ]);
  const seenByAdmin = (await admin.get<SuppliesView>('/api/stock/supplies')).supplies;
  assert.ok(seenByAdmin.every((s) => s.canChange && s.changeUntil === null));

  const forbidden = await barista.post(`/api/stock/supplies/${theirs.body.id}/delete`, {});
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error?.code, 'SUPPLY_CHANGE_FORBIDDEN');
  assert.match(forbidden.body.error!.message, /директор или управляющий/);

  const corrected = await barista.post<SupplyView>(`/api/stock/supplies/${mine.body.id}/update`, {
    supplier: 'Ферма',
    lines: [{ ...line, quantity: 900 }],
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));

  h.clock.advance(SUPPLY_CHANGE_WINDOW_MS + MIN);
  const late = await barista.post(`/api/stock/supplies/${mine.body.id}/delete`, {});
  assert.equal(late.status, 403, 'half an hour later — only the director or the administrator');
  assert.equal((await admin.post(`/api/stock/supplies/${mine.body.id}/delete`, {})).status, 200);
  assert.equal((await admin.post(`/api/stock/supplies/${theirs.body.id}/delete`, {})).status, 200);

  // «Исправить остаток» and «Удалить» сырьё are for the director and the administrator.
  assert.equal((await barista.post(`/api/stock/ingredients/${milk.id}/adjust`, { quantity: 1, reason: 'Пересчитали' })).status, 403);
  assert.equal((await barista.post(`/api/stock/ingredients/${milk.id}/remove`, {})).status, 403);
  assert.equal((await barista.post('/api/stock/sample/remove', {})).status, 403);
});

// ─── A new item straight from the invoice ───────────────────────────────────

test('a delivery line may bring something not on the stock yet: it is created with the delivery', async (t) => {
  const h = harness(t);
  const hub = await cafe(h, { secure: true });
  const staff = hub.hub.staff.list().find((s) => s.name === 'Данияр Бариста')!;
  const { key } = hub.hub.auth.issueKey({ staffId: staff.id, actor: SYSTEM_ACTOR });
  const token = ((await hub.app.inject({ method: 'POST', url: '/api/auth/login', payload: { key } })).json() as { token: string }).token;
  const supplyAs = async (payload: object) => {
    const res = await hub.app.inject({
      method: 'POST',
      url: '/api/stock/supplies',
      payload,
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
    });
    return { status: res.statusCode, body: res.json() as SupplyView & ErrorBody };
  };
  const count = () => hub.hub.stock.ingredients().ingredients.length;
  const before = count();

  // A barista typing in an invoice: «Сливки 33%» are not on the stock yet.
  const res = await supplyAs({
    supplier: 'Молочная ферма',
    lines: [
      { newIngredient: { name: ' Сливки   33% ', unit: 'мл' }, quantity: 2000, amount: 5000_00 },
      { newIngredient: { name: 'молоко 3,2%', unit: 'мл' }, quantity: 1000, amount: 600_00 }, // exists: no twin
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(count(), before + 1);
  const cream = hub.hub.stock.ingredients().ingredients.find((i) => i.name === 'Сливки 33%')!;
  assert.equal(cream.quantity, 2000);
  assert.equal(cream.costPerUnit, 250);
  assert.equal(cream.isSample, false);
  assert.equal(hub.hub.stock.ingredients().ingredients.find((i) => i.name === 'Молоко 3,2%')!.quantity, 13000);
  const created = one<{ actor: string; data: string }>(hub.db, "SELECT actor, data FROM audit_log WHERE action = 'stock.ingredient_created' ORDER BY id DESC LIMIT 1")!;
  assert.equal(created.actor, 'Данияр Бариста');

  // Bad lines: nothing is created.
  const bad = await supplyAs({
    supplier: 'Ферма',
    lines: [
      { newIngredient: { name: 'Мёд', unit: 'мл' }, quantity: 1, amount: 1 },
      { newIngredient: { name: 'Корица', unit: 'кг' }, quantity: 1, amount: 1 },
    ],
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error?.code, 'UNIT_INVALID');
  const empty = await supplyAs({ supplier: 'Ферма', lines: [{ quantity: 1, amount: 1 }] });
  assert.equal(empty.body.error?.code, 'LINE_INGREDIENT_REQUIRED');
  assert.equal(count(), before + 1, 'a refused delivery creates nothing');
});

// ─── Removing an ingredient ─────────────────────────────────────────────────

test('removing an ingredient: never used — deleted; with history — deleted for good, the history keeps it; in recipes — named, taken out when asked', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);

  // Nothing ever happened to it: gone completely.
  const cinnamon = (await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Корица', unit: 'г' })).body;
  assert.equal(cinnamon.hasHistory, false);
  const plan = (await get<IngredientRemovalView>(hub, `/api/stock/ingredients/${cinnamon.id}/removal`)).body;
  assert.deepEqual([plan.outcome, plan.recipes], ['delete', []]);
  const gone = await send<RemoveIngredientResponse>(hub, `/api/stock/ingredients/${cinnamon.id}/remove`, {});
  assert.deepEqual(gone.body, { historyKept: false, recipes: [], quantity: 0 });
  assert.equal(one(hub.db, 'SELECT id FROM ingredients WHERE id = ?', cinnamon.id), undefined);

  // Sugar: in the Раф recipe and with a starting level — the dialog names the recipe.
  const sugar = await ingredient(hub, 'Сахар');
  assert.equal(sugar.hasHistory, true);
  const sugarPlan = (await get<IngredientRemovalView>(hub, `/api/stock/ingredients/${sugar.id}/removal`)).body;
  assert.equal(sugarPlan.outcome, 'history');
  assert.equal(sugarPlan.quantity, 2000);
  assert.deepEqual(sugarPlan.recipes.map((r) => r.name), ['Раф']);
  assert.deepEqual(sugarPlan.history, { movements: 1, supplies: 0, counts: 0 });
  const refused = await send(hub, `/api/stock/ingredients/${sugar.id}/remove`, {});
  assertError(refused, 409, 'INGREDIENT_IN_RECIPES');
  assert.match(refused.body.error!.message, /Раф/);
  // Archiving it by hand would leave the Раф taking hidden sugar: refused the same way.
  assertError(await send(hub, `/api/stock/ingredients/${sugar.id}/update`, { isArchived: true }), 409, 'INGREDIENT_IN_RECIPES');

  const removed = await send<RemoveIngredientResponse>(hub, `/api/stock/ingredients/${sugar.id}/remove`, { fromRecipes: true });
  assert.deepEqual(removed.body, { historyKept: true, recipes: ['Раф'], quantity: 2000 });
  assert.ok(!(await ingredients(hub)).some((i) => i.id === sugar.id), 'gone from the list and from the archive');
  const raf = (await get<RecipeView>(hub, `/api/stock/recipes/${await productId(hub, 'Раф')}`)).body;
  assert.ok(raf.items.length > 0 && raf.items.every((i) => i.ingredientId !== sugar.id));
  await sell(hub, [{ product: 'Раф', options: ['s'] }]);
  // The history keeps the name; what was left went off as «удалено».
  const log = await movements(hub, sugar.id);
  assert.deepEqual(
    log.map((m) => [m.kind, m.quantity, m.balance, m.reason, m.name]),
    [
      ['writeoff', -2000, 0, 'Сырьё удалено', 'Сахар'],
      ['initial', 2000, 2000, null, 'Сахар'],
    ],
    'a Раф no longer takes sugar',
  );

  // Milk: in the base of every milk drink, in the sizes and as what «Овсяное» replaces — all of it goes.
  const milk = await ingredient(hub, 'Молоко 3,2%');
  const milkPlan = (await get<IngredientRemovalView>(hub, `/api/stock/ingredients/${milk.id}/removal`)).body;
  assert.deepEqual(milkPlan.recipes.map((r) => r.name).sort(), ['Американо', 'Капучино', 'Латте', 'Раф', 'Флэт уайт']);
  await send(hub, `/api/stock/ingredients/${milk.id}/remove`, { fromRecipes: true });
  const left = all<{ n: number }>(hub.db, 'SELECT COUNT(*) AS n FROM recipe_items WHERE ingredient_id = ? OR replaces_id = ?', milk.id, milk.id);
  assert.equal(left[0]!.n, 0);
  const latte = (await get<RecipeView>(hub, `/api/stock/recipes/${await productId(hub, 'Латте')}`)).body;
  assert.ok(latte.items.length > 0, 'the rest of the recipe stays');
  assertError(await send(hub, `/api/stock/ingredients/${randomUUID()}/remove`, {}), 404, 'INGREDIENT_NOT_FOUND');
});

test('«Удалить» an archived raw material with stock on hand: gone for good, written off as «удалено», its name free again', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const coffee = await ingredient(hub, 'Кофе в зёрнах'); // 3 000 г at 12 ₸, in all six coffees
  await sell(hub, [{ product: 'Латте', options: ['s'] }]); // −18 г
  const supply = await send<SupplyView>(hub, '/api/stock/supplies', {
    supplier: 'Обжарщик',
    lines: [{ ingredientId: coffee.id, quantity: 1000, amount: 12000_00 }],
  });
  assert.equal(supply.status, 201);
  const count = await send(hub, '/api/stock/counts', { lines: [{ ingredientId: coffee.id, counted: 3900 }] });
  assert.equal(count.status, 201);
  // Out of the recipes by hand, then into the archive — like the owner's «10 в архиве».
  for (const p of ['Американо', 'Капучино', 'Латте', 'Раф', 'Флэт уайт', 'Эспрессо']) {
    const id = await productId(hub, p);
    const r = (await get<RecipeView>(hub, `/api/stock/recipes/${id}`)).body;
    const res = await send(hub, `/api/stock/recipes/${id}`, {
      items: r.items.filter((i) => i.ingredientId !== coffee.id),
      options: r.options.filter((o) => o.ingredientId !== coffee.id && o.replacesId !== coffee.id),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  assert.equal((await send(hub, `/api/stock/ingredients/${coffee.id}/update`, { isArchived: true })).status, 200);
  assert.equal((await ingredient(hub, 'Кофе в зёрнах')).isArchived, true);

  h.clock.advance(MIN);
  const plan = (await get<IngredientRemovalView>(hub, `/api/stock/ingredients/${coffee.id}/removal`)).body;
  assert.equal(plan.outcome, 'history');
  assert.equal(plan.quantity, 3900);
  assert.deepEqual(plan.recipes, []);
  assert.deepEqual(plan.history, { movements: 4, supplies: 1, counts: 1 });
  const removed = await send<RemoveIngredientResponse>(hub, `/api/stock/ingredients/${coffee.id}/remove`, {});
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body, { historyKept: true, recipes: [], quantity: 3900 });

  // Gone from the levels, the archive, the sample — the row stays for the history.
  assert.ok(!(await ingredients(hub)).some((i) => i.id === coffee.id));
  assert.ok(!hub.hub.stock.sample().ingredients.some((i) => i.id === coffee.id));
  const row = one<{ deleted_at: number | null; quantity: number; is_sample: number }>(
    hub.db,
    'SELECT deleted_at, quantity, is_sample FROM ingredients WHERE id = ?',
    coffee.id,
  )!;
  assert.deepEqual({ ...row }, { deleted_at: h.clock.now(), quantity: 0, is_sample: 0 });
  // The stock it had went off at its cost, so the totals stay honest.
  const [last] = await movements(hub, coffee.id);
  assert.deepEqual([last!.kind, last!.quantity, last!.balance, last!.cost, last!.reason], ['writeoff', -3900, 0, -3900 * 1200, 'Сырьё удалено']);
  // Deliveries, counts and the journal still name it.
  assert.equal((await get<SuppliesView>(hub, '/api/stock/supplies')).body.supplies[0]!.lines[0]!.name, 'Кофе в зёрнах');
  assert.equal(hub.hub.stock.counts().counts[0]!.lines[0]!.name, 'Кофе в зёрнах');
  const entry = one<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'stock.ingredient_removed' ORDER BY id DESC LIMIT 1")!;
  assert.deepEqual(JSON.parse(entry.data), {
    name: 'Кофе в зёрнах',
    unit: 'г',
    outcome: 'deleted',
    historyKept: true,
    recipes: [],
    quantity: 3900,
    cost: -3900 * 1200,
  });

  // Nothing can be done to it any more — it cannot come back from a screen.
  assertError(await send(hub, `/api/stock/ingredients/${coffee.id}/update`, { isArchived: false }), 404, 'INGREDIENT_NOT_FOUND');
  assertError(await send(hub, `/api/stock/ingredients/${coffee.id}/adjust`, { quantity: 1, reason: 'Пересчитали' }), 404, 'INGREDIENT_NOT_FOUND');
  assertError(await send(hub, '/api/stock/writeoffs', { ingredientId: coffee.id, quantity: 1, reason: 'Пролили' }), 404, 'INGREDIENT_NOT_FOUND');
  assertError(await send(hub, '/api/stock/counts', { lines: [{ ingredientId: coffee.id, counted: 1 }] }), 404, 'INGREDIENT_NOT_FOUND');
  assertError(await send(hub, `/api/stock/ingredients/${coffee.id}/remove`, {}), 404, 'INGREDIENT_NOT_FOUND');
  assert.equal((await get(hub, `/api/stock/ingredients/${coffee.id}/removal`)).status, 404);
  assertError(
    await send(hub, '/api/stock/supplies', { supplier: 'Обжарщик', lines: [{ ingredientId: coffee.id, quantity: 1, amount: 1 }] }),
    422,
    'INGREDIENT_DELETED',
  );
  assertError(
    await send(hub, `/api/stock/recipes/${await productId(hub, 'Эспрессо')}`, { items: [{ ingredientId: coffee.id, quantity: 9 }] }),
    422,
    'RECIPE_INVALID',
  );

  // A new «Кофе в зёрнах» can be made — typed in, or brought by a delivery line.
  const again = await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Кофе в зёрнах', unit: 'г' });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.notEqual(again.body.id, coffee.id);
  assert.deepEqual([again.body.quantity, again.body.hasHistory, again.body.isSample], [0, false, false]);
  const fresh = await send<SupplyView>(hub, '/api/stock/supplies', {
    supplier: 'Обжарщик',
    lines: [{ newIngredient: { name: 'кофе в зёрнах', unit: 'г' }, quantity: 500, amount: 6000_00 }],
  });
  assert.equal(fresh.body.lines[0]!.ingredientId, again.body.id, 'the delivery finds the new one, not the deleted one');
});

test('a level below zero is brought to zero when the raw material is deleted', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const cream = (await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Сливки', unit: 'мл', quantity: 500, costPerUnit: 200 })).body;
  await send(hub, '/api/stock/writeoffs', { ingredientId: cream.id, quantity: 600, reason: 'Скисло' });
  assert.equal((await ingredient(hub, 'Сливки')).quantity, -100);
  const plan = (await get<IngredientRemovalView>(hub, `/api/stock/ingredients/${cream.id}/removal`)).body;
  assert.deepEqual([plan.outcome, plan.quantity], ['history', -100]);
  const removed = await send<RemoveIngredientResponse>(hub, `/api/stock/ingredients/${cream.id}/remove`, {});
  assert.deepEqual(removed.body, { historyKept: true, recipes: [], quantity: -100 });
  const [last] = await movements(hub, cream.id);
  assert.deepEqual([last!.kind, last!.quantity, last!.balance, last!.cost, last!.reason], ['adjust', 100, 0, 200 * 100, 'Сырьё удалено']);
});

test('after a raw material is deleted, a cancelled order and a deleted or corrected delivery leave it at zero', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%');
  const cups = await ingredient(hub, 'Стакан 0,5'); // 100
  const supply = await send<SupplyView>(hub, '/api/stock/supplies', {
    supplier: 'Метро',
    lines: [
      { ingredientId: milk.id, quantity: 1000, amount: 600_00 },
      { ingredientId: cups.id, quantity: 50, amount: 2000_00 },
    ],
  });
  const order = await sell(hub, [{ product: 'Латте', options: ['l'] }]); // a 0,5 cup and 350 мл
  assert.equal((await ingredient(hub, 'Стакан 0,5')).quantity, 149);
  const removed = await send<RemoveIngredientResponse>(hub, `/api/stock/ingredients/${cups.id}/remove`, { fromRecipes: true });
  assert.equal(removed.body.quantity, 149);
  const level = () => one<{ quantity: number }>(hub.db, 'SELECT quantity FROM ingredients WHERE id = ?', cups.id)!.quantity;
  const cupMoves = () => all(hub.db, 'SELECT id FROM stock_movements WHERE ingredient_id = ?', cups.id).length;
  const before = cupMoves();

  // The cancel gives the milk back; the deleted cups stay at zero.
  await send(hub, `/api/counter/orders/${order.id}/cancel`, { reason: 'Гость передумал' });
  assert.equal((await ingredient(hub, 'Молоко 3,2%')).quantity, 13000);
  assert.deepEqual([level(), cupMoves()], [0, before]);

  // A correction keeps the line of the deleted cups as it was; changing that line is refused.
  const fixed = await send<SupplyView>(hub, `/api/stock/supplies/${supply.body.id}/update`, {
    supplier: 'Метро',
    lines: [
      { ingredientId: milk.id, quantity: 2000, amount: 1200_00 },
      { ingredientId: cups.id, quantity: 50, amount: 2000_00 },
    ],
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.lines[1]!.name, 'Стакан 0,5');
  assert.equal((await ingredient(hub, 'Молоко 3,2%')).quantity, 14000);
  const changed = await send(hub, `/api/stock/supplies/${supply.body.id}/update`, {
    supplier: 'Метро',
    lines: [{ ingredientId: milk.id, quantity: 2000, amount: 1200_00 }],
  });
  assertError(changed, 422, 'INGREDIENT_DELETED');
  assert.match(changed.body.error!.message, /Стакан 0,5/);

  // Deleting the delivery takes the milk back; nothing moves on the deleted cups.
  const deleted = await send<SupplyView>(hub, `/api/stock/supplies/${supply.body.id}/delete`, {});
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await ingredient(hub, 'Молоко 3,2%')).quantity, 12000);
  assert.deepEqual([level(), cupMoves()], [0, before]);
});

test('migration 022: ingredients get deleted_at; an old base keeps its rows as they were', async (t) => {
  const h = harness(t);
  const dir = join(h.dir, 'migrations');
  mkdirSync(dir);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (Number.parseInt(f, 10) < 22) copyFileSync(new URL(f, MIGRATIONS_DIR), join(dir, f));
  const old = openDb(h.dbPath, h.clock.now(), { migrationsDir: pathToFileURL(dir + '/') });
  run(old, "INSERT INTO ingredients (id, name, unit, quantity, is_archived, created_at, updated_at) VALUES ('a', 'Кофе в зёрнах', 'г', 1500, 1, 1, 1)");
  old.close();
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('022_'))!;
  copyFileSync(new URL(file, MIGRATIONS_DIR), join(dir, file));
  const db = openDb(h.dbPath, h.clock.now(), { migrationsDir: pathToFileURL(dir + '/') });
  try {
    assert.deepEqual({ ...one<object>(db, 'SELECT id, quantity, is_archived, deleted_at FROM ingredients') }, { id: 'a', quantity: 1500, is_archived: 1, deleted_at: null });
  } finally {
    db.close();
  }
});

// ─── «Исправить остаток» ────────────────────────────────────────────────────

test('«Исправить остаток»: the level as it really is, with a reason — an adjustment on top, the sale untouched', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%'); // 12 000 at 0,60
  await sell(hub, [{ product: 'Латте', options: ['s'] }]); // −200
  h.clock.advance(MIN);

  const res = await send<IngredientView>(hub, `/api/stock/ingredients/${milk.id}/adjust`, { quantity: 11900, reason: 'Продажа списала лишнее' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.quantity, 11900);
  const log = await movements(hub, milk.id);
  assert.deepEqual(
    log.slice(0, 2).map((m) => [m.kind, m.quantity, m.balance, m.cost, m.reason]),
    [
      ['adjust', 100, 11900, 100 * 60, 'Продажа списала лишнее'],
      ['sale', -200, 11800, -200 * 60, null],
    ],
  );
  assert.ok(auditActions(hub).includes('stock.adjusted'));

  assertError(await send(hub, `/api/stock/ingredients/${milk.id}/adjust`, { quantity: 11900, reason: 'Пересчитали' }), 422, 'NOTHING_CHANGED');
  assertError(await send(hub, `/api/stock/ingredients/${milk.id}/adjust`, { quantity: 100, reason: ' ' }), 422, 'REASON_REQUIRED');
  assertError(await send(hub, `/api/stock/ingredients/${milk.id}/adjust`, { quantity: -1, reason: 'Пересчитали' }), 422, 'QUANTITY_INVALID');
  // Down to zero is fine.
  assert.equal((await send<IngredientView>(hub, `/api/stock/ingredients/${milk.id}/adjust`, { quantity: 0, reason: 'Скисло всё' })).body.quantity, 0);
});

// ─── The example TS put in ──────────────────────────────────────────────────

test('the sample stock: marked, changeable like your own, removed at once — what was used stays, explained', async (t) => {
  const clock = new ManualClock(MONDAY_NOON);
  const db = openDb(':memory:', clock.now());
  const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 5 }), lampOptions: FAST_LAMPS });
  await hub.license.init();
  t.after(() => {
    hub.close();
    db.close();
  });
  setupTrialClub(hub, { venue: 'Утро', managerName: 'Айгерим', key: '482913', timezone: 'Asia/Almaty', withMenu: true, now: clock.now() });
  const actor = 'Айгерим';
  const byName = () => new Map(hub.stock.ingredients().ingredients.map((i) => [i.name, i]));
  assert.ok([...byName().values()].every((i) => i.isSample));
  const sample = hub.stock.sample();
  assert.equal(sample.ingredients.length, 10);
  assert.ok(sample.ingredients.every((i) => i.outcome === 'delete'));
  assert.equal(sample.recipes.length, 6);

  // The owner changes the Американо: it is theirs now. An own ingredient is never part of the sample.
  const product = (name: string) => hub.bar.catalog().products.find((p) => p.name === name)!;
  const coffee = byName().get('Кофе в зёрнах')!;
  const cup = byName().get('Стакан 0,3')!;
  hub.stock.setRecipe({
    productId: product('Американо').id,
    items: [
      { ingredientId: coffee.id, quantity: 20 },
      { ingredientId: cup.id, quantity: 1 },
    ],
    options: [],
    actor,
  });
  hub.stock.createIngredient({ name: 'Корица', unit: 'г', actor });
  // A latte was sold: the milk has real history now.
  hub.counter.create({
    items: [{ productId: product('Латте').id, qty: 1, options: ['s'] }],
    service: 'TAKEAWAY',
    payment: null,
    actor,
  });
  // The quantity of a sample row may be put right like any other.
  hub.stock.adjust({ id: byName().get('Сироп ореховый')!.id, quantity: 500, reason: 'Пересчитали', actor });

  const plan = new Map(hub.stock.sample().ingredients.map((i) => [i.name, i]));
  assert.equal(plan.get('Кофе в зёрнах')!.outcome, 'keep');
  assert.match(plan.get('Кофе в зёрнах')!.why ?? '', /Американо/);
  assert.equal(plan.get('Молоко 3,2%')!.outcome, 'archive');
  assert.match(plan.get('Молоко 3,2%')!.why ?? '', /продаж/);
  assert.equal(plan.get('Сироп ореховый')!.outcome, 'archive', 'its level was put right by hand: that stays in the history');
  assert.equal(plan.get('Овсяное молоко')!.outcome, 'delete');
  assert.ok(!plan.has('Корица'));
  assert.deepEqual(hub.stock.sample().recipes.map((r) => r.name).sort(), ['Капучино', 'Латте', 'Раф', 'Флэт уайт', 'Эспрессо']);

  const result = hub.stock.removeSample({ actor });
  assert.deepEqual(result.recipes.sort(), ['Капучино', 'Латте', 'Раф', 'Флэт уайт', 'Эспрессо']);
  assert.ok(result.deleted.includes('Овсяное молоко') && result.deleted.includes('Сахар'));
  assert.deepEqual(result.archived.sort(), ['Молоко 3,2%', 'Сироп ореховый']);
  assert.deepEqual(result.kept.map((k) => k.name).sort(), ['Кофе в зёрнах', 'Стакан 0,3']);
  const after = byName();
  assert.ok(!after.has('Овсяное молоко'));
  assert.equal(after.get('Молоко 3,2%')!.isArchived, true);
  assert.equal(after.get('Кофе в зёрнах')!.isArchived, false);
  assert.ok(after.has('Корица'));
  // The latte sold keeps its movements; a deleted sample leaves no orphan movements.
  assert.ok(one(db, "SELECT id FROM stock_movements WHERE kind = 'sale' LIMIT 1"));
  assert.equal(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM stock_movements m LEFT JOIN ingredients i ON i.id = m.ingredient_id WHERE i.id IS NULL')!.n, 0);
  // The Американо (the owner's) keeps its recipe; the rest of the sample recipes are gone.
  assert.equal(hub.stock.recipe(product('Американо').id).items.length, 2);
  assert.equal(hub.stock.recipe(product('Латте').id).items.length, 0);
  assert.ok(auditActions({ db } as TestHub).includes('stock.sample_removed'));

  // Nothing left to remove.
  const again = hub.stock.sample();
  assert.equal(again.recipes.length, 0);
  assert.ok(again.ingredients.every((i) => i.outcome === 'keep'));
});

test('migration 021 marks the sample a trial coffee shop got before it', async (t) => {
  const h = harness(t);
  const dir = join(h.dir, 'migrations');
  mkdirSync(dir);
  for (const f of readdirSync(MIGRATIONS_DIR)) if (Number.parseInt(f, 10) < 21) copyFileSync(new URL(f, MIGRATIONS_DIR), join(dir, f));
  const old = openDb(h.dbPath, h.clock.now(), { migrationsDir: pathToFileURL(dir + '/') });
  seedDemo(old, h.clock.now(), 'Asia/Almaty', 'cafe');
  // The old build's sample: rows as it wrote them, at the moment the trial was made.
  const at = h.clock.now();
  const ing = (id: string, name: string, unit: string, when: number) =>
    run(old, 'INSERT INTO ingredients (id, name, unit, quantity, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)', id, name, unit, when, when);
  ing('coffee', 'Кофе в зёрнах', 'г', at);
  ing('milk', 'Молоко 3,2%', 'мл', at + 3);
  ing('mine', 'Корица', 'г', at + 60 * MIN); // the owner's, later
  ing('late-sugar', 'Сахар', 'г', at + 60 * MIN); // a sample name typed by the owner later
  const latte = one<{ id: string }>(old, "SELECT id FROM products WHERE name = 'Латте'")!.id;
  const cappuccino = one<{ id: string }>(old, "SELECT id FROM products WHERE name = 'Капучино'")!.id;
  const item = (product: string, ingredientId: string, when: number) =>
    run(
      old,
      "INSERT INTO recipe_items (product_id, choice_id, mode, ingredient_id, quantity, sort_order, updated_at) VALUES (?, NULL, 'base', ?, 1000, 1, ?)",
      product,
      ingredientId,
      when,
    );
  item(latte, 'coffee', at + 5);
  item(latte, 'milk', at + 5);
  item(cappuccino, 'coffee', at + 30 * MIN); // changed by the owner since
  old.close();

  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('021_'))!;
  copyFileSync(new URL(file, MIGRATIONS_DIR), join(dir, file));
  const db = openDb(h.dbPath, h.clock.now(), { migrationsDir: pathToFileURL(dir + '/') });
  try {
    const flags = Object.fromEntries(all<{ id: string; is_sample: number }>(db, 'SELECT id, is_sample FROM ingredients').map((r) => [r.id, r.is_sample]));
    assert.deepEqual(flags, { coffee: 1, milk: 1, mine: 0, 'late-sugar': 0 });
    const recipeFlags = all<{ product_id: string; is_sample: number }>(db, 'SELECT DISTINCT product_id, is_sample FROM recipe_items');
    assert.deepEqual(
      recipeFlags.map((r) => [r.product_id === latte ? 'Латте' : 'Капучино', r.is_sample]).sort(),
      [
        ['Капучино', 0],
        ['Латте', 1],
      ],
    );
    // The new movement kinds are accepted.
    run(db, "INSERT INTO stock_movements (at, ingredient_id, kind, quantity, balance, actor) VALUES (?, 'milk', 'adjust', 1, 1, 'x')", at);
  } finally {
    db.close();
  }
});

// ─── The first-run checklist ────────────────────────────────────────────────

test('setup: what the first-run checklist of «Склад» shows', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const setup = (await get<StockSetupView>(hub, '/api/stock/setup')).body;
  assert.equal(setup.ingredients, 10);
  assert.equal(setup.supplies, 0);
  assert.equal(setup.sales, 0);
  assert.ok(setup.products > 6);
  const without = setup.withoutRecipe.map((p) => p.name);
  assert.ok(without.includes('Круассан'), without.join());
  assert.ok(!without.includes('Латте'));
  await sell(hub, [{ product: 'Латте', options: ['s'] }]);
  const milk = await ingredient(hub, 'Молоко 3,2%');
  await send(hub, '/api/stock/supplies', { supplier: 'Ферма', lines: [{ ingredientId: milk.id, quantity: 1000, amount: 600_00 }] });
  const later = (await get<StockSetupView>(hub, '/api/stock/setup')).body;
  assert.equal(later.sales, 1);
  assert.equal(later.supplies, 1);
});

// ─── Options the way an owner writes them ───────────────────────────────────

test('«L: молоко +100 мл» and «Овсяное: вместо молока» together take 300 мл of oat milk and no milk', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%');
  const oat = await ingredient(hub, 'Овсяное молоко');
  const coffee = await ingredient(hub, 'Кофе в зёрнах');
  const latte = await productId(hub, 'Латте');
  const set = await send(hub, `/api/stock/recipes/${latte}`, {
    items: [
      { ingredientId: coffee.id, quantity: 18 },
      { ingredientId: milk.id, quantity: 200 },
    ],
    options: [
      { choiceId: 'l', mode: 'add', ingredientId: milk.id, quantity: 100 },
      { choiceId: 'oat', mode: 'swap', ingredientId: oat.id, replacesId: milk.id, quantity: 0 },
    ],
  });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const before = Object.fromEntries((await ingredients(hub)).map((i) => [i.name, i.quantity]));
  const order = await sell(hub, [{ product: 'Латте', options: ['l', 'oat'] }]);
  const after = Object.fromEntries((await ingredients(hub)).map((i) => [i.name, i.quantity]));
  assert.equal(after['Молоко 3,2%'], before['Молоко 3,2%']);
  assert.equal(after['Овсяное молоко']! - before['Овсяное молоко']!, -300);
  assert.equal(after['Кофе в зёрнах']! - before['Кофе в зёрнах']!, -18);
  // Its cancel gives exactly that back.
  await send(hub, `/api/counter/orders/${order.id}/cancel`, { reason: 'Гость передумал' });
  assert.deepEqual(Object.fromEntries((await ingredients(hub)).map((i) => [i.name, i.quantity])), before);
});

test('a correction keeps the lines of an ingredient archived since the delivery; a new delivery of it is refused', async (t) => {
  const h = harness(t);
  const hub = await cafe(h);
  const milk = await ingredient(hub, 'Молоко 3,2%');
  const cups = (await send<IngredientView>(hub, '/api/stock/ingredients', { name: 'Стакан 0,2', unit: 'шт' })).body;
  const supply = await send<SupplyView>(hub, '/api/stock/supplies', {
    supplier: 'Метро',
    lines: [
      { ingredientId: milk.id, quantity: 1000, amount: 600_00 },
      { ingredientId: cups.id, quantity: 50, amount: 2000_00 },
    ],
  });
  // «В архив» — hidden for a while, not deleted.
  assert.equal((await send(hub, `/api/stock/ingredients/${cups.id}/update`, { isArchived: true })).status, 200);
  assert.equal((await ingredient(hub, 'Стакан 0,2')).isArchived, true);
  const fixed = await send<SupplyView>(hub, `/api/stock/supplies/${supply.body.id}/update`, {
    supplier: 'Метро',
    lines: [
      { ingredientId: milk.id, quantity: 2000, amount: 1200_00 },
      { ingredientId: cups.id, quantity: 50, amount: 2000_00 },
    ],
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal((await ingredient(hub, 'Молоко 3,2%')).quantity, 14000);
  assertError(
    await send(hub, '/api/stock/supplies', { supplier: 'Метро', lines: [{ ingredientId: cups.id, quantity: 1, amount: 1 }] }),
    422,
    'INGREDIENT_ARCHIVED',
  );
});
