/**
 * The PostgreSQL dialect, checked on a real PostgreSQL parser and planner:
 * PGlite (PostgreSQL compiled to WASM, in-process) behind createPostgresDriver.
 * Runs regardless of CLOUD_TEST_DB. The same HUB + owner flow goes through the
 * Fastify app on SQLite and on PGlite; every HTTP answer must be identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent, SyncSnapshotRequest, TariffConfig } from '@bills/domain';
import { migrate } from '../src/db/migrate.ts';
import { seedDemo } from '../src/seed.ts';
import {
  createTestCloud,
  event,
  gameEvents,
  HOUR,
  HUB1,
  HUB2,
  hubGet,
  hubPost,
  login,
  MONDAY_NOON,
  openTestDb,
  ownerGet,
  ownerPut,
  sendEvents,
  tableIdOf,
} from './helpers.ts';
import type { TestCloud, TestDbKind } from './helpers.ts';

const MIN = 60_000;
const NOON = MONDAY_NOON;
const TODAY = '2026-10-12';

const CONFIG: TariffConfig = {
  currency: 'KZT',
  basePricePerHour: 2500_00,
  windows: [{ label: 'Вечер', days: [1, 2, 3, 4, 5], from: '18:00', to: '02:00', pricePerHour: 3500_00 }],
  stepMinutes: 1,
  minimumMinutes: 30,
  freeMinutes: 3,
  roundingMinor: 10_00,
};

const hubEvent = (id: number, at: number, topic: string, data: Record<string, unknown>): SyncEvent =>
  event(id, at, topic, 'hub', data, { actor: 'system', entityType: 'hub' });

function snapshot(settingsVersion: number): SyncSnapshotRequest {
  return {
    hubId: HUB1.id,
    settingsVersion,
    club: { name: 'Клуб «Демо»', timezone: 'Asia/Almaty', currency: 'KZT' },
    tariffs: [{ id: 'hub-tariff-1', name: 'Из HUB', config: CONFIG, isActive: true }],
    tables: [
      { id: 'hub-table-1', name: 'Стол A', kind: 'pool', lampChannel: 'relay-1', defaultTariffId: 'hub-tariff-1', sortOrder: 1, isActive: true },
      { id: 'hub-table-2', name: 'Стол B', kind: 'pool', lampChannel: 'relay-2', defaultTariffId: 'hub-tariff-1', sortOrder: 2, isActive: true },
    ],
  };
}

/** A shift with a paid game, a prepaid game, a check edited in every way, a refund, cash moves, an outage and a Z report. */
function shiftEvents(): SyncEvent[] {
  const t1 = 'hub-table-1';
  const t2 = 'hub-table-2';
  const stop = NOON;
  return [
    hubEvent(1, NOON - 3 * HOUR, 'hub.started', {}),
    event(2, NOON - 2 * HOUR, 'shift.opened', 'shift-1', { number: 1, openingFloat: 5000_00 }),
    ...gameEvents(3, 'g1', t1, NOON - HOUR, stop, 2500_00),
    event(6, stop, 'check.created', 'chk-1', { number: 1, items: [{ itemId: 'i1', sessionId: 'g1', tableId: t1, amount: 2500_00 }] }),
    event(7, stop + 1000, 'check.item_added', 'chk-1', { itemId: 'i2', sessionId: 'g2', tableId: t2, amount: 400_00 }),
    event(8, stop + 2000, 'check.item_removed', 'chk-1', { itemId: 'i2', sessionId: 'g2', tableId: t2, amount: 400_00 }),
    event(9, stop + 3000, 'check.discount_set', 'chk-1', { kind: 'PERCENT', value: 10, amount: 250_00, reason: 'Акция', subtotal: 2500_00 }),
    event(10, stop + 4000, 'check.discount_removed', 'chk-1', {}),
    event(11, stop + 5000, 'check.discount_set', 'chk-1', { kind: 'FIXED', value: 500_00, amount: 500_00, reason: 'Постоянный клиент', subtotal: 2500_00 }),
    event(12, stop + 6000, 'shift.cash_deposited', 'shift-1', { movementId: 'm1', amount: 1000_00, reason: 'размен' }),
    event(13, stop + 7000, 'payment.accepted', 'chk-1', {
      number: 1,
      shiftId: 'shift-1',
      operationId: 'op-1',
      parts: [
        { method: 'CASH', amount: 1000_00, tendered: 1500_00, change: 500_00 },
        { method: 'CARD', amount: 1000_00, tendered: null, change: null },
      ],
      applied: 2000_00,
      change: 500_00,
      remaining: 0,
    }),
    event(14, stop + 7000, 'session.closed', 'g1', { tableId: t1, checkId: 'chk-1' }),
    event(15, stop + 7000, 'check.paid', 'chk-1', { number: 1, shiftId: 'shift-1', subtotal: 2500_00, discount: 500_00, total: 2000_00, paid: 2000_00, sessionIds: ['g1'] }),
    event(16, stop + 8000, 'payment.refunded', 'chk-1', { number: 1, shiftId: 'shift-1', method: 'QR', amount: 300_00, reason: 'Пересчёт', approvedBy: 'Менеджер' }),
    // A prepaid game on table 2 that runs out, with a pause and an outage in the middle.
    event(17, stop + 10 * MIN, 'session.open_requested', 'g2', { tableId: t2, tariffId: 'hub-tariff-1' }),
    event(18, stop + 10 * MIN, 'session.prepaid', 'g2', { tableId: t2, minutes: 60 }),
    event(19, stop + 10 * MIN + 1000, 'session.started', 'g2', { tableId: t2, startedAt: stop + 10 * MIN + 1000 }, { actor: 'system' }),
    hubEvent(20, stop + 20 * MIN, 'power.on_battery', { chargePercent: 80, runtimeSeconds: 1200, status: 'OB' }),
    event(21, stop + 20 * MIN, 'session.paused', 'g2', { tableId: t2, pauseId: 'p1', pausedAt: stop + 20 * MIN, reason: 'power', lamp: 'off' }, { actor: 'system' }),
    hubEvent(22, stop + 20 * MIN, 'power.auto_paused', { sessionIds: ['g2'] }),
    hubEvent(23, stop + 22 * MIN, 'power.critical', { chargePercent: 10, runtimeSeconds: 60, since: stop + 20 * MIN }),
    hubEvent(24, stop + 25 * MIN, 'power.restored', { since: stop + 20 * MIN, outageMs: 5 * MIN, chargePercent: 12, critical: true }),
    event(25, stop + 25 * MIN, 'session.resumed', 'g2', { tableId: t2, pauseId: 'p1', pausedSeconds: 300 }, { actor: 'system' }),
    event(26, stop + 75 * MIN, 'session.stopped', 'g2', {
      tableId: t2,
      startedAt: stop + 10 * MIN + 1000,
      stoppedAt: stop + 75 * MIN,
      playedSeconds: 3600,
      billedSeconds: 3600,
      pausedSeconds: 300,
      amount: 2500_00,
      segments: [],
    }, { actor: 'system' }),
    event(27, stop + 75 * MIN, 'session.prepaid_ended', 'g2', { tableId: t2, minutes: 60 }, { actor: 'system' }),
    // A lamp that failed and an alert about it, resolved later.
    event(28, stop + 80 * MIN, 'lamp.failed', t1, { commandId: 'c1', action: 'ON', attempts: 4, error: 'timeout' }, { actor: 'system' }),
    event(29, stop + 80 * MIN, 'alert.raised', 'alert-1', { kind: 'LAMP_ON_FAILED', tableId: t1, sessionId: 'g3', message: 'Стол A: лампа не подтвердила включение' }, { actor: 'system' }),
    event(30, stop + 81 * MIN, 'alert.raised', 'alert-2', { kind: 'LAMP_OFF_FAILED', tableId: t2, message: 'Стол B: лампа не выключилась' }, { actor: 'system' }),
    event(31, stop + 85 * MIN, 'alert.resolved', 'alert-1', { resolution: 'lamp ok' }, { actor: 'system' }),
    // A cancelled game and a failed one.
    event(32, stop + 90 * MIN, 'session.open_requested', 'g3', { tableId: t1, tariffId: 'hub-tariff-1' }),
    event(33, stop + 91 * MIN, 'session.cancelled', 'g3', { tableId: t1, reason: 'Ошибся столом' }),
    event(34, stop + 92 * MIN, 'session.open_requested', 'g4', { tableId: t1, tariffId: 'hub-tariff-1' }),
    event(35, stop + 93 * MIN, 'session.failed', 'g4', { tableId: t1, error: 'lamp' }, { actor: 'system' }),
    event(36, stop + 94 * MIN, 'unknown.topic', 'x', {}),
    event(37, stop + 95 * MIN, 'shift.cash_withdrawn', 'shift-1', { movementId: 'm2', amount: 300_00, reason: 'инкассация' }),
    event(38, stop + 96 * MIN, 'shift.closed', 'shift-1', {
      number: 1,
      expectedCash: 6700_00,
      countedCash: 6500_00,
      difference: -200_00,
      note: 'не сошлось',
      net: { CASH: 1000_00, CARD: 1000_00, QR: -300_00, total: 1700_00 },
    }),
  ];
}

