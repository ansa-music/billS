import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BillingError,
  PAYMENT_METHODS,
  discountAmount,
  checkTotals,
  netPaidByMethod,
  planPayment,
  assertRefundable,
  assertReason,
  assertApprover,
  parseMoney,
  minorPerMajor,
  roundToStep,
  canTransition,
} from '../src/index.ts';
import type { DiscountKind, LedgerEntry, PaymentMethod, PaymentPart, PaymentPlan } from '../src/index.ts';

/** assert.throws validator: a BillingError with this code. */
const billingError = (code: string) => (e: unknown) => e instanceof BillingError && e.code === code;

const pay = (method: PaymentMethod, amount: number): LedgerEntry => ({ kind: 'PAYMENT', method, amount });
const refund = (method: PaymentMethod, amount: number): LedgerEntry => ({ kind: 'REFUND', method, amount });

/** The books balance: applied ≤ due, applied + change = what was handed over. */
function assertBalanced(due: number, parts: readonly PaymentPart[], plan: PaymentPlan) {
  const sum = plan.parts.reduce((s, p) => s + p.amount, 0);
  assert.equal(plan.applied, sum);
  assert.ok(plan.applied <= due, `applied ${plan.applied} > due ${due}`);
  assert.ok(plan.parts.every((p) => p.amount > 0));
  assert.equal(plan.remaining, due - plan.applied);
  const handed = parts.reduce((s, p) => s + p.amount, 0);
  assert.equal(handed, plan.applied + plan.change);
}

// ── Discounts ────────────────────────────────────────────────────────────────

test('no discount is zero', () => {
  assert.equal(discountAmount(2070_00, null), 0);
  assert.equal(discountAmount(2070_00, null, 100), 0);
});

test('percent discount of the subtotal', () => {
  assert.equal(discountAmount(2070_00, { kind: 'PERCENT', value: 10 }, 1), 207_00);
  assert.equal(discountAmount(2070_00, { kind: 'PERCENT', value: 15 }), 310_50);
});

test('percent discount rounds half up to the step', () => {
  // 15% of 2070 ₸ = 310.50 ₸ → 311 ₸ in whole tenge.
  assert.equal(discountAmount(2070_00, { kind: 'PERCENT', value: 15 }, 100), 311_00);
  // 12% = 248.40 ₸ → 248 ₸.
  assert.equal(discountAmount(2070_00, { kind: 'PERCENT', value: 12 }, 100), 248_00);
  // 10% of 2070.05 ₸ = 207.005 ₸ = 20700.5 tiyn → 20701 tiyn.
  assert.equal(discountAmount(2070_05, { kind: 'PERCENT', value: 10 }, 1), 207_01);
  // To 10 ₸: 15% of 2070 ₸ = 310.50 ₸ → 310 ₸.
  assert.equal(discountAmount(2070_00, { kind: 'PERCENT', value: 15 }, 10_00), 310_00);
});

test('100% discount covers the whole subtotal', () => {
  assert.equal(discountAmount(2070_00, { kind: 'PERCENT', value: 100 }), 2070_00);
  assert.equal(discountAmount(2070_00, { kind: 'PERCENT', value: 100 }, 100), 2070_00);
  // Subtotal that is not a multiple of the step: nothing may be left to pay.
  assert.equal(discountAmount(2066_33, { kind: 'PERCENT', value: 100 }, 100), 2066_33);
  assert.equal(discountAmount(2066_67, { kind: 'PERCENT', value: 100 }, 100), 2066_67);
  const t = checkTotals([2066_33], { kind: 'PERCENT', value: 100 }, [], 100);
  assert.equal(t.total, 0);
  assert.equal(t.due, 0);
});

test('rounded percent discount never exceeds the subtotal', () => {
  // 60% of 0.90 ₸ = 0.54 ₸ rounds up to 1 ₸, capped at 0.90 ₸.
  assert.equal(discountAmount(90, { kind: 'PERCENT', value: 60 }, 100), 90);
  assert.equal(discountAmount(0, { kind: 'PERCENT', value: 50 }, 100), 0);
});

