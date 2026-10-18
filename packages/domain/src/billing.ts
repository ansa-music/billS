import type { Minor } from './money.ts';
import { roundToStep } from './money.ts';

/**
 * Guest checks: games (and, from stage 4, bar orders) → discount → payments.
 * Pure arithmetic and rules; the HUB stores the rows and calls these.
 */

export const PAYMENT_METHODS = ['CASH', 'CARD', 'QR'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DISCOUNT_KINDS = ['PERCENT', 'AMOUNT'] as const;
export type DiscountKind = (typeof DISCOUNT_KINDS)[number];

/** A money rule was broken. `code` is stable for clients; the message is shown to staff. */
export class BillingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
  }
}

export interface Discount {
  kind: DiscountKind;
  /** PERCENT: whole percent 1…100. AMOUNT: minor units. */
  value: number;
}

/** One row of a check's money ledger. Amounts are positive; the kind gives the sign. */
export interface LedgerEntry {
  kind: 'PAYMENT' | 'REFUND';
  method: PaymentMethod;
  amount: Minor;
}

export interface CheckTotals {
  /** Sum of items. */
  subtotal: Minor;
  /** Discount in minor units. */
  discount: Minor;
  /** subtotal − discount. */
  total: Minor;
  /** Payments, gross. */
  paid: Minor;
  refunded: Minor;
  /** What is still owed: total − (paid − refunded), never negative. */
  due: Minor;
}

const isPositiveInt = (n: number) => Number.isInteger(n) && n > 0;

/**
 * Discount in minor units. A percent discount is rounded half up to `step`
 * (e.g. 100 = whole tenge) and never exceeds the subtotal.
 */
export function discountAmount(subtotal: Minor, discount: Discount | null, step: Minor = 1): Minor {
  if (!discount) return 0;
  if (discount.kind === 'PERCENT') {
    if (!Number.isInteger(discount.value) || discount.value < 1 || discount.value > 100) {
      throw new BillingError('INVALID_DISCOUNT', 'Скидка в процентах — целое число от 1 до 100');
    }
    // 100% is the whole subtotal, even when the subtotal is not a multiple of the step.
    if (discount.value === 100) return subtotal;
    return Math.min(subtotal, roundToStep((subtotal * discount.value) / 100, step));
  }
  if (discount.kind === 'AMOUNT') {
    if (!isPositiveInt(discount.value)) {
      throw new BillingError('INVALID_DISCOUNT', 'Скидка суммой — положительное целое число');
    }
    if (discount.value > subtotal) throw new BillingError('DISCOUNT_EXCEEDS_TOTAL', 'Скидка больше суммы счёта');
    return discount.value;
  }
  throw new BillingError('INVALID_DISCOUNT', 'Неизвестный вид скидки');
}

export function checkTotals(
  itemAmounts: readonly Minor[],
  discount: Discount | null,
  entries: readonly LedgerEntry[],
  step: Minor = 1,
): CheckTotals {
  const subtotal = itemAmounts.reduce((s, a) => s + a, 0);
  const disc = discountAmount(subtotal, discount, step);
  const total = subtotal - disc;
  let paid = 0;
  let refunded = 0;
  for (const e of entries) {
    if (e.kind === 'PAYMENT') paid += e.amount;
    else refunded += e.amount;
  }
  return { subtotal, discount: disc, total, paid, refunded, due: Math.max(0, total - (paid - refunded)) };
}

/** Money taken by each method minus what was refunded by it: the most that can be refunded. */
export function netPaidByMethod(entries: readonly LedgerEntry[]): Record<PaymentMethod, Minor> {
  const net: Record<PaymentMethod, Minor> = { CASH: 0, CARD: 0, QR: 0 };
  for (const e of entries) net[e.method] += e.kind === 'PAYMENT' ? e.amount : -e.amount;
  return net;
}

/** What the guest hands over by one method. */
export interface PaymentPart {
  method: PaymentMethod;
  amount: Minor;
}

