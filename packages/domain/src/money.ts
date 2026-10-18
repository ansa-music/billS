/**
 * Money is always an integer number of minor units (tiyn, kopecks, cents).
 * Only formatting converts to major units.
 */
export type Minor = number;

const formatters = new Map<string, Intl.NumberFormat>();

function digitsFor(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function formatMoney(amount: Minor, currency: string, locale = 'ru-RU'): string {
  const digits = digitsFor(currency);
  const major = amount / 10 ** digits;
  const whole = Number.isInteger(major);
  const key = `${locale}|${currency}|${whole}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: digits,
    });
    formatters.set(key, f);
  }
  return f.format(major);
}

/** Rounds a non-negative amount to the nearest multiple of `step` (half up). */
export function roundToStep(amount: number, step: number): Minor {
  if (step <= 1) return Math.round(amount);
  return Math.round(amount / step) * step;
}
