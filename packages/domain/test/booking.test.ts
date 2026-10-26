import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BookingLoad } from '../src/booking.ts';
import {
  DEFAULT_BOOKING_SETTINGS,
  bookingConflict,
  bookingDays,
  bookingIcs,
  bookingName,
  bookingPushBody,
  bookingSettingsProblems,
  bookingSlots,
  bookingWindow,
  canFit,
  capacityOf,
  isBookableStart,
  isBookingSlug,
  isNoShowDue,
  localInstant,
  normalizeBookingSettings,
  occupiedSpan,
  planBookingTables,
  slugify,
} from '../src/booking.ts';
import { isPushKind, PUSH_KINDS } from '../src/push.ts';
import { formatPhone, maskPhone, normalizePhone } from '../src/loyalty.ts';

const TZ = 'Asia/Almaty'; // UTC+5, no DST
const H = 3_600_000;
/** Monday 2026-10-12 12:00 Almaty. */
const NOON = Date.UTC(2026, 9, 12, 7, 0);
const at = (day: string, hhmm: string) => localInstant(day, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), TZ);

test('local instants and the opening window: 12:00–02:00 ends after midnight of the next day', () => {
  assert.equal(localInstant('2026-10-12', 12 * 60, TZ), NOON);
  const w = bookingWindow('2026-10-12', DEFAULT_BOOKING_SETTINGS, TZ);
  assert.equal(w.from, NOON);
  assert.equal(w.to, Date.UTC(2026, 9, 12, 21, 0)); // 02:00 on the 13th = 21:00 UTC on the 12th
  // Equal times: never closes.
  const all = bookingWindow('2026-10-12', { opensAt: '06:00', closesAt: '06:00' }, TZ);
  assert.equal(all.to - all.from, 24 * H);
  // A zone with DST: local wall time stays right on the change day.
  assert.equal(localInstant('2026-03-29', 12 * 60, 'Europe/Berlin'), Date.UTC(2026, 2, 29, 10, 0));
});

test('days to pick: the working day (from 06:00) and 14 more', () => {
  const days = bookingDays(NOON, TZ);
  assert.equal(days.length, 15);
  assert.equal(days[0], '2026-10-12');
  assert.equal(days[14], '2026-10-26');
  // 01:30 on Tuesday is still Monday's working day.
  assert.equal(bookingDays(Date.UTC(2026, 9, 12, 20, 30), TZ)[0], '2026-10-12');
});