export interface AppliedPart {
  method: PaymentMethod;
  /** Applied to the check (what stays in the till / on the account). */
  amount: Minor;
  /** Cash only: what the guest handed over. */
  tendered: Minor | null;
  /** Cash only: given back. */
  change: Minor | null;
}

export interface PaymentPlan {
  parts: AppliedPart[];
  /** Sum applied to the check, ≤ due. */
  applied: Minor;
  change: Minor;
  /** Still owed after this payment; > 0 means a partial payment. */
  remaining: Minor;
}

/**
 * Splits what the guest hands over into what is applied to the check.
 * Card and QR are never more than the amount due; extra cash is change.
 * Paying less than due is a partial payment. A check with nothing due is
 * settled with no parts at all.
 */
export function planPayment(due: Minor, parts: readonly PaymentPart[]): PaymentPlan {
  if (!Number.isInteger(due) || due < 0) throw new BillingError('INVALID_AMOUNT', 'Неверная сумма к оплате');
  const seen = new Set<PaymentMethod>();
  for (const p of parts) {
    if (!PAYMENT_METHODS.includes(p.method)) throw new BillingError('INVALID_METHOD', 'Неизвестный способ оплаты');
    if (!isPositiveInt(p.amount)) throw new BillingError('INVALID_AMOUNT', 'Сумма оплаты — положительное целое число');
    if (seen.has(p.method)) throw new BillingError('DUPLICATE_METHOD', 'Каждый способ оплаты — одной строкой');
    seen.add(p.method);
  }
  if (due === 0) {
    if (parts.length > 0) throw new BillingError('NOTHING_DUE', 'По счёту нечего оплачивать');
    return { parts: [], applied: 0, change: 0, remaining: 0 };
  }
  if (parts.length === 0) throw new BillingError('NO_PAYMENT', 'Укажите сумму оплаты');

  const cash = parts.find((p) => p.method === 'CASH')?.amount ?? 0;
  const nonCash = parts.reduce((s, p) => s + (p.method === 'CASH' ? 0 : p.amount), 0);
  if (nonCash > due) {
    throw new BillingError('NON_CASH_OVERPAYMENT', 'Картой или QR нельзя заплатить больше суммы к оплате');
  }
  const change = Math.max(0, cash + nonCash - due);
  if (cash > 0 && cash === change) {
    throw new BillingError('CASH_NOT_NEEDED', 'Карта и QR уже покрывают счёт — наличные не нужны');
  }

  const applied: AppliedPart[] = parts.map((p) =>
    p.method === 'CASH'
      ? { method: p.method, amount: p.amount - change, tendered: p.amount, change }
      : { method: p.method, amount: p.amount, tendered: null, change: null },
  );
  const sum = applied.reduce((s, p) => s + p.amount, 0);
  return { parts: applied, applied: sum, change, remaining: due - sum };
}

/** Checks a refund against what was actually taken by that method. */
export function assertRefundable(entries: readonly LedgerEntry[], method: PaymentMethod, amount: Minor): void {
  if (!PAYMENT_METHODS.includes(method)) throw new BillingError('INVALID_METHOD', 'Неизвестный способ оплаты');
  if (!isPositiveInt(amount)) throw new BillingError('INVALID_AMOUNT', 'Сумма возврата — положительное целое число');
  if (amount > netPaidByMethod(entries)[method]) {
    throw new BillingError('REFUND_EXCEEDS_PAID', 'Возврат больше, чем было оплачено этим способом');
  }
}

/** Cancels, refunds and discounts need a human reason in the audit. */
export function assertReason(reason: string | undefined | null, what = 'причину'): string {
  const text = (reason ?? '').trim();
  if (text.length < 3) throw new BillingError('REASON_REQUIRED', `Укажите ${what}`);
  return text.slice(0, 500);
}

/** Until PIN login (stage 3) the approving manager is named in the request. */
export function assertApprover(approvedBy: string | undefined | null): string {
  const name = (approvedBy ?? '').trim();
  if (name.length < 2) throw new BillingError('APPROVAL_REQUIRED', 'Нужно подтверждение управляющего');
  return name.slice(0, 100);
}
