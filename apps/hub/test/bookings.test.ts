import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HubBookingsResponse, SyncBooking, SyncBookingsResponse, SyncEventsRequest } from '@bills/domain';
import { bookingConflict } from '@bills/domain';
import { all, one } from '../src/db.ts';
import { applyBookings, appliedBookingsVersion } from '../src/bookings.ts';
import { Harness, MONDAY_NOON, post, sessionStatus, tableId, waitFor } from './helpers.ts';
import type { TestHub } from './helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const AT_19 = MONDAY_NOON + 7 * HOUR; // 19:00 in Almaty

const booking = (id: string, extra: Partial<SyncBooking> = {}): SyncBooking => ({
  id,
  startsAt: AT_19,
  minutes: 120,
  kind: null,
  guestName: 'Аня',
  phone: '+77071234567',
  status: 'PENDING',
  createdAt: MONDAY_NOON - HOUR,
  ...extra,
});

const pkg = (bookings: SyncBooking[], version = 1): SyncBookingsResponse => ({ version, enabled: true, holdMinutes: 15, bookings });

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function list(hub: TestHub): Promise<HubBookingsResponse> {
  const res = await hub.app.inject({ method: 'GET', url: '/api/bookings' });
  assert.equal(res.statusCode, 200);
  return res.json() as HubBookingsResponse;
}

const outbox = (hub: TestHub, topic: string) =>
  all<{ payload: string }>(hub.db, 'SELECT payload FROM outbox WHERE topic = ? ORDER BY id', topic).map((r) => JSON.parse(r.payload) as { entityId: string; data: Record<string, unknown> });

/** Answers the HUB like the Supabase cloud does: bookingsVersion in /sync/events, the list in /sync/bookings. */
async function fakeCloud(t: { after: (fn: () => Promise<void>) => void }, state: { version: number; bookings: SyncBooking[]; fail?: boolean }) {
  const seen: string[] = [];
  const events: SyncEventsRequest['events'] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    seen.push(`${req.method} ${req.url}`);
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (state.fail) return send(503, { error: { code: 'DOWN', message: 'нет связи' } });
    if (req.url === '/sync/snapshot') return send(200, { accepted: true, settingsVersion: 0 });
    if (req.url === '/sync/events') {
      events.push(...(body as SyncEventsRequest).events);
      const last = (body as SyncEventsRequest).events.at(-1)?.id ?? null;
      return send(200, { lastAcceptedId: last, inserted: 0, settingsVersion: 0, bookingsVersion: state.version });
    }
    if (req.url === '/sync/bookings') return send(200, pkg(state.bookings, state.version));
    send(404, { error: { code: 'NOT_FOUND', message: String(req.url) } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, events };
}

test('sync: a new bookingsVersion makes the HUB pull /sync/bookings; the same version does not; offline the bookings stay', async (t) => {
  const h = harness(t);
  const state = { version: 3, bookings: [booking('b1'), booking('b2', { kind: 'snooker', guestName: 'Борис', startsAt: AT_19 + HOUR })], fail: false };
  const cloud = await fakeCloud(t, state);
  const hub = await h.start(undefined, { sync: { url: cloud.url, apiKey: 'k', hubId: 'hub-test', intervalMs: 10_000, kickDelayMs: 10 } });
  const sync = hub.hub.sync!;
  sync.stop();
  await sync.tick();
  assert.equal(cloud.seen.filter((s) => s === 'GET /sync/bookings').length, 1);
  assert.equal(appliedBookingsVersion(hub.db), 3);
  assert.deepEqual((await list(hub)).bookings.map((b) => [b.guestName, b.kind, b.status]), [
    ['Аня', null, 'PENDING'],
    ['Борис', 'snooker', 'PENDING'],
  ]);

  h.clock.advance(20_000);
  await sync.tick();
  assert.equal(cloud.seen.filter((s) => s === 'GET /sync/bookings').length, 1, 'same version: no pull');

  // The owner cancels b2 in the cabinet: a new version, the HUB pulls again.
  state.version = 4;
  state.bookings = [booking('b1', { status: 'CONFIRMED' }), booking('b2', { kind: 'snooker', guestName: 'Борис', startsAt: AT_19 + HOUR, status: 'CANCELLED' })];
  h.clock.advance(20_000);
  await sync.tick();
  assert.deepEqual((await list(hub)).bookings.map((b) => b.status), ['CONFIRMED', 'CANCELLED']);

  // No internet: the hall keeps what it has.
  state.fail = true;
  h.clock.advance(20_000);
  await sync.tick();
  assert.equal((await list(hub)).bookings.length, 2);

  // A broken package is refused as a whole.
  assert.throws(() => applyBookings(hub.db, h.clock.now(), { version: 9, enabled: true, holdMinutes: 15, bookings: [{ ...booking('x'), minutes: -1 }] }), /повреждён/);
  assert.equal(appliedBookingsVersion(hub.db), 4);
});

test('the hall: a booking is shown on a planned table; opening that table within the hour is a conflict; full phone only for managers', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  applyBookings(hub.db, h.clock.now(), pkg([booking('b1', { kind: 'russian' }), booking('b2', { kind: 'russian', startsAt: AT_19 + 30 * MIN })]));
  const res = await list(hub);
  const [b1, b2] = res.bookings;
  assert.equal(b1!.plannedTableId, tableId(hub, 'Стол 4'));
  assert.equal(b2!.plannedTableId, tableId(hub, 'Стол 5'), 'overlapping bookings never share a table');
  assert.equal(b1!.phone, '+77071234567', 'X-Actor in tests is a manager');

  const asHall = res.bookings.map((b) => ({ ...b, tableId: b.plannedTableId }));
  assert.equal(bookingConflict(asHall, tableId(hub, 'Стол 4'), AT_19 - 30 * MIN, res.holdMinutes)?.id, 'b1');
  assert.equal(bookingConflict(asHall, tableId(hub, 'Стол 4'), AT_19 - 2 * HOUR, res.holdMinutes), null);
  assert.equal(bookingConflict(asHall, tableId(hub, 'Стол 1'), AT_19, res.holdMinutes), null);

  // A busy table is planned last: with a game on Стол 4, the booking goes to Стол 5 first.
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 4')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  const after = await list(hub);
  assert.equal(after.bookings[0]!.plannedTableId, tableId(hub, 'Стол 5'));
});

