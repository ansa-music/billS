import type { TableKind } from './api.ts';
import { workingDay } from './cafe.ts';

/**
 * «Онлайн-бронь столов» (billiards; off by default per club). Pure rules shared by the cloud
 * (public Edge Function `booking`, owner routes), the HUB (bookings.ts: tables on the hall,
 * «Гость пришёл», «не пришёл») and both web apps (the guest's page in the cabinet, the hall).
 *
 * A booking holds capacity of a table type (or of «любой» table) for its whole time; a booking
 * the HUB marked «не пришёл» only holds the first `holdMinutes`. Tables are assigned on the HUB
 * when the guest arrives, so the cloud only counts tables per type.
 */

export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'ARRIVED' | 'NO_SHOW';

export const BOOKING_STATUSES: readonly BookingStatus[] = ['PENDING', 'CONFIRMED', 'CANCELLED', 'ARRIVED', 'NO_SHOW'];

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  PENDING: 'Новая',
  CONFIRMED: 'Подтверждена',
  CANCELLED: 'Отменена',
  ARRIVED: 'Гость пришёл',
  NO_SHOW: 'Не пришёл',
};

/** Holds a table: everything except a cancelled booking. */
export function isBookingActive(status: BookingStatus): boolean {
  return status === 'PENDING' || status === 'CONFIRMED';
}

/** What a guest may book: 1, 2 or 3 hours. */
export const BOOKING_DURATIONS = [60, 120, 180] as const;
export type BookingDuration = (typeof BOOKING_DURATIONS)[number];

/** Days a guest can pick: today and the next 14. */
export const BOOKING_DAYS_AHEAD = 14;
/** The earliest slot starts at least this long after now. */
export const BOOKING_MIN_LEAD_MINUTES = 30;
/** The hall shows «Бронь 19:00 · Аня» on the table from this long before. */
export const BOOKING_SHOW_BEFORE_MINUTES = 60;
/** Opening a game on a table booked within this many minutes asks to confirm. */
export const BOOKING_OPEN_WARN_MINUTES = 60;
export const BOOKING_NAME_MAX = 40;
export const BOOKING_SLOT_CHOICES = [15, 30, 60] as const;
export const BOOKING_HOLD_LIMITS = [5, 60] as const;
/** Upcoming bookings one phone may hold in a club at once. */
export const BOOKING_MAX_PER_PHONE = 3;
/** Rate limits of the public `booking` function: tries per IP an hour and per phone an hour. */
export const BOOKING_RATE = { perIpHour: 20, perPhoneHour: 5 } as const;

export interface BookingSettings {
  enabled: boolean;
  /** Opening hours, "HH:MM". A closing time at or before the opening is after midnight. */
  opensAt: string;
  closesAt: string;
  /** Step between start times a guest can pick. */
  slotMinutes: number;
  /** A guest late by this long is «не пришёл» and the table is free again. */
  holdMinutes: number;
  /** The public address: #/book/<slug>; null → #/book/<clubId>. */
  slug: string | null;
}

export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  enabled: false,
  opensAt: '12:00',
  closesAt: '02:00',
  slotMinutes: 60,
  holdMinutes: 15,
  slug: null,
};

/** Tables a club has, per type (active tables only). */
export type BookingCapacity = Partial<Record<TableKind, number>>;

export const BOOKING_KINDS: readonly TableKind[] = ['pool', 'russian', 'snooker'];

export const BOOKING_KIND_LABEL: Record<TableKind, string> = {
  pool: 'Пул',
  russian: 'Русский бильярд',
  snooker: 'Снукер',
};

/** One booking as far as capacity is concerned. */
export interface BookingLoad {
  id?: string;
  kind: TableKind | null;
  startsAt: number;
  minutes: number;
  status: BookingStatus;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const CLOCK = /^([01]\d|2[0-4]):([0-5]\d)$/;

/** "HH:MM" → minutes since midnight (00:00…24:00); null when malformed. */
export function clockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = CLOCK.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes > 1440 ? null : minutes;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;

/** A slug for the public link: 3–40 latin letters, digits and dashes, no dash at the ends. */
export function isBookingSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value) && !value.includes('--');
}

