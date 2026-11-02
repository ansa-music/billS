/**
 * «Пробные версии» of the platform cabinet: pure helpers (no browser globals, so `node --test`
 * runs them as is) — the trial's term, last activity and the backup file in words and shapes.
 */
import type { TrialCloudMoveState, TrialPaidRequest, TrialsListResponse, TrialStats, TrialStatus, TrialView } from '@bills/domain';
import {
  TRIAL_CLOUD_MOVE,
  TRIAL_PAID_NOTE_MAX,
  canMarkPaid,
  formatCafeCode,
  paidDaysLeft,
  paidEndsSoon,
  parsePaidAmount,
  shiftDay,
  trialPaidRange,
  trialPaidUntil,
  TRIAL_DEFAULT_TIMEZONE,
  TRIAL_EXTEND_MAX_DAYS,
  TRIAL_MESSAGE_MAX,
  formatMoney,
  trialCalendarDay,
  trialDayEnd,
  trialEndDate,
  trialEndDateRange,
} from '@bills/domain';

export type { TrialStats, TrialStatus, TrialView } from '@bills/domain';

/** GET /platform/trials: the trials and whether the cloud cash desk is connected. */
export type TrialsList = TrialsListResponse<TrialView>;

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

const yearFormats = new Map<string, Intl.DateTimeFormat>();

