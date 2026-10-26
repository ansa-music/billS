import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BookingAvailability, SyncEvent } from '@bills/domain';
import { localInstant } from '@bills/domain';
import { handleBooking } from '../../apps/cloud/src/edge/booking.ts';
import { handleOwner } from '../../apps/cloud/src/edge/owner.ts';
import { handleSync } from '../../apps/cloud/src/edge/sync.ts';
import { alertText } from '../../apps/cloud/src/telegram.ts';
import { DEMO_HUBS } from '../../apps/cloud/src/seed.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { clubIdOf, edgeTest, HOUR, linkOwner, MONDAY_NOON, otherCompany, userJwt } from './edge-helpers.ts';

const TZ = 'Asia/Almaty';
const HUB1 = DEMO_HUBS[0];
const TODAY = '2026-10-12'; // MONDAY_NOON is 12:00 of this day in Almaty
const at = (day: string, hhmm: string) => localInstant(day, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), TZ);

async function setup(t: Parameters<typeof edgeTest>[0]) {
  const e = await edgeTest(t);
  const uid = await linkOwner(e.s);
  const owner = { authorization: `Bearer ${userJwt(uid)}` };
  const clubId = await clubIdOf(e.s, HUB1.id);
  return { e, owner, clubId };
}

async function enable(e: EdgeTest, owner: Record<string, string>, clubId: string, patch: Record<string, unknown> = {}) {
  const res = await e.call(handleOwner, 'PUT', `/owner/owner/clubs/${clubId}/booking-settings`, { headers: owner, body: { enabled: true, slug: 'demo-club', ...patch } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

const book = (e: EdgeTest, body: Record<string, unknown>, ip = '203.0.113.7', ref = 'demo-club') =>
  e.call(handleBooking, 'POST', `/booking/${ref}`, {
    headers: { 'x-forwarded-for': ip },
    body: { date: TODAY, startsAt: at(TODAY, '19:00'), minutes: 120, kind: null, name: 'Аня', phone: '8 707 123 45 67', ...body },
  });

const hubEvents = (e: EdgeTest, events: SyncEvent[]) =>
  e.call(handleSync, 'POST', '/sync/events', { headers: { authorization: `Bearer ${HUB1.key}` }, body: { hubId: HUB1.id, settingsVersion: 0, events } });

test('booking: off by default; the owner switches it on, the guest page shows the club, days and free times', async (t) => {
  const { e, owner, clubId } = await setup(t);
  const off = await e.call(handleBooking, 'GET', `/booking/${clubId}/availability`);
  assert.equal(off.status, 404);
  assert.equal(off.body.error.code, 'BOOKING_NOT_FOUND');

  const settings = await enable(e, owner, clubId);
  assert.equal(settings.publicUrl, 'https://ts-cabinet.pages.dev/#/book/demo-club');
  assert.deepEqual(settings.capacity, { pool: 3, russian: 2, snooker: 1 });
  assert.equal(settings.opensAt, '12:00');
  assert.equal(settings.closesAt, '02:00');

  for (const ref of ['demo-club', clubId]) {
    const res = await e.call<BookingAvailability>(handleBooking, 'GET', `/functions/v1/booking/${ref}/availability?date=${TODAY}`);
    assert.equal(res.status, 200, ref);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.body.club.name, 'Клуб «Демо»');
    assert.equal(res.body.club.ref, 'demo-club');
    assert.equal(res.body.days.length, 15);
    assert.deepEqual(res.body.kinds, ['pool', 'russian', 'snooker']);
    const twoHours = res.body.slots['120']!.any!;
    assert.equal(twoHours[0]!.time, '13:00', '12:00 is sooner than 30 minutes from now');
    assert.equal(twoHours.at(-1)!.time, '00:00', 'a 2-hour game ends by 02:00');
    assert.ok(twoHours.every((s) => s.free));
  }
  const far = await e.call(handleBooking, 'GET', '/booking/demo-club/availability?date=2026-10-27');
  assert.equal(far.status, 422);
  assert.equal(far.body.error.code, 'DAY_OUT_OF_RANGE');
});

test('booking: a new booking is stored, the HUB sees a new version and the owner gets «Новая бронь: Аня, 19:00, 2 ч»', async (t) => {
  const { e, owner, clubId } = await setup(t);
  await enable(e, owner, clubId);
  const device = await e.call(handleOwner, 'POST', '/owner/devices', { headers: owner, body: { platform: 'ntfy', token: 'https://ntfy.sh/ts-ABCDEFGHIJKLMNOPQRSTUVWX' } });
  assert.equal(device.status, 200);

  const res = await book(e, {});
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'PENDING');
  assert.equal(res.body.guestName, 'Аня');
  assert.equal(res.body.startsAt, at(TODAY, '19:00'));
  const [row] = await e.s.db.all<{ phone: string; status: string }>('SELECT phone, status FROM bookings WHERE id = ?', [res.body.id]);
  assert.deepEqual(row, { phone: '+77071234567', status: 'PENDING' });

  const pushed = e.sent.filter((m) => m.data.kind === 'BOOKING_NEW');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]!.title, 'Клуб «Демо»: Новая онлайн-бронь');
  assert.equal(pushed[0]!.body, 'Новая бронь: Аня, 19:00, 2 ч');
  assert.doesNotMatch(pushed[0]!.body, /707/, 'no phone in the push');
  assert.equal(alertText(pushed[0]!), '🟢 <b>Клуб «Демо»: Новая онлайн-бронь</b>\nНовая бронь: Аня, 19:00, 2 ч');
  const queue = await e.s.db.all<{ kind: string; status: string }>("SELECT kind, status FROM push_queue WHERE kind = 'BOOKING_NEW'");
  assert.deepEqual(queue, [{ kind: 'BOOKING_NEW', status: 'SENT' }]);

  // The owner can switch the kind off like any other.
  await e.call(handleOwner, 'PUT', '/owner/push/rules', { headers: owner, body: { rules: [{ kind: 'BOOKING_NEW', clubId: null, enabled: false }] } });
  assert.equal((await book(e, { phone: '+7 701 000 00 01', startsAt: at(TODAY, '20:00') })).status, 201);
  assert.equal(e.sent.filter((m) => m.data.kind === 'BOOKING_NEW').length, 1);

  // The HUB: /sync/events reports the version, /sync/bookings hands the list over.
  const sync = await hubEvents(e, []);
  assert.equal(sync.status, 200);
  assert.ok(sync.body.bookingsVersion >= 3, 'settings + two bookings');
  const pulled = await e.call(handleSync, 'GET', '/sync/bookings', { headers: { authorization: `Bearer ${HUB1.key}` } });
  assert.equal(pulled.status, 200);
  assert.equal(pulled.body.version, sync.body.bookingsVersion);
  assert.equal(pulled.body.enabled, true);
  assert.equal(pulled.body.holdMinutes, 15);
  assert.deepEqual(pulled.body.bookings.map((b: { guestName: string; phone: string }) => [b.guestName, b.phone]), [
    ['Аня', '+77071234567'],
    ['Аня', '+77010000001'],
  ]);
  const unknown = await e.call(handleSync, 'GET', '/sync/bookings', { headers: { authorization: 'Bearer nope' } });
  assert.equal(unknown.status, 401);
});

