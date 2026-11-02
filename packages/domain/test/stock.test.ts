import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Recipe } from '../src/stock.ts';
import {
  averageCost,
  canChangeSupply,
  costOf,
  costWithout,
  daysLeftOf,
  describeOptionLine,
  formatQty,
  formatStock,
  fromMilli,
  isQuantity,
  marginPercent,
  QTY_INPUT_UNITS,
  recipeCost,
  recipeUsage,
  SUPPLY_CHANGE_WINDOW_MS,
  supplyChanges,
  toBaseQty,
  toMilli,
  validateRecipe,
} from '../src/stock.ts';

const LATTE: Recipe = {
  items: [
    { ingredientId: 'coffee', quantity: 18 },
    { ingredientId: 'milk', quantity: 200 },
    { ingredientId: 'cup-s', quantity: 1 },
  ],
  options: [
    { choiceId: 'l', mode: 'set', ingredientId: 'milk', quantity: 350 },
    { choiceId: 'l', mode: 'swap', ingredientId: 'cup-l', replacesId: 'cup-s', quantity: 0 },
    { choiceId: 'oat', mode: 'swap', ingredientId: 'oat', replacesId: 'milk', quantity: 0 },
    { choiceId: 'caramel', mode: 'add', ingredientId: 'caramel', quantity: 20 },
    { choiceId: 'shot', mode: 'add', ingredientId: 'coffee', quantity: 9 },
    { choiceId: 'no-milk', mode: 'set', ingredientId: 'milk', quantity: 0 },
  ],
};

const usage = (recipe: Recipe, choices: string[] = []) =>
  Object.fromEntries(recipeUsage(recipe, choices).map((l) => [l.ingredientId, l.quantity]));

test('recipeUsage: the plain portion is the base recipe', () => {
  assert.deepEqual(usage(LATTE), { coffee: 18, milk: 200, 'cup-s': 1 });
});

test('recipeUsage: sets first, then adds, then swaps — «L + Овсяное» swaps the L amount of milk', () => {
  assert.deepEqual(usage(LATTE, ['l']), { coffee: 18, milk: 350, 'cup-l': 1 });
  assert.deepEqual(usage(LATTE, ['oat']), { coffee: 18, oat: 200, 'cup-s': 1 });
  // Order of the chosen ids does not matter.
  assert.deepEqual(usage(LATTE, ['oat', 'l', 'caramel', 'shot']), { coffee: 27, oat: 350, 'cup-l': 1, caramel: 20 });
  assert.deepEqual(usage(LATTE, ['l', 'oat', 'caramel', 'shot']), usage(LATTE, ['shot', 'caramel', 'oat', 'l']));
  // set 0 removes the ingredient; an unknown choice changes nothing.
  assert.deepEqual(usage(LATTE, ['no-milk', 'unknown']), { coffee: 18, 'cup-s': 1 });
});

test('recipeUsage: a swap with its own quantity, a swap of something absent, repeated lines add up', () => {
  const r: Recipe = {
    items: [
      { ingredientId: 'coffee', quantity: 9 },
      { ingredientId: 'coffee', quantity: 9.5 },
    ],
    options: [
      { choiceId: 'decaf', mode: 'swap', ingredientId: 'decaf', replacesId: 'coffee', quantity: 16 },
      { choiceId: 'milk', mode: 'swap', ingredientId: 'oat', replacesId: 'milk', quantity: 0 },
      { choiceId: 'milk30', mode: 'swap', ingredientId: 'oat', replacesId: 'milk', quantity: 30 },
    ],
  };
  assert.deepEqual(usage(r), { coffee: 18.5 });
  assert.deepEqual(usage(r, ['decaf']), { decaf: 16 });
  assert.deepEqual(usage(r, ['milk']), { coffee: 18.5 }, 'nothing to swap, nothing added');
  assert.deepEqual(usage(r, ['milk30']), { coffee: 18.5, oat: 30 });
});

