/**
 * «Пробные версии» of the platform cabinet: pure helpers (no browser globals, so `node --test`
 * runs them as is) — the trial's term, last activity and the backup file in words and shapes.
 */
import type { TrialStats, TrialStatus, TrialView } from '@bills/domain';
import { TRIAL_DEFAULT_TIMEZONE, TRIAL_EXTEND_MAX_DAYS, formatMoney, trialCalendarDay, trialDayEnd, trialEndDate, trialEndDateRange } from '@bills/domain';

export type { TrialStats, TrialStatus, TrialView } from '@bills/domain';

/** GET /platform/trials/:id/snapshot: the trial's last SQLite file, base64. */
export interface TrialSnapshot {
  snapshot: string;
  snapshotAt: number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Trials are coffee shops in Kazakhstan: dates and days are Almaty's unless the trial has its own zone. */
export const TRIAL_ZONE = TRIAL_DEFAULT_TIMEZONE;
export const TRIAL_CURRENCY = 'KZT';
/** «Сейчас работает» when the trial reported within this window. */
export const WORKING_WINDOW_MS = 10 * MINUTE_MS;
export const EXTEND_MIN_DAYS = 1;
export const EXTEND_MAX_DAYS = TRIAL_EXTEND_MAX_DAYS;
/** Where a coffee shop starts its trial (the empty state shows it). */
export const DEFAULT_TRIAL_URL = 'https://ts-kofe.pages.dev';

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function daysText(n: number): string {
  return `${n} ${plural(n, 'день', 'дня', 'дней')}`;
}

export function ordersText(n: number): string {
  return `${n} ${plural(n, 'заказ', 'заказа', 'заказов')}`;
}

export function trialMoney(minor: number): string {
  return formatMoney(minor, TRIAL_CURRENCY);
}

const dayMonthFormats = new Map<string, Intl.DateTimeFormat>();
const clockFormats = new Map<string, Intl.DateTimeFormat>();

function formatIn(cache: Map<string, Intl.DateTimeFormat>, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = cache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', { timeZone, ...options });
    cache.set(timeZone, f);
  }
  return f;
}

/** «12 ноября» in the trial's zone (Almaty by default). */
export function trialDate(ms: number, timeZone: string = TRIAL_ZONE): string {
  return formatIn(dayMonthFormats, timeZone, { day: 'numeric', month: 'long' }).format(ms);
}

/** YYYY-MM-DD of an instant in Almaty. */
export function trialDay(ms: number): string {
  return trialCalendarDay(ms, TRIAL_ZONE);
}

/** «12 ноября, до конца дня» when the trial runs through the whole day (a date set in the cabinet), else «12 ноября, 14:30». */
export function trialEndText(t: Pick<TrialView, 'endsAt' | 'timezone'>): string {
  const date = trialDate(t.endsAt, t.timezone);
  if (trialDayEnd(trialCalendarDay(t.endsAt, t.timezone), t.timezone) === t.endsAt) return `${date}, до конца дня`;
  return `${date}, ${formatIn(clockFormats, t.timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t.endsAt)}`;
}

/** The «Дата окончания» picker: today … today + 90 days in the trial's zone (YYYY-MM-DD, for min/max). */
export function endDateRange(now: number, timeZone: string): { min: string; max: string } {
  return trialEndDateRange(now, timeZone);
}

/** What the picker starts at: the trial's current last day when it can be chosen, else today. */
export function endDateDefault(t: Pick<TrialView, 'endsAt' | 'timezone'>, now: number): string {
  return trialEndDate(trialCalendarDay(t.endsAt, t.timezone), now, t.timezone) ?? trialCalendarDay(now, t.timezone);
}

/** The picker's value → the day to send, or null when it is empty or outside the range. */
export function parseEndDate(text: string, now: number, timeZone: string): string | null {
  return trialEndDate(text.trim(), now, timeZone);
}

/** «14 ноября» of a picked YYYY-MM-DD, for messages (the day as written, no zone involved). */
export function endDateText(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return trialDate(Date.UTC(y, m - 1, d, 12), 'UTC');
}

/** The status as the screen should treat it: an «active» trial past its end is already over. */
export function effectiveStatus(t: Pick<TrialView, 'status' | 'endsAt'>, now: number): TrialStatus {
  return t.status === 'active' && t.endsAt <= now ? 'expired' : t.status;
}

/** Whole days left, rounded up; 0 when the trial is not running. */
export function trialDaysLeft(t: Pick<TrialView, 'status' | 'endsAt'>, now: number): number {
  if (effectiveStatus(t, now) !== 'active') return 0;
  return Math.max(1, Math.ceil((t.endsAt - now) / DAY_MS));
}

export const TRIAL_STATUS_LABEL: Record<TrialStatus, string> = {
  active: 'Идёт',
  ended: 'Завершена',
  expired: 'Истекла',
};