/** «12 ноября 2027» in the trial's zone: a paid term may run years ahead. */
export function trialDateYear(ms: number, timeZone: string = TRIAL_ZONE): string {
  return formatIn(yearFormats, timeZone, { day: 'numeric', month: 'long', year: 'numeric' }).format(ms).replace(/\s*г\.?$/, '');
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

/** The status as the screen should treat it: an «active» trial or a paid term past its end is already over. */
export function effectiveStatus(t: Pick<TrialView, 'status' | 'endsAt'>, now: number): TrialStatus {
  return (t.status === 'active' || t.status === 'paid') && t.endsAt <= now ? 'expired' : t.status;
}

/** A request still waiting for «Подтвердить» / «Отклонить». */
export function isRequest(t: Pick<TrialView, 'status'>): boolean {
  return t.status === 'pending';
}

/** How many requests wait: the number on the «Пробные версии» tab. */
export function pendingCount(trials: ReadonlyArray<Pick<TrialView, 'status'>> | null | undefined): number {
  return (trials ?? []).filter(isRequest).length;
}

/** «Новая заявка на пробную версию ждёт ответа» / «3 заявки на пробную версию ждут ответа» (the clients tab). */
export function waitingText(n: number): string {
  if (n === 1) return 'Новая заявка на пробную версию ждёт ответа';
  return `${n} ${plural(n, 'заявка', 'заявки', 'заявок')} на пробную версию ${plural(n, 'ждёт', 'ждут', 'ждут')} ответа`;
}

/** Requests first (newest request first), then the trials by start, newest first — as the cloud sends them. */
export function sortTrials<T extends Pick<TrialView, 'id' | 'status' | 'startedAt' | 'requestedAt'>>(trials: readonly T[]): T[] {
  const key = (t: T) => (isRequest(t) ? (t.requestedAt ?? t.startedAt) : t.startedAt);
  return [...trials].sort((a, b) => Number(isRequest(b)) - Number(isRequest(a)) || key(b) - key(a) || a.id.localeCompare(b.id));
}

/**
 * «Удалить» is offered for what does not run: a request, a rejected, ended or expired trial — never a café in the cloud
 * (the row is the only link to it) or one that bought TS (the row keeps its payments).
 */
export function canDeleteTrial(t: Pick<TrialView, 'status' | 'endsAt'> & Partial<Pick<TrialView, 'cloud' | 'paid'>>, now: number): boolean {
  if (t.cloud || t.paid) return false;
  const s = effectiveStatus(t, now);
  return s === 'pending' || s === 'rejected' || s === 'ended' || s === 'expired';
}

/** «Продлить» / «Дата окончания» are for a trial TS approved (not for a request, not for a paid café: «Продлить оплату»). */
export function canChangeTerm(t: Pick<TrialView, 'status'>): boolean {
  return t.status !== 'pending' && t.status !== 'rejected' && t.status !== 'paid';
}

/** «похоже на повтор: «Coffee book» (Аиша, с 1 ноября)» — the earlier trial a request repeats. */
export function duplicateText(dup: TrialView['duplicateOf'], timeZone: string = TRIAL_ZONE): string | null {
  if (!dup) return null;
  const since = dup.status === 'pending' ? `заявка от ${trialDate(dup.startedAt, timeZone)}` : `с ${trialDate(dup.startedAt, timeZone)}`;
  return `похоже на повтор: «${dup.venue}» (${dup.managerName ? `${dup.managerName}, ` : ''}${since})`;
}

/** The rejection message as typed: trimmed; null when empty; undefined when longer than the cloud takes. */
export function parseRejectMessage(text: string): string | null | undefined {
  const s = text.trim();
  if (s.length > TRIAL_MESSAGE_MAX) return undefined;
  return s || null;
}

export const REJECT_MESSAGE_MAX = TRIAL_MESSAGE_MAX;

/** Whole days left, rounded up; 0 when the trial is not running. */
export function trialDaysLeft(t: Pick<TrialView, 'status' | 'endsAt'>, now: number): number {
  if (effectiveStatus(t, now) !== 'active') return 0;
  return Math.max(1, Math.ceil((t.endsAt - now) / DAY_MS));
}

export const TRIAL_STATUS_LABEL: Record<TrialStatus, string> = {
  pending: 'Заявка',
  active: 'Идёт',
  ended: 'Завершена',
  expired: 'Истекла',
  rejected: 'Отклонена',
  permanent: 'Постоянная',
  paid: 'Купили',
};

/** Colour of the chip, the same tones as the license chip: ok / warn (2 days or less, a request) / danger. */
export function trialTone(t: Pick<TrialView, 'status' | 'endsAt'>, now: number): 'ok' | 'warn' | 'danger' {
  const status = effectiveStatus(t, now);
  if (status === 'permanent') return 'ok';
  if (status === 'paid') return paidEndsSoon({ status, endsAt: t.endsAt }, now) ? 'warn' : 'ok';
  if (status === 'pending') return 'warn';
  if (status !== 'active') return 'danger';
  return trialDaysLeft(t, now) <= 2 ? 'warn' : 'ok';
}

/**
 * «осталось 5 дней · до 12 ноября» / «последний день · до 12 ноября» / «завершена досрочно» / «истекла 12 ноября» /
 * «ждёт подтверждения с 12 ноября, 14:30» / «отклонена 12 ноября» / «без срока».
 */
export function trialTermText(
  t: Pick<TrialView, 'status' | 'endsAt'> & Partial<Pick<TrialView, 'timezone' | 'requestedAt' | 'decidedAt' | 'startedAt' | 'paid'>>,
  now: number,
): string {
  const status = effectiveStatus(t, now);
  if (status === 'paid') {
    const left = paidDaysLeft(t.endsAt, now);
    return `оплачено до ${trialDateYear(t.endsAt, t.timezone)} · ${plural(left, 'остался', 'осталось', 'осталось')} ${daysText(left)}`;
  }
  if (status === 'expired' && t.paid) return `оплата закончилась ${trialDateYear(t.endsAt, t.timezone)}`;
  if (status === 'pending') {
    const at = t.requestedAt ?? t.startedAt;
    return at ? `ждёт подтверждения с ${trialDate(at, t.timezone)}, ${formatIn(clockFormats, t.timezone ?? TRIAL_ZONE, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)}` : 'ждёт подтверждения';
  }
  if (status === 'rejected') return t.decidedAt ? `отклонена ${trialDate(t.decidedAt, t.timezone)}` : 'отклонена';
  if (status === 'permanent') return 'без срока';
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

/** A request's page asks every half a minute while open: «страница заявки открыта» / «страница закрыта · была 2 ч назад». */
export function requestSeenText(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt === null) return 'страница заявки не выходила на связь';
  if (isWorkingNow(lastSeenAt, now)) return 'страница заявки открыта';
  return `страница закрыта · была ${agoText(now - lastSeenAt)} назад`;
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

// ---------------------------------------------------------------------------
// «Облачная касса» (packages/domain/src/cloud-cafe.ts)

/** «Перевести в облако» is offered for a trial TS approved that is not in the cloud yet. */
export function canMoveToCloud(t: Pick<TrialView, 'status' | 'cloud'>): boolean {
  return !t.cloud && t.status !== 'pending' && t.status !== 'rejected';
}

/** What the coffee shop is sent: the link, the café code and what to do (WhatsApp or copied). */
export function cloudShareText(venue: string, url: string | null, code: string): string {
  const where = url ? `${url}\n` : '';
  return `Касса «${venue}» теперь в облаке TS — работает на любом телефоне и компьютере.\n${where}Код кофейни: ${formatCafeCode(code)}\nОткройте ссылку и войдите своим кодом — тем же, что раньше.`;
}

/** A WhatsApp link that opens a chat with the text ready (the person picks the contact). */
export function whatsAppLink(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** «сегодня в 14:32» / «2 ноября в 14:32» — when the last copy came, in the trial's zone. */
export function copyTimeText(ms: number, now: number, timeZone: string = TRIAL_ZONE): string {
  const time = formatIn(clockFormats, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  return trialCalendarDay(ms, timeZone) === trialCalendarDay(now, timeZone) ? `сегодня в ${time}` : `${trialDate(ms, timeZone)} в ${time}`;
}

/** The steps of «Перевести в облако» in the cabinet, as a pure state machine (the same shape as the move between computers). */
export type CloudMoveStep =
  | { step: 'idle' }
  /** «Перевести «…» в облако?» */
  | { step: 'confirm' }
  /** The cash desk is being asked for a fresh copy. */
  | { step: 'asking' }
  /** The cash desk is on line: waiting for its fresh copy until `until`. */
  | { step: 'waiting'; requestedAt: number; snapshotAt: number | null; until: number }
  /** Only an older copy: the person decides (offline — not on line; timeout — it did not answer). */
  | { step: 'older'; snapshotAt: number; reason: 'offline' | 'timeout' }
  /** The cash desk never sent a copy: nothing to move. */
  | { step: 'empty' }
  /** Importing into the cloud cash desk. */
  | { step: 'moving'; acceptOlder: boolean }
  | { step: 'done' }
  | { step: 'error'; message: string };

export type CloudMoveEvent =
  | { type: 'open' }
  | { type: 'cancel' }
  | { type: 'confirm' }
  | { type: 'started'; state: TrialCloudMoveState; now: number }
  | { type: 'polled'; state: TrialCloudMoveState; now: number }
  | { type: 'tick'; now: number }
  | { type: 'stopWaiting' }
  | { type: 'confirmOlder' }
  | { type: 'moved' }
  | { type: 'failed'; message: string };

export const CLOUD_MOVE_IDLE: CloudMoveStep = { step: 'idle' };

function cloudTimedOut(s: Extract<CloudMoveStep, { step: 'waiting' }>): CloudMoveStep {
  return s.snapshotAt === null ? { step: 'empty' } : { step: 'older', snapshotAt: s.snapshotAt, reason: 'timeout' };
}

/** The next step of «Перевести в облако». Events that do not fit the step change nothing. */
export function cloudMoveReducer(s: CloudMoveStep, e: CloudMoveEvent): CloudMoveStep {
  switch (e.type) {
    case 'open':
      return s.step === 'idle' || s.step === 'error' ? { step: 'confirm' } : s;
    case 'cancel':
      return s.step === 'moving' || s.step === 'asking' ? s : CLOUD_MOVE_IDLE;
    case 'confirm':
      return s.step === 'confirm' ? { step: 'asking' } : s;
    case 'started': {
      if (s.step !== 'asking') return s;
      const st = e.state;
      if (st.cloud) return { step: 'done' };
      if (st.requestedAt !== null) {
        if (st.fresh) return { step: 'moving', acceptOlder: false };
        return { step: 'waiting', requestedAt: st.requestedAt, snapshotAt: st.snapshotAt, until: e.now + TRIAL_CLOUD_MOVE.waitFreshMs };
      }
      if (st.snapshotAt === null) return { step: 'empty' };
      return { step: 'older', snapshotAt: st.snapshotAt, reason: 'offline' };
    }
    case 'polled': {
      if (s.step !== 'waiting') return s;
      const st = e.state;
      if (st.cloud) return { step: 'done' };
      if (st.fresh) return { step: 'moving', acceptOlder: false };
      const next = { ...s, snapshotAt: st.snapshotAt };
      return e.now >= s.until ? cloudTimedOut(next) : next;
    }
    case 'tick':
      return s.step === 'waiting' && e.now >= s.until ? cloudTimedOut(s) : s;
    case 'stopWaiting':
      return s.step === 'waiting' ? cloudTimedOut(s) : s;
    case 'confirmOlder':
      return s.step === 'older' ? { step: 'moving', acceptOlder: true } : s;
    case 'moved':
      return s.step === 'moving' ? { step: 'done' } : s;
    case 'failed':
      return s.step === 'idle' || s.step === 'done' ? s : { step: 'error', message: e.message };
  }
}

// ---------------------------------------------------------------------------
// «Купили» (packages/domain/src/trial-paid.ts)

/** A café that bought TS: it is listed in «Клиенты → Купили», not among the trials. */
export function isBought(t: Pick<TrialView, 'paid'>): boolean {
  return t.paid !== null && t.paid !== undefined;
}

/** «Купили» is offered for any approved café; for a paid one the same form is «Продлить оплату». */
export function canBuy(t: Pick<TrialView, 'status'>): boolean {
  return canMarkPaid(t.status);
}

/** The cafés that bought TS: running paid terms first (the soonest end on top), then the ones whose payment ran out, then the rest. */
export function sortBought<T extends Pick<TrialView, 'id' | 'status' | 'endsAt'>>(list: readonly T[], now: number): T[] {
  const rank = (t: T) => {
    const s = effectiveStatus(t, now);
    return s === 'paid' ? 0 : s === 'expired' ? 1 : 2;
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || a.endsAt - b.endsAt || a.id.localeCompare(b.id));
}

/** «Скоро конец оплаты»: the mark in «Купили» (the same window as the owner's reminder). */
export function paidSoon(t: Pick<TrialView, 'status' | 'endsAt'>, now: number): boolean {
  return paidEndsSoon({ status: effectiveStatus(t, now), endsAt: t.endsAt }, now);
}

/** «150 000 ₸» or «—» for a payment without a sum. */
export function paidAmountText(minor: number | null | undefined): string {
  return minor === null || minor === undefined ? '—' : trialMoney(minor);
}

/** What the «Оплачено до» picker starts at: a month after the current paid date (or today), within the range. */
export function paidDefaultUntil(t: Pick<TrialView, 'paid' | 'timezone'>, now: number): string {
  const { min, max } = trialPaidRange(now, t.timezone);
  const base = t.paid && t.paid.until >= min ? t.paid.until : min;
  const next = shiftDay(base, 30);
  return next > max ? max : next;
}

/** The «Купили» form → the request, or why not. */
export function parsePaidForm(
  form: { until: string; amount: string; note: string },
  now: number,
  timeZone: string,
): { ok: true; body: TrialPaidRequest } | { ok: false; error: string } {
  const until = trialPaidUntil(form.until.trim(), now, timeZone);
  if (until === null) {
    const { min, max } = trialPaidRange(now, timeZone);
    return { ok: false, error: `«Оплачено до»: выберите дату с ${endDateText(min)} по ${endDateText(max)} ${max.slice(0, 4)}` };
  }
  const amount = parsePaidAmount(form.amount);
  if (amount === undefined) return { ok: false, error: 'Сумма — число в тенге, например 150000 (или оставьте пустым)' };
  const note = form.note.trim();
  if (note.length > TRIAL_PAID_NOTE_MAX) return { ok: false, error: `Заметка — не длиннее ${TRIAL_PAID_NOTE_MAX} символов` };
  return { ok: true, body: { until, amount, note: note || null } };
}

/** The cafés of the list split into new requests, trials and the ones that bought TS. */
export function splitTrials<T extends Pick<TrialView, 'status' | 'paid'>>(list: readonly T[]): { requests: T[]; trials: T[]; bought: T[] } {
  return {
    requests: list.filter((t) => isRequest(t)),
    trials: list.filter((t) => !isRequest(t) && !isBought(t)),
    bought: list.filter((t) => isBought(t)),
  };
}