test('booking: the last table goes once — two guests racing for the snooker table at 19:00', async (t) => {
  const { e, owner, clubId } = await setup(t);
  await enable(e, owner, clubId);
  const [a, b] = await Promise.all([
    book(e, { kind: 'snooker', name: 'Аня', phone: '+7 707 111 11 11' }, '198.51.100.1'),
    book(e, { kind: 'snooker', name: 'Борис', phone: '+7 707 222 22 22' }, '198.51.100.2'),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const lost = a.status === 409 ? a : b;
  assert.equal(lost.body.error.code, 'SLOT_TAKEN');
  const rows = await e.s.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM bookings WHERE table_kind = 'snooker'");
  assert.equal(rows[0]!.n, 1);

  // The guest page now shows 19:00 snooker as taken, but a pool table is still free then.
  const page = await e.call<BookingAvailability>(handleBooking, 'GET', `/booking/demo-club/availability?date=${TODAY}`);
  const slot = (minutes: string, kind: string, time: string) => page.body.slots[minutes]![kind]!.find((s) => s.time === time)!;
  assert.equal(slot('60', 'snooker', '19:00').free, false);
  assert.equal(slot('60', 'snooker', '20:00').free, false);
  assert.equal(slot('60', 'snooker', '21:00').free, true);
  assert.equal(slot('60', 'pool', '19:00').free, true);
  assert.equal(slot('60', 'any', '19:00').free, true);

  // «Любой» uses every table: 6 tables, 6 bookings at 22:00, the 7th is refused.
  for (let i = 0; i < 6; i++) {
    const r = await book(e, { startsAt: at(TODAY, '22:00'), minutes: 60, phone: `+7 707 300 00 0${i}` }, `192.0.2.${i}`);
    assert.equal(r.status, 201, `booking ${i}`);
  }
  const seventh = await book(e, { startsAt: at(TODAY, '22:00'), minutes: 60, phone: '+7 707 300 00 09' }, '192.0.2.9');
  assert.equal(seventh.status, 409);
});

test('booking: validation and the limits per IP and per phone', async (t) => {
  const { e, owner, clubId } = await setup(t);
  await enable(e, owner, clubId);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ name: '  ' }, 'NAME_REQUIRED'],
    [{ phone: '123' }, 'PHONE_INVALID'],
    [{ minutes: 90 }, 'DURATION_INVALID'],
    [{ kind: 'carom' }, 'KIND_INVALID'],
    [{ startsAt: at(TODAY, '19:15') }, 'SLOT_INVALID'],
    [{ startsAt: at(TODAY, '12:00') }, 'SLOT_TOO_SOON'],
    [{ startsAt: at('2026-10-13', '01:00') }, 'SLOT_INVALID'], // 01:00–03:00 ends after closing
    [{ date: '2026-11-30', startsAt: at('2026-11-30', '19:00') }, 'DAY_OUT_OF_RANGE'],
  ];
  for (const [body, code] of cases) {
    const res = await book(e, body, `10.0.0.${cases.findIndex((c) => c[0] === body)}`);
    assert.equal(res.status, 422, code);
    assert.equal(res.body.error.code, code);
  }
  const bot = await book(e, { website: 'http://spam' });
  assert.equal(bot.status, 400);
  assert.equal((await e.call(handleBooking, 'POST', '/booking/no-such-club', { body: [] })).status, 400);
  assert.equal((await e.call(handleBooking, 'POST', '/booking/no-such-club', { body: { date: TODAY, startsAt: at(TODAY, '19:00'), minutes: 60, name: 'A', phone: '+77071234567' } })).status, 404);

  // One phone: 5 tries an hour (wrong times count too), then 429.
  for (let i = 0; i < 5; i++) assert.equal((await book(e, { startsAt: at(TODAY, '19:15'), phone: '+7 777 555 55 55' }, `172.16.0.${i}`)).status, 422);
  const phoneLimited = await book(e, { phone: '+7 777 555 55 55' }, '172.16.0.99');
  assert.equal(phoneLimited.status, 429);
  assert.equal(phoneLimited.body.error.code, 'RATE_LIMITED');

  // One IP: 20 tries an hour.
  for (let i = 0; i < 20; i++) await book(e, { startsAt: at(TODAY, '19:15'), phone: `+7 705 000 00 ${String(i).padStart(2, '0')}` }, '198.18.0.1');
  assert.equal((await book(e, { phone: '+7 705 111 11 11' }, '198.18.0.1')).status, 429);
  // An hour later the IP may try again.
  e.clock.now += HOUR + 1;
  assert.equal((await book(e, { phone: '+7 705 111 11 11' }, '198.18.0.1')).status, 201);

  // Three upcoming bookings per phone.
  e.clock.now = MONDAY_NOON + 2 * HOUR;
  for (const time of ['20:00', '21:00']) assert.equal((await book(e, { phone: '+7 705 111 11 11', startsAt: at(TODAY, time), minutes: 60 }, '198.18.0.2')).status, 201);
  const fourth = await book(e, { phone: '+7 705 111 11 11', startsAt: at(TODAY, '23:00'), minutes: 60 }, '198.18.0.2');
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, 'TOO_MANY_BOOKINGS');
});