test('percent outside 1…100 or fractional is rejected', () => {
  for (const value of [0, 101, 2.5, -10, Number.NaN]) {
    assert.throws(() => discountAmount(2070_00, { kind: 'PERCENT', value }), billingError('INVALID_DISCOUNT'), String(value));
  }
});

test('amount discount up to the subtotal', () => {
  assert.equal(discountAmount(2070_00, { kind: 'AMOUNT', value: 500_00 }), 500_00);
  assert.equal(discountAmount(2070_00, { kind: 'AMOUNT', value: 2070_00 }), 2070_00);
  // An amount is taken as given, not rounded to the step.
  assert.equal(discountAmount(2070_00, { kind: 'AMOUNT', value: 3_33 }, 100), 3_33);
});

test('amount discount above the subtotal is rejected', () => {
  assert.throws(
    () => discountAmount(2070_00, { kind: 'AMOUNT', value: 2070_01 }),
    billingError('DISCOUNT_EXCEEDS_TOTAL'),
  );
  assert.throws(() => discountAmount(0, { kind: 'AMOUNT', value: 1 }), billingError('DISCOUNT_EXCEEDS_TOTAL'));
});

test('amount discount must be a positive whole number', () => {
  for (const value of [0, -100_00, 10.5, Number.NaN]) {
    assert.throws(() => discountAmount(2070_00, { kind: 'AMOUNT', value }), billingError('INVALID_DISCOUNT'), String(value));
  }
});

test('unknown discount kind is rejected', () => {
  const kind = 'FREE' as string as DiscountKind;
  assert.throws(() => discountAmount(2070_00, { kind, value: 10 }), billingError('INVALID_DISCOUNT'));
});

// ── Check totals ─────────────────────────────────────────────────────────────

test('check totals sum the games and apply the discount', () => {
  const t = checkTotals([2070_00, 1500_00, 430_00], { kind: 'PERCENT', value: 10 }, []);
  assert.deepEqual(t, { subtotal: 4000_00, discount: 400_00, total: 3600_00, paid: 0, refunded: 0, due: 3600_00 });
});

test('check totals round a percent discount to the step', () => {
  const t = checkTotals([2070_00], { kind: 'PERCENT', value: 15 }, [], 100);
  assert.equal(t.discount, 311_00);
  assert.equal(t.total, 1759_00);
  assert.equal(t.due, 1759_00);
});

test('an empty check owes nothing', () => {
  assert.deepEqual(checkTotals([], null, []), { subtotal: 0, discount: 0, total: 0, paid: 0, refunded: 0, due: 0 });
});

test('payments reduce what is due', () => {
  const t = checkTotals([2070_00, 1500_00], { kind: 'AMOUNT', value: 70_00 }, [pay('CASH', 1000_00), pay('CARD', 2000_00)]);
  assert.equal(t.total, 3500_00);
  assert.equal(t.paid, 3000_00);
  assert.equal(t.refunded, 0);
  assert.equal(t.due, 500_00);
});

test('due is never negative', () => {
  const t = checkTotals([2000_00], null, [pay('CASH', 1500_00), pay('CARD', 1000_00)]);
  assert.equal(t.paid, 2500_00);
  assert.equal(t.due, 0);
});

test('a refund on an open check makes money due again', () => {
  const paid = [pay('CARD', 2000_00)];
  assert.equal(checkTotals([2000_00], null, paid).due, 0);
  const t = checkTotals([2000_00], null, [...paid, refund('CARD', 500_00)]);
  assert.equal(t.paid, 2000_00);
  assert.equal(t.refunded, 500_00);
  assert.equal(t.due, 500_00);
});

// ── Payments ─────────────────────────────────────────────────────────────────

test('payment methods', () => {
  assert.deepEqual([...PAYMENT_METHODS], ['CASH', 'CARD', 'QR']);
});

