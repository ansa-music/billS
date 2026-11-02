import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProductOptionGroup } from '../src/cafe.ts';
import { CAFE_ROLE_LABEL, roleLabel, rolesLabel } from '../src/permissions.ts';
import type { Recipe } from '../src/stock.ts';
import {
  buildProfitReport,
  buildSalesReport,
  hintName,
  ingredientPurchaseList,
  purchaseNeed,
  stockAlerts,
} from '../src/stock-reports.ts';
import { findIngredient, matchSampleDrink, normalizeName, sampleChoiceRoles, sizeRank } from '../src/stock-sample.ts';

// ── «Заполнить примером»: matching the coffee shop's own menu ───────────────

test('sample drinks are matched by the name the coffee shop gave them', () => {
  const cases: Array<[string, string | null]> = [
    ['Латте', 'latte'],
    ['латте 0,4', 'latte'],
    ['Латте макиато', 'latte'],
    ['Капучино', 'cappuccino'],
    ['Капуччино большой', 'cappuccino'],
    ['Cappuccino', 'cappuccino'],
    ['Американо', 'americano'],
    ['Американо с молоком', 'americano'],
    ['Эспрессо', 'espresso'],
    ['Доппио', 'espresso'],
    ['Раф', 'raf'],
    ['Раф лавандовый', 'raf'],
    ['Раф-латте', 'raf'],
    ['Флэт уайт', 'flat-white'],
    ['Флэт Уайт', 'flat-white'],
    ['Flat white', 'flat-white'],
    ['Мокко', 'mocha'],
    ['Какао', 'cocoa'],
    ['Горячий шоколад', 'cocoa'],
    // Not coffee, or not one of the samples.
    ['Матча-латте', null],
    ['Чай латте', null],
    ['Раффаэлло', null],
    ['Круассан', null],
    ['Чёрный', null],
    ['', null],
  ];
  for (const [name, drink] of cases) assert.equal(matchSampleDrink(name), drink, name);
  assert.equal(normalizeName('  Флэт-Уайт (0,3) Ёж '), 'флэт уайт 0 3 еж');
});

test('size choices are ordered by what they say; milk, syrups and the extra shot by name', () => {
  assert.ok(sizeRank('S')! < sizeRank('M')! && sizeRank('M')! < sizeRank('L')!);
  assert.ok(sizeRank('0,3')! < sizeRank('0,4 л')! && sizeRank('0,4 л')! < sizeRank('500 мл')!);
  assert.ok(sizeRank('Маленький')! < sizeRank('Средний')! && sizeRank('Средний')! < sizeRank('Большой')!);
  assert.equal(sizeRank('Овсяное'), null);

  // The coffee shop's own ids, sizes typed largest first.
  const groups: ProductOptionGroup[] = [
    {
      id: 'g1',
      name: 'Объём',
      required: true,
      multiple: false,
      choices: [
        { id: 'big', name: '0,5', priceDelta: 400_00 },
        { id: 'small', name: '0,3', priceDelta: 0 },
        { id: 'mid', name: '0,4', priceDelta: 200_00 },
      ],
    },
    {
      id: 'g2',
      name: 'Молоко',
      required: false,
      multiple: false,
      choices: [
        { id: 'c1', name: 'Обычное', priceDelta: 0 },
        { id: 'c2', name: 'На овсяном', priceDelta: 300_00 },
        { id: 'c3', name: 'Миндальное', priceDelta: 300_00 },
      ],
    },
    {
      id: 'g3',
      name: 'Сироп',
      required: false,
      multiple: true,
      choices: [
        { id: 'c4', name: 'Карамель', priceDelta: 200_00 },
        { id: 'c5', name: 'Лесной орех', priceDelta: 200_00 },
      ],
    },
    { id: 'g4', name: 'Добавки', required: false, multiple: true, choices: [{ id: 'c6', name: 'Доп. шот', priceDelta: 300_00 }] },
  ];
  assert.deepEqual(Object.fromEntries(sampleChoiceRoles(groups)), {
    m: 'mid',
    l: 'big',
    regular: 'c1',
    oat: 'c2',
    caramel: 'c4',
    nut: 'c5',
    'extra-shot': 'c6',
  });
  // Two sizes: the second one is «m»; no options at all — nothing.
  const two: ProductOptionGroup[] = [
    { id: 'g', name: 'Размер', required: true, multiple: false, choices: [{ id: 'a', name: 'Стандарт', priceDelta: 0 }, { id: 'b', name: 'Большой', priceDelta: 1 }] },
  ];
  assert.deepEqual(Object.fromEntries(sampleChoiceRoles(two)), { m: 'b' });
  assert.equal(sampleChoiceRoles([]).size, 0);
});

