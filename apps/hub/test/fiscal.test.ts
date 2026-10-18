import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FiscalError,
  MAX_OFFLINE_MS,
  paymentMethodOf,
  refundReceiptFor,
  validateFiscalReceipt,
} from '@bills/domain';
import type { FiscalReceipt, FiscalResult } from '@bills/domain';
import { ManualClock } from '../src/clock.ts';
import { MockFiscalProvider, MockQrPaymentProvider } from '../src/fiscal/mock.ts';
import { OfflineFiscalQueue } from '../src/fiscal/queue.ts';
import { MONDAY_NOON } from './helpers.ts';

const HOUR = 60 * 60 * 1000;

function sale(id: string, overrides: Partial<FiscalReceipt> = {}): FiscalReceipt {
  return {
    id,
    operation: 'sale',
    currency: 'KZT',
    items: [
      { name: 'Бильярд, стол 1', kind: 'service', quantityMilli: 1500, unit: 'час', unitPriceMinor: 2000_00, totalMinor: 3000_00 },
      { name: 'Кола 0,5', kind: 'goods', quantityMilli: 2000, unit: 'шт', unitPriceMinor: 500_00, totalMinor: 1000_00 },
    ],
    payments: [{ method: 'cash', amountMinor: 4000_00 }],
    paymentMethod: 'cash',
    totalMinor: 4000_00,
    changeMinor: 0,
    cashier: 'Кассир Айгерим',
    createdAt: MONDAY_NOON,
    ...overrides,
  };
}

function setup(options: { maxOfflineMs?: number } = {}) {
  const clock = new ManualClock(MONDAY_NOON);
  const kkm = new MockFiscalProvider({ clock });
  const fiscalized: Array<{ final: FiscalResult; provisional: FiscalResult }> = [];
  const queue = new OfflineFiscalQueue(kkm, {
    clock,
    maxOfflineMs: options.maxOfflineMs,
    cashbox: { serial: kkm.serial, registration: kkm.registration, ofdName: kkm.ofdName },
    onFiscalized: (final, provisional) => fiscalized.push({ final, provisional }),
  });
  return { clock, kkm, queue, fiscalized };
}

// ---------- domain helpers ----------

test('a well-formed receipt passes validation', () => {
  assert.deepEqual(validateFiscalReceipt(sale('r1')), []);
});

test('validation catches money that does not add up', () => {
  const badTotal = validateFiscalReceipt(sale('r1', { totalMinor: 3999_00 }));
  assert.ok(badTotal.some((p) => p.includes('items sum')));

  const badPayments = validateFiscalReceipt(sale('r2', { payments: [{ method: 'card', amountMinor: 3000_00 }], paymentMethod: 'card' }));
  assert.ok(badPayments.some((p) => p.includes('payments')));

  const floatPrice = sale('r3');
  floatPrice.items[0]!.unitPriceMinor = 2000.5;
  assert.ok(validateFiscalReceipt(floatPrice).some((p) => p.includes('unit price')));

  const changeFromCard = validateFiscalReceipt(
    sale('r4', { payments: [{ method: 'card', amountMinor: 4500_00 }], paymentMethod: 'card', changeMinor: 500_00 }),
  );
  assert.ok(changeFromCard.some((p) => p.includes('change is only possible from a cash payment')));
});

test('mixed payment is derived from the payment lines and must be declared as such', () => {
  const payments = [
    { method: 'cash' as const, amountMinor: 1000_00 },
    { method: 'qr' as const, amountMinor: 3000_00 },
  ];
  assert.equal(paymentMethodOf(payments), 'mixed');
  assert.equal(paymentMethodOf([{ method: 'qr', amountMinor: 10 }]), 'qr');
  // A zero line does not make the payment mixed.
  assert.equal(paymentMethodOf([{ method: 'cash', amountMinor: 0 }, { method: 'card', amountMinor: 10 }]), 'card');

  const wrong = validateFiscalReceipt(sale('r1', { payments, paymentMethod: 'cash' }));
  assert.ok(wrong.some((p) => p.includes('paymentMethod')));
  assert.deepEqual(validateFiscalReceipt(sale('r1', { payments, paymentMethod: 'mixed' })), []);
});

