/**
 * «Онлайн-бронь столов» in the cloud (Supabase only: migration 20261026000000_bookings.sql).
 * The rules are packages/domain/src/booking.ts; here — storage, the public calls of the Edge
 * Function `booking`, the owner's calls of `owner`, and what the HUB pulls (GET /sync/bookings)
 * and reports back (booking.arrived / booking.no_show events). Runtime-neutral (node:crypto only).
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  BookingAvailability,
  BookingCapacity,
  BookingLoad,
  BookingSettings,
  BookingSettingsView,
  BookingStatus,
  CreateBookingResponse,
  OwnerBookingsResponse,
  OwnerBookingView,
  SyncBooking,
  SyncBookingsResponse,
  SyncEvent,
  TableKind,
} from '@bills/domain';
import {
  BOOKING_DURATIONS,
  BOOKING_KINDS,
  BOOKING_MAX_PER_PHONE,
  BOOKING_MIN_LEAD_MINUTES,
  BOOKING_RATE,
  DEFAULT_BOOKING_SETTINGS,
  bookingDays,
  bookingName,
  bookingPushBody,
  bookingSettingsProblems,
  bookingSlots,
  bookingWindow,
  canFit,
  capacityKinds,
  capacityOf,
  isBookableStart,
  isBookingDay,
  isBookingSlug,
  normalizePhone,
  workingDay,
  localInstant,
  shiftDay,
  WORKDAY_START_HOUR,
} from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';
import { alertTitle, enqueuePush } from './push.ts';
import type { ClubRow } from './settings.ts';
import { businessTypeOf, loadSettings } from './settings.ts';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The longest booking: loads are read this far before a window so a booking crossing into it counts. */
const LONGEST_MS = Math.max(...BOOKING_DURATIONS) * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ClubBookingRow {
  club_id: string;
  enabled: number | boolean;
  opens_at: string;
  closes_at: string;
  slot_minutes: number;
  hold_minutes: number;
  slug: string | null;
  version: number | string;
  updated_at: number;
}

interface BookingRow {
  id: string;
  club_id: string;
  starts_at: number | string;
  minutes: number;
  table_kind: string | null;
  guest_name: string;
  phone: string;
  status: BookingStatus;
  table_id: string | null;
  created_at: number | string;
  updated_at: number | string;
  status_at: number | string | null;
}

const kindOf = (v: string | null): TableKind | null => ((BOOKING_KINDS as readonly string[]).includes(v ?? '') ? (v as TableKind) : null);

function settingsOf(row: ClubBookingRow | null | undefined): BookingSettings {
  if (!row) return { ...DEFAULT_BOOKING_SETTINGS };
  return {
    enabled: Boolean(Number(row.enabled)),
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    slotMinutes: Number(row.slot_minutes),
    holdMinutes: Number(row.hold_minutes),
    slug: row.slug,
  };
}