test('a sample raw material the coffee shop already has is found by name or a usual name, same unit only', () => {
  const existing = [
    { id: '1', name: 'Молоко', unit: 'мл' as const },
    { id: '2', name: 'Кофе в зёрнах', unit: 'шт' as const },
    { id: '3', name: 'сахар', unit: 'г' as const, isArchived: true },
  ];
  assert.deepEqual(findIngredient(existing, { name: 'Молоко 3,2%', unit: 'мл', aliases: ['молоко'] }), { id: '1' });
  assert.deepEqual(findIngredient(existing, { name: 'Молоко 3,2%', unit: 'г', aliases: ['молоко'] }), null);
  assert.deepEqual(findIngredient(existing, { name: 'Кофе в зёрнах', unit: 'г' }), { clash: true });
  assert.equal(findIngredient(existing, { name: 'Сахар', unit: 'г' }), null, 'archived ones do not count');
});

// ── «Докупить на неделю» ────────────────────────────────────────────────────

test('what to buy: ⌈use per day × 7 + minimum − stock⌉, never below zero', () => {
  assert.equal(purchaseNeed(500, 4000, 2000), 500 * 7 + 4000 - 2000);
  assert.equal(purchaseNeed(0, 1000, 300), 700, 'no sales: up to the minimum');
  assert.equal(purchaseNeed(10, null, 1000), 0);
  assert.equal(purchaseNeed(0.3, null, 0), 3, '2,1 → 3 whole units');
  assert.equal(purchaseNeed(100, null, -50), 750, 'below zero is bought back too');

  const list = ingredientPurchaseList(
    [
      { id: 'm', name: 'Молоко', unit: 'мл', quantity: 2000, minLevel: 4000, costPerUnit: 60, used: 14_000 },
      { id: 'c', name: 'Кофе', unit: 'г', quantity: 5000, minLevel: 1000, costPerUnit: 1200, used: 700 },
      { id: 'o', name: 'Овсяное', unit: 'мл', quantity: 0, minLevel: 500, costPerUnit: null, used: 0 },
    ],
    14,
  );
  assert.deepEqual(
    list.lines.map((l) => [l.name, l.perDay, l.need, l.cost]),
    [
      ['Молоко', 1000, 1000 * 7 + 4000 - 2000, 9000 * 60],
      ['Овсяное', 0, 500, null],
    ],
  );
  assert.equal(list.total, 9000 * 60);
  assert.equal(list.unpriced, 1);
  assert.equal(list.days, 7);
});

// ── Alerts for the staff ────────────────────────────────────────────────────