test('a refund must point at the original fiscal number; the helper builds it', () => {
  const problems = validateFiscalReceipt(sale('r1', { operation: 'refund' }));
  assert.ok(problems.some((p) => p.includes('original fiscal number')));

  const original = sale('s1', { changeMinor: 500_00, payments: [{ method: 'cash', amountMinor: 4500_00 }] });
  const result: FiscalResult = {
    receiptId: 's1',
    fiscalNumber: '123456',
    receiptNumber: '1',
    ofdUrl: 'https://ofd.example.kz/t',
    qrPayload: 'https://ofd.example.kz/t',
    cashboxSerial: 'S',
    cashboxRegistration: 'R',
    ofdName: 'ОФД',
    shiftNumber: 1,
    offline: false,
    registeredAt: MONDAY_NOON,
  };
  const refund = refundReceiptFor(original, result, { id: 'rf1', cashier: 'Управляющий', createdAt: MONDAY_NOON + HOUR });
  assert.equal(refund.operation, 'refund');
  assert.equal(refund.refundOfFiscalNumber, '123456');
  assert.equal(refund.changeMinor, 0);
  assert.equal(refund.totalMinor, original.totalMinor);
  // Refund returns the exact amount, without the change the guest already got back.
  assert.deepEqual(refund.payments, [{ method: 'cash', amountMinor: 4500_00 }]);
  assert.deepEqual(validateFiscalReceipt(refund), ['payments (450000) must equal total + change (400000)']);
  refund.payments = [{ method: 'cash', amountMinor: 4000_00 }];
  assert.deepEqual(validateFiscalReceipt(refund), []);
  assert.throws(() => refundReceiptFor(refund, result, { id: 'x', cashier: 'x', createdAt: 0 }), /only a sale/);
});

// ---------- mock register ----------

test('the mock register issues a fiscal number, an ОФД link and a QR with that link', async () => {
  const { kkm } = setup();
  const r = await kkm.register(sale('r1'));
  assert.equal(r.receiptId, 'r1');
  assert.equal(r.offline, false);
  assert.equal(r.receiptNumber, '1');
  assert.match(r.fiscalNumber, /^\d+$/);
  assert.ok(r.ofdUrl.startsWith('https://'));
  assert.equal(r.qrPayload, r.ofdUrl);
  assert.equal(r.cashboxSerial, kkm.serial);
  assert.equal(r.cashboxRegistration, kkm.registration);
  assert.equal(r.shiftNumber, 1);

  const second = await kkm.register(sale('r2'));
  assert.equal(second.receiptNumber, '2');
  assert.notEqual(second.fiscalNumber, r.fiscalNumber);
});

test('registering the same receipt twice returns the same result and does not duplicate it', async () => {
  const { kkm } = setup();
  const a = await kkm.register(sale('r1'));
  const b = await kkm.register(sale('r1'));
  assert.deepEqual(a, b);
  assert.equal(kkm.registered.length, 1);
});

test('an invalid receipt is rejected before it reaches the register', async () => {
  const { kkm } = setup();
  await assert.rejects(kkm.register(sale('r1', { totalMinor: 1 })), (e: unknown) => e instanceof FiscalError && e.code === 'INVALID_RECEIPT');
  assert.equal(kkm.registered.length, 0);
});

test('a refund is registered against the sale; an unknown sale is refused', async () => {
  const { kkm } = setup();
  const saleResult = await kkm.register(sale('s1'));
  const refund = refundReceiptFor(sale('s1'), saleResult, { id: 'rf1', cashier: 'Управляющий', createdAt: MONDAY_NOON + HOUR });
  const r = await kkm.register(refund);
  assert.equal(r.offline, false);
  assert.equal(kkm.receipt('rf1')?.operation, 'refund');

  const bogus = { ...refund, id: 'rf2', refundOfFiscalNumber: '000' };
  await assert.rejects(kkm.register(bogus), (e: unknown) => e instanceof FiscalError && e.code === 'PROVIDER_ERROR');
});

test('a slow register can be aborted', async () => {
  const clock = new ManualClock(MONDAY_NOON);
  const kkm = new MockFiscalProvider({ clock, latencyMs: 500 });
  const ac = new AbortController();
  const p = kkm.register(sale('r1'), ac.signal);
  ac.abort(new Error('timeout'));
  await assert.rejects(p, /timeout/);
  assert.equal(kkm.registered.length, 0);
});

// ---------- offline → queued → retried ----------

test('offline: the guest still gets a receipt with an autonomous code, and it is queued', async () => {
  const { kkm, queue, clock } = setup();
  kkm.offline = true;

  const r = await queue.register(sale('r1'));
  assert.equal(r.offline, true);
  assert.match(r.fiscalNumber, /^AUTO-/);
  assert.equal(r.ofdUrl, '');
  assert.equal(r.cashboxSerial, kkm.serial);
  assert.equal(queue.pending().length, 1);
  assert.equal(queue.offlineSince(), clock.now());
  assert.equal(kkm.registered.length, 0);

  // Re-asking for the same receipt while offline gives the same provisional result.
  assert.deepEqual(await queue.register(sale('r1')), r);
  assert.equal(queue.pending().length, 1);
});

test('retry while still offline changes nothing but the attempt counter', async () => {
  const { kkm, queue } = setup();
  kkm.offline = true;
  await queue.register(sale('r1'));
  assert.equal(await queue.retry(), 0);
  const [entry] = queue.pending();
  assert.equal(entry?.attempts, 2);
  assert.ok(entry?.lastError);
});