async function settingsRow(db: SqlDriver, clubId: string, forUpdate = false): Promise<ClubBookingRow | null> {
  const rows = await db.all<ClubBookingRow>(`SELECT * FROM club_booking WHERE club_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [clubId]);
  return rows[0] ?? null;
}

/** Bumps the version the HUB follows; creates the settings row (off) when there is none. */
async function bumpVersion(tx: SqlDriver, clubId: string, now: number): Promise<void> {
  await tx.run(
    `INSERT INTO club_booking (club_id, version, updated_at) VALUES (?, 1, ?)
     ON CONFLICT (club_id) DO UPDATE SET version = club_booking.version + 1, updated_at = excluded.updated_at`,
    [clubId, now],
  );
}

const notFound = (): CloudError => new CloudError(404, 'BOOKING_NOT_FOUND', 'Онлайн-бронь в этом заведении не работает');

/** A club by its public reference: the club id, else the slug. */
export async function findBookingClub(db: SqlDriver, ref: string): Promise<{ club: ClubRow; row: ClubBookingRow | null } | null> {
  const clean = ref.trim().toLowerCase();
  if (!clean || clean.length > 64) return null;
  let club: ClubRow | undefined;
  if (UUID.test(clean)) club = (await db.all<ClubRow>('SELECT * FROM clubs WHERE id = ?', [ref.trim()]))[0];
  if (!club && isBookingSlug(clean)) {
    club = (await db.all<ClubRow>('SELECT c.* FROM clubs c JOIN club_booking b ON b.club_id = c.id WHERE b.slug = ?', [clean]))[0];
  }
  if (!club) return null;
  return { club, row: await settingsRow(db, club.id) };
}

/** Active tables per type, from the club's tables (as the HUB reported them); a coffee shop has none. */
export async function clubCapacity(db: SqlDriver, club: ClubRow): Promise<BookingCapacity> {
  if (businessTypeOf(club) !== 'billiards') return {};
  return capacityOf((await loadSettings(db, club)).tables);
}

/** Bookings that may hold a table somewhere in [from, to). */
async function loadsIn(db: SqlDriver, clubId: string, from: number, to: number): Promise<BookingLoad[]> {
  const rows = await db.all<BookingRow>(
    `SELECT id, table_kind, starts_at, minutes, status FROM bookings
      WHERE club_id = ? AND starts_at >= ? AND starts_at < ? AND status <> 'CANCELLED'
      ORDER BY starts_at, id`,
    [clubId, from - LONGEST_MS, to],
  );
  return rows.map((r) => ({ id: r.id, kind: kindOf(r.table_kind), startsAt: Number(r.starts_at), minutes: Number(r.minutes), status: r.status }));
}

// ---------------------------------------------------------------------------
// Public: the guest's page
// ---------------------------------------------------------------------------

async function openClub(db: SqlDriver, ref: string): Promise<{ club: ClubRow; settings: BookingSettings }> {
  const found = await findBookingClub(db, ref);
  if (!found || businessTypeOf(found.club) !== 'billiards') throw notFound();
  const settings = settingsOf(found.row);
  if (!settings.enabled) throw notFound();
  return { club: found.club, settings };
}

/** GET /booking/<club>/availability?date= — free start times of a day for every duration and table type. */
export async function publicAvailability(db: SqlDriver, now: number, ref: string, date: string | null): Promise<BookingAvailability> {
  const { club, settings } = await openClub(db, ref);
  const days = bookingDays(now, club.timezone);
  const day = date ?? days[0]!;
  if (!isBookingDay(day) || !days.includes(day)) throw new CloudError(422, 'DAY_OUT_OF_RANGE', 'Бронь открыта на сегодня и ещё 14 дней вперёд');
  const capacity = await clubCapacity(db, club);
  const kinds = capacityKinds(capacity);
  const window = bookingWindow(day, settings, club.timezone);
  const loads = await loadsIn(db, club.id, window.from, window.to);
  const slots: BookingAvailability['slots'] = {};
  for (const minutes of BOOKING_DURATIONS) {
    const byKind: Record<string, BookingAvailability['slots'][string][string]> = {};
    for (const kind of [null, ...kinds]) {
      byKind[kind ?? 'any'] = bookingSlots({ day, settings, timezone: club.timezone, capacity, bookings: loads, minutes, kind, now });
    }
    slots[String(minutes)] = byKind;
  }
  return {
    club: { name: club.name, timezone: club.timezone, ref: settings.slug ?? club.id },
    now,
    days,
    date: day,
    opensAt: settings.opensAt,
    closesAt: settings.closesAt,
    holdMinutes: settings.holdMinutes,
    kinds,
    durations: [...BOOKING_DURATIONS],
    slots,
  };
}

const hashKey = (key: string): string => createHash('sha256').update(`ts-booking:${key}`).digest('hex');

/** Counts an attempt under each key; 429 past the hourly limit of any of them. */
async function countAttempt(db: SqlDriver, now: number, keys: Array<{ key: string; perHour: number }>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM booking_attempts WHERE at < ?', [now - DAY_MS]);
    for (const { key, perHour } of keys) {
      const hash = hashKey(key);
      const rows = await tx.all<{ n: number | string }>('SELECT COUNT(*) AS n FROM booking_attempts WHERE key_hash = ? AND at > ?', [hash, now - HOUR_MS]);
      if (Number(rows[0]?.n ?? 0) >= perHour) {
        throw new CloudError(429, 'RATE_LIMITED', 'Слишком много попыток брони. Попробуйте через час или позвоните в клуб');
      }
    }
    for (const { key } of keys) await tx.run('INSERT INTO booking_attempts (id, key_hash, at) VALUES (?, ?, ?)', [randomUUID(), hashKey(key), now]);
  });
}

const invalid = (code: string, message: string): CloudError => new CloudError(422, code, message);

interface BookingInput {
  date: string;
  startsAt: number;
  minutes: number;
  kind: TableKind | null;
  name: string;
  phone: string;
}

export function readBookingRequest(raw: unknown): BookingInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Заполните форму брони');
  const r = raw as Record<string, unknown>;
  if (typeof r.website === 'string' && r.website.trim() !== '') throw new CloudError(400, 'BAD_REQUEST', 'Заполните форму брони');
  if (!isBookingDay(r.date)) throw invalid('DAY_OUT_OF_RANGE', 'Выберите день');
  const startsAt = Number(r.startsAt);
  if (!Number.isSafeInteger(startsAt)) throw invalid('SLOT_INVALID', 'Выберите время');
  const minutes = Number(r.minutes);
  if (!(BOOKING_DURATIONS as readonly number[]).includes(minutes)) throw invalid('DURATION_INVALID', 'Выберите, на сколько часов');
  const kind = r.kind === null || r.kind === undefined || r.kind === 'any' ? null : kindOf(String(r.kind));
  if (r.kind !== null && r.kind !== undefined && r.kind !== 'any' && !kind) throw invalid('KIND_INVALID', 'Выберите стол');
  const name = bookingName(r.name);
  if (!name) throw invalid('NAME_REQUIRED', 'Напишите имя — на него будет бронь');
  const phone = normalizePhone(typeof r.phone === 'string' && r.phone.length <= 30 ? r.phone : null);
  if (!phone) throw invalid('PHONE_INVALID', 'Проверьте телефон: например, +7 707 123-45-67');
  return { date: r.date, startsAt, minutes, kind, name, phone };
}

/**
 * POST /booking/<club>: one transaction with the club's settings row locked (FOR UPDATE), so two
 * guests racing for the last table cannot both get it. Queues the owner's push in the same transaction.
 */
export async function createPublicBooking(db: SqlDriver, now: number, ref: string, raw: unknown, ip: string): Promise<CreateBookingResponse> {
  const input = readBookingRequest(raw);
  const opened = await openClub(db, ref);
  await countAttempt(db, now, [
    { key: `ip:${ip}`, perHour: BOOKING_RATE.perIpHour },
    { key: `phone:${opened.club.id}:${input.phone}`, perHour: BOOKING_RATE.perPhoneHour },
  ]);
  return db.transaction(async (tx) => {
    const club = opened.club;
    const settings = settingsOf(await settingsRow(tx, club.id, true));
    if (!settings.enabled) throw notFound();
    if (!bookingDays(now, club.timezone).includes(input.date)) throw invalid('DAY_OUT_OF_RANGE', 'Бронь открыта на сегодня и ещё 14 дней вперёд');
    if (!isBookableStart(input.date, input.startsAt, input.minutes, settings, club.timezone)) {
      throw invalid('SLOT_INVALID', 'Это время не подходит — выберите время из списка');
    }
    if (input.startsAt < now + BOOKING_MIN_LEAD_MINUTES * 60_000) {
      throw invalid('SLOT_TOO_SOON', `Бронь — не позже чем за ${BOOKING_MIN_LEAD_MINUTES} минут. Позвоните в клуб`);
    }
    const capacity = await clubCapacity(tx, club);
    if (input.kind && !(capacity[input.kind] ?? 0)) throw invalid('KIND_INVALID', 'Таких столов в клубе нет');
    const mine = await tx.all<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM bookings WHERE club_id = ? AND phone = ? AND starts_at > ? AND status IN ('PENDING', 'CONFIRMED')`,
      [club.id, input.phone, now],
    );
    if (Number(mine[0]?.n ?? 0) >= BOOKING_MAX_PER_PHONE) {
      throw new CloudError(409, 'TOO_MANY_BOOKINGS', `На этот телефон уже ${BOOKING_MAX_PER_PHONE} брони. Позвоните в клуб, если нужно больше`);
    }
    const end = input.startsAt + input.minutes * 60_000;
    const loads = await loadsIn(tx, club.id, input.startsAt, end);
    if (!canFit(capacity, loads, input, settings.holdMinutes)) {
      throw new CloudError(409, 'SLOT_TAKEN', 'Это время только что заняли — выберите другое');
    }
    const id = randomUUID();
    await tx.run(
      `INSERT INTO bookings (id, club_id, starts_at, minutes, table_kind, guest_name, phone, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      [id, club.id, input.startsAt, input.minutes, input.kind, input.name, input.phone, now, now],
    );
    await bumpVersion(tx, club.id, now);
    await enqueuePush(tx, now, {
      dedupeKey: `booking:${id}`,
      clubId: club.id,
      kind: 'BOOKING_NEW',
      title: alertTitle(club.name, 'BOOKING_NEW'),
      body: bookingPushBody({ guestName: input.name, startsAt: input.startsAt, minutes: input.minutes, kind: input.kind }, club.timezone, now),
      at: now,
    });
    return {
      id,
      clubName: club.name,
      timezone: club.timezone,
      startsAt: input.startsAt,
      minutes: input.minutes,
      kind: input.kind,
      guestName: input.name,
      status: 'PENDING',
      createdAt: now,
    };
  });
}

// ---------------------------------------------------------------------------
// The owner's cabinet
// ---------------------------------------------------------------------------

const toOwnerView = (r: BookingRow): OwnerBookingView => ({
  id: r.id,
  startsAt: Number(r.starts_at),
  minutes: Number(r.minutes),
  kind: kindOf(r.table_kind),
  guestName: r.guest_name,
  phone: r.phone,
  status: r.status,
  tableId: r.table_id,
  createdAt: Number(r.created_at),
});

export function publicBookingUrl(cabinetUrl: string, settings: BookingSettings, clubId: string): string {
  return `${cabinetUrl.replace(/\/+$/, '')}/#/book/${encodeURIComponent(settings.slug ?? clubId)}`;
}

async function settingsView(db: SqlDriver, cabinetUrl: string, club: ClubRow): Promise<BookingSettingsView> {
  const settings = settingsOf(await settingsRow(db, club.id));
  return { ...settings, publicUrl: publicBookingUrl(cabinetUrl, settings, club.id), capacity: await clubCapacity(db, club) };
}

/** Bookings of `days` working days from `fromDay` (default: today's working day), with the settings. */
export async function ownerBookings(
  db: SqlDriver,
  now: number,
  cabinetUrl: string,
  club: ClubRow,
  fromDay: string | null,
  days: number,
): Promise<OwnerBookingsResponse> {
  const first = fromDay ?? workingDay(now, club.timezone);
  if (!isBookingDay(first)) throw new CloudError(400, 'BAD_REQUEST', 'from — день в виде 2026-10-27');
  const span = Math.min(Math.max(Math.floor(days) || 1, 1), 62);
  const from = localInstant(first, WORKDAY_START_HOUR * 60, club.timezone);
  const to = localInstant(shiftDay(first, span), WORKDAY_START_HOUR * 60, club.timezone);
  const rows = await db.all<BookingRow>('SELECT * FROM bookings WHERE club_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at, created_at', [
    club.id,
    from,
    to,
  ]);
  return { settings: await settingsView(db, cabinetUrl, club), timezone: club.timezone, bookings: rows.map(toOwnerView) };
}

/** «Подтвердить» (new → confirmed) and «Отменить» (new or confirmed → cancelled). Repeats are no-ops. */
export async function setBookingStatus(db: SqlDriver, now: number, club: ClubRow, bookingId: string, action: 'confirm' | 'cancel'): Promise<OwnerBookingView> {
  return db.transaction(async (tx) => {
    const rows = await tx.all<BookingRow>('SELECT * FROM bookings WHERE id = ? AND club_id = ? FOR UPDATE', [bookingId, club.id]);
    const row = rows[0];
    if (!row) throw new CloudError(404, 'BOOKING_NOT_FOUND', 'Бронь не найдена');
    const target: BookingStatus = action === 'confirm' ? 'CONFIRMED' : 'CANCELLED';
    if (row.status === target) return toOwnerView(row);
    const allowed = action === 'confirm' ? row.status === 'PENDING' : row.status === 'PENDING' || row.status === 'CONFIRMED';
    if (!allowed) {
      const why = row.status === 'CANCELLED' ? 'бронь уже отменена' : row.status === 'ARRIVED' ? 'гость уже пришёл' : 'гость не пришёл';
      throw new CloudError(409, 'BOOKING_STATE', `Нельзя: ${why}`);
    }
    await tx.run('UPDATE bookings SET status = ?, status_at = ?, updated_at = ? WHERE id = ?', [target, now, now, bookingId]);
    await bumpVersion(tx, club.id, now);
    return toOwnerView({ ...row, status: target, status_at: now, updated_at: now });
  });
}

/** Saves the owner's settings (a partial patch); the HUB sees on/off and the hold time on its next pull. */
export async function updateBookingSettings(db: SqlDriver, now: number, cabinetUrl: string, club: ClubRow, raw: unknown): Promise<BookingSettingsView> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CloudError(400, 'BAD_REQUEST', 'Нужны настройки брони');
  const r = raw as Record<string, unknown>;
  const patch: Partial<BookingSettings> = {};
  if (r.enabled !== undefined) {
    if (typeof r.enabled !== 'boolean') throw invalid('BOOKING_SETTINGS', 'enabled — да или нет');
    patch.enabled = r.enabled;
  }
  for (const key of ['opensAt', 'closesAt'] as const) if (r[key] !== undefined) patch[key] = String(r[key]);
  for (const key of ['slotMinutes', 'holdMinutes'] as const) if (r[key] !== undefined) patch[key] = Number(r[key]);
  if (r.slug !== undefined) patch.slug = r.slug === null || r.slug === '' ? null : String(r.slug).trim().toLowerCase();
  const problems = bookingSettingsProblems(patch);
  if (patch.slug && UUID.test(patch.slug)) problems.push('Адрес не может выглядеть как номер заведения');
  if (problems.length) throw invalid('BOOKING_SETTINGS', problems.join('. '));
  if (patch.enabled && businessTypeOf(club) !== 'billiards') throw invalid('BOOKING_BILLIARDS_ONLY', 'Онлайн-бронь столов — только для бильярдного клуба');

  await db.transaction(async (tx) => {
    const current = settingsOf(await settingsRow(tx, club.id, true));
    const next: BookingSettings = { ...current, ...patch };
    if (next.slug && next.slug !== current.slug) {
      const taken = await tx.all<{ club_id: string }>('SELECT club_id FROM club_booking WHERE slug = ? AND club_id <> ?', [next.slug, club.id]);
      if (taken.length) throw new CloudError(409, 'SLUG_TAKEN', 'Такой адрес уже занят другим заведением — придумайте другой');
    }
    await tx.run(
      `INSERT INTO club_booking (club_id, enabled, opens_at, closes_at, slot_minutes, hold_minutes, slug, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (club_id) DO UPDATE SET
         enabled = excluded.enabled, opens_at = excluded.opens_at, closes_at = excluded.closes_at,
         slot_minutes = excluded.slot_minutes, hold_minutes = excluded.hold_minutes, slug = excluded.slug,
         version = club_booking.version + 1, updated_at = excluded.updated_at`,
      [club.id, next.enabled ? 1 : 0, next.opensAt, next.closesAt, next.slotMinutes, next.holdMinutes, next.slug, now],
    );
  });
  return settingsView(db, cabinetUrl, club);
}