test('«Гость пришёл»: «любой» gets a free table, the game opens with the normal flow, the cloud hears booking.arrived without names', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  h.clock.set(AT_19 - 5 * MIN);
  applyBookings(hub.db, h.clock.now(), pkg([booking('b1'), booking('b2', { kind: 'snooker' }), booking('b3', { kind: 'snooker', guestName: 'Вика', phone: '+77070000003', startsAt: AT_19 + 3 * HOUR })]));

  const arrived = await post(hub, '/api/bookings/b1/arrive', {});
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  const { tableId: table, booking: view } = arrived.body as unknown as { tableId: string; booking: { status: string; tableId: string } };
  assert.equal(view.status, 'ARRIVED');
  assert.equal(view.tableId, table);
  const opened = await post(hub, `/api/tables/${table}/open`);
  assert.equal(opened.status, 201);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');

  const again = await post(hub, '/api/bookings/b1/arrive', {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error?.code, 'BOOKING_ARRIVED');

  // Snooker: one table. b2 takes it; b3 (later) cannot arrive while the game is on.
  const b2 = await post(hub, '/api/bookings/b2/arrive', {});
  assert.equal(b2.status, 200);
  assert.equal((b2.body as unknown as { tableId: string }).tableId, tableId(hub, 'Снукер'));
  const snooker = await post(hub, `/api/tables/${tableId(hub, 'Снукер')}/open`);
  await waitFor(() => sessionStatus(hub, snooker.body.id) === 'ACTIVE');
  const noTable = await post(hub, '/api/bookings/b3/arrive', {});
  assert.equal(noTable.status, 409);
  assert.equal(noTable.body.error?.code, 'NO_FREE_TABLE');
  const wrongKind = await post(hub, '/api/bookings/b3/arrive', { tableId: tableId(hub, 'Стол 2') });
  assert.equal(wrongKind.body.error?.code, 'TABLE_KIND');

  const sent = outbox(hub, 'booking.arrived');
  assert.deepEqual(sent.map((e) => [e.entityId, e.data.tableId]), [['b1', table], ['b2', tableId(hub, 'Снукер')]]);
  const text = JSON.stringify(sent);
  assert.doesNotMatch(text, /Аня|707/, 'no name or phone goes to the cloud');
});

test('«не пришёл»: 15 minutes after the time the booking closes by itself, the table is free; a late guest may still arrive', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  h.clock.set(AT_19 - HOUR);
  applyBookings(hub.db, h.clock.now(), pkg([booking('b1', { kind: 'pool' }), booking('b2', { kind: 'pool', status: 'CONFIRMED' }), booking('b3', { status: 'CANCELLED' })]));

  h.clock.set(AT_19 + 14 * MIN);
  assert.equal((await list(hub)).bookings.filter((b) => b.status === 'NO_SHOW').length, 0);
  h.clock.set(AT_19 + 15 * MIN);
  const res = await list(hub);
  assert.deepEqual(res.bookings.map((b) => b.status), ['NO_SHOW', 'NO_SHOW', 'CANCELLED']);
  assert.equal(res.bookings[0]!.plannedTableId, null, 'no table held any more');
  assert.deepEqual(outbox(hub, 'booking.no_show').map((e) => [e.entityId, e.data.auto]), [['b1', true], ['b2', true]]);
  // The sweep runs once per booking.
  await list(hub);
  assert.equal(outbox(hub, 'booking.no_show').length, 2);

  const late = await post(hub, '/api/bookings/b1/arrive', {});
  assert.equal(late.status, 200);
  assert.equal(one<{ local_status: string }>(hub.db, "SELECT local_status FROM bookings WHERE id = 'b1'")!.local_status, 'ARRIVED');
  const cancelled = await post(hub, '/api/bookings/b3/arrive', {});
  assert.equal(cancelled.body.error?.code, 'BOOKING_CANCELLED');

  // A new package from the cloud keeps the hall's own decision.
  applyBookings(hub.db, h.clock.now(), pkg([booking('b1', { kind: 'pool', status: 'NO_SHOW' }), booking('b2', { kind: 'pool', status: 'CONFIRMED' })], 2));
  assert.deepEqual((await list(hub)).bookings.map((b) => b.status), ['ARRIVED', 'NO_SHOW', 'CANCELLED']);

  // By hand, before the hold runs out.
  applyBookings(hub.db, h.clock.now(), pkg([booking('b4', { startsAt: h.clock.now() + HOUR })], 3));
  const manual = await post(hub, '/api/bookings/b4/no-show', {});
  assert.equal(manual.status, 200);
  assert.deepEqual(outbox(hub, 'booking.no_show').at(-1)!.data, { startsAt: h.clock.now() + HOUR, auto: false });
});