/** Lowercases and drops what a slug cannot have; '' when nothing is left. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** Fills gaps and drops bad values with the defaults (stored rows may be old). */
export function normalizeBookingSettings(raw: unknown, base: BookingSettings = DEFAULT_BOOKING_SETTINGS): BookingSettings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const slot = Number(r.slotMinutes);
  const hold = Number(r.holdMinutes);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : base.enabled,
    opensAt: clockMinutes(r.opensAt) !== null ? String(r.opensAt) : base.opensAt,
    closesAt: clockMinutes(r.closesAt) !== null ? String(r.closesAt) : base.closesAt,
    slotMinutes: (BOOKING_SLOT_CHOICES as readonly number[]).includes(slot) ? slot : base.slotMinutes,
    holdMinutes: Number.isInteger(hold) && hold >= BOOKING_HOLD_LIMITS[0] && hold <= BOOKING_HOLD_LIMITS[1] ? hold : base.holdMinutes,
    slug: r.slug === null ? null : isBookingSlug(r.slug) ? r.slug : base.slug,
  };
}

/** Problems of a settings patch from the owner, in plain words; empty when it can be saved. */
export function bookingSettingsProblems(patch: Partial<BookingSettings>): string[] {
  const out: string[] = [];
  if (patch.opensAt !== undefined && clockMinutes(patch.opensAt) === null) out.push('Время открытия пишется как 12:00');
  if (patch.closesAt !== undefined && clockMinutes(patch.closesAt) === null) out.push('Время закрытия пишется как 02:00');
  if (patch.slotMinutes !== undefined && !(BOOKING_SLOT_CHOICES as readonly number[]).includes(patch.slotMinutes)) {
    out.push('Шаг брони — 15, 30 или 60 минут');
  }
  if (
    patch.holdMinutes !== undefined &&
    !(Number.isInteger(patch.holdMinutes) && patch.holdMinutes >= BOOKING_HOLD_LIMITS[0] && patch.holdMinutes <= BOOKING_HOLD_LIMITS[1])
  ) {
    out.push(`Ждать опоздавших — от ${BOOKING_HOLD_LIMITS[0]} до ${BOOKING_HOLD_LIMITS[1]} минут`);
  }
  if (patch.slug !== undefined && patch.slug !== null && !isBookingSlug(patch.slug)) {
    out.push('Адрес — 3–40 латинских букв, цифр и дефисов, например: kiy-almaty');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calendar in the club's time zone
// ---------------------------------------------------------------------------

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function localParts(at: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  let f = partFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    partFormatters.set(timeZone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(at))) p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute! };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isBookingDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Calendar day ± n (no time zone involved). */
export function shiftDay(day: string, n: number): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`Invalid day "${day}"`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * The instant of local wall time `day` + `minute` minutes in the zone; minutes past 1440
 * roll into the next days (a 01:00 slot of a day that closes at 02:00).
 */
export function localInstant(day: string, minute: number, timeZone: string): number {
  const extraDays = Math.floor(minute / 1440);
  const m = DAY_RE.exec(shiftDay(day, extraDays))!;
  const rest = minute - extraDays * 1440;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Math.floor(rest / 60), rest % 60);
  let guess = wall;
  // Two passes settle the zone offset (and a DST change on that day).
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, timeZone);
    const diff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - wall;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/** "19:00" in the club's zone. */