test('alerts: raw materials at zero or below the minimum, and the products they hold up', () => {
  const recipes = new Map<string, Recipe>([
    ['latte', { items: [{ ingredientId: 'milk', quantity: 200 }, { ingredientId: 'cup', quantity: 1 }], options: [{ choiceId: 'oat', mode: 'swap', ingredientId: 'oat', replacesId: 'milk', quantity: 0 }] }],
    ['espresso', { items: [{ ingredientId: 'coffee', quantity: 9 }], options: [] }],
  ]);
  const view = stockAlerts(
    [
      { id: 'milk', name: 'Молоко', unit: 'мл', quantity: -40, minLevel: 1000, isArchived: false },
      { id: 'cup', name: 'Стакан 0,3', unit: 'шт', quantity: 10, minLevel: 50, isArchived: false },
      { id: 'coffee', name: 'Кофе', unit: 'г', quantity: 900, minLevel: 500, isArchived: false },
      { id: 'oat', name: 'Овсяное', unit: 'мл', quantity: 0, minLevel: null, isArchived: false },
      { id: 'lid', name: 'Крышка', unit: 'шт', quantity: 0, minLevel: null, isArchived: false },
      { id: 'old', name: 'Старое', unit: 'г', quantity: 0, minLevel: 10, isArchived: true },
    ],
    recipes,
  );
  assert.deepEqual(
    view.low.map((l) => [l.name, l.out]),
    [
      ['Молоко', true],
      ['Овсяное', true],
      ['Стакан 0,3', false],
    ],
  );
  assert.deepEqual(view.products, [{ productId: 'latte', out: ['Молоко'] }]);
  assert.ok(!JSON.stringify(view).includes('cost'), 'no money for the staff');
  assert.equal(hintName('Молоко 3,2%'), 'молоко 3,2%');
});

// ── Profit ──────────────────────────────────────────────────────────────────

test('profit: revenue, cost of goods sold, margin per product, no-recipe products flagged, losses apart', () => {
  const report = buildProfitReport({
    range: { from: '2026-10-12', to: '2026-10-12' },
    generatedAt: 1,
    timezone: 'Asia/Almaty',
    currency: 'KZT',
    products: [
      { productId: 'latte', name: 'Латте', qty: 4, revenue: 4 * 1300_00, qtyWithoutRecipe: 0 },
      { productId: 'cookie', name: 'Печенье', qty: 2, revenue: 2 * 500_00, qtyWithoutRecipe: 2 },
      { productId: 'raf', name: 'Раф', qty: 2, revenue: 2 * 1500_00, qtyWithoutRecipe: 1 },
    ],
    costs: [
      { productId: 'latte', cost: 4 * 365_00, incomplete: false },
      { productId: 'raf', cost: 400_00, incomplete: true },
    ],
    losses: [
      { kind: 'writeoff', ingredientId: 'milk', name: 'Молоко', unit: 'мл', quantity: -100, cost: -60_00 },
      { kind: 'writeoff', ingredientId: 'milk', name: 'Молоко', unit: 'мл', quantity: -50, cost: -30_00 },
      { kind: 'inventory', ingredientId: 'coffee', name: 'Кофе', unit: 'г', quantity: -20, cost: -240_00 },
      { kind: 'inventory', ingredientId: 'cup', name: 'Стакан', unit: 'шт', quantity: 2, cost: 60_00 },
      { kind: 'writeoff', ingredientId: 'syrup', name: 'Сироп', unit: 'мл', quantity: -10, cost: null },
    ],
  });
  assert.equal(report.revenue, 4 * 1300_00 + 2 * 500_00 + 2 * 1500_00);
  assert.equal(report.cost, 4 * 365_00 + 400_00);
  assert.equal(report.profit, report.revenue - report.cost);
  assert.equal(report.margin, Math.round((report.profit / report.revenue) * 100));
  assert.equal(report.productsWithoutRecipe, 1);
  assert.equal(report.revenueWithoutRecipe, 2 * 500_00 + 1500_00);
  assert.equal(report.costIncomplete, true);

  assert.deepEqual(
    report.lines.map((l) => [l.name, l.cost, l.profit, l.margin, l.noRecipe, l.partlyWithoutRecipe]),
    [
      ['Латте', 4 * 365_00, 4 * (1300_00 - 365_00), Math.round(((1300_00 - 365_00) / 1300_00) * 100), false, false],
      // Half of the raf sales had no card: profit on the half the cost covers.
      ['Раф', 400_00, 1500_00 - 400_00, Math.round(((1500_00 - 400_00) / 1500_00) * 100), false, true],
      ['Печенье', null, null, null, true, false],
    ],
  );

  assert.deepEqual(
    { writeOff: report.losses.writeOff, shortage: report.losses.shortage, surplus: report.losses.surplus, total: report.losses.total, unpriced: report.losses.unpriced },
    { writeOff: 90_00, shortage: 240_00, surplus: 60_00, total: 90_00 + 240_00 - 60_00, unpriced: 1 },
  );
  const milk = report.losses.lines.find((l) => l.ingredientId === 'milk')!;
  assert.deepEqual([milk.quantity, milk.loss], [-150, 90_00]);
  assert.equal(report.profitAfterLosses, report.profit - report.losses.total);
});