/** Ids generated by the server (seed tariffs, clubs, owner) differ per run: number them by first appearance. */
function stableIds(value: unknown): unknown {
  const seen = new Map<string, string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string' && uuid.test(v)) {
      let id = seen.get(v);
      if (!id) {
        id = `uuid#${seen.size + 1}`;
        seen.set(v, id);
      }
      return id;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

/** The flow: every answer the cloud gives, in order. */
async function flow(c: TestCloud): Promise<Array<{ step: string; status: number; body: unknown }>> {
  const out: Array<{ step: string; status: number; body: unknown }> = [];
  const record = (step: string, r: { status: number; body: unknown }) => out.push({ step, status: r.status, body: r.body });

  const cookie = await login(c);
  record('me', await ownerGet(c, cookie, '/api/auth/me'));
  const overview0 = await ownerGet<{ clubs: Array<{ id: string; hub: { id: string } | null }> }>(c, cookie, '/api/owner/overview');
  record('overview (empty)', overview0);
  const club1 = overview0.body.clubs.find((x) => x.hub?.id === HUB1.id)!.id;
  const club2 = overview0.body.clubs.find((x) => x.hub?.id === HUB2.id)!.id;

  record('snapshot v0', await hubPost(c, HUB1.key, '/sync/snapshot', snapshot(0)));
  const events = shiftEvents();
  record('events', await sendEvents(c, HUB1, events));
  record('events again', await sendEvents(c, HUB1, events));
  record('events with a duplicate inside', await sendEvents(c, HUB1, [events[0]!, events[0]!]));

  const club2Table = await tableIdOf(c, HUB2.id, 'Стол 1');
  record('club 2 game', await sendEvents(c, HUB2, gameEvents(1, 'n1', club2Table, NOON - 2 * HOUR, NOON, 4000_00)));
  c.clock.advance(2 * HOUR);

  record('overview', await ownerGet(c, cookie, '/api/owner/overview'));
  record('club 1', await ownerGet(c, cookie, `/api/owner/clubs/${club1}`));
  record('club 2', await ownerGet(c, cookie, `/api/owner/clubs/${club2}`));
  record('club 1 sessions today', await ownerGet(c, cookie, `/api/owner/clubs/${club1}/sessions?day=${TODAY}`));
  record('club 1 sessions default day', await ownerGet(c, cookie, `/api/owner/clubs/${club1}/sessions`));
  record('club 1 sessions yesterday', await ownerGet(c, cookie, `/api/owner/clubs/${club1}/sessions?day=2026-10-11`));
  record('club 1 sessions bad day', await ownerGet(c, cookie, `/api/owner/clubs/${club1}/sessions?day=12.10.2026`));

  record('settings since 0', await hubGet(c, HUB1.key, `/sync/settings?since=0&hubId=${HUB1.id}`));
  record(
    'tariffs update',
    await ownerPut(c, cookie, `/api/owner/clubs/${club1}/tariffs`, {
      tariffs: [
        { id: 'hub-tariff-1', name: 'Стандарт+', config: { ...CONFIG, basePricePerHour: 3000_00 }, isActive: true },
        { name: 'VIP', config: { ...CONFIG, basePricePerHour: 9000_00 }, isActive: false },
      ],
    }),
  );
  record('tariffs invalid', await ownerPut(c, cookie, `/api/owner/clubs/${club1}/tariffs`, { tariffs: [{ name: '', config: CONFIG, isActive: true }] }));
  record('overview pending settings', await ownerGet(c, cookie, '/api/owner/overview'));
  record('empty batch', await sendEvents(c, HUB1, [], 0));
  record('settings since 0 after update', await hubGet(c, HUB1.key, '/sync/settings?since=0'));
  record('settings since 1', await hubGet(c, HUB1.key, '/sync/settings?since=1'));
  record('stale snapshot', await hubPost(c, HUB1.key, '/sync/snapshot', snapshot(0)));
  record('current snapshot', await hubPost(c, HUB1.key, '/sync/snapshot', snapshot(1)));
  c.clock.advance(MIN);
  record('club 1 after settings', await ownerGet(c, cookie, `/api/owner/clubs/${club1}`));
  record('wrong hub key', await hubPost(c, HUB2.key, '/sync/events', { hubId: HUB1.id, settingsVersion: 0, events: [] }));
  record('unknown club', await ownerGet(c, cookie, '/api/owner/clubs/no-such-club'));

  const logout = await c.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
  record('logout', { status: logout.statusCode, body: logout.json() });
  record('me after logout', await ownerGet(c, cookie, '/api/auth/me'));
  return out;
}

async function runFlow(kind: TestDbKind) {
  const c = await createTestCloud(kind);
  try {
    return stableIds(await flow(c)) as Array<{ step: string; status: number; body: unknown }>;
  } finally {
    await c.close();
  }
}

test('the same HUB + owner flow answers identically on SQLite and on PostgreSQL (PGlite)', async () => {
  const sqlite = await runFlow('sqlite');
  const pglite = await runFlow('pglite');
  assert.deepEqual(
    pglite.map((s) => [s.step, s.status]),
    sqlite.map((s) => [s.step, s.status]),
  );
  for (let i = 0; i < sqlite.length; i++) assert.deepEqual(pglite[i], sqlite[i], `step "${sqlite[i]?.step}"`);
  // The flow did real work, not a row of errors.
  const statuses = new Map(sqlite.map((s) => [s.step, s.status]));
  assert.equal(statuses.get('events'), 200);
  assert.equal(statuses.get('overview'), 200);
  assert.equal(statuses.get('tariffs update'), 200);
  assert.equal(statuses.get('tariffs invalid'), 400);
  assert.equal(statuses.get('me after logout'), 401);
});

test('PostgreSQL: migrations and seed are idempotent; counts and sums come back as numbers', async () => {
  const db = await openTestDb('pglite');
  try {
    assert.deepEqual(await migrate(db, NOON), ['001_init.sql', '002_money.sql']);
    assert.deepEqual(await migrate(db, NOON), []);
    assert.equal(await seedDemo(db, NOON), true);
    assert.equal(await seedDemo(db, NOON), false);
    // COUNT → bigint, SUM(integer) → bigint, SUM(bigint) → numeric, MAX(bigint) → bigint.
    const [row] = await db.all<Record<string, unknown>>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(settings_version), 0) AS v, SUM(created_at) AS s, MAX(created_at) AS m FROM hubs',
    );
    assert.deepEqual(row, { n: 2, v: 0, s: 2 * NOON, m: NOON });
  } finally {
    await db.close();
  }
});

