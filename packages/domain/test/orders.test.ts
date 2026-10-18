import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_MAX_LINES,
  orderItemAmount,
  orderTotal,
  sessionTotal,
  validateOrderItems,
} from '../src/orders.ts';

test('line amount and order total are plain integer arithmetic', () => {
  assert.equal(orderItemAmount(600_00, 3), 1800_00);
  assert.equal(orderItemAmount(0, 5), 0);
  assert.equal(
    orderTotal([
      { price: 600_00, qty: 2 },
      { price: 300_00, qty: 1 },
    ]),
    1500_00,
  );
  assert.equal(orderTotal([]), 0);
});

test('a valid order passes', () => {
  assert.deepEqual(validateOrderItems([{ productId: 'a', qty: 1 }, { productId: 'b', qty: 99 }]), []);
});

test('an empty order is rejected', () => {
  assert.deepEqual(validateOrderItems([]), ['В заказе нет позиций']);
  assert.deepEqual(validateOrderItems(undefined), ['В заказе нет позиций']);
});

test('quantity must be an integer from 1 to 99', () => {
  assert.equal(validateOrderItems([{ productId: 'a', qty: 0 }]).length, 1);
  assert.equal(validateOrderItems([{ productId: 'a', qty: 100 }]).length, 1);
  assert.equal(validateOrderItems([{ productId: 'a', qty: 1.5 }]).length, 1);
  assert.equal(validateOrderItems([{ productId: 'a', qty: Number.NaN }]).length, 1);
  assert.match(validateOrderItems([{ productId: 'a', qty: -1 }])[0] ?? '', /Позиция 1/);
});

test('duplicate products and missing ids are reported per line', () => {
  const errors = validateOrderItems([
    { productId: 'a', qty: 1 },
    { productId: 'a', qty: 2 },
    { productId: '', qty: 1 },
  ]);
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? '', /Позиция 2.*повторяется/);
  assert.match(errors[1] ?? '', /Позиция 3.*не указан/);
});

test('an order is limited to 50 lines', () => {
  const items = Array.from({ length: ORDER_MAX_LINES + 1 }, (_, i) => ({ productId: `p${i}`, qty: 1 }));
  assert.match(validateOrderItems(items)[0] ?? '', /Не больше 50/);
  assert.deepEqual(validateOrderItems(items.slice(0, ORDER_MAX_LINES)), []);
});

test('the running total of a game adds open orders to the time', () => {
  assert.equal(sessionTotal(2000_00, 1500_00), 3500_00);
  assert.equal(sessionTotal(null, 1500_00), 1500_00);
  assert.equal(sessionTotal(0, 0), 0);
});