test('thousandths: sums never drift, quantities are checked', () => {
  assert.equal(toMilli(0.1) + toMilli(0.2), toMilli(0.3));
  assert.equal(fromMilli(toMilli(18.5)), 18.5);
  assert.ok(isQuantity(0));
  assert.ok(!isQuantity(0, true));
  assert.ok(!isQuantity(0.0001, true), 'below a thousandth is zero');
  assert.ok(isQuantity(0.001, true));
  assert.ok(!isQuantity(-1));
  assert.ok(!isQuantity(Number.NaN));
  assert.ok(!isQuantity('5'));
  assert.ok(!isQuantity(20_000_000));
});

test('costOf, recipeCost and the margin', () => {
  assert.equal(costOf(18, 1200), 21600);
  assert.equal(costOf(18.5, 1200), 22200);
  assert.equal(costOf(-300, 60), -18000);
  assert.equal(costOf(0.333, 100), 33);
  assert.equal(costOf(5, null), null);
  const costs = new Map<string, number | null>([
    ['coffee', 1200],
    ['milk', 60],
    ['cup-s', 3000],
  ]);
  assert.deepEqual(recipeCost(recipeUsage(LATTE), costs), { cost: 21600 + 12000 + 3000, complete: true });
  assert.deepEqual(recipeCost(recipeUsage(LATTE, ['oat']), costs), { cost: 21600 + 3000, complete: false });
  assert.equal(marginPercent(1300_00, 366_00), 72);
  assert.equal(marginPercent(0, 10), null);
});

test('averageCost: what is left at the old cost plus the delivery at its price', () => {
  assert.equal(averageCost(12000, 60, 12000, 9600_00), 70);
  assert.equal(averageCost(0, 60, 1000, 800_00), 80, 'nothing left: the new price');
  assert.equal(averageCost(-500, 60, 1000, 800_00), 80, 'below zero: the new price');
  assert.equal(averageCost(1000, null, 1000, 800_00), 80, 'no known cost: the new price');
  assert.equal(averageCost(1000, 60, 0, 0), 60);
});

test('daysLeftOf and formatQty', () => {
  assert.equal(daysLeftOf(8000, 1000), 8);
  assert.equal(daysLeftOf(999, 1000), 0);
  assert.equal(daysLeftOf(0, 1000), 0);
  assert.equal(daysLeftOf(-5, null), 0);
  assert.equal(daysLeftOf(100, null), null);
  assert.equal(formatQty(1250, 'г').replace(/\s/g, ' '), '1 250 г');
  assert.equal(formatQty(0.5, 'шт'), '0,5 шт');
  assert.equal(formatQty(-40, 'мл'), '−40 мл');
  assert.equal(formatQty(18.0004, 'г'), '18 г');
});

test('validateRecipe names every problem', () => {
  const known = { ingredientIds: new Set(['coffee', 'milk', 'oat']), choiceIds: new Set(['l', 'oat']) };
  assert.deepEqual(validateRecipe({ items: [{ ingredientId: 'coffee', quantity: 18 }], options: [] }, known), []);
  assert.deepEqual(validateRecipe({ items: [], options: [] }, known), [], 'an empty recipe removes it');
  assert.deepEqual(validateRecipe(null, known), ['Состав: неверный формат']);
  const problems = validateRecipe(
    {
      items: [
        { ingredientId: 'coffee', quantity: 0 },
        { ingredientId: 'nope', quantity: 5 },
        { ingredientId: 'coffee', quantity: 5 },
      ],
      options: [
        { choiceId: 'xl', mode: 'add', ingredientId: 'milk', quantity: 1 },
        { choiceId: 'l', mode: 'grow', ingredientId: 'milk', quantity: 1 },
        { choiceId: 'oat', mode: 'swap', ingredientId: 'oat', quantity: 0 },
        { choiceId: 'oat', mode: 'swap', ingredientId: 'oat', replacesId: 'oat', quantity: 0 },
        { choiceId: 'l', mode: 'add', ingredientId: 'milk', quantity: 0 },
        { choiceId: 'l', mode: 'set', ingredientId: 'milk', quantity: 0 },
      ],
    },
    known,
  );
  assert.deepEqual(problems, [
    'Строка 1: количество больше нуля',
    'Строка 2: выберите сырьё',
    'Строка 3: это сырьё уже есть в составе',
    'Добавка 1: такого варианта нет у товара',
    'Добавка 2: неизвестное действие',
    'Добавка 3: укажите, что заменить',
    'Добавка 4: сырьё заменяет само себя',
    'Добавка 5: количество больше нуля',
  ]);
});

