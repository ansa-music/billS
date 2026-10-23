import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CafeError,
  can,
  canMoveStage,
  decide,
  defaultChoices,
  nextCounterNumber,
  nextStage,
  normalizeClubSettings,
  priceLine,
  validateCounterLines,
  validateOptionGroups,
  workingDay,
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

test('workingDay: the club day starts at 06:00 club time', () => {
  // Almaty is UTC+5: 2026-10-13 05:59 local still belongs to the 12th, 06:00 starts the 13th.
  assert.equal(workingDay(Date.UTC(2026, 9, 12, 7, 0), 'Asia/Almaty'), '2026-10-12');
  assert.equal(workingDay(Date.UTC(2026, 9, 13, 0, 59), 'Asia/Almaty'), '2026-10-12');
  assert.equal(workingDay(Date.UTC(2026, 9, 13, 1, 0), 'Asia/Almaty'), '2026-10-13');
  // Month and year boundaries step back on the calendar.
  assert.equal(workingDay(Date.UTC(2027, 0, 1, 0, 0), 'Asia/Almaty'), '2026-12-31');
});

test('validateCounterLines: the same product may repeat with other options, not with the same ones', () => {
  assert.deepEqual(
    validateCounterLines([
      { productId: 'cap', qty: 1, options: ['s'] },
      { productId: 'cap', qty: 2, options: ['l', 'oat'] },
      { productId: 'croissant', qty: 1 },
    ]),
    [],
  );
  assert.ok(
    validateCounterLines([
      { productId: 'cap', qty: 1, options: ['oat', 'l'] },
      { productId: 'cap', qty: 1, options: ['l', 'oat'] },
    ])[0]!.includes('повторяется'),
  );
  assert.deepEqual(validateCounterLines([]), ['В заказе нет позиций']);
  assert.ok(validateCounterLines([{ productId: 'cap', qty: 0 }])[0]!.includes('количество'));
  assert.ok(validateCounterLines([{ productId: 'cap', qty: 1, options: [1 as never] }])[0]!.includes('добавок'));
});

test('counter rights: cashier and barista take orders and move stages; a waiter does not', () => {
  for (const role of ['cashier', 'bartender', 'senior', 'admin', 'manager'] as const) {
    assert.ok(can(role, 'counter.take'), role);
    assert.ok(can(role, 'counter.stage'), role);
  }
  assert.ok(!can('waiter', 'counter.take'));
  assert.ok(!can('bartender', 'payment.take'));
  const ro = { readOnly: true, modules: { bar: true, cloud: true, hardware: true } };
  assert.equal(decide('bartender', 'counter.take', ro), 'read_only');
  assert.equal(decide('bartender', 'counter.stage', ro), 'ok');
  assert.equal(decide('cashier', 'counter.take', { readOnly: false, modules: { bar: false, cloud: true, hardware: true } }), 'module_off');
});