test('slots: every hour from opening, the last one ends by closing, nothing sooner than 30 min from now', () => {
  const base = { day: '2026-10-12', settings: DEFAULT_BOOKING_SETTINGS, timezone: TZ, capacity: { pool: 2 }, bookings: [], kind: null };
  const twoHours = bookingSlots({ ...base, minutes: 120, now: NOON - 2 * H });
  assert.deepEqual(twoHours.map((s) => s.time), ['12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '22:00', '23:00', '00:00']);
  assert.ok(twoHours.every((s) => s.free));
  // At 12:40 the 13:00 slot is too close (20 minutes): it starts from 14:00.
  assert.equal(bookingSlots({ ...base, minutes: 60, now: NOON + 40 * 60_000 })[0]!.time, '14:00');
  // Half-hour grid.
  const half = bookingSlots({ ...base, settings: { ...DEFAULT_BOOKING_SETTINGS, slotMinutes: 30 }, minutes: 180, now: NOON - H });
  assert.equal(half.at(-1)!.time, '23:00');
  assert.equal(half[1]!.time, '12:30');
  assert.ok(isBookableStart('2026-10-12', at('2026-10-13', '00:00'), 120, DEFAULT_BOOKING_SETTINGS, TZ));
  assert.ok(!isBookableStart('2026-10-12', at('2026-10-13', '01:00'), 120, DEFAULT_BOOKING_SETTINGS, TZ), 'ends after closing');
  assert.ok(!isBookableStart('2026-10-12', NOON + 15 * 60_000, 60, DEFAULT_BOOKING_SETTINGS, TZ), 'off the grid');
});

test('capacity per table type: the last table goes once, other types are not affected', () => {
  const cap = capacityOf([
    { kind: 'pool' },
    { kind: 'pool' },
    { kind: 'russian' },
    { kind: 'snooker', isActive: false },
  ]);
  assert.deepEqual(cap, { pool: 2, russian: 1 });
  const evening = at('2026-10-12', '19:00');
  const existing: BookingLoad[] = [{ kind: 'russian', startsAt: evening, minutes: 120, status: 'PENDING' }];
  assert.equal(canFit(cap, existing, { kind: 'russian', startsAt: evening + H, minutes: 60 }, 15), false);
  assert.equal(canFit(cap, existing, { kind: 'russian', startsAt: evening + 2 * H, minutes: 60 }, 15), true, 'starts when the other ends');
  assert.equal(canFit(cap, existing, { kind: 'pool', startsAt: evening, minutes: 60 }, 15), true);
  assert.equal(canFit(cap, existing, { kind: 'snooker', startsAt: evening, minutes: 60 }, 15), false, 'no active snooker table');
  // A cancelled booking holds nothing.
  assert.equal(canFit(cap, [{ ...existing[0]!, status: 'CANCELLED' }], { kind: 'russian', startsAt: evening, minutes: 60 }, 15), true);
});

test('«любой» stol: fits while all bookings together fit all tables and each type its own', () => {
  const cap = { pool: 1, russian: 1 };
  const t = at('2026-10-12', '20:00');
  const pool: BookingLoad = { kind: 'pool', startsAt: t, minutes: 60, status: 'CONFIRMED' };
  const any: BookingLoad = { kind: null, startsAt: t, minutes: 60, status: 'PENDING' };
  assert.equal(canFit(cap, [pool], { kind: null, startsAt: t, minutes: 60 }, 15), true, '«любой» takes the russian table');
  assert.equal(canFit(cap, [pool, any], { kind: null, startsAt: t, minutes: 60 }, 15), false, 'two tables, two bookings');
  assert.equal(canFit(cap, [any], { kind: 'pool', startsAt: t, minutes: 60 }, 15), true, '«любой» moves to russian');
  assert.equal(canFit(cap, [any, { ...pool, kind: 'russian' }], { kind: 'pool', startsAt: t, minutes: 60 }, 15), false);
  // Overlaps that never coincide: 19–21 and 21–22 on one table each.
  const a: BookingLoad = { kind: null, startsAt: t - H, minutes: 120, status: 'PENDING' };
  const b: BookingLoad = { kind: null, startsAt: t + H, minutes: 60, status: 'PENDING' };
  assert.equal(canFit({ pool: 1 }, [a], { kind: null, startsAt: t + H, minutes: 60 }, 15), true);
  assert.equal(canFit({ pool: 1 }, [a, b], { kind: null, startsAt: t, minutes: 30 }, 15), false);
});

test('hold time: a «не пришёл» booking frees the table after holdMinutes', () => {
  const t = at('2026-10-12', '19:00');
  const noShow: BookingLoad = { kind: 'pool', startsAt: t, minutes: 120, status: 'NO_SHOW' };
  assert.deepEqual(occupiedSpan(noShow, 15), { from: t, to: t + 15 * 60_000 });
  assert.equal(canFit({ pool: 1 }, [noShow], { kind: 'pool', startsAt: t + 30 * 60_000, minutes: 60 }, 15), true);
  assert.equal(canFit({ pool: 1 }, [noShow], { kind: 'pool', startsAt: t + 10 * 60_000, minutes: 60 }, 15), false);
  assert.equal(isNoShowDue({ startsAt: t, status: 'PENDING' }, t + 14 * 60_000, 15), false);
  assert.equal(isNoShowDue({ startsAt: t, status: 'CONFIRMED' }, t + 15 * 60_000, 15), true);
  assert.equal(isNoShowDue({ startsAt: t, status: 'ARRIVED' }, t + H, 15), false);
  // Slots on the page: the booked hour is taken, a slot after the hold is free again.
  const slots = bookingSlots({
    day: '2026-10-12',
    settings: { ...DEFAULT_BOOKING_SETTINGS, slotMinutes: 30 },
    timezone: TZ,
    capacity: { pool: 1 },
    bookings: [{ kind: 'pool', startsAt: t, minutes: 60, status: 'PENDING' }],
    minutes: 60,
    kind: 'pool',
    now: NOON,
  });
  const free = (time: string) => slots.find((s) => s.time === time)!.free;
  assert.equal(free('18:00'), true);
  assert.equal(free('18:30'), false);
  assert.equal(free('19:30'), false);
  assert.equal(free('20:00'), true);
});

test('settings: defaults, normalizing and the owner’s mistakes in words', () => {
  assert.deepEqual(normalizeBookingSettings({}), DEFAULT_BOOKING_SETTINGS);
  assert.deepEqual(normalizeBookingSettings({ enabled: true, opensAt: '25:00', slotMinutes: 45, holdMinutes: 20, slug: 'kiy-almaty' }), {
    ...DEFAULT_BOOKING_SETTINGS,
    enabled: true,
    holdMinutes: 20,
    slug: 'kiy-almaty',
  });
  assert.deepEqual(bookingSettingsProblems({ opensAt: '10:00', slotMinutes: 30, holdMinutes: 15, slug: 'ok-club' }), []);
  assert.equal(bookingSettingsProblems({ opensAt: '9:00', slotMinutes: 20, holdMinutes: 90, slug: 'Кий' }).length, 4);
  assert.ok(isBookingSlug('kiy-almaty'));
  assert.ok(!isBookingSlug('-kiy'));
  assert.ok(!isBookingSlug('ki'));
  assert.ok(!isBookingSlug('kiy--a'));
  assert.equal(slugify('Kiy Club  Almaty!'), 'kiy-club-almaty');
});

test('guest details: names and phones', () => {
  assert.equal(bookingName('  Аня   Ким '), 'Аня Ким');
  assert.equal(bookingName('   '), null);
  assert.equal(bookingName('<b>Аня</b>'), 'bАня/b');
  assert.equal(normalizePhone('8 (707) 123-45-67'), '+77071234567');
  assert.equal(normalizePhone('+7 707 123 45 67'), '+77071234567');
  assert.equal(normalizePhone('7071234567'), '+77071234567');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+7 707 123'), null);
  assert.equal(normalizePhone('call me'), null);
  assert.equal(formatPhone('+77071234567'), '+7 707 123 45 67');
  assert.equal(maskPhone('+77071234567'), '+7 ••• ••• 45 67');
});

test('push text: «Новая бронь: Аня, 19:00, 2 ч», the day when not today, no phone', () => {
  const b = { guestName: 'Аня', startsAt: at('2026-10-12', '19:00'), minutes: 120, kind: null };
  assert.equal(bookingPushBody(b, TZ, NOON), 'Новая бронь: Аня, 19:00, 2 ч');
  assert.equal(bookingPushBody({ ...b, startsAt: at('2026-10-13', '19:00'), kind: 'russian' }, TZ, NOON), 'Новая бронь: Аня, завтра 19:00, 2 ч, русский бильярд');
  assert.equal(bookingPushBody({ ...b, startsAt: at('2026-10-20', '13:00'), minutes: 60 }, TZ, NOON), 'Новая бронь: Аня, 20 октября 13:00, 1 ч');
  // 01:00 after midnight of a Monday evening is still «сегодня» (the working day).
  assert.equal(bookingPushBody({ ...b, startsAt: at('2026-10-13', '01:00'), minutes: 60 }, TZ, NOON), 'Новая бронь: Аня, 01:00, 1 ч');
  assert.ok(isPushKind('BOOKING_NEW'));
  assert.equal(PUSH_KINDS.find((k) => k.kind === 'BOOKING_NEW')?.defaultOn, true);
});

test('calendar file: UTC times, escaped text, CRLF lines', () => {
  const ics = bookingIcs({ id: 'b1', clubName: 'Кий; клуб, Алматы', startsAt: at('2026-10-12', '19:00'), minutes: 120, guestName: 'Аня', kind: 'pool', createdAt: NOON });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nDTSTART:20261012T140000Z\r\n/);
  assert.match(ics, /\r\nDTEND:20261012T160000Z\r\n/);
  assert.match(ics, /SUMMARY:Бильярд — Кий\\; клуб\\, Алматы/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.split('\r\n').every((l) => l.length <= 61));
});

test('the hall: «любой» gets a free table of any type, a type only its own, overlaps never share', () => {
  const t = at('2026-10-12', '19:00');
  const tables = [
    { id: 't1', kind: 'pool' as const, busy: true },
    { id: 't2', kind: 'pool' as const, busy: false },
    { id: 't3', kind: 'russian' as const, busy: false },
  ];
  const plan = planBookingTables(
    [
      { id: 'a', startsAt: t, minutes: 60, kind: 'pool', status: 'PENDING', tableId: null },
      { id: 'b', startsAt: t, minutes: 60, kind: null, status: 'CONFIRMED', tableId: null },
      { id: 'c', startsAt: t + 30 * 60_000, minutes: 60, kind: 'pool', status: 'PENDING', tableId: null },
      { id: 'd', startsAt: t, minutes: 60, kind: 'russian', status: 'CANCELLED', tableId: null },
      { id: 'f', startsAt: t + 45 * 60_000, minutes: 60, kind: 'pool', status: 'PENDING', tableId: null },
      { id: 'e', startsAt: t + 2 * H, minutes: 60, kind: 'russian', status: 'PENDING', tableId: null },
    ],
    tables,
    15,
  );
  assert.equal(plan.get('a'), 't2', 'a free table first');
  assert.equal(plan.get('b'), 't3', '«любой» prefers a free table of another type to a busy one');
  assert.equal(plan.get('c'), 't1');
  assert.equal(plan.get('f'), null, 'both pool tables are taken at 19:45');
  assert.equal(plan.has('d'), false);
  assert.equal(plan.get('e'), 't3');

  const list = [{ id: 'a', startsAt: t, status: 'PENDING' as const, tableId: 't2' }];
  assert.equal(bookingConflict(list, 't2', t - 59 * 60_000, 15)?.id, 'a');
  assert.equal(bookingConflict(list, 't2', t - 61 * 60_000, 15), null, 'more than an hour before');
  assert.equal(bookingConflict(list, 't2', t + 10 * 60_000, 15)?.id, 'a', 'late, still held');
  assert.equal(bookingConflict(list, 't2', t + 16 * 60_000, 15), null, 'past the hold time');
  assert.equal(bookingConflict(list, 't1', t, 15), null);
});