test('exact cash', () => {
  const plan = planPayment(1500_00, [{ method: 'CASH', amount: 1500_00 }]);
  assert.deepEqual(plan, {
    parts: [{ method: 'CASH', amount: 1500_00, tendered: 1500_00, change: 0 }],
    applied: 1500_00,
    change: 0,
    remaining: 0,
  });
});

test('cash with change', () => {
  const parts: PaymentPart[] = [{ method: 'CASH', amount: 2000_00 }];
  const plan = planPayment(1500_00, parts);
  assert.deepEqual(plan, {
    parts: [{ method: 'CASH', amount: 1500_00, tendered: 2000_00, change: 500_00 }],
    applied: 1500_00,
    change: 500_00,
    remaining: 0,
  });
  assertBalanced(1500_00, parts, plan);
});

test('exact card or QR', () => {
  for (const method of ['CARD', 'QR'] as const) {
    assert.deepEqual(planPayment(1500_00, [{ method, amount: 1500_00 }]), {
      parts: [{ method, amount: 1500_00, tendered: null, change: null }],
      applied: 1500_00,
      change: 0,
      remaining: 0,
    });
  }
});

test('card or QR above what is due is rejected', () => {
  assert.throws(() => planPayment(1500_00, [{ method: 'CARD', amount: 1500_01 }]), billingError('NON_CASH_OVERPAYMENT'));
  assert.throws(() => planPayment(1500_00, [{ method: 'QR', amount: 2000_00 }]), billingError('NON_CASH_OVERPAYMENT'));
  assert.throws(
    () => planPayment(1500_00, [{ method: 'CARD', amount: 1000_00 }, { method: 'QR', amount: 600_00 }]),
    billingError('NON_CASH_OVERPAYMENT'),
  );
  assert.throws(
    () => planPayment(1500_00, [{ method: 'CARD', amount: 1600_00 }, { method: 'CASH', amount: 100_00 }]),
    billingError('NON_CASH_OVERPAYMENT'),
  );
});

test('mixed cash and card: change comes only from cash', () => {
  const parts: PaymentPart[] = [{ method: 'CARD', amount: 1000_00 }, { method: 'CASH', amount: 1000_00 }];
  const plan = planPayment(1500_00, parts);
  assert.deepEqual(plan.parts, [
    { method: 'CARD', amount: 1000_00, tendered: null, change: null },
    { method: 'CASH', amount: 500_00, tendered: 1000_00, change: 500_00 },
  ]);
  assert.equal(plan.applied, 1500_00);
  assert.equal(plan.change, 500_00);
  assert.equal(plan.remaining, 0);
  assertBalanced(1500_00, parts, plan);
});

test('mixed card and QR, exact', () => {
  const parts: PaymentPart[] = [{ method: 'CARD', amount: 1000_00 }, { method: 'QR', amount: 500_00 }];
  const plan = planPayment(1500_00, parts);
  assert.deepEqual(plan, {
    parts: [
      { method: 'CARD', amount: 1000_00, tendered: null, change: null },
      { method: 'QR', amount: 500_00, tendered: null, change: null },
    ],
    applied: 1500_00,
    change: 0,
    remaining: 0,
  });
});

test('all three methods with change', () => {
  const parts: PaymentPart[] = [
    { method: 'CARD', amount: 1000_00 },
    { method: 'QR', amount: 1000_00 },
    { method: 'CASH', amount: 2000_00 },
  ];
  const plan = planPayment(3000_00, parts);
  assert.deepEqual(plan.parts[2], { method: 'CASH', amount: 1000_00, tendered: 2000_00, change: 1000_00 });
  assert.equal(plan.applied, 3000_00);
  assert.equal(plan.change, 1000_00);
  assert.equal(plan.remaining, 0);
  assertBalanced(3000_00, parts, plan);
});