test('booking: the owner lists, confirms and cancels; a cancelled booking frees the table; strangers see nothing', async (t) => {
  const { e, owner, clubId } = await setup(t);
  await enable(e, owner, clubId);
  const a = await book(e, { kind: 'snooker' });
  assert.equal(a.status, 201);

  const list = await e.call(handleOwner, 'GET', `/owner/owner/clubs/${clubId}/bookings?from=${TODAY}&days=2`, { headers: owner });
  assert.equal(list.status, 200);
  assert.equal(list.body.timezone, TZ);
  assert.equal(list.body.settings.enabled, true);
  assert.deepEqual(
    list.body.bookings.map((b: { guestName: string; phone: string; kind: string; status: string }) => [b.guestName, b.phone, b.kind, b.status]),
    [['Аня', '+77071234567', 'snooker', 'PENDING']],
  );

  const version = async () => (await hubEvents(e, [])).body.bookingsVersion as number;
  const v0 = await version();
  const confirmed = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/bookings/${a.body.id}/confirm`, { headers: owner });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, 'CONFIRMED');
  assert.equal(await version(), v0 + 1, 'the HUB pulls the change');
  assert.equal((await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/bookings/${a.body.id}/confirm`, { headers: owner })).body.status, 'CONFIRMED');

  assert.equal((await book(e, { kind: 'snooker', phone: '+7 701 999 99 99' }, '10.1.1.1')).status, 409);
  const cancelled = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/bookings/${a.body.id}/cancel`, { headers: owner });
  assert.equal(cancelled.body.status, 'CANCELLED');
  const again = await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/bookings/${a.body.id}/confirm`, { headers: owner });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'BOOKING_STATE');
  assert.equal((await book(e, { kind: 'snooker', phone: '+7 701 999 99 99' }, '10.1.1.1')).status, 201, 'the table is free again');

  const other = await otherCompany(e.s);
  const strangerUid = await linkOwner(e.s, other.email);
  const stranger = { authorization: `Bearer ${userJwt(strangerUid)}` };
  assert.equal((await e.call(handleOwner, 'GET', `/owner/clubs/${clubId}/bookings`, { headers: stranger })).status, 404);
  assert.equal((await e.call(handleOwner, 'POST', `/owner/clubs/${clubId}/bookings/${a.body.id}/cancel`, { headers: stranger })).status, 404);
  assert.equal((await e.call(handleOwner, 'GET', `/owner/clubs/${clubId}/bookings`)).status, 401);

  // Settings: a taken slug, bad values.
  const north = await clubIdOf(e.s, DEMO_HUBS[1].id);
  const taken = await e.call(handleOwner, 'PUT', `/owner/clubs/${north}/booking-settings`, { headers: owner, body: { slug: 'demo-club' } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'SLUG_TAKEN');
  const bad = await e.call(handleOwner, 'PUT', `/owner/clubs/${clubId}/booking-settings`, { headers: owner, body: { opensAt: '9', holdMinutes: 0 } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'BOOKING_SETTINGS');
  const off = await e.call(handleOwner, 'PUT', `/owner/clubs/${clubId}/booking-settings`, { headers: owner, body: { enabled: false } });
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.slug, 'demo-club', 'a partial patch keeps the rest');
  assert.equal((await e.call(handleBooking, 'GET', '/booking/demo-club/availability')).status, 404);
});