// ---------------------------------------------------------------------------
// The HUB: GET /sync/bookings and the events it sends back
// ---------------------------------------------------------------------------

/** The version /sync/events reports as bookingsVersion; undefined while the club never set booking up. */
export async function bookingsVersionOf(db: SqlDriver, clubId: string): Promise<number | undefined> {
  const row = await settingsRow(db, clubId);
  return row ? Number(row.version) : undefined;
}

/** Bookings from a day ago on (the HUB keeps today's for «пришёл» / «не пришёл»), with on/off and the hold time. */
export async function syncBookings(db: SqlDriver, now: number, clubId: string): Promise<SyncBookingsResponse> {
  const row = await settingsRow(db, clubId);
  const settings = settingsOf(row);
  const rows = await db.all<BookingRow>('SELECT * FROM bookings WHERE club_id = ? AND starts_at >= ? ORDER BY starts_at, created_at LIMIT 2000', [
    clubId,
    now - DAY_MS,
  ]);
  return {
    version: row ? Number(row.version) : 0,
    enabled: settings.enabled,
    holdMinutes: settings.holdMinutes,
    bookings: rows.map<SyncBooking>((r) => ({
      id: r.id,
      startsAt: Number(r.starts_at),
      minutes: Number(r.minutes),
      kind: kindOf(r.table_kind),
      guestName: r.guest_name,
      phone: r.phone,
      status: r.status,
      createdAt: Number(r.created_at),
    })),
  };
}

