import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Recipe } from '../src/stock.ts';
import {
  averageCost,
  costOf,
  daysLeftOf,
  formatQty,
  fromMilli,
  isQuantity,
  marginPercent,
  recipeCost,
  recipeUsage,
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
  assert.deepEqual(validateRecipe(null, known), ['Тех. карта: неверный формат']);
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
