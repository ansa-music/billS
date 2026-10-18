import type { Minor } from '@bills/domain';

/**
 * Price fields are typed in major units ("12,50"); the HUB stores minor units.
 * Digits per currency come from Intl, like formatMoney in the domain.
 */
export function fractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "12,50" → 1250 (for 2-digit currencies). null when the text is not a non-negative number. */
export function parseMajor(text: string, currency: string): Minor | null {
  const cleaned = text.replace(/\s/g, '').replace(',', '.');
  if (cleaned === '' || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10 ** fractionDigits(currency));
}

/** 1250 → "12.50" — for an input's value (a dot, so type="number" accepts it). */
export function toMajorText(minor: Minor, currency: string): string {
  const digits = fractionDigits(currency);
  const major = minor / 10 ** digits;
  return Number.isInteger(major) ? String(major) : major.toFixed(digits);
}