// ── Typing amounts the way an invoice says them ─────────────────────────────

test('units: kilograms and litres are typed as such and kept in grams and millilitres', () => {
  assert.deepEqual(QTY_INPUT_UNITS['г'].map((u) => [u.label, u.factor]), [['г', 1], ['кг', 1000]]);
  assert.deepEqual(QTY_INPUT_UNITS['мл'].map((u) => [u.label, u.factor]), [['мл', 1], ['л', 1000]]);
  assert.deepEqual(QTY_INPUT_UNITS['шт'].map((u) => [u.label, u.factor]), [['шт', 1]]);
  assert.equal(toBaseQty(2, 1000), 2000, '2 кг of beans = 2 000 г');
  assert.equal(toBaseQty(1.5, 1000), 1500);
  assert.equal(toBaseQty(0.333, 1000), 333);
  assert.equal(toBaseQty(1.005, 1000), 1005, 'no float drift');
  assert.equal(toBaseQty(18.5, 1), 18.5);
  assert.equal(toBaseQty(12, 1), 12);
});

test('formatStock: big amounts of grams and millilitres read in kilograms and litres', () => {
  const plain = (s: string) => s.replace(/\s/g, ' ');
  assert.equal(plain(formatStock(3000, 'г')), '3 кг');
  assert.equal(plain(formatStock(12500, 'мл')), '12,5 л');
  assert.equal(plain(formatStock(1234, 'г')), '1,234 кг');
  assert.equal(plain(formatStock(850, 'г')), '850 г');
  assert.equal(plain(formatStock(999.5, 'мл')), '999,5 мл');
  assert.equal(plain(formatStock(-1500, 'г')), '−1,5 кг', 'below zero too');
  assert.equal(plain(formatStock(-40, 'мл')), '−40 мл');
  assert.equal(plain(formatStock(1200, 'шт')), '1 200 шт', 'pieces stay pieces');
  assert.equal(plain(formatStock(0, 'г')), '0 г');
});

// ── Recipe option lines in words ────────────────────────────────────────────

test('describeOptionLine: what an option does, in plain words', () => {
  const names: Record<string, { name: string; unit: 'г' | 'мл' | 'шт' }> = {
    milk: { name: 'Молоко', unit: 'мл' },
    oat: { name: 'Овсяное молоко', unit: 'мл' },
    caramel: { name: 'Сироп карамельный', unit: 'мл' },
    sugar: { name: 'Сахар', unit: 'г' },
    'cup-s': { name: 'Стакан 0,3', unit: 'шт' },
    'cup-l': { name: 'Стакан 0,5', unit: 'шт' },
  };
  const of = (id: string) => names[id];
  const base = [
    { ingredientId: 'milk', quantity: 200 },
    { ingredientId: 'cup-s', quantity: 1 },
    { ingredientId: 'sugar', quantity: 10 },
  ];
  assert.equal(describeOptionLine({ choiceId: 'l', mode: 'add', ingredientId: 'milk', quantity: 100 }, of, base), 'Молоко +100 мл');
  assert.equal(describeOptionLine({ choiceId: 'l', mode: 'set', ingredientId: 'milk', quantity: 350 }, of, base), 'Молоко 350 мл вместо 200 мл');
  assert.equal(describeOptionLine({ choiceId: 'x', mode: 'set', ingredientId: 'caramel', quantity: 15 }, of, base), 'Сироп карамельный 15 мл');
  assert.equal(describeOptionLine({ choiceId: 'n', mode: 'set', ingredientId: 'sugar', quantity: 0 }, of, base), 'без «Сахар»');
  assert.equal(
    describeOptionLine({ choiceId: 'oat', mode: 'swap', ingredientId: 'oat', replacesId: 'milk', quantity: 0 }, of, base),
    'Овсяное молоко вместо «Молоко»',
  );
  assert.equal(
    describeOptionLine({ choiceId: 'l', mode: 'swap', ingredientId: 'cup-l', replacesId: 'cup-s', quantity: 2 }, of, base),
    'Стакан 0,5 вместо «Стакан 0,3», 2 шт',
  );
  assert.equal(describeOptionLine({ choiceId: 'l', mode: 'add', ingredientId: 'gone', quantity: 5 }, of, base), '— +5');
});