test('profit of an empty period is zeros, without a margin', () => {
  const r = buildProfitReport({ range: { from: 'a', to: 'a' }, generatedAt: 0, timezone: 'UTC', currency: 'KZT', products: [], costs: [], losses: [] });
  assert.deepEqual([r.revenue, r.cost, r.profit, r.margin, r.lines.length, r.losses.total], [0, 0, 0, null, 0, 0]);
});

// ── What sells ──────────────────────────────────────────────────────────────

test('sales: tops by units and by revenue, orders by local hour, average check, money by method', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 12, h - 5, m); // Asia/Almaty is UTC+5
  const r = buildSalesReport({
    range: { from: '2026-10-12', to: '2026-10-12' },
    generatedAt: 0,
    timezone: 'Asia/Almaty',
    currency: 'KZT',
    items: [
      { productId: 'e', name: 'Эспрессо', qty: 5, revenue: 5 * 800_00 },
      { productId: 'r', name: 'Раф', qty: 2, revenue: 2 * 1500_00 + 400_00 },
      { productId: 'l', name: 'Латте', qty: 3, revenue: 3 * 1300_00 },
    ],
    orders: [
      { at: at(8, 10), total: 1000_00 },
      { at: at(8, 50), total: 2000_00 },
      { at: at(13), total: 3000_00 },
    ],
    checks: { count: 3, paid: 5900_00 },
    byMethod: { CASH: 2000_00, CARD: 3900_00 },
  });
  assert.deepEqual(r.topByQty.map((t) => t.name), ['Эспрессо', 'Латте', 'Раф']);
  assert.deepEqual(r.topByRevenue.map((t) => t.name), ['Эспрессо', 'Латте', 'Раф']);
  assert.equal(r.topByQty[0]!.share, Math.round((4000_00 / (4000_00 + 3400_00 + 3900_00)) * 100));
  assert.equal(r.byHour.length, 24);
  assert.deepEqual(r.byHour[8], { hour: 8, orders: 2, revenue: 3000_00 });
  assert.deepEqual(r.byHour[13], { hour: 13, orders: 1, revenue: 3000_00 });
  assert.equal(r.orders, 3);
  assert.equal(r.revenue, 6000_00);
  assert.equal(r.items, 10);
  assert.equal(r.avgCheck, Math.round(5900_00 / 3));
  assert.deepEqual(r.byMethod, { CASH: 2000_00, CARD: 3900_00, QR: 0 });
});

// ── Coffee-shop role words ──────────────────────────────────────────────────

test('in a coffee shop the bartender is called a barista', () => {
  assert.equal(CAFE_ROLE_LABEL.bartender, 'Бариста');
  assert.equal(roleLabel('bartender', 'cafe'), 'Бариста');
  assert.equal(roleLabel('bartender'), 'Бармен / бариста');
  assert.equal(roleLabel('cashier', 'cafe'), 'Кассир');
  assert.equal(rolesLabel(['cashier', 'bartender'], 'cafe'), 'Кассир + бариста');
  assert.equal(rolesLabel(['bartender']), 'Бармен / бариста');
});
