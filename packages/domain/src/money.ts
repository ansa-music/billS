/**
 * Money is always an integer number of minor units (tiyn, kopecks, cents).
 * Only formatting converts to major units.
 */
export type Minor = number;

const formatters = new Map<string, Intl.NumberFormat>();

function digitsFor(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** Minor units in one major unit: 100 for KZT (tiyn), 1 for JPY. */
export function minorPerMajor(currency: string): Minor {
  return 10 ** digitsFor(currency);
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

/**
 * Parses what staff type into a money field ("2 070", "2070,5", "2070.50")
 * into minor units. Returns null for anything that is not a non-negative amount
 * with at most the currency's number of decimals.
 */
export function parseMoney(text: string, currency: string): Minor | null {
  const digits = digitsFor(currency);
  const clean = text.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  const m = /^(\d+)(?:\.(\d*))?$/.exec(clean);
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > digits) return null;
  const minor = Number(m[1]) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}
