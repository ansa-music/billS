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
