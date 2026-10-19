import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { HallLayoutView, JournalPage, LampDetail, SessionView } from '@bills/domain';
import { Harness, MONDAY_NOON, post, sessionStatus, tableId, waitFor } from './helpers.ts';
import type { TestHub } from './helpers.ts';

const HOUR = 60 * 60 * 1000;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

async function get<T>(hub: TestHub, url: string): Promise<{ status: number; body: T }> {
  const res = await hub.app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T };
}

async function putHall(hub: TestHub, body: unknown) {
  const res = await hub.app.inject({
    method: 'PUT',
    url: '/api/hall',
    payload: body as object,
    headers: { 'idempotency-key': randomUUID(), 'x-actor': encodeURIComponent('Управляющий') },
  });
  return { status: res.statusCode, body: res.json() as HallLayoutView & { error?: { code: string; message: string } } };
}

test('a club without a saved plan gets an arrangement of all its tables', async (t) => {
  const hub = await harness(t).start();
  const { body } = await get<HallLayoutView>(hub, '/api/hall');
  assert.equal(body.saved, false);
  assert.equal(body.layout.tables.length, 6);
  assert.equal(body.updatedBy, null);
});

test('a saved plan is returned to every screen and audited', async (t) => {
  const hub = await harness(t).start();
  const events: string[] = [];
  hub.hub.events.on('changed', (e) => events.push(e.kind));
  const { body: initial } = await get<HallLayoutView>(hub, '/api/hall');
  const layout = {
    ...initial.layout,
    tables: initial.layout.tables.map((p, i) => (i === 0 ? { ...p, rotation: 90 as const } : p)),
    landmarks: [{ id: 'bar-1', kind: 'bar', x: 700, y: 60, w: 400, h: 100 }],
  };

  const saved = await putHall(hub, layout);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.saved, true);
  assert.equal(saved.body.updatedBy, 'Управляющий');

  const { body } = await get<HallLayoutView>(hub, '/api/hall');
  assert.deepEqual(body.layout, layout);
  assert.ok(events.includes('layout'));
  const journal = await get<JournalPage>(hub, '/api/journal?category=system');
  assert.equal(journal.body.entries[0]?.action, 'hall.layout_saved');
});

test('a broken plan is rejected with the reason', async (t) => {
  const hub = await harness(t).start();
  const { body: initial } = await get<HallLayoutView>(hub, '/api/hall');
  const res = await putHall(hub, {
    ...initial.layout,
    tables: initial.layout.tables.map((p, i) => (i === 0 ? { ...p, rotation: 45 } : p)).slice(0, 5),
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error?.code, 'LAYOUT_INVALID');
  assert.match(res.body.error?.message ?? '', /rotation must be 0 or 90/);
  assert.match(res.body.error?.message ?? '', /is not placed/);
  assert.equal((await get<HallLayoutView>(hub, '/api/hall')).body.saved, false);
});

test('the journal lists actions newest first, by category and table, page by page', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const t1 = tableId(hub, 'Стол 1');
  const opened = await post(hub, `/api/tables/${t1}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  h.clock.advance(HOUR);
  await post(hub, `/api/sessions/${opened.body.id}/stop`);
  await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`);

  const games = await get<JournalPage>(hub, '/api/journal?category=games');
  assert.deepEqual(
    games.body.entries.map((e) => e.action),
    ['session.open_requested', 'session.stopped', 'session.started', 'session.open_requested'],
  );

  const forTable = await get<JournalPage>(hub, `/api/journal?tableId=${t1}`);
  assert.ok(forTable.body.entries.length > 0);
  assert.ok(forTable.body.entries.every((e) => e.tableId === t1));
  assert.ok(forTable.body.entries.some((e) => e.action === 'lamp.on'));

  const page1 = await get<JournalPage>(hub, '/api/journal?limit=2');
  assert.equal(page1.body.entries.length, 2);
  assert.ok(page1.body.nextBefore);
  const page2 = await get<JournalPage>(hub, `/api/journal?limit=2&before=${page1.body.nextBefore}`);
  assert.ok((page2.body.entries[0]?.id ?? 0) < (page1.body.entries[1]?.id ?? 0));

  // The cash desk has its own filter: shift, check and payment records.
  await post(hub, '/api/shifts/open', { openingFloat: 5000_00 });
  const check = await post(hub, '/api/checks', { sessionIds: [opened.body.id] });
  await post(hub, `/api/checks/${check.body.id}/pay`, { parts: [{ method: 'CASH', amount: 10_000_00 }] });
  const money = await get<JournalPage>(hub, '/api/journal?category=money');
  assert.deepEqual(
    money.body.entries.map((e) => e.action),
    ['check.paid', 'payment.accepted', 'check.created', 'shift.opened'],
  );

  assert.equal((await get(hub, '/api/journal?category=nope')).status, 400);
});

test('history returns games that overlap the period, live ones included', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const first = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, first.body.id) === 'ACTIVE');
  h.clock.advance(HOUR);
  await post(hub, `/api/sessions/${first.body.id}/stop`);
  h.clock.advance(3 * HOUR);
  const second = await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`);

  const all = await get<SessionView[]>(hub, `/api/sessions?from=${MONDAY_NOON - HOUR}&to=${h.clock.now() + HOUR}`);
  assert.deepEqual(all.body.map((s) => s.id), [second.body.id, first.body.id]);

  const later = await get<SessionView[]>(hub, `/api/sessions?from=${MONDAY_NOON + 2 * HOUR}&to=${h.clock.now() + HOUR}`);
  assert.deepEqual(later.body.map((s) => s.id), [second.body.id]);

  assert.equal((await get(hub, `/api/sessions?from=10&to=5`)).status, 400);
  assert.equal((await get(hub, '/api/sessions')).status, 400);
});

test('lamp details show the last command of every table', async (t) => {
  const hub = await harness(t).start();
  hub.driver.offline = true;
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'FAILED');

  const { body } = await get<LampDetail[]>(hub, '/api/lamps');
  assert.equal(body.length, 6);
  const t1 = body.find((l) => l.tableName === 'Стол 1');
  assert.equal(t1?.channel, 'relay-1');
  assert.equal(t1?.lastCommand?.action, 'OFF'); // the safety OFF after the failed ON
  assert.ok(body.filter((l) => l.tableName !== 'Стол 1').every((l) => l.lastCommand?.action === 'OFF'));
});
