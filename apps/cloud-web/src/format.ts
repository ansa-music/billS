import type { SessionStatus, TableKind, Weekday } from '@bills/domain';
import { formatMoney } from '@bills/domain';

export const KIND_LABEL: Record<TableKind, string> = {
  pool: 'Пул',
  russian: 'Русский',
  snooker: 'Снукер',
};

export const STATUS_LABEL: Record<SessionStatus, string> = {
  OPENING: 'Включается',
  ACTIVE: 'Идёт',
  PAUSED: 'На паузе',
  AWAITING_PAYMENT: 'Ждёт оплаты',
  CLOSED: 'Оплачено',
  CANCELLED: 'Отменено',
  FAILED: 'Не началась',
};

export const WEEKDAYS: Array<{ day: Weekday; label: string }> = [
  { day: 1, label: 'пн' },
  { day: 2, label: 'вт' },
  { day: 3, label: 'ср' },
  { day: 4, label: 'чт' },
  { day: 5, label: 'пт' },
  { day: 6, label: 'сб' },
  { day: 7, label: 'вс' },
];

export function money(amount: number, currency: string): string {
  return formatMoney(amount, currency);
}

/** Signed amount: "+1 500 ₸" / "−1 500 ₸" / "0 ₸" — for cash differences and other deltas. */
export function formatSigned(amount: number, currency: string): string {
  if (amount > 0) return `+${formatMoney(amount, currency)}`;
  if (amount < 0) return `−${formatMoney(-amount, currency)}`;
  return formatMoney(0, currency);
}

/** "излишек +1 500 ₸" / "недостача −300 ₸" / "сходится" — the Z report difference in words. */
export function differenceLabel(difference: number, currency: string): string {
  if (difference > 0) return `излишек ${formatSigned(difference, currency)}`;
  if (difference < 0) return `недостача ${formatSigned(difference, currency)}`;
  return 'сходится';
}

/** "пауза 12 мин" / "пауза 1 ч 05 мин". */
export function pauseLabel(seconds: number): string {
  return `пауза ${formatMinutes(seconds)}`;
}

/** 1:05 — hours:minutes of a duration in seconds. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** 1 ч 05 мин / 12 мин */
export function formatMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${m} мин`;
}

/** 12,5 ч — for hour-load charts. */
export function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  return `${hours.toLocaleString('ru-RU', { maximumFractionDigits: hours >= 10 ? 0 : 1 })} ч`;
}

/** "нет связи 5 мин" / "нет связи 3 ч" / "нет связи 2 дн". */
export function formatAgo(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions, key: string): Intl.DateTimeFormat {
  const k = `${timeZone}|${key}`;
  let f = formatters.get(k);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('ru-RU', { timeZone, ...options });
    } catch {
      // An unknown club time zone must not break the page: fall back to the browser's.
      f = new Intl.DateTimeFormat('ru-RU', options);
    }
    formatters.set(k, f);
  }
  return f;
}

/** 18:05 in the club's time zone. */
export function formatClock(epochMs: number, timeZone: string): string {
  return formatter(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, 'clock').format(epochMs);
}

/** 12.03, 18:05 */
export function formatDateTime(epochMs: number, timeZone: string): string {
  return formatter(
    timeZone,
    { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
    'datetime',
  ).format(epochMs);
}

/** 12 марта 2026 */
export function formatDate(epochMs: number, timeZone: string): string {
  return formatter(timeZone, { day: 'numeric', month: 'long', year: 'numeric' }, 'date').format(epochMs);
}

/** YYYY-MM-DD of an instant in the club's time zone (for the sessions-by-day request). */
export function localDay(epochMs: number, timeZone: string): string {
  const parts = formatter(timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' }, 'iso').formatToParts(
    epochMs,
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** "2026-03-12" → "12 мар"; a bare day number when `short`. */
export function formatDayLabel(day: string, short = false): string {
  const [, m, d] = day.split('-');
  const dayNum = Number(d);
  if (short || !m) return String(dayNum);
  return `${dayNum} ${MONTHS_SHORT[Number(m) - 1] ?? m}`;
}

const digitsCache = new Map<string, number>();

/** Minor-unit digits of a currency (2 for KZT: 1 ₸ = 100 тиын). */
export function currencyDigits(currency: string): number {
  let d = digitsCache.get(currency);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    digitsCache.set(currency, d);
  }
  return d;
}

/** Minor units → major as an input string ("1500" for 150000 tiyn). */
export function toMajor(minor: number, currency: string): string {
  const major = minor / 10 ** currencyDigits(currency);
  return Number.isInteger(major) ? String(major) : major.toFixed(currencyDigits(currency));
}

/** Major input string → minor units; NaN when the text is not a number. */
export function toMinor(major: string, currency: string): number {
  const n = Number(major.replace(',', '.').trim());
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 10 ** currencyDigits(currency));
}

/** Symbol of the currency alone, for input suffixes ("₸"). */
export function currencySymbol(currency: string): string {
  return formatMoney(0, currency).replace(/[\d\s,. ]/g, '').trim() || currency;
}