/**
 * The HUB's word on a booking (outbox events `booking.arrived` { tableId } and `booking.no_show`):
 * the guest came (any earlier status; the hall knows best) or did not (only an active booking —
 * an arrival is never undone). Idempotent: a resent batch changes nothing. Returns rows changed.
 */
export async function applyHubBookingEvents(db: SqlDriver, now: number, clubId: string, events: readonly SyncEvent[]): Promise<number> {
  let changed = 0;
  for (const e of events) {
    const p = e.payload;
    if (p.entityType !== 'booking' || (p.action !== 'booking.arrived' && p.action !== 'booking.no_show')) continue;
    const data = (p.data ?? {}) as Record<string, unknown>;
    if (p.action === 'booking.arrived') {
      const tableId = typeof data.tableId === 'string' ? data.tableId : null;
      changed += await db.run(
        `UPDATE bookings SET status = 'ARRIVED', table_id = COALESCE(?, table_id), status_at = ?, updated_at = ?
          WHERE id = ? AND club_id = ? AND status <> 'ARRIVED'`,
        [tableId, e.at, now, p.entityId, clubId],
      );
    } else {
      changed += await db.run(
        `UPDATE bookings SET status = 'NO_SHOW', status_at = ?, updated_at = ?
          WHERE id = ? AND club_id = ? AND status IN ('PENDING', 'CONFIRMED')`,
        [e.at, now, p.entityId, clubId],
      );
    }
  }
  return changed;
}
