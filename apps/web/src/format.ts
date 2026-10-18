import type { TableKind } from '@bills/domain';

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