test('partial payment leaves the rest due', () => {
  const cash = planPayment(1500_00, [{ method: 'CASH', amount: 1000_00 }]);
  assert.deepEqual(cash, {
    parts: [{ method: 'CASH', amount: 1000_00, tendered: 1000_00, change: 0 }],
    applied: 1000_00,
    change: 0,
    remaining: 500_00,
  });
  const card = planPayment(1500_00, [{ method: 'CARD', amount: 500_00 }]);
  assert.equal(card.applied, 500_00);
  assert.equal(card.remaining, 1000_00);
});

test('partial mixed payment', () => {
  const parts: PaymentPart[] = [{ method: 'CASH', amount: 1000_00 }, { method: 'QR', amount: 500_00 }];
  const plan = planPayment(3000_00, parts);
  assert.deepEqual(plan.parts, [
    { method: 'CASH', amount: 1000_00, tendered: 1000_00, change: 0 },
    { method: 'QR', amount: 500_00, tendered: null, change: null },
  ]);
  assert.equal(plan.applied, 1500_00);
  assert.equal(plan.change, 0);
  assert.equal(plan.remaining, 1500_00);
});

test('each method goes on one line', () => {
  assert.throws(
    () => planPayment(1500_00, [{ method: 'CASH', amount: 500_00 }, { method: 'CASH', amount: 500_00 }]),
    billingError('DUPLICATE_METHOD'),
  );
  assert.throws(
    () =>
      planPayment(1500_00, [
        { method: 'CARD', amount: 500_00 },
        { method: 'QR', amount: 100_00 },
        { method: 'CARD', amount: 100_00 },
      ]),
    billingError('DUPLICATE_METHOD'),
  );
});

test('money due needs a payment', () => {
  assert.throws(() => planPayment(1500_00, []), billingError('NO_PAYMENT'));
});

test('nothing due is settled with no parts', () => {
  assert.deepEqual(planPayment(0, []), { parts: [], applied: 0, change: 0, remaining: 0 });
});

test('paying when nothing is due is rejected', () => {
  assert.throws(() => planPayment(0, [{ method: 'CASH', amount: 100_00 }]), billingError('NOTHING_DUE'));
  assert.throws(() => planPayment(0, [{ method: 'CARD', amount: 100_00 }]), billingError('NOTHING_DUE'));
});

test('cash is refused when card and QR already cover the bill', () => {
  assert.throws(
    () => planPayment(1500_00, [{ method: 'CARD', amount: 1500_00 }, { method: 'CASH', amount: 500_00 }]),
    billingError('CASH_NOT_NEEDED'),
  );
  assert.throws(
    () =>
      planPayment(1500_00, [
        { method: 'CARD', amount: 1000_00 },
        { method: 'QR', amount: 500_00 },
        { method: 'CASH', amount: 1 },
      ]),
    billingError('CASH_NOT_NEEDED'),
  );
});

test('part amounts must be positive whole minor units', () => {
  for (const method of PAYMENT_METHODS) {
    for (const amount of [0, -100_00, 10.5, Number.NaN]) {
      assert.throws(() => planPayment(1500_00, [{ method, amount }]), billingError('INVALID_AMOUNT'), `${method} ${amount}`);
    }
  }
});

test('amount due must be a non-negative whole number', () => {
  for (const due of [-1, 10.5, Number.NaN]) {
    assert.throws(() => planPayment(due, [{ method: 'CASH', amount: 100_00 }]), billingError('INVALID_AMOUNT'), String(due));
  }
});

test('unknown payment method is rejected', () => {
  const method = 'BITCOIN' as string as PaymentMethod;
  assert.throws(() => planPayment(1500_00, [{ method, amount: 100_00 }]), billingError('INVALID_METHOD'));
});

