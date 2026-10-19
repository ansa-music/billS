import type { TableKind } from '@bills/domain';
import { zonedParts } from '@bills/domain';

/** Clubs work past midnight: a working day runs from 06:00 to 06:00. */
export const DAY_START_HOUR = 6;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the club's working day that contains `at`. */
export function workdayStart(at: number, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  let minutes = p.minuteOfDay - DAY_START_HOUR * 60;
  if (minutes < 0) minutes += 1440;
  return at - minutes * 60_000 - p.second * 1000 - p.millisecond;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** «пн, 12 окт» in the club's time zone. */
export function formatDay(epochMs: number, timeZone: string): string {
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
    dateFormatters.set(timeZone, f);
  }
  return f.format(epochMs).replace('.', '');
}

/** 2 ч 05 мин / 45 мин / 30 с — compact, for lists. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} ч ${String(m % 60).padStart(2, '0')} мин` : `${m} мин`;
}

/** Controller errors come from drivers in English; staff read Russian. */
export function lampErrorText(error: string): string {
  if (/no controller confirmation/i.test(error)) return 'контроллер не ответил вовремя';
  if (/controller error/i.test(error)) return 'контроллер вернул ошибку';
  if (/unknown table/i.test(error)) return 'стол не найден';
  return error;
}

/** «5 мин назад» */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`;
}

export const KIND_LABEL: Record<TableKind, string> = {
  pool: 'Пул',
  russian: 'Русский',
  snooker: 'Снукер',
};

/** 0:05:09 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 04:12, or 1:04:12 once a pause runs over an hour. */
export function formatPause(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ms_ = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${ms_}` : ms_;
}

/** 1 ч 05 мин */
export function formatMinutes(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} ч ${String(m).padStart(2, '0')} мин` : `${m} мин`;
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** 18:05 in the club's time zone. */
export function formatClock(epochMs: number, timeZone: string, withSeconds = false): string {
  const key = `${timeZone}|${withSeconds}`;
  let f = clockFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      ...(withSeconds ? { second: '2-digit' } : {}),
      hourCycle: 'h23',
    });
    clockFormatters.set(key, f);
  }
  return f.format(epochMs);
}

/** Russian plural: plural(3, ['игра', 'игры', 'игр']). */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