export function bookingClock(at: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** The days a guest can pick: the current working day (it starts at 06:00) and the next 14. */
export function bookingDays(now: number, timeZone: string): string[] {
  const today = workingDay(now, timeZone);
  return Array.from({ length: BOOKING_DAYS_AHEAD + 1 }, (_, i) => shiftDay(today, i));
}

/**
 * Opening hours of a working day: [opens, closes). A closing time at or before the opening
 * belongs to the next calendar day (12:00–02:00 ends at 02:00 of the day after); equal times
 * mean the club never closes.
 */
export function bookingWindow(day: string, settings: Pick<BookingSettings, 'opensAt' | 'closesAt'>, timeZone: string): { from: number; to: number } {
  const open = clockMinutes(settings.opensAt) ?? clockMinutes(DEFAULT_BOOKING_SETTINGS.opensAt)!;
  let close = clockMinutes(settings.closesAt) ?? clockMinutes(DEFAULT_BOOKING_SETTINGS.closesAt)!;
  if (close <= open) close += 1440;
  return { from: localInstant(day, open, timeZone), to: localInstant(day, close, timeZone) };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/** Active tables per type, from the club's tables. */
export function capacityOf(tables: ReadonlyArray<{ kind: TableKind; isActive?: boolean }>): BookingCapacity {
  const out: BookingCapacity = {};
  for (const t of tables) {
    if (t.isActive === false) continue;
    out[t.kind] = (out[t.kind] ?? 0) + 1;
  }
  return out;
}

/** Table types the club has, in a fixed order. */
export function capacityKinds(capacity: BookingCapacity): TableKind[] {
  return BOOKING_KINDS.filter((k) => (capacity[k] ?? 0) > 0);
}

const capacityTotal = (capacity: BookingCapacity): number => BOOKING_KINDS.reduce((s, k) => s + (capacity[k] ?? 0), 0);

/**
 * When a booking holds a table: its whole time while it is active or the guest came; only the
 * first `holdMinutes` once marked «не пришёл»; never when cancelled.
 */
export function occupiedSpan(b: BookingLoad, holdMinutes: number): { from: number; to: number } | null {
  if (b.status === 'CANCELLED') return null;
  const minutes = b.status === 'NO_SHOW' ? Math.min(holdMinutes, b.minutes) : b.minutes;
  return { from: b.startsAt, to: b.startsAt + minutes * 60_000 };
}

/**
 * Whether one more booking fits next to `existing` without ever needing more tables than
 * the club has. A table type counts its own bookings; «любой» may take a table of any type,
 * so at every moment each type's own bookings fit its tables and all bookings together fit
 * all tables (that is exactly when «любой» can be seated).
 */
export function canFit(
  capacity: BookingCapacity,
  existing: readonly BookingLoad[],
  candidate: { kind: TableKind | null; startsAt: number; minutes: number },
  holdMinutes: number,
): boolean {
  const total = capacityTotal(capacity);
  if (total === 0) return false;
  if (candidate.kind !== null && (capacity[candidate.kind] ?? 0) === 0) return false;
  const from = candidate.startsAt;
  const to = candidate.startsAt + candidate.minutes * 60_000;
  const spans: Array<{ kind: TableKind | null; from: number; to: number }> = [];
  for (const b of existing) {
    const s = occupiedSpan(b, holdMinutes);
    if (s && s.from < to && s.to > from) spans.push({ kind: b.kind, ...s });
  }
  // The load only grows at a start: checking the candidate's start and every start inside it is enough.
  const points = [from, ...spans.map((s) => s.from).filter((p) => p > from && p < to)];
  for (const p of points) {
    const live = spans.filter((s) => s.from <= p && s.to > p);
    if (live.length + 1 > total) return false;
    const kinds = candidate.kind ? [candidate.kind] : BOOKING_KINDS;
    for (const k of kinds) {
      const own = live.filter((s) => s.kind === k).length + (candidate.kind === k ? 1 : 0);
      if (own > (capacity[k] ?? 0)) return false;
    }
  }
  return true;
}

export interface SlotsInput {
  day: string;
  settings: Pick<BookingSettings, 'opensAt' | 'closesAt' | 'slotMinutes' | 'holdMinutes'>;
  timezone: string;
  capacity: BookingCapacity;
  bookings: readonly BookingLoad[];
  minutes: number;
  kind: TableKind | null;
  now: number;
}

export interface BookingSlot {
  startsAt: number;
  /** "19:00" in the club's zone. */
  time: string;
  free: boolean;
}

/**
 * Start times of a working day for a booking of `minutes`: every `slotMinutes` from the
 * opening while the booking still ends by the closing time, not earlier than now +
 * BOOKING_MIN_LEAD_MINUTES; `free` when the tables of that type are not all booked.
 */
export function bookingSlots(input: SlotsInput): BookingSlot[] {
  const { from, to } = bookingWindow(input.day, input.settings, input.timezone);
  const step = Math.max(5, input.settings.slotMinutes) * 60_000;
  const length = input.minutes * 60_000;
  const earliest = input.now + BOOKING_MIN_LEAD_MINUTES * 60_000;
  const out: BookingSlot[] = [];
  for (let t = from; t + length <= to; t += step) {
    if (t < earliest) continue;
    out.push({
      startsAt: t,
      time: bookingClock(t, input.timezone),
      free: canFit(input.capacity, input.bookings, { kind: input.kind, startsAt: t, minutes: input.minutes }, input.settings.holdMinutes),
    });
  }
  return out;
}

/**
 * Whether `startsAt` is a start a guest could have picked on that day (on the grid, inside
 * the opening hours, the booking ends by closing). Checked by the cloud on POST.
 */
export function isBookableStart(
  day: string,
  startsAt: number,
  minutes: number,
  settings: Pick<BookingSettings, 'opensAt' | 'closesAt' | 'slotMinutes'>,
  timezone: string,
): boolean {
  const { from, to } = bookingWindow(day, settings, timezone);
  const step = Math.max(5, settings.slotMinutes) * 60_000;
  return startsAt >= from && startsAt + minutes * 60_000 <= to && (startsAt - from) % step === 0;
}

// ---------------------------------------------------------------------------
// The guest's details
// ---------------------------------------------------------------------------

/** A name for the booking: trimmed, single spaces, 1…BOOKING_NAME_MAX characters; null when empty. */
export function bookingName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return name.slice(0, BOOKING_NAME_MAX).trim();
}

// Phones: normalizePhone / formatPhone / maskPhone of loyalty.ts (+7 numbers), shared with loyalty.

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "2 ч", "1 ч 30 мин", "45 мин". */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} мин`;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

/** "27 октября" of a 'YYYY-MM-DD' day. */
export function dayText(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
}

/** "пн" of a 'YYYY-MM-DD' day. */
export function weekdayShort(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m) return '';
  return WEEKDAYS_SHORT[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()]!;
}

/** "сегодня", "завтра" or "27 октября" for the working day of a booking, seen from `now`. */
export function relativeDayText(at: number, now: number, timeZone: string): string {
  const day = workingDay(at, timeZone);
  const today = workingDay(now, timeZone);
  if (day === today) return 'сегодня';
  if (day === shiftDay(today, 1)) return 'завтра';
  return dayText(day);
}

/**
 * The owner's push and Telegram text: «Новая бронь: Аня, 19:00, 2 ч», with the day when it
 * is not today and the table type when the guest picked one. No phone: it stays in the cabinet.
 */
export function bookingPushBody(
  b: { guestName: string; startsAt: number; minutes: number; kind: TableKind | null },
  timeZone: string,
  now: number,
): string {
  const day = relativeDayText(b.startsAt, now, timeZone);
  const when = day === 'сегодня' ? bookingClock(b.startsAt, timeZone) : `${day} ${bookingClock(b.startsAt, timeZone)}`;
  const kind = b.kind ? `, ${BOOKING_KIND_LABEL[b.kind].toLowerCase()}` : '';
  return `Новая бронь: ${b.guestName}, ${when}, ${durationText(b.minutes)}${kind}`;
}

// ---------------------------------------------------------------------------
// Calendar file (.ics) for «Добавить в календарь»
// ---------------------------------------------------------------------------

const icsTime = (at: number): string => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const icsText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** RFC 5545 folds lines longer than 75 octets; counted in characters here, which is stricter for Cyrillic. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 60) {
    out.push(rest.slice(0, 60));
    rest = ` ${rest.slice(60)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export interface BookingIcsInput {
  id: string;
  clubName: string;
  startsAt: number;
  minutes: number;
  guestName: string;
  kind: TableKind | null;
  createdAt: number;
}

/** A calendar event for the booking (UTC times, CRLF lines), with a reminder an hour before. */
export function bookingIcs(b: BookingIcsInput): string {
  const what = b.kind ? `${BOOKING_KIND_LABEL[b.kind]}, ` : '';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TS//Booking//RU',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.id}@ts-booking`,
    `DTSTAMP:${icsTime(b.createdAt)}`,
    `DTSTART:${icsTime(b.startsAt)}`,
    `DTEND:${icsTime(b.startsAt + b.minutes * 60_000)}`,
    `SUMMARY:${icsText(`Бильярд — ${b.clubName}`)}`,
    `LOCATION:${icsText(b.clubName)}`,
    `DESCRIPTION:${icsText(`Бронь на имя ${b.guestName}: ${what}${durationText(b.minutes)}. Если планы изменились, позвоните в клуб.`)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(`Через час бильярд — ${b.clubName}`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// The hall: which table a booking takes
// ---------------------------------------------------------------------------

export interface HallBooking {
  id: string;
  startsAt: number;
  minutes: number;
  kind: TableKind | null;
  status: BookingStatus;
  /** Set on arrival. */
  tableId: string | null;
}

export interface HallTable {
  id: string;
  kind: TableKind;
  /** A game is on the table now. */
  busy: boolean;
}

/**
 * A table for every active booking that has none yet (the guest has not arrived): the first
 * table of the right type that no overlapping booking already took, a free one first. For the
 * hall only — the table is fixed when the guest arrives.
 */
export function planBookingTables(bookings: readonly HallBooking[], tables: readonly HallTable[], holdMinutes: number): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const taken: Array<{ tableId: string; from: number; to: number }> = [];
  const spanOf = (b: HallBooking) => occupiedSpan({ kind: b.kind, startsAt: b.startsAt, minutes: b.minutes, status: b.status }, holdMinutes);
  for (const b of bookings) {
    const span = spanOf(b);
    if (b.tableId && span) taken.push({ tableId: b.tableId, ...span });
  }
  const open = [...bookings].filter((b) => !b.tableId && isBookingActive(b.status)).sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
  const ordered = [...tables].sort((a, b) => Number(a.busy) - Number(b.busy));
  for (const b of open) {
    const span = spanOf(b)!;
    const table = ordered.find(
      (t) => (b.kind === null || t.kind === b.kind) && !taken.some((x) => x.tableId === t.id && x.from < span.to && x.to > span.from),
    );
    out.set(b.id, table?.id ?? null);
    if (table) taken.push({ tableId: table.id, ...span });
  }
  return out;
}

/**
 * The booking that makes opening a game on `tableId` worth a question: an active booking of
 * this table (assigned or planned) starting within `warnMinutes`, or already due and still
 * within the hold time.
 */
export function bookingConflict<T extends { startsAt: number; status: BookingStatus; tableId: string | null }>(
  bookings: readonly T[],
  tableId: string,
  now: number,
  holdMinutes: number,
  warnMinutes = BOOKING_OPEN_WARN_MINUTES,
): T | null {
  const hits = bookings
    .filter((b) => isBookingActive(b.status) && b.tableId === tableId)
    .filter((b) => b.startsAt - now <= warnMinutes * 60_000 && now < b.startsAt + holdMinutes * 60_000)
    .sort((a, b) => a.startsAt - b.startsAt);
  return hits[0] ?? null;
}

/** Due for «не пришёл»: still active `holdMinutes` after its start. */
export function isNoShowDue(b: { startsAt: number; status: BookingStatus }, now: number, holdMinutes: number): boolean {
  return isBookingActive(b.status) && now >= b.startsAt + holdMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** GET /booking/<club>/availability?date= — the guest's page. */
export interface BookingAvailability {
  club: { name: string; timezone: string; ref: string };
  /** Server time: the page counts «сегодня» from it, not from the phone. */
  now: number;
  days: string[];
  date: string;
  opensAt: string;
  closesAt: string;
  /** Table types the club has (the picker shows when there are several). */
  kinds: TableKind[];
  durations: number[];
  /** Start times per duration ('60') and table type ('any' | kind); `free` false when all tables are booked. */
  slots: Record<string, Record<string, Array<{ startsAt: number; time: string; free: boolean }>>>;
}

export interface CreateBookingRequest {
  date: string;
  startsAt: number;
  minutes: number;
  kind: TableKind | null;
  name: string;
  phone: string;
  /** Honeypot: a real page leaves it empty. */
  website?: string;
}

export interface CreateBookingResponse {
  id: string;
  clubName: string;
  timezone: string;
  startsAt: number;
  minutes: number;
  kind: TableKind | null;
  guestName: string;
  status: BookingStatus;
  createdAt: number;
}

/** A booking in the owner's cabinet. */
export interface OwnerBookingView {
  id: string;
  startsAt: number;
  minutes: number;
  kind: TableKind | null;
  guestName: string;
  phone: string;
  status: BookingStatus;
  tableId: string | null;
  createdAt: number;
}

export interface BookingSettingsView extends BookingSettings {
  /** The guest page: <cabinet>/#/book/<slug or clubId>. */
  publicUrl: string;
  capacity: BookingCapacity;
}

export interface OwnerBookingsResponse {
  settings: BookingSettingsView;
  timezone: string;
  bookings: OwnerBookingView[];
}

export type UpdateBookingSettingsRequest = Partial<BookingSettings>;

/** GET /sync/bookings — what the HUB keeps (bookings from a day ago on). */
export interface SyncBooking {
  id: string;
  startsAt: number;
  minutes: number;
  kind: TableKind | null;
  guestName: string;
  phone: string;
  status: BookingStatus;
  createdAt: number;
}

export interface SyncBookingsResponse {
  version: number;
  enabled: boolean;
  holdMinutes: number;
  bookings: SyncBooking[];
}

/** A booking on the HUB's hall (GET /api/bookings). */
export interface HubBookingView extends HallBooking {
  guestName: string;
  phone: string;
  /** The table the hall shows it on: the assigned one, else the planned one; null when none fits. */
  plannedTableId: string | null;
  arrivedAt: number | null;
}

export interface HubBookingsResponse {
  holdMinutes: number;
  serverNow: number;
  bookings: HubBookingView[];
}

export interface ArriveBookingResponse {
  booking: HubBookingView;
  tableId: string;
}