test('applied never exceeds due across combinations', () => {
  const dues = [1, 50_00, 1500_00, 2070_50];
  const amounts = [undefined, 1, 49_99, 50_00, 1000_00, 1500_00, 2000_00, 2070_50, 5000_00];
  const allowed = new Set(['NON_CASH_OVERPAYMENT', 'CASH_NOT_NEEDED', 'NO_PAYMENT']);
  let planned = 0;
  let rejected = 0;
  for (const due of dues) {
    for (const cash of amounts) {
      for (const card of amounts) {
        for (const qr of amounts) {
          const parts: PaymentPart[] = [];
          if (card !== undefined) parts.push({ method: 'CARD', amount: card });
          if (qr !== undefined) parts.push({ method: 'QR', amount: qr });
          if (cash !== undefined) parts.push({ method: 'CASH', amount: cash });
          let plan: PaymentPlan;
          try {
            plan = planPayment(due, parts);
          } catch (e) {
            assert.ok(e instanceof BillingError && allowed.has(e.code), String(e));
            rejected++;
            continue;
          }
          planned++;
          assertBalanced(due, parts, plan);
          for (const p of plan.parts) {
            if (p.method === 'CASH') {
              assert.equal(p.tendered, cash);
              assert.equal(p.amount + (p.change ?? 0), cash);
            } else {
              // Card and QR are applied in full and never give change.
              assert.equal(p.amount, p.method === 'CARD' ? card : qr);
              assert.equal(p.change, null);
            }
          }
          if (plan.change > 0) assert.equal(plan.remaining, 0);
        }
      }
    }
  }
  assert.ok(planned > 100 && rejected > 100, `planned ${planned}, rejected ${rejected}`);
});

// ── Refunds ──────────────────────────────────────────────────────────────────

test('net paid by method', () => {
  assert.deepEqual(netPaidByMethod([]), { CASH: 0, CARD: 0, QR: 0 });
  assert.deepEqual(
    netPaidByMethod([pay('CASH', 1000_00), pay('CARD', 2000_00), refund('CASH', 300_00), pay('CASH', 500_00)]),
    { CASH: 1200_00, CARD: 2000_00, QR: 0 },
  );
});

const paidEntries = [pay('CASH', 1000_00), pay('CARD', 2000_00)];

test('refund up to what was paid by that method', () => {
  assert.doesNotThrow(() => assertRefundable(paidEntries, 'CARD', 2000_00));
  assert.doesNotThrow(() => assertRefundable(paidEntries, 'CASH', 1000_00));
  assert.doesNotThrow(() => assertRefundable(paidEntries, 'CASH', 1));
});

test('refund above what was paid by that method is rejected', () => {
  assert.throws(() => assertRefundable(paidEntries, 'CARD', 2000_01), billingError('REFUND_EXCEEDS_PAID'));
  // 3000 ₸ was paid in all, but only 1000 ₸ of it in cash.
  assert.throws(() => assertRefundable(paidEntries, 'CASH', 1500_00), billingError('REFUND_EXCEEDS_PAID'));
});

test('refund by a method that was not used is rejected', () => {
  assert.throws(() => assertRefundable(paidEntries, 'QR', 1), billingError('REFUND_EXCEEDS_PAID'));
  assert.throws(() => assertRefundable([], 'CASH', 1), billingError('REFUND_EXCEEDS_PAID'));
});

test('earlier refunds lower the limit', () => {
  const entries = [...paidEntries, refund('CARD', 1500_00)];
  assert.doesNotThrow(() => assertRefundable(entries, 'CARD', 500_00));
  assert.throws(() => assertRefundable(entries, 'CARD', 500_01), billingError('REFUND_EXCEEDS_PAID'));
  const fully = [...entries, refund('CARD', 500_00)];
  assert.throws(() => assertRefundable(fully, 'CARD', 1), billingError('REFUND_EXCEEDS_PAID'));
  assert.doesNotThrow(() => assertRefundable(fully, 'CASH', 1000_00));
});

test('refund amount must be a positive whole number', () => {
  for (const amount of [0, -1, 10.5, Number.NaN]) {
    assert.throws(() => assertRefundable(paidEntries, 'CASH', amount), billingError('INVALID_AMOUNT'), String(amount));
  }
});

