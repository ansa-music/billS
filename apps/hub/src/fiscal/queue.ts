import { FiscalError, MAX_OFFLINE_MS } from '@bills/domain';
import type { FiscalProvider, FiscalReceipt, FiscalResult } from '@bills/domain';
import type { Clock } from '../clock.ts';

/**
 * Autonomous-mode wrapper around any FiscalProvider.
 *
 * How a real online ККМ behaves in Kazakhstan (п. 81 Правил, приказ МФ РК № 626):
 *  - no link to the ОФД → the receipt is still issued, with an *autonomous* code
 *    instead of a fiscal number; the register keeps it and resends it later;
 *  - the ОФД returns a real фискальный признак for every queued receipt;
 *  - after 72 hours offline the register is blocked until the backlog is sent.
 *
 * This class gives the HUB the same behaviour on top of a provider that simply
 * throws FiscalError('OFD_UNAVAILABLE'): the guest gets a receipt right away,
 * the queue is retried, and `onFiscalized` reports the final numbers so the
 * bill can be updated and the guest re-sent a copy.
 */

export interface QueuedReceipt {
  receipt: FiscalReceipt;
  /** Result shown to the guest while offline (autonomous code). */
  provisional: FiscalResult;
  attempts: number;
  queuedAt: number;
  lastError: string | null;
}

export interface OfflineQueueOptions {
  clock: Clock;
  /** Hard limit of autonomous mode; default 72 h. */
  maxOfflineMs?: number;
  /** Called when a queued receipt finally gets its fiscal number. */
  onFiscalized?: (final: FiscalResult, provisional: FiscalResult) => void;
  /** Identity of the register printed on autonomous receipts. */
  cashbox: { serial: string; registration: string; ofdName: string };
}

export class OfflineFiscalQueue implements FiscalProvider {
  readonly name: string;
  readonly #inner: FiscalProvider;
  readonly #clock: Clock;
  readonly #maxOfflineMs: number;
  readonly #onFiscalized: OfflineQueueOptions['onFiscalized'];
  readonly #cashbox: OfflineQueueOptions['cashbox'];
  readonly #pending = new Map<string, QueuedReceipt>();
  readonly #done = new Map<string, FiscalResult>();
  #offlineSince: number | null = null;
  #autonomousSeq = 0;
  #retrying: Promise<number> | null = null;

  constructor(inner: FiscalProvider, options: OfflineQueueOptions) {
    this.#inner = inner;
    this.name = `queued(${inner.name})`;
    this.#clock = options.clock;
    this.#maxOfflineMs = options.maxOfflineMs ?? MAX_OFFLINE_MS;
    this.#onFiscalized = options.onFiscalized;
    this.#cashbox = options.cashbox;
  }

  /** Receipts waiting for the ОФД, oldest first. */
  pending(): QueuedReceipt[] {
    return [...this.#pending.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /** Since when the register has been in autonomous mode, or null when online. */
  offlineSince(): number | null {
    return this.#offlineSince;
  }

  async register(receipt: FiscalReceipt, signal?: AbortSignal): Promise<FiscalResult> {
    const known = this.#done.get(receipt.id) ?? this.#pending.get(receipt.id)?.provisional;
    if (known) return known;

    this.#assertNotBlocked();
    try {
      const result = await this.#inner.register(receipt, signal);
      this.#done.set(receipt.id, result);
      this.#offlineSince = null;
      return result;
    } catch (err) {
      if (!(err instanceof FiscalError) || err.code !== 'OFD_UNAVAILABLE') throw err;
      const now = this.#clock.now();
      this.#offlineSince ??= now;
      const provisional = this.#autonomousResult(receipt, now);
      this.#pending.set(receipt.id, { receipt, provisional, attempts: 1, queuedAt: now, lastError: err.message });
      return provisional;
    }
  }

  /**
   * Re-sends queued receipts in order. Stops at the first receipt that still
   * cannot be delivered (the ОФД is still down), so order is preserved.
   * Returns how many receipts were fiscalized in this pass.
   */
  retry(): Promise<number> {
    this.#retrying ??= this.#retryOnce().finally(() => {
      this.#retrying = null;
    });
    return this.#retrying;
  }

  async #retryOnce(): Promise<number> {
    let sent = 0;
    for (const entry of this.pending()) {
      entry.attempts += 1;
      try {
        const final = await this.#inner.register(entry.receipt);
        this.#pending.delete(entry.receipt.id);
        this.#done.set(entry.receipt.id, final);
        entry.lastError = null;
        sent += 1;
        this.#onFiscalized?.(final, entry.provisional);
      } catch (err) {
        entry.lastError = err instanceof Error ? err.message : String(err);
        if (err instanceof FiscalError && err.code === 'OFD_UNAVAILABLE') break;
        // Any other error: leave it queued and move on — staff must look at it.
      }
    }
    if (this.#pending.size === 0) this.#offlineSince = null;
    return sent;
  }

  #assertNotBlocked(): void {
    if (this.#offlineSince === null) return;
    const offlineFor = this.#clock.now() - this.#offlineSince;
    if (offlineFor >= this.#maxOfflineMs) {
      throw new FiscalError(
        'OFFLINE_LIMIT_EXCEEDED',
        `Касса в автономном режиме дольше ${Math.round(this.#maxOfflineMs / 3_600_000)} ч; восстановите связь с ОФД и отправьте очередь`,
      );
    }
  }

  #autonomousResult(receipt: FiscalReceipt, now: number): FiscalResult {
    this.#autonomousSeq += 1;
    const code = `AUTO-${this.#cashbox.serial}-${String(this.#autonomousSeq).padStart(6, '0')}`;
    return {
      receiptId: receipt.id,
      fiscalNumber: code,
      receiptNumber: code,
      ofdUrl: '',
      qrPayload: '',
      cashboxSerial: this.#cashbox.serial,
      cashboxRegistration: this.#cashbox.registration,
      ofdName: this.#cashbox.ofdName,
      shiftNumber: null,
      offline: true,
      registeredAt: now,
    };
  }
}