test('when the ОФД is back, queued receipts get real fiscal numbers in order and the bill is told', async () => {
  const { kkm, queue, fiscalized } = setup();
  kkm.offline = true;
  const p1 = await queue.register(sale('r1'));
  const p2 = await queue.register(sale('r2'));
  const p3 = await queue.register(sale('r3'));
  assert.equal(queue.pending().length, 3);

  kkm.offline = false;
  assert.equal(await queue.retry(), 3);
  assert.equal(queue.pending().length, 0);
  assert.equal(queue.offlineSince(), null);

  assert.deepEqual(fiscalized.map((f) => f.provisional.fiscalNumber), [p1.fiscalNumber, p2.fiscalNumber, p3.fiscalNumber]);
  assert.deepEqual(fiscalized.map((f) => f.final.receiptNumber), ['1', '2', '3']);
  for (const f of fiscalized) {
    assert.equal(f.final.offline, false);
    assert.ok(f.final.ofdUrl);
    assert.equal(f.final.receiptId, f.provisional.receiptId);
  }

  // After the flush the queue answers with the final result for the same id.
  const again = await queue.register(sale('r2'));
  assert.equal(again.offline, false);
  assert.equal(again.fiscalNumber, fiscalized[1]!.final.fiscalNumber);
  assert.equal(kkm.registered.length, 3);
});

test('a receipt registered online while others are queued does not jump the queue on retry', async () => {
  const { kkm, queue } = setup();
  kkm.offline = true;
  await queue.register(sale('r1'));
  kkm.offline = false;
  const online = await queue.register(sale('r2'));
  assert.equal(online.offline, false);
  assert.equal(queue.pending().length, 1);
  await queue.retry();
  assert.equal(queue.pending().length, 0);
  assert.deepEqual(kkm.registered.map((r) => r.receiptId), ['r2', 'r1']);
});

test('after 72 hours offline the register is blocked until the queue is sent', async () => {
  const { kkm, queue, clock } = setup();
  kkm.offline = true;
  await queue.register(sale('r1'));

  clock.advance(MAX_OFFLINE_MS - 1);
  const stillOk = await queue.register(sale('r2'));
  assert.equal(stillOk.offline, true);

  clock.advance(1);
  await assert.rejects(queue.register(sale('r3')), (e: unknown) => e instanceof FiscalError && e.code === 'OFFLINE_LIMIT_EXCEEDED');
  assert.equal(queue.pending().length, 2);

  kkm.offline = false;
  assert.equal(await queue.retry(), 2);
  const r3 = await queue.register(sale('r3'));
  assert.equal(r3.offline, false);
});

test('concurrent retries share one pass', async () => {
  const { kkm, queue } = setup();
  kkm.offline = true;
  await queue.register(sale('r1'));
  kkm.offline = false;
  const [a, b] = await Promise.all([queue.retry(), queue.retry()]);
  assert.equal(a + b, 2); // both callers see the same pass result
  assert.equal(kkm.registered.length, 1);
});

// ---------- QR payments ----------

test('QR invoice: pending until the guest pays, then paid', async () => {
  const clock = new ManualClock(MONDAY_NOON);
  const qr = new MockQrPaymentProvider({ clock });
  const inv = await qr.createInvoice(4000_00, 'bill-1');
  assert.ok(inv.qrPayload.includes('amount=400000'));
  assert.equal(inv.expiresAt, MONDAY_NOON + 3 * 60 * 1000);
  assert.equal(await qr.status(inv.invoiceId), 'pending');
  assert.equal(qr.pay(inv.invoiceId), true);
  assert.equal(await qr.status(inv.invoiceId), 'paid');
});

test('QR invoice is idempotent per order and refuses a different amount for the same order', async () => {
  const clock = new ManualClock(MONDAY_NOON);
  const qr = new MockQrPaymentProvider({ clock });
  const a = await qr.createInvoice(1000, 'bill-1');
  const b = await qr.createInvoice(1000, 'bill-1');
  assert.equal(a.invoiceId, b.invoiceId);
  await assert.rejects(qr.createInvoice(2000, 'bill-1'), (e: unknown) => e instanceof FiscalError && e.code === 'PROVIDER_ERROR');
  await assert.rejects(qr.createInvoice(0, 'bill-2'), (e: unknown) => e instanceof FiscalError && e.code === 'INVALID_RECEIPT');
  await assert.rejects(qr.createInvoice(10.5, 'bill-3'), (e: unknown) => e instanceof FiscalError && e.code === 'INVALID_RECEIPT');
});

test('an unpaid QR expires and can no longer be paid', async () => {
  const clock = new ManualClock(MONDAY_NOON);
  const qr = new MockQrPaymentProvider({ clock, ttlMs: 60_000 });
  const inv = await qr.createInvoice(500, 'bill-1');
  clock.advance(59_999);
  assert.equal(await qr.status(inv.invoiceId), 'pending');
  clock.advance(1);
  assert.equal(await qr.status(inv.invoiceId), 'expired');
  assert.equal(qr.pay(inv.invoiceId), false);
  assert.equal(await qr.status(inv.invoiceId), 'expired');
  await assert.rejects(qr.status('nope'), /не найден/);
});
