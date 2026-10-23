import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CafeError,
  canMoveStage,
  defaultChoices,
  nextCounterNumber,
  nextStage,
  normalizeClubSettings,
  priceLine,
  validateOptionGroups,
} from '../src/index.ts';
import type { ProductOptionGroup } from '../src/index.ts';

const options: ProductOptionGroup[] = [
  {
    id: 'size',
    name: 'Размер',
    required: true,
    multiple: false,
    choices: [
      { id: 's', name: 'S', priceDelta: 0 },
      { id: 'l', name: 'L', priceDelta: 300 },
    ],
  },
  {
    id: 'milk',
    name: 'Молоко',
    required: false,
    multiple: false,
    choices: [
      { id: 'cow', name: 'Обычное', priceDelta: 0 },
      { id: 'oat', name: 'Овсяное', priceDelta: 250 },
    ],
  },
  {
    id: 'syrup',
    name: 'Сироп',
    required: false,
    multiple: true,
    choices: [
      { id: 'caramel', name: 'Карамель', priceDelta: 200 },
      { id: 'vanilla', name: 'Ваниль', priceDelta: 200 },
    ],
  },
];
const cappuccino = { name: 'Капучино', price: 1200, options };

test('priceLine: price and title from the chosen options, in group order', () => {
  assert.deepEqual(priceLine(cappuccino, ['oat', 'l']), {
    unitPrice: 1750,
    title: 'Капучино · L · Овсяное',
    optionNames: ['L', 'Овсяное'],
  });
  assert.equal(priceLine(cappuccino, ['s', 'caramel', 'vanilla']).unitPrice, 1600);
  assert.equal(priceLine({ name: 'Круассан', price: 900, options: [] }).title, 'Круассан');
});

test('priceLine: required, single-choice, unknown and repeated options are refused', () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      assert.ok(e instanceof CafeError);
      return e.code;
    }
    return 'none';
  };
  assert.equal(code(() => priceLine(cappuccino, [])), 'OPTION_REQUIRED');
  assert.equal(code(() => priceLine(cappuccino, ['s', 'l'])), 'OPTION_SINGLE');
  assert.equal(code(() => priceLine(cappuccino, ['s', 'nope'])), 'OPTION_UNKNOWN');
  assert.equal(code(() => priceLine(cappuccino, ['s', 's'])), 'OPTION_REPEATED');
});

test('priceLine: a cheaper choice never makes the line negative', () => {
  const tiny = { name: 'Вода', price: 100, options: [{ ...options[0]!, choices: [{ id: 'x', name: 'Мини', priceDelta: -500 }] }] };
  assert.equal(priceLine(tiny, ['x']).unitPrice, 0);
});

test('defaultChoices: the first choice of every required group', () => {
  assert.deepEqual(defaultChoices(options), ['s']);
});

test('validateOptionGroups: accepts a menu and names the problems of a broken one', () => {
  assert.deepEqual(validateOptionGroups(options), []);
  assert.deepEqual(validateOptionGroups(undefined), []);
  assert.ok(validateOptionGroups('x').length > 0);
  const errors = validateOptionGroups([
    { id: 'a', name: '', required: true, multiple: false, choices: [] },
    { id: 'a', name: 'Сироп', required: false, multiple: true, choices: [{ id: 'c', name: 'К', priceDelta: 1.5 }] },
  ]);
  assert.ok(errors.some((e) => e.includes('название')));
  assert.ok(errors.some((e) => e.includes('хотя бы один вариант')));
  assert.ok(errors.some((e) => e.includes('id повторяется')));
  assert.ok(errors.some((e) => e.includes('надбавка')));
});

test('nextCounterNumber: 1…999, then from 1 again', () => {
  assert.equal(nextCounterNumber(null), 1);
  assert.equal(nextCounterNumber(17), 18);
  assert.equal(nextCounterNumber(999), 1);
});

test('canMoveStage / nextStage: forward, one step back, straight to issued; issued is final', () => {
  assert.equal(canMoveStage('NEW', 'PREPARING'), true);
  assert.equal(canMoveStage('PREPARING', 'NEW'), true);
  assert.equal(canMoveStage('NEW', 'READY'), false);
  assert.equal(canMoveStage('NEW', 'ISSUED'), true);
  assert.equal(canMoveStage('ISSUED', 'READY'), false);
  assert.equal(canMoveStage('READY', 'READY'), false);
  assert.equal(nextStage('NEW'), 'PREPARING');
  assert.equal(nextStage('READY'), 'ISSUED');
  assert.equal(nextStage('ISSUED'), null);
});

test('club settings: business type defaults to billiards, cafe is kept, garbage ignored', () => {
  assert.equal(normalizeClubSettings({}).business.type, 'billiards');
  assert.equal(normalizeClubSettings({ business: { type: 'cafe' } }).business.type, 'cafe');
  assert.equal(normalizeClubSettings({ business: { type: 'bar' } }).business.type, 'billiards');
});
