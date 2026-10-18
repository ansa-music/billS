import type { Minor } from './money.ts';

/**
 * Fiscal boundary (Kazakhstan: online ККМ → ОФД → КГД) and QR payments.
 *
 * Only types and pure helpers live here. Providers (Webkassa, re:Kassa, Kaspi …)
 * are implemented in apps/hub/src/fiscal/ behind these interfaces; the rest of
 * the system never talks to a cash register directly.
 *
 * See docs/FISCAL_RU.md for the legal background and the field mapping.
 */

/** sale — чек продажи; refund — чек возврата (the only way to correct a sale since 2026). */
export type FiscalOperation = 'sale' | 'refund';

/** How the guest paid. `mixed` means several lines in `payments`. */
export type PaymentMethod = 'cash' | 'card' | 'qr' | 'mixed';

export type SinglePaymentMethod = Exclude<PaymentMethod, 'mixed'>;

/** 0 — товар, 1 — работа, 2 — услуга. Table time is a service. */
export type FiscalItemKind = 'goods' | 'work' | 'service';

export interface FiscalItem {
  /** Name as printed on the receipt (must match the national catalogue, НКТ). */
  name: string;
  kind: FiscalItemKind;
  /** Quantity in thousandths (1 piece = 1000) so 1.5 hours is an integer. */
  quantityMilli: number;
  /** Unit label, e.g. "час", "шт". */
  unit: string;
  /** Price per unit in minor units. */
  unitPriceMinor: Minor;
  /** Line total in minor units after discount (what the guest actually pays). */
  totalMinor: Minor;
  /** Discount already subtracted from totalMinor; informational. */
  discountMinor?: Minor;
  /** Code in the national catalogue of goods (НКТ / NTIN), when known. */
  catalogCode?: string;
  /** VAT rate in basis points (1200 = 12 %). Omit for non-VAT payers. */
  vatRateBp?: number;
}

export interface FiscalPayment {
  method: SinglePaymentMethod;
  amountMinor: Minor;
}

export interface FiscalReceipt {
  /** Our own id; providers must treat a repeated id as the same receipt. */
  id: string;
  operation: FiscalOperation;
  /** ISO 4217, e.g. "KZT". */
  currency: string;
  items: FiscalItem[];
  payments: FiscalPayment[];
  /** Derived from `payments`, kept explicit for storage and display. */
  paymentMethod: PaymentMethod;
  /** Sum of item totals. */
  totalMinor: Minor;
  /** Cash handed back to the guest (cash received − total), 0 when none. */
  changeMinor: Minor;
  /** For refunds: fiscal number of the original sale receipt. */
  refundOfFiscalNumber?: string;
  /** Guest's ИИН/БИН printed on request (п. 57 Правил). */
  customerTaxId?: string;
  /** Where to send an electronic copy. */
  customerContact?: { email?: string; phone?: string };
  /** Who rang it up (shown on the receipt and in the audit). */
  cashier: string;
  /** HUB time when the receipt was created, epoch ms. */
  createdAt: number;
  /** Free-form links back to our data (bill id, session ids). Not sent to the provider. */
  externalRef?: string;
}

export interface FiscalResult {
  receiptId: string;
  /** Фискальный признак (ФП) from the ОФД, or the autonomous code while offline. */
  fiscalNumber: string;
  /** Порядковый номер чека within the cash register. */
  receiptNumber: string;
  /** Link to the receipt on the ОФД site (printed as text and encoded in the QR). */
  ofdUrl: string;
  /** Exact content of the QR code to print/show. */
  qrPayload: string;
  /** Заводской номер ККМ (ЗНМ). */
  cashboxSerial: string;
  /** Регистрационный номер ККМ (РНМ) in the tax authority. */
  cashboxRegistration: string;
  /** Name of the ОФД as printed on the receipt. */
  ofdName: string;
  shiftNumber: number | null;
  /** True when registered in autonomous mode: the number is a temporary code, a real ФП arrives later. */
  offline: boolean;
  /** Provider's registration time, epoch ms. */
  registeredAt: number;
}

export type FiscalErrorCode =
  | 'INVALID_RECEIPT'
  | 'OFD_UNAVAILABLE'
  | 'OFFLINE_LIMIT_EXCEEDED'
  | 'SHIFT_EXPIRED'
  | 'PROVIDER_ERROR';

export class FiscalError extends Error {
  readonly code: FiscalErrorCode;

  constructor(code: FiscalErrorCode, message: string) {
    super(message);
    this.name = 'FiscalError';
    this.code = code;
  }
}

/** A cash register / ОФД adapter. One instance per physical or software ККМ. */
export interface FiscalProvider {
  readonly name: string;
  /**
   * Registers a receipt. Must be idempotent on `receipt.id`.
   * Throws FiscalError('OFD_UNAVAILABLE') when the register cannot be reached;
   * the caller decides whether to queue (see apps/hub/src/fiscal/queue.ts).
   */
  register(receipt: FiscalReceipt, signal?: AbortSignal): Promise<FiscalResult>;
}

export type QrInvoiceStatus = 'pending' | 'paid' | 'expired';