// ── Deleting or correcting a delivery ───────────────────────────────────────

test('costWithout: the cost per unit as it would be without a delivery line', () => {
  // 12 000 мл at 0,60 ₸ + 12 000 мл for 9 600 ₸ → 0,70 ₸; without that delivery → 0,60 ₸ again.
  assert.equal(costWithout(24000, 70, 12000, 9600_00), 60);
  // Some was used since (all at 0,70): the rest without the delivery's value.
  assert.equal(costWithout(18000, 70, 12000, 9600_00), 50);
  // A free sample never changed the price, so taking it back leaves the price.
  assert.equal(costWithout(1000, 3500, 50, 0), 3500);
  // Nothing (or less than nothing) would be left, or the value would turn negative: keep the price.
  assert.equal(costWithout(1000, 80, 1000, 800_00), 80);
  assert.equal(costWithout(500, 80, 1000, 800_00), 80);
  assert.equal(costWithout(2000, 10, 1000, 800_00), 10);
  assert.equal(costWithout(2000, null, 1000, 800_00), null);
});

test('supplyChanges: per ingredient, only what differs between the old and the corrected delivery', () => {
  const before = [
    { ingredientId: 'coffee', quantity: 2000, amount: 24000_00 },
    { ingredientId: 'milk', quantity: 12000, amount: 9600_00 },
    { ingredientId: 'cups', quantity: 100, amount: 3000_00 },
  ];
  const after = [
    { ingredientId: 'coffee', quantity: 1000, amount: 12000_00 }, // typed 2 kg, came 1 kg
    { ingredientId: 'milk', quantity: 6000, amount: 4800_00 },
    { ingredientId: 'milk', quantity: 6000, amount: 4800_00 }, // split in two lines: the same in total
    { ingredientId: 'sugar', quantity: 1000, amount: 400_00 }, // a forgotten line
    // cups removed: a wrong line
  ];
  assert.deepEqual(supplyChanges(before, after), [
    { ingredientId: 'coffee', before: { quantity: 2000, amount: 24000_00 }, after: { quantity: 1000, amount: 12000_00 } },
    { ingredientId: 'cups', before: { quantity: 100, amount: 3000_00 }, after: { quantity: 0, amount: 0 } },
    { ingredientId: 'sugar', before: { quantity: 0, amount: 0 }, after: { quantity: 1000, amount: 400_00 } },
  ]);
  assert.deepEqual(supplyChanges(before, before), []);
});

test('canChangeSupply: the director and the administrator always; whoever entered it, for a while', () => {
  const at = 1_000_000;
  const supply = { at, createdById: 'barista', deletedAt: null };
  const window = SUPPLY_CHANGE_WINDOW_MS;
  assert.equal(window, 30 * 60 * 1000);
  assert.deepEqual(canChangeSupply(supply, { id: 'boss', mayEditStock: true }, at + 10 * window), { ok: true, until: null });
  assert.deepEqual(canChangeSupply(supply, { id: 'barista', mayEditStock: false }, at + 60_000), { ok: true, until: at + window });
  assert.deepEqual(canChangeSupply(supply, { id: 'barista', mayEditStock: false }, at + window + 1), { ok: false, until: null });
  assert.deepEqual(canChangeSupply(supply, { id: 'cashier', mayEditStock: false }, at + 60_000), { ok: false, until: null });
  assert.deepEqual(canChangeSupply({ ...supply, createdById: null }, { id: null, mayEditStock: false }, at), { ok: false, until: null });
  assert.deepEqual(canChangeSupply({ ...supply, deletedAt: at + 5 }, { id: 'boss', mayEditStock: true }, at + 10), { ok: false, until: null });
});
