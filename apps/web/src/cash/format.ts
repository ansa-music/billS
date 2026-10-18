import type { Minor, PaymentMethod } from '@bills/domain';
import { formatMoney, minorPerMajor } from '@bills/domain';
import { formatClock } from '../format.ts';

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Наличные',
  CARD: 'Карта',
  QR: 'QR',
};

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** 18.10 in the club's time zone. */
function formatDay(epochMs: number, timeZone: string): string {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit' });
    dayFormatters.set(timeZone, f);
  }
  return f.format(epochMs);
}

/** 18.10 18:05 */
export function formatDateTime(epochMs: number, timeZone: string): string {
  return `${formatDay(epochMs, timeZone)} ${formatClock(epochMs, timeZone)}`;
}

/** 18:05 today, 17.10 23:40 on another day: a shift can run past midnight. */
export function formatWhen(epochMs: number, timeZone: string, nowMs: number): string {
  return formatDay(epochMs, timeZone) === formatDay(nowMs, timeZone)
    ? formatClock(epochMs, timeZone)
    : formatDateTime(epochMs, timeZone);
}

/** "₸" for KZT — for field labels like «Сумма, ₸». */
export function currencySymbol(currency: string): string {
  const parts = new Intl.NumberFormat('ru-RU', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
  return parts.find((p) => p.type === 'currency')?.value ?? currency;
}

/** Minor units as staff would type them into a field: 207050 → "2070,50". */
export function toMoneyInput(amount: Minor, currency: string): string {
  const per = minorPerMajor(currency);
  const whole = Math.trunc(amount / per);
  const rest = amount % per;
  return rest === 0 ? String(whole) : `${whole},${String(rest).padStart(String(per).length - 1, '0')}`;
}

export type DifferenceSign = 'short' | 'over' | 'zero';

/** counted − expected, in words: a shortage is negative. */
export function describeDifference(
  diff: Minor,
  currency: string,
  zeroText = 'Расхождения нет',
): { sign: DifferenceSign; text: string } {
  if (diff < 0) return { sign: 'short', text: `Недостача ${formatMoney(-diff, currency)}` };
  if (diff > 0) return { sign: 'over', text: `Излишек ${formatMoney(diff, currency)}` };
  return { sign: 'zero', text: zeroText };
}
