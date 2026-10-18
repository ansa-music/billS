import { FiscalError, validateFiscalReceipt } from '@bills/domain';
import type {
  FiscalProvider,
  FiscalReceipt,
  FiscalResult,
  Minor,
  QrInvoice,
  QrInvoiceStatus,
  QrPaymentProvider,
} from '@bills/domain';
import type { Clock } from '../clock.ts';

/**
 * In-memory stand-ins for a cash register (ККМ + ОФД) and a QR payment service.
 * Used in tests and demos until a real provider (Webkassa, re:Kassa, Kaspi …) is wired.
 * Together with OfflineFiscalQueue they reproduce "offline → queued → retried".
 */

export interface MockFiscalOptions {
  clock: Clock;
  serial?: string;
  registration?: string;
  ofdName?: string;
  ofdBaseUrl?: string;
  latencyMs?: number;
}

export class MockFiscalProvider implements FiscalProvider {
  readonly name = 'mock-kkm';
  /** While true every call fails like a register that lost the ОФД. */
  offline = false;
  readonly serial: string;
  readonly registration: string;
  readonly ofdName: string;
  readonly registered: FiscalResult[] = [];
  readonly #clock: Clock;
  readonly #ofdBaseUrl: string;
  readonly #latencyMs: number;
  readonly #byId = new Map<string, FiscalResult>();
  readonly #receipts = new Map<string, FiscalReceipt>();
  #seq = 0;
  #shift = 1;

  constructor(options: MockFiscalOptions) {
    this.#clock = options.clock;
    this.serial = options.serial ?? 'SWK00000001';
    this.registration = options.registration ?? '010100000001';
    this.ofdName = options.ofdName ?? 'Mock ОФД';
    this.#ofdBaseUrl = options.ofdBaseUrl ?? 'https://ofd.example.kz/ticket';
    this.#latencyMs = options.latencyMs ?? 0;
  }

  /** The receipt a result was issued for (for tests and for the refund flow). */
  receipt(id: string): FiscalReceipt | undefined {
    return this.#receipts.get(id);
  }

  /** Closes the shift: a Z-report in a real register. */
  closeShift(): void {
    this.#shift += 1;
  }

  async register(receipt: FiscalReceipt, signal?: AbortSignal): Promise<FiscalResult> {
    signal?.throwIfAborted();
    const problems = validateFiscalReceipt(receipt);
    if (problems.length > 0) throw new FiscalError('INVALID_RECEIPT', problems.join('; '));

    const known = this.#byId.get(receipt.id);
    if (known) return known;

    if (this.#latencyMs > 0) await delay(this.#latencyMs, signal);
    if (this.offline) throw new FiscalError('OFD_UNAVAILABLE', 'ОФД недоступен (имитация)');

    if (receipt.operation === 'refund') {
      const original = this.registered.find((r) => r.fiscalNumber === receipt.refundOfFiscalNumber && !r.offline);
      if (!original) throw new FiscalError('PROVIDER_ERROR', `Чек продажи ${receipt.refundOfFiscalNumber} не найден на этой кассе`);
    }

    this.#seq += 1;
    const number = String(this.#seq);
    const fiscalNumber = String(100000 + this.#seq * 7919);
    const ofdUrl = `${this.#ofdBaseUrl}?i=${this.registration}&f=${fiscalNumber}&s=${receipt.totalMinor}`;
    const result: FiscalResult = {
      receiptId: receipt.id,
      fiscalNumber,
      receiptNumber: number,
      ofdUrl,
      qrPayload: ofdUrl,
      cashboxSerial: this.serial,
      cashboxRegistration: this.registration,
      ofdName: this.ofdName,
      shiftNumber: this.#shift,
      offline: false,
      registeredAt: this.#clock.now(),
    };
    this.#byId.set(receipt.id, result);
    this.#receipts.set(receipt.id, receipt);
    this.registered.push(result);
    return result;
  }
}

export interface MockQrOptions {
  clock: Clock;
  /** How long a dynamic QR stays valid; Kaspi QR codes live a few minutes. */
  ttlMs?: number;
}

interface MockInvoice extends QrInvoice {
  orderId: string;
  amountMinor: Minor;
  paidAt: number | null;
}

export class MockQrPaymentProvider implements QrPaymentProvider {
  readonly name = 'mock-qr';
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #byInvoice = new Map<string, MockInvoice>();
  readonly #byOrder = new Map<string, MockInvoice>();
  #seq = 0;

  constructor(options: MockQrOptions) {
    this.#clock = options.clock;
    this.#ttlMs = options.ttlMs ?? 3 * 60 * 1000;
  }

  async createInvoice(amountMinor: Minor, orderId: string): Promise<QrInvoice> {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new FiscalError('INVALID_RECEIPT', 'Сумма QR-счёта должна быть положительным целым числом');
    }
    if (!orderId) throw new FiscalError('INVALID_RECEIPT', 'orderId обязателен');

    const existing = this.#byOrder.get(orderId);
    if (existing) {
      if (existing.amountMinor !== amountMinor) {
        throw new FiscalError('PROVIDER_ERROR', `Счёт ${orderId} уже выставлен на другую сумму`);
      }
      return existing;
    }

    this.#seq += 1;
    const invoiceId = `mockqr-${this.#seq}`;
    const now = this.#clock.now();
    const invoice: MockInvoice = {
      invoiceId,
      orderId,
      amountMinor,
      qrPayload: `mockqr://pay?invoice=${invoiceId}&amount=${amountMinor}&order=${encodeURIComponent(orderId)}`,
      expiresAt: now + this.#ttlMs,
      paidAt: null,
    };
    this.#byInvoice.set(invoiceId, invoice);
    this.#byOrder.set(orderId, invoice);
    return invoice;
  }

  async status(invoiceId: string): Promise<QrInvoiceStatus> {
    const inv = this.#byInvoice.get(invoiceId);
    if (!inv) throw new FiscalError('PROVIDER_ERROR', `Счёт ${invoiceId} не найден`);
    if (inv.paidAt !== null) return 'paid';
    return this.#clock.now() >= inv.expiresAt ? 'expired' : 'pending';
  }

  /** The guest scans and confirms. Returns false when the QR has already expired. */
  pay(invoiceId: string): boolean {
    const inv = this.#byInvoice.get(invoiceId);
    if (!inv) throw new FiscalError('PROVIDER_ERROR', `Счёт ${invoiceId} не найден`);
    if (inv.paidAt !== null) return true;
    if (this.#clock.now() >= inv.expiresAt) return false;
    inv.paidAt = this.#clock.now();
    return true;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
