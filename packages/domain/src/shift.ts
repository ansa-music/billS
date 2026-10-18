import type { LedgerEntry, PaymentMethod } from './billing.ts';
import { BillingError, PAYMENT_METHODS } from './billing.ts';
import type { Minor } from './money.ts';

/** Cash shift arithmetic: what should be in the drawer and what the X/Z report shows. */

export const CASH_MOVEMENT_KINDS = ['DEPOSIT', 'WITHDRAWAL'] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[number];

export interface CashMovement {
  kind: CashMovementKind;
  amount: Minor;
}

export type MethodTotals = Record<PaymentMethod, Minor> & { total: Minor };

export interface ShiftLedger {
  /** Change put into the drawer when the shift opened. */
  openingFloat: Minor;
  /** Payments and refunds taken during the shift. */
  entries: readonly LedgerEntry[];
  /** Cash put in or taken out (not sales). */
  movements: readonly CashMovement[];
}

export interface ShiftTotals {
  openingFloat: Minor;
  sales: MethodTotals;
  refunds: MethodTotals;
  /** sales − refunds. */
  net: MethodTotals;
  deposits: Minor;
  withdrawals: Minor;
  /** openingFloat + net cash + deposits − withdrawals. */
  expectedCash: Minor;
}

function emptyTotals(): MethodTotals {
  return { CASH: 0, CARD: 0, QR: 0, total: 0 };
}

export function shiftTotals(ledger: ShiftLedger): ShiftTotals {
  const sales = emptyTotals();
  const refunds = emptyTotals();
  for (const e of ledger.entries) {
    const bucket = e.kind === 'PAYMENT' ? sales : refunds;
    bucket[e.method] += e.amount;
    bucket.total += e.amount;
  }
  const net = emptyTotals();
  for (const m of PAYMENT_METHODS) net[m] = sales[m] - refunds[m];
  net.total = sales.total - refunds.total;

  let deposits = 0;
  let withdrawals = 0;
  for (const m of ledger.movements) {
    if (m.kind === 'DEPOSIT') deposits += m.amount;
    else withdrawals += m.amount;
  }
  return {
    openingFloat: ledger.openingFloat,
    sales,
    refunds,
    net,
    deposits,
    withdrawals,
    expectedCash: ledger.openingFloat + net.CASH + deposits - withdrawals,
  };
}

/** Counted minus expected: positive is a surplus, negative a shortage. */
export function cashDifference(countedCash: Minor, expectedCash: Minor): Minor {
  return countedCash - expectedCash;
}

/** Cash can only leave the drawer (withdrawal, cash refund) if it is there. */
export function assertCashAvailable(expectedCash: Minor, amount: Minor): void {
  if (amount > expectedCash) throw new BillingError('INSUFFICIENT_CASH', 'В кассе нет столько наличных');
}

export function assertCashAmount(amount: Minor, allowZero = false): void {
  if (!Number.isInteger(amount) || amount < 0 || (!allowZero && amount === 0)) {
    throw new BillingError('INVALID_AMOUNT', allowZero ? 'Сумма — целое неотрицательное число' : 'Сумма — положительное целое число');
  }
}