test('booking: the HUB reports «пришёл» and «не пришёл»; a resent batch changes nothing; a «не пришёл» booking frees the table after the hold', async (t) => {
  const { e, owner, clubId } = await setup(t);
  await enable(e, owner, clubId);
  const a = await book(e, { kind: 'snooker', startsAt: at(TODAY, '14:00'), minutes: 180 });
  const b = await book(e, { kind: 'pool', phone: '+7 701 222 33 44' }, '10.2.2.2');
  const ev = (id: number, action: string, entityId: string, data: Record<string, unknown>): SyncEvent => ({
    id,
    at: MONDAY_NOON + id,
    topic: action,
    payload: { actor: 'system', action, entityType: 'booking', entityId, data },
  });
  e.clock.now = at(TODAY, '14:20');
  const batch = [ev(1, 'booking.no_show', a.body.id, {}), ev(2, 'booking.arrived', b.body.id, { tableId: 'table-7' })];
  assert.equal((await hubEvents(e, batch)).status, 200);
  assert.equal((await hubEvents(e, batch)).status, 200);
  const rows = await e.s.db.all<{ id: string; status: string; table_id: string | null }>('SELECT id, status, table_id FROM bookings ORDER BY starts_at');
  assert.deepEqual(rows.map((r) => [r.status, r.table_id]), [['NO_SHOW', null], ['ARRIVED', 'table-7']]);
  // An arrival is never undone by a late «не пришёл».
  await hubEvents(e, [ev(3, 'booking.no_show', b.body.id, {})]);
  assert.equal((await e.s.db.all<{ status: string }>('SELECT status FROM bookings WHERE id = ?', [b.body.id]))[0]!.status, 'ARRIVED');

  // The snooker table is free from 15:00 (the no-show held it 15 minutes only).
  const page = await e.call<BookingAvailability>(handleBooking, 'GET', `/booking/demo-club/availability?date=${TODAY}`);
  assert.equal(page.body.slots['60']!.snooker!.find((s) => s.time === '15:00')!.free, true);
});