test('refund by an unknown method is rejected', () => {
  const method = 'BITCOIN' as string as PaymentMethod;
  assert.throws(() => assertRefundable(paidEntries, method, 100), billingError('INVALID_METHOD'));
});

// ── Reasons and approvals ────────────────────────────────────────────────────

test('a reason is required', () => {
  for (const reason of ['', '   ', 'ab', '  ab  ', null, undefined]) {
    assert.throws(() => assertReason(reason), billingError('REASON_REQUIRED'), JSON.stringify(reason));
  }
});

test('a reason is trimmed and kept', () => {
  assert.equal(assertReason('abc'), 'abc');
  assert.equal(assertReason('  Гость ушёл раньше \n'), 'Гость ушёл раньше');
  assert.equal(assertReason('x'.repeat(600)).length, 500);
});

test('the missing reason message names what is missing', () => {
  assert.throws(
    () => assertReason(' ', 'причину скидки'),
    (e: unknown) => e instanceof BillingError && e.code === 'REASON_REQUIRED' && e.message.includes('причину скидки'),
  );
});

test('a manager approval is required', () => {
  for (const name of ['', '   ', 'A', ' A ', null, undefined]) {
    assert.throws(() => assertApprover(name), billingError('APPROVAL_REQUIRED'), JSON.stringify(name));
  }
});

test('the approver name is trimmed', () => {
  assert.equal(assertApprover('  Айгерим  '), 'Айгерим');
  assert.equal(assertApprover('Ли'), 'Ли');
  assert.equal(assertApprover('я'.repeat(150)).length, 100);
});

// ── Money parsing ────────────────────────────────────────────────────────────

test('minor units per major unit', () => {
  assert.equal(minorPerMajor('KZT'), 100);
  assert.equal(minorPerMajor('USD'), 100);
  assert.equal(minorPerMajor('JPY'), 1);
});

test('parseMoney reads what staff type', () => {
  assert.equal(parseMoney('2070', 'KZT'), 2070_00);
  assert.equal(parseMoney('2 070', 'KZT'), 2070_00);
  assert.equal(parseMoney('2 070', 'KZT'), 2070_00);
  assert.equal(parseMoney('2 070', 'KZT'), 2070_00);
  assert.equal(parseMoney('  2070  ', 'KZT'), 2070_00);
  assert.equal(parseMoney('2070,5', 'KZT'), 2070_50);
  assert.equal(parseMoney('2070,50', 'KZT'), 2070_50);
  assert.equal(parseMoney('2070.50', 'KZT'), 2070_50);
  assert.equal(parseMoney('0,05', 'KZT'), 5);
  assert.equal(parseMoney('0', 'KZT'), 0);
});

test('parseMoney rejects what is not an amount', () => {
  for (const text of ['', '   ', '-5', '+5', '1e3', '12.345', 'abc', '1,2,3', '.5', '2 070 ₸', '99999999999999999999']) {
    assert.equal(parseMoney(text, 'KZT'), null, JSON.stringify(text));
  }
});

test('parseMoney follows the currency decimals', () => {
  assert.equal(parseMoney('1500', 'JPY'), 1500);
  assert.equal(parseMoney('1500.5', 'JPY'), null);
});

test('roundToStep rounds half up', () => {
  assert.equal(roundToStep(310_50, 100), 311_00);
  assert.equal(roundToStep(310_49, 100), 310_00);
  assert.equal(roundToStep(20700.5, 1), 20701);
  assert.equal(roundToStep(20700.49, 1), 20700);
});

// ── Session ──────────────────────────────────────────────────────────────────

test('an unpaid game can be voided, a paid or running one cannot', () => {
  assert.ok(canTransition('AWAITING_PAYMENT', 'CANCELLED'));
  assert.ok(canTransition('AWAITING_PAYMENT', 'CLOSED'));
  assert.ok(!canTransition('CLOSED', 'CANCELLED'));
  assert.ok(!canTransition('ACTIVE', 'CANCELLED'));
  assert.ok(!canTransition('CANCELLED', 'AWAITING_PAYMENT'));
});
