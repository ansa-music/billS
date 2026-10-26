import type { CheckView, SessionView } from './api.ts';
import type { PaymentMethod } from './billing.ts';
import { BillingError } from './billing.ts';
import type { Minor } from './money.ts';
import type { TariffConfig } from './tariff.ts';
import { calculateCharge } from './tariff.ts';

/**
 * Prepaid ("for N minutes") games: the HUB stops them itself at the deadline and
 * blinks the lamp a few minutes before, so guests see the time running out.
 * The deadline counts from the lamp-confirmed start, like billing.
 */

/** The lamp blinks this long before the deadline. */
export const PREPAID_WARNING_MS = 5 * 60_000;
export const PREPAID_MIN_MINUTES = 5;
export const PREPAID_MAX_MINUTES = 12 * 60;
/**
 * The HUB honours a price shown to the guest up to this long ago. A game across a
 * rate change costs a little more every few seconds; the guest pays what was quoted.
 */
export const PREPAID_QUOTE_TTL_MS = 60_000;

export function assertPrepaidMinutes(minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < PREPAID_MIN_MINUTES || minutes > PREPAID_MAX_MINUTES) {
    throw new BillingError(
      'INVALID_PREPAID_MINUTES',
      `Предоплата — целое число минут от ${PREPAID_MIN_MINUTES} до ${PREPAID_MAX_MINUTES}`,
    );
  }
}

/** When the game ends: lamp-confirmed start + prepaid time. */
export function prepaidDeadline(startedAt: number, minutes: number): number {
  return startedAt + minutes * 60_000;
}

/** Milliseconds left until the deadline, never negative. */
export function prepaidRemainingMs(now: number, deadline: number): number {
  return Math.max(0, deadline - now);
}

/** Inside the warning window: the lamp should blink. */
export function isPrepaidEnding(now: number, deadline: number): boolean {
  return now >= deadline - PREPAID_WARNING_MS && now < deadline;
}

/**
 * Price of N minutes starting at `at`, by the same rules as a stopped game
 * (time windows, minimum, rounding). Shown before payment and checked by the HUB.
 */
export function prepaidPrice(at: number, minutes: number, tariff: TariffConfig, timeZone: string): Minor {
  assertPrepaidMinutes(minutes);
  return calculateCharge(at, prepaidDeadline(at, minutes), tariff, timeZone).amount;
}

// ── Extending a prepaid game («Продлить на N минут») ────────────────────────

/** Quick choices on the hall and on the guest page. */
export const PREPAID_EXTEND_MINUTES = [30, 60] as const;

/** Extra minutes: a whole number from PREPAID_MIN_MINUTES; the game stays within PREPAID_MAX_MINUTES in all. */
export function assertPrepaidExtension(extraMinutes: number, paidMinutes: number): void {
  if (!Number.isInteger(extraMinutes) || extraMinutes < PREPAID_MIN_MINUTES) {
    throw new BillingError('INVALID_PREPAID_MINUTES', `Продлить можно на целое число минут, от ${PREPAID_MIN_MINUTES}`);
  }
  if (paidMinutes + extraMinutes > PREPAID_MAX_MINUTES) {
    const left = Math.max(0, PREPAID_MAX_MINUTES - paidMinutes);
    throw new BillingError(
      'PREPAID_TOO_LONG',
      left >= PREPAID_MIN_MINUTES
        ? `Игра на время — не больше ${PREPAID_MAX_MINUTES / 60} ч: продлить можно ещё на ${left} мин`
        : `Игра на время — не больше ${PREPAID_MAX_MINUTES / 60} ч: продлевать дальше нельзя`,
    );
  }
}

/**
 * Price of `extraMinutes` added to a game of `paidMinutes` that ends at `deadline`: what the
 * longer game costs minus what the paid time costs, both by the game's tariff (time windows,
 * step, rounding). The extra minutes are priced at the rates in force after the current
 * deadline; the minimum and the free minutes of a new game do not apply again.
 */
export function prepaidExtensionPrice(
  deadline: number,
  paidMinutes: number,
  extraMinutes: number,
  tariff: TariffConfig,
  timeZone: string,
): Minor {
  const from = deadline - paidMinutes * 60_000;
  const longer = calculateCharge(from, deadline + extraMinutes * 60_000, tariff, timeZone).amount;
  const paid = calculateCharge(from, deadline, tariff, timeZone).amount;
  return Math.max(0, longer - paid);
}

/** POST /api/sessions/:sessionId/extend — add paid minutes to a running prepaid game. */
export interface ExtendPrepaidRequest {
  minutes: number;
  /** The price shown to staff (prepaidExtensionPrice); the HUB refuses if it no longer matches. */
  amount?: Minor;
  /**
   * A game paid upfront: what the guest hands over now, as for /pay — must cover the whole
   * extension and needs an open shift. Without it the extension waits on a check «Продление».
   */
  parts?: Array<{ method: PaymentMethod; amount: Minor }>;
}

/** POST /api/guest-requests/:requestId/extend — the guest's «Продлить» with its minutes. */
export type ExtendGuestRequestBody = Omit<ExtendPrepaidRequest, 'minutes'>;

export interface ExtendPrepaidResponse {
  /** False for a game without a time limit: there is nothing to extend, staff just acknowledge. */
  extended: boolean;
  session: SessionView;
  /** Minutes added (0 when not extended). */
  minutes: number;
  /** Price of the added minutes. A game paid after the stop is billed by played time as usual. */
  price: Minor;
  /** Game paid upfront: the check «Продление» with the new line (PAID when paid right away). */
  check: CheckView | null;
  applied: Minor;
  change: Minor;
}