test('PostgreSQL: concurrent batches from two HUBs serialise into whole transactions', async () => {
  const c = await createTestCloud('pglite');
  try {
    const t1 = await tableIdOf(c, HUB1.id, 'Стол 1');
    const t2 = await tableIdOf(c, HUB2.id, 'Стол 1');
    const batches = [];
    for (let i = 0; i < 5; i++) {
      batches.push(sendEvents(c, HUB1, gameEvents(1 + i * 3, `a${i}`, t1, NOON - HOUR + i * MIN, NOON + i * MIN, 2000_00)));
      batches.push(sendEvents(c, HUB2, gameEvents(1 + i * 3, `b${i}`, t2, NOON - HOUR + i * MIN, NOON + i * MIN, 1000_00)));
    }
    const results = await Promise.all(batches);
    assert.deepEqual(results.map((r) => r.status), Array(10).fill(200));
    assert.deepEqual(results.map((r) => r.body.inserted), Array(10).fill(3));
    const totals = await c.db.all<{ hub_id: string; n: number; last: number }>(
      'SELECT hub_id, COUNT(*) AS n, MAX(outbox_id) AS last FROM events GROUP BY hub_id ORDER BY hub_id',
    );
    assert.deepEqual(totals, [
      { hub_id: HUB1.id, n: 15, last: 15 },
      { hub_id: HUB2.id, n: 15, last: 15 },
    ]);
    const stats = await c.db.all<{ revenue: number; games: number }>('SELECT revenue, games FROM daily_stats ORDER BY revenue');
    assert.deepEqual(stats, [
      { revenue: 5000_00, games: 5 },
      { revenue: 10_000_00, games: 5 },
    ]);
  } finally {
    await c.close();
  }
});
