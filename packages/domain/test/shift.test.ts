import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BillingError,
  CASH_MOVEMENT_KINDS,
  shiftTotals,
  cashDifference,
  assertCashAvailable,
  assertCashAmount,
} from '../src/index.ts';
import type { LedgerEntry, PaymentMethod, ShiftLedger } from '../src/index.ts';

/** assert.throws validator: a BillingError with this code. */
const billingError = (code: string) => (e: unknown) => e instanceof BillingError && e.code === code;

const pay = (method: PaymentMethod, amount: number): LedgerEntry => ({ kind: 'PAYMENT', method, amount });
const refund = (method: PaymentMethod, amount: number): LedgerEntry => ({ kind: 'REFUND', method, amount });

const ledger: ShiftLedger = {
  openingFloat: 10000_00,
  entries: [
    pay('CASH', 2070_00),
    pay('CARD', 3000_00),
    pay('QR', 1500_00),
    pay('CASH', 1500_00),
    refund('CASH', 500_00),
    refund('CARD', 1000_00),
  ],
  movements: [
    { kind: 'DEPOSIT', amount: 2000_00 },
    { kind: 'WITHDRAWAL', amount: 5000_00 },
    { kind: 'WITHDRAWAL', amount: 1000_00 },
  ],
};

test('cash movement kinds', () => {
  assert.deepEqual([...CASH_MOVEMENT_KINDS], ['DEPOSIT', 'WITHDRAWAL']);
});

test('an empty shift expects just the opening float', () => {
  const t = shiftTotals({ openingFloat: 10000_00, entries: [], movements: [] });
  const zero = { CASH: 0, CARD: 0, QR: 0, total: 0 };
  assert.deepEqual(t, {
    openingFloat: 10000_00,
    sales: zero,
    refunds: zero,
    net: zero,
    deposits: 0,
    withdrawals: 0,
    expectedCash: 10000_00,
  });
});

test('sales, refunds and net per method', () => {
  const t = shiftTotals(ledger);
  assert.equal(t.openingFloat, 10000_00);
  assert.deepEqual(t.sales, { CASH: 3570_00, CARD: 3000_00, QR: 1500_00, total: 8070_00 });
  assert.deepEqual(t.refunds, { CASH: 500_00, CARD: 1000_00, QR: 0, total: 1500_00 });
  assert.deepEqual(t.net, { CASH: 3070_00, CARD: 2000_00, QR: 1500_00, total: 6570_00 });
});

test('expected cash: float + cash sales − cash refunds + deposits − withdrawals', () => {
  const t = shiftTotals(ledger);
  assert.equal(t.deposits, 2000_00);
  assert.equal(t.withdrawals, 6000_00);
  assert.equal(t.expectedCash, 10000_00 + 3570_00 - 500_00 + 2000_00 - 6000_00);
  assert.equal(t.expectedCash, 9070_00);
});

test('card and QR do not change expected cash', () => {
  const more = shiftTotals({
    ...ledger,
    entries: [...ledger.entries, pay('CARD', 7000_00), pay('QR', 3000_00), refund('QR', 1000_00)],
  });
  assert.equal(more.expectedCash, shiftTotals(ledger).expectedCash);
  assert.equal(more.net.CARD, 9000_00);
  assert.equal(more.net.QR, 3500_00);
  assert.equal(more.net.total, 6570_00 + 9000_00);
});

test('cash refunds and withdrawals take cash out of the drawer', () => {
  const base = shiftTotals(ledger).expectedCash;
  assert.equal(shiftTotals({ ...ledger, entries: [...ledger.entries, refund('CASH', 70_00)] }).expectedCash, base - 70_00);
  assert.equal(
    shiftTotals({ ...ledger, movements: [...ledger.movements, { kind: 'WITHDRAWAL', amount: 70_00 }] }).expectedCash,
    base - 70_00,
  );
  assert.equal(
    shiftTotals({ ...ledger, movements: [...ledger.movements, { kind: 'DEPOSIT', amount: 70_00 }] }).expectedCash,
    base + 70_00,
  );
});

test('cash difference: shortage is negative, surplus positive', () => {
  assert.equal(cashDifference(9000_00, 9070_00), -70_00);
  assert.equal(cashDifference(9100_00, 9070_00), 30_00);
  assert.equal(cashDifference(9070_00, 9070_00), 0);
});

test('cash can leave the drawer only if it is there', () => {
  const expected = shiftTotals(ledger).expectedCash;
  assert.doesNotThrow(() => assertCashAvailable(expected, 1));
  assert.doesNotThrow(() => assertCashAvailable(expected, expected));
  assert.throws(() => assertCashAvailable(expected, expected + 1), billingError('INSUFFICIENT_CASH'));
  assert.throws(() => assertCashAvailable(0, 1), billingError('INSUFFICIENT_CASH'));
  // Taking out everything that is there leaves an empty drawer, never a negative one.
  const emptied = shiftTotals({ ...ledger, movements: [...ledger.movements, { kind: 'WITHDRAWAL', amount: expected }] });
  assert.equal(emptied.expectedCash, 0);
});

test('cash amounts are positive whole minor units', () => {
  assert.doesNotThrow(() => assertCashAmount(1));
  assert.doesNotThrow(() => assertCashAmount(10000_00));
  for (const amount of [0, -1, 10.5, Number.NaN]) {
    assert.throws(() => assertCashAmount(amount), billingError('INVALID_AMOUNT'), String(amount));
  }
});

test('zero is allowed only when asked for', () => {
  // E.g. opening a shift with an empty drawer, or counting an empty drawer at close.
  assert.doesNotThrow(() => assertCashAmount(0, true));
  assert.doesNotThrow(() => assertCashAmount(500_00, true));
  for (const amount of [-1, 10.5, Number.NaN]) {
    assert.throws(() => assertCashAmount(amount, true), billingError('INVALID_AMOUNT'), String(amount));
  }
});