export interface QrInvoice {
  invoiceId: string;
  /** Content of the QR code shown to the guest. */
  qrPayload: string;
  /** When the QR stops working, epoch ms (Kaspi QR lives a few minutes). */
  expiresAt: number;
}

/** A QR payment adapter (Kaspi QR / Smart POS / bank QR). */
export interface QrPaymentProvider {
  readonly name: string;
  /** Creates a dynamic QR for `amountMinor`. Must be idempotent on `orderId`. */
  createInvoice(amountMinor: Minor, orderId: string): Promise<QrInvoice>;
  status(invoiceId: string): Promise<QrInvoiceStatus>;
}

/** Maximum autonomous (offline) mode before the register is blocked: 72 hours (п. 81 Правил). */
export const MAX_OFFLINE_MS = 72 * 60 * 60 * 1000;

/** Maximum shift length before a Z-report is required: 24 hours (п. 29 Правил). */
export const MAX_SHIFT_MS = 24 * 60 * 60 * 1000;

export function paymentMethodOf(payments: readonly FiscalPayment[]): PaymentMethod {
  const used = new Set(payments.filter((p) => p.amountMinor > 0).map((p) => p.method));
  if (used.size === 0) return payments[0]?.method ?? 'cash';
  if (used.size > 1) return 'mixed';
  return [...used][0]!;
}

function isMinor(n: unknown): n is Minor {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/** Returns a list of problems; empty means the receipt can go to a provider. */
export function validateFiscalReceipt(r: FiscalReceipt): string[] {
  const problems: string[] = [];
  if (!r.id) problems.push('id is required');
  if (r.operation !== 'sale' && r.operation !== 'refund') problems.push('operation must be sale or refund');
  if (!/^[A-Z]{3}$/.test(r.currency)) problems.push('currency must be an ISO 4217 code');
  if (!r.cashier) problems.push('cashier is required');
  if (r.items.length === 0) problems.push('at least one item is required');

  let itemsTotal = 0;
  r.items.forEach((it, i) => {
    if (!it.name.trim()) problems.push(`item ${i}: name is required`);
    if (!Number.isSafeInteger(it.quantityMilli) || it.quantityMilli <= 0) problems.push(`item ${i}: quantity must be positive`);
    if (!isMinor(it.unitPriceMinor) || it.unitPriceMinor < 0) problems.push(`item ${i}: unit price must be a non-negative integer`);
    if (!isMinor(it.totalMinor) || it.totalMinor < 0) problems.push(`item ${i}: total must be a non-negative integer`);
    if (it.discountMinor !== undefined && (!isMinor(it.discountMinor) || it.discountMinor < 0)) {
      problems.push(`item ${i}: discount must be a non-negative integer`);
    }
    if (it.vatRateBp !== undefined && (!Number.isInteger(it.vatRateBp) || it.vatRateBp < 0 || it.vatRateBp > 10000)) {
      problems.push(`item ${i}: vat rate out of range`);
    }
    itemsTotal += it.totalMinor;
  });
  if (!isMinor(r.totalMinor) || r.totalMinor < 0) problems.push('total must be a non-negative integer');
  else if (itemsTotal !== r.totalMinor) problems.push(`items sum to ${itemsTotal}, total is ${r.totalMinor}`);

  if (r.payments.length === 0) problems.push('at least one payment is required');
  let paid = 0;
  r.payments.forEach((p, i) => {
    if (!isMinor(p.amountMinor) || p.amountMinor < 0) problems.push(`payment ${i}: amount must be a non-negative integer`);
    else paid += p.amountMinor;
  });
  if (!isMinor(r.changeMinor) || r.changeMinor < 0) problems.push('change must be a non-negative integer');
  else if (isMinor(r.totalMinor) && paid !== r.totalMinor + r.changeMinor) {
    problems.push(`payments (${paid}) must equal total + change (${r.totalMinor + r.changeMinor})`);
  }
  if (r.changeMinor > 0 && !r.payments.some((p) => p.method === 'cash' && p.amountMinor >= r.changeMinor)) {
    problems.push('change is only possible from a cash payment');
  }
  if (r.paymentMethod !== paymentMethodOf(r.payments)) problems.push('paymentMethod does not match payments');

  if (r.operation === 'refund' && !r.refundOfFiscalNumber) problems.push('refund must reference the original fiscal number');
  if (r.customerTaxId !== undefined && !/^\d{12}$/.test(r.customerTaxId)) problems.push('customer ИИН/БИН must be 12 digits');
  return problems;
}

/** Builds the refund receipt for a registered sale (full refund, same items and payment split). */
export function refundReceiptFor(
  sale: FiscalReceipt,
  saleResult: FiscalResult,
  details: { id: string; cashier: string; createdAt: number },
): FiscalReceipt {
  if (sale.operation !== 'sale') throw new FiscalError('INVALID_RECEIPT', 'only a sale can be refunded');
  return {
    ...sale,
    id: details.id,
    operation: 'refund',
    cashier: details.cashier,
    createdAt: details.createdAt,
    refundOfFiscalNumber: saleResult.fiscalNumber,
    payments: sale.payments.map((p) => ({ ...p })),
    items: sale.items.map((it) => ({ ...it })),
    changeMinor: 0,
    customerContact: sale.customerContact ? { ...sale.customerContact } : undefined,
  };
}