/** Colour of the chip, the same tones as the license chip: ok / warn (2 days or less) / danger. */
export function trialTone(t: Pick<TrialView, 'status' | 'endsAt'>, now: number): 'ok' | 'warn' | 'danger' {
  const status = effectiveStatus(t, now);
  if (status !== 'active') return 'danger';
  return trialDaysLeft(t, now) <= 2 ? 'warn' : 'ok';
}

/** «осталось 5 дней · до 12 ноября» / «последний день · до 12 ноября» / «завершена досрочно» / «истекла 12 ноября». */
export function trialTermText(t: Pick<TrialView, 'status' | 'endsAt'> & Partial<Pick<TrialView, 'timezone'>>, now: number): string {
  const status = effectiveStatus(t, now);
  if (status === 'ended') return 'завершена досрочно';
  if (status === 'expired') return `истекла ${trialDate(t.endsAt, t.timezone)}`;
  const left = trialDaysLeft(t, now);
  const until = `до ${trialDate(t.endsAt, t.timezone)}`;
  if (left <= 1) return `последний день · ${until}`;
  return `${plural(left, 'остался', 'осталось', 'осталось')} ${daysText(left)} · ${until}`;
}

/** «12 мин» / «3 ч» / «2 дн» — how long ago. */
export function agoText(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ч`;
  return `${Math.floor(hours / 24)} дн`;
}

export function isWorkingNow(lastSeenAt: number | null, now: number): boolean {
  return lastSeenAt !== null && now - lastSeenAt < WORKING_WINDOW_MS;
}

/** «сейчас работает» / «был(а) 2 ч назад» / «ещё не выходил(а) на связь». */
export function lastSeenText(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt === null) return 'ещё не выходил(а) на связь';
  if (isWorkingNow(lastSeenAt, now)) return 'сейчас работает';
  return `был(а) ${agoText(now - lastSeenAt)} назад`;
}

/** «последний заказ 25 мин назад» / «последний заказ только что» / «заказов ещё не было». */
export function lastOrderText(lastOrderAt: number | null, now: number): string {
  if (lastOrderAt === null) return 'заказов ещё не было';
  if (now - lastOrderAt < 2 * MINUTE_MS) return 'последний заказ только что';
  return `последний заказ ${agoText(now - lastOrderAt)} назад`;
}

/** «1,4 МБ» / «820 КБ». */
export function bytesText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
}

/** Custom «Продлить на …» input → whole days 1..90, or null. */
export function parseExtendDays(text: string): number | null {
  const s = text.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= EXTEND_MIN_DAYS && n <= EXTEND_MAX_DAYS ? n : null;
}

/** The last `count` Almaty days ending today, oldest first; days the cash register did not report are zeros. */
export function lastDays(days: TrialStats['days'] | undefined, count: number, now: number): TrialStats['days'] {
  const byDay = new Map((days ?? []).map((d) => [d.day, d]));
  const out: TrialStats['days'] = [];
  for (let i = count - 1; i >= 0; i--) {
    const day = trialDay(now - i * DAY_MS);
    const d = byDay.get(day);
    out.push({ day, orders: d?.orders ?? 0, revenue: d?.revenue ?? 0 });
  }
  return out;
}

// Latin only: Chromium drops a download name with Cyrillic letters (same table as the trial page).
const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};

/** «Кофе Тау» → «kofe-tau». */
export function latinName(name: string): string {
  const latin = [...name.toLowerCase()].map((c) => LATIN[c] ?? c).join('');
  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kofeynya';
}

/** What «Восстановить из копии» on the trial page reads (apps/web demo-hub/trial-store.ts). */
export interface TrialBackupFile {
  format: 'ts-trial-backup';
  version: 1;
  startedAt: number;
  venue: string;
  managerName: string;
  managerKey: string;
  savedAt: number;
  db: string;
  /** The term as the cabinet has it, so a restored copy opens with the same end date. */
  endsAt: number;
  status: TrialView['status'];
}

export function trialBackup(t: Pick<TrialView, 'startedAt' | 'venue' | 'managerName' | 'endsAt' | 'status'>, snap: TrialSnapshot): TrialBackupFile {
  return {
    format: 'ts-trial-backup',
    version: 1,
    startedAt: t.startedAt,
    venue: t.venue,
    managerName: t.managerName,
    managerKey: '',
    savedAt: snap.snapshotAt,
    db: snap.snapshot,
    endsAt: t.endsAt,
    status: t.status,
  };
}

/** «TS-kofe-tau-2026-10-29.ts-backup.json»: the day the copy was taken, in Almaty. */
export function trialBackupFileName(venue: string, snapshotAt: number): string {
  return `TS-${latinName(venue)}-${trialDay(snapshotAt)}.ts-backup.json`;
}
