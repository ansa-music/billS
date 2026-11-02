import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { TrialStats, TrialSummary, TrialView } from '@bills/domain';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PAID_ENDED_MESSAGE, PAID_FOREVER_AT, TRIAL_ENDED_MESSAGE, TRIAL_EXPIRED_MESSAGE, TRIAL_MOVED_MESSAGE, TRIAL_SNAPSHOT_MAX_BYTES } from '@bills/domain';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { handleTrial } from '../../apps/cloud/src/edge/trial.ts';
import { DEMO_PLATFORM } from '../../apps/cloud/src/seed.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, HOUR, linkOwner, MONDAY_NOON, userJwt } from './edge-helpers.ts';

const DAY = 24 * HOUR;
/** What a trial's terms carry besides status and end, for a trial plan without a copy. */
const PLAIN = { plan: 'trial', paidUntil: null, snapshotAt: null } as const;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const STATS: TrialStats = {
  ordersTotal: 7,
  ordersToday: 2,
  revenueTotal: 15_400,
  revenueToday: 4_200,
  productsCount: 12,
  staffCount: 2,
  shiftOpen: true,
  lastOrderAt: MONDAY_NOON - HOUR,
  days: [
    { day: '2026-10-11', orders: 5, revenue: 11_200 },
    { day: '2026-10-12', orders: 2, revenue: 4_200 },
  ],
  appVersion: 'trial-1',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, apikey, x-client-info',
};

function assertCors(headers: Headers, what: string) {
  for (const [k, v] of Object.entries(CORS)) assert.equal(headers.get(k), v, `${what}: ${k}`);
}

async function start(e: EdgeTest, body: Record<string, unknown> = { venue: '  Кофейня «Зерно»  ', managerName: 'Айгерим', timezone: 'Asia/Almaty' }, ip = '198.51.100.4') {
  const res = await e.call(handleTrial, 'POST', '/functions/v1/trial/trial/start', { headers: { 'x-forwarded-for': ip }, body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id as string, token: res.body.token as string, auth: { authorization: `Bearer ${res.body.token}` }, body: res.body };
}

async function platformToken(e: EdgeTest, key: string): Promise<Record<string, string>> {
  const r = await e.call(handlePlatform, 'POST', '/platform/login', { body: { key } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { authorization: `Bearer ${r.body.token}` };
}

test('trial: start → report → terms; the token is stored only as sha256', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  assert.match(s.id, /^[0-9a-f-]{36}$/);
  assert.match(s.token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.deepEqual(s.body, { id: s.id, token: s.token, startedAt: MONDAY_NOON, endsAt: MONDAY_NOON + 14 * DAY, status: 'active' });
  const [row] = await e.s.db.all<{ token_hash: string; venue: string; created_ip: string; status: string }>(
    'SELECT token_hash, venue, created_ip, status FROM trials WHERE id = ?::uuid',
    [s.id],
  );
  assert.deepEqual(row, { token_hash: sha(s.token), venue: 'Кофейня «Зерно»', created_ip: '198.51.100.4', status: 'active' });

  e.clock.now += HOUR;
  const rep = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: { ...STATS, junk: 1 } } });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.deepEqual(rep.body, { status: 'active', endsAt: MONDAY_NOON + 14 * DAY, ...PLAIN });
  assert.equal(rep.headers.get('cache-control'), 'no-store');
  assertCors(rep.headers, 'report');

  e.clock.now += HOUR;
  const terms = await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth });
  assert.equal(terms.status, 200);
  assert.deepEqual(terms.body, { status: 'active', endsAt: MONDAY_NOON + 14 * DAY, ...PLAIN });

  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const list = await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/platform/trials', { headers: owner });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.trials, [
    {
      id: s.id,
      venue: 'Кофейня «Зерно»',
      managerName: 'Айгерим',
      startedAt: MONDAY_NOON,
      endsAt: MONDAY_NOON + 14 * DAY,
      status: 'active',
      lastSeenAt: MONDAY_NOON + 2 * HOUR,
      stats: STATS,
      snapshotAt: null,
      snapshotBytes: null,
      plan: 'trial',
      paidUntil: null,
      summaryAt: null,
      viewLink: false,
    },
  ]);
});

test('trial: bad input, bad token (401), unknown id (404), stats validation, CORS on OPTIONS and on errors', async (t) => {
  const e = await edgeTest(t);
  const pre = await e.call(handleTrial, 'OPTIONS', '/trial/report');
  assert.equal(pre.status, 204);
  assertCors(pre.headers, 'OPTIONS');

  for (const venue of ['', '   ', 'x'.repeat(81), 5]) {
    const r = await e.call(handleTrial, 'POST', '/trial/start', { body: { venue } });
    assert.equal(r.status, 422, String(venue));
    assert.equal(r.body.error.code, 'VENUE_INVALID');
    assertCors(r.headers, '422');
  }
  assert.equal((await e.call(handleTrial, 'POST', '/trial/start', { body: { venue: 'x'.repeat(80) } })).status, 201);

  const s = await start(e);
  const noToken = await e.call(handleTrial, 'POST', '/trial/report', { body: { id: s.id, stats: STATS } });
  assert.equal(noToken.status, 401);
  assertCors(noToken.headers, '401');
  const wrong = await e.call(handleTrial, 'POST', '/trial/report', { headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` }, body: { id: s.id, stats: STATS } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'UNAUTHORIZED');
  assertCors(wrong.headers, '401');
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: { authorization: 'Bearer nope' } })).status, 401);

  // Another trial's token does not open this one.
  const other = await start(e, { venue: 'Другая' });
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: other.auth })).status, 401);

  for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
    const r = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id, stats: STATS } });
    assert.equal(r.status, 404, id);
    assert.equal(r.body.error.code, 'TRIAL_NOT_FOUND');
    assertCors(r.headers, '404');
  }
  assert.equal((await e.call(handleTrial, 'GET', '/trial/terms', { headers: s.auth })).status, 404);

  const bad = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: { ...STATS, ordersTotal: -1 } } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'STATS_INVALID');
  const badSnap = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, snapshot: 'не base64!' } });
  assert.equal(badSnap.status, 422);
  assert.equal(badSnap.body.error.code, 'SNAPSHOT_INVALID');
  const nothing = await e.call(handleTrial, 'GET', '/trial/nothing');
  assert.equal(nothing.status, 404);
  assertCors(nothing.headers, 'unknown route');
});

test('trial: rate limits — 10 starts an hour per IP, 120 reports an hour per trial', async (t) => {
  const e = await edgeTest(t);
  for (let i = 0; i < 10; i++) await start(e, { venue: `К${i}` }, '203.0.113.9');
  const over = await e.call(handleTrial, 'POST', '/trial/start', { headers: { 'x-forwarded-for': '203.0.113.9' }, body: { venue: 'Ещё' } });
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, 'RATE_LIMITED');
  assertCors(over.headers, '429');
  await start(e, { venue: 'Соседи' }, '203.0.113.10');
  e.clock.now += HOUR + 1;
  const s = await start(e, { venue: 'Через час' }, '203.0.113.9');

  for (let i = 0; i < 120; i++) {
    const r = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS } });
    assert.equal(r.status, 200, `report ${i}`);
  }
  const tooMany = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS } });
  assert.equal(tooMany.status, 429);
});

test('trial: expired is computed; the platform owner extends and ends; a non-platform caller is refused', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);

  // Refused: no session, a client's manager (Supabase JWT, not on the platform team), the trial's own token.
  const uid = await linkOwner(e.s);
  for (const headers of [{}, { authorization: `Bearer ${userJwt(uid)}` }, s.auth]) {
    for (const [method, path, body] of [
      ['GET', '/platform/trials', undefined],
      ['POST', `/platform/trials/${s.id}/extend`, { days: 7 }],
      ['POST', `/platform/trials/${s.id}/end`, undefined],
      ['GET', `/platform/trials/${s.id}/snapshot`, undefined],
    ] as const) {
      const r = await e.call(handlePlatform, method, path, { headers, ...(body ? { body } : {}) });
      assert.equal(r.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
    }
  }
  const [still] = await e.s.db.all<{ status: string }>('SELECT status FROM trials WHERE id = ?::uuid', [s.id]);
  assert.equal(still!.status, 'active');

  e.clock.now = MONDAY_NOON + 14 * DAY;
  const expired = await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth });
  assert.deepEqual(expired.body, { status: 'expired', endsAt: MONDAY_NOON + 14 * DAY, message: TRIAL_EXPIRED_MESSAGE, ...PLAIN });
  const rep = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS } });
  assert.equal(rep.status, 200, 'an expired trial still reports');
  assert.equal(rep.body.status, 'expired');

  for (const days of [0, 91, 1.5, '7x', null]) {
    const r = await e.call(handlePlatform, 'POST', `/platform/trials/${s.id}/extend`, { headers: owner, body: { days } });
    assert.equal(r.status, 422, String(days));
    assert.equal(r.body.error.code, 'DAYS_INVALID');
  }
  assert.equal((await e.call(handlePlatform, 'POST', '/platform/trials/00000000-0000-4000-8000-000000000000/extend', { headers: owner, body: { days: 7 } })).status, 404);

  // Ten days after the end: max(endsAt, now) + 7 days.
  e.clock.now = MONDAY_NOON + 24 * DAY;
  const ext = await e.call<TrialView>(handlePlatform, 'POST', `/platform/platform/trials/${s.id}/extend`, { headers: owner, body: { days: 7 } });
  assert.equal(ext.status, 200, JSON.stringify(ext.body));
  assert.equal(ext.body.status, 'active');
  assert.equal(ext.body.endsAt, MONDAY_NOON + 31 * DAY);
  // Before the end: added to endsAt.
  const ext2 = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${s.id}/extend`, { headers: owner, body: { days: 3 } });
  assert.equal(ext2.body.endsAt, MONDAY_NOON + 34 * DAY);
  assert.deepEqual((await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth })).body, { status: 'active', endsAt: MONDAY_NOON + 34 * DAY, ...PLAIN });
  assert.ok(e.log.some((l) => l.includes('продлил') && l.includes(s.id)));

  // The support team (tech) has the same rights as for client licenses.
  const tech = await platformToken(e, DEMO_PLATFORM[1].key);
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/trials', { headers: tech })).body.trials.length, 1);

  e.clock.now += HOUR;
  const ended = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${s.id}/end`, { headers: owner });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body.status, 'ended');
  assert.equal(ended.body.endsAt, e.clock.now);
  assert.ok(e.log.some((l) => l.includes('завершил') && l.includes(s.id)));
  const terms = await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth });
  assert.deepEqual(terms.body, { status: 'ended', endsAt: e.clock.now, message: TRIAL_ENDED_MESSAGE, ...PLAIN });

  // Extending an ended trial makes it active again.
  const back = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${s.id}/extend`, { headers: owner, body: { days: 1 } });
  assert.equal(back.body.status, 'active');
  assert.equal(back.body.endsAt, e.clock.now + DAY);
});

test('trial: the snapshot goes up with a report and comes back to the platform byte for byte; newest trials first', async (t) => {
  const e = await edgeTest(t);
  const first = await start(e, { venue: 'Первая' });
  e.clock.now += HOUR;
  const s = await start(e, { venue: 'Вторая' });
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);

  const none = await e.call(handlePlatform, 'GET', `/platform/trials/${s.id}/snapshot`, { headers: owner });
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, 'SNAPSHOT_NOT_FOUND');
  assert.equal((await e.call(handlePlatform, 'GET', '/platform/trials/not-a-uuid/snapshot', { headers: owner })).status, 404);

  const bytes = Buffer.concat([Buffer.from('SQLite format 3\0'), randomBytes(200_000)]);
  const snapshot = bytes.toString('base64');
  e.clock.now += HOUR;
  const rep = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, snapshot } });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  const snapAt = e.clock.now;

  const got = await e.call(handlePlatform, 'GET', `/platform/trials/${s.id}/snapshot`, { headers: owner });
  assert.equal(got.status, 200);
  assert.equal(got.body.snapshotAt, snapAt);
  assert.ok(Buffer.from(got.body.snapshot, 'base64').equals(bytes));
  assert.equal(got.body.snapshot, snapshot);

  // A later report without a snapshot keeps the last one.
  e.clock.now += HOUR;
  await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: { ...STATS, ordersTotal: 8 } } });
  const list = await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/trials', { headers: owner });
  assert.deepEqual(list.body.trials.map((v) => v.venue), ['Вторая', 'Первая']);
  const view = list.body.trials[0]!;
  assert.equal(view.snapshotAt, snapAt);
  assert.equal(view.snapshotBytes, bytes.length);
  assert.equal(view.stats!.ordersTotal, 8);
  assert.equal(view.lastSeenAt, e.clock.now);
  assert.equal(list.body.trials[1]!.id, first.id);
  assert.equal(list.body.trials[1]!.stats, null);

  // Over 6 MB decoded: 413, nothing stored.
  const big = Buffer.alloc(TRIAL_SNAPSHOT_MAX_BYTES + 3).toString('base64');
  const tooBig = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, snapshot: big } });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.error.code, 'SNAPSHOT_TOO_LARGE');
  // Exactly 6 MB fits the body limit of the report.
  const max = Buffer.alloc(TRIAL_SNAPSHOT_MAX_BYTES, 7);
  const ok = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, snapshot: max.toString('base64') } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [stored] = await e.s.db.all<{ n: number }>('SELECT snapshot_bytes AS n FROM trials WHERE id = ?::uuid', [s.id]);
  assert.equal(stored!.n, TRIAL_SNAPSHOT_MAX_BYTES);
});

const SUMMARY: TrialSummary = {
  at: MONDAY_NOON,
  currency: 'KZT',
  timezone: 'Asia/Almaty',
  date: '2026-10-12',
  revenueToday: 4_200,
  revenue7: 15_400,
  revenue30: 15_400,
  checksToday: 2,
  avgCheckToday: 2_100,
  topToday: [
    { name: 'Капучино', qty: 3, revenue: 2_700 },
    { name: 'Круассан', qty: 1, revenue: 1_500 },
  ],
  methodsToday: { cash: 1_500, card: 2_700, qr: 0 },
  shiftOpen: true,
  lastActivityAt: MONDAY_NOON - HOUR,
  days: [{ day: '2026-10-12', revenue: 4_200 }],
};

test('trial: «Сделать постоянной» — paid until a date or without an end, «Продлить до…», back to a trial; the cash register learns it', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const uid = await linkOwner(e.s);
  for (const headers of [{}, { authorization: `Bearer ${userJwt(uid)}` }, s.auth]) {
    const r = await e.call(handlePlatform, 'POST', `/platform/trials/${s.id}/plan`, { headers, body: { plan: 'paid', paidUntil: null } });
    assert.equal(r.status, 401);
  }
  for (const body of [{}, { plan: 'gold' }, { plan: 'paid', paidUntil: MONDAY_NOON - 1 }, { plan: 'paid', paidUntil: MONDAY_NOON + 3661 * DAY }, { plan: 'paid', paidUntil: 'x' }, { plan: 'trial', days: 0 }]) {
    const r = await e.call(handlePlatform, 'POST', `/platform/trials/${s.id}/plan`, { headers: owner, body });
    assert.equal(r.status, 422, JSON.stringify(body));
  }

  // Paid until 12 December (end of that day).
  const until = MONDAY_NOON + 60 * DAY;
  const paid = await e.call<TrialView>(handlePlatform, 'POST', `/platform/platform/trials/${s.id}/plan`, { headers: owner, body: { plan: 'paid', paidUntil: until } });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.plan, 'paid');
  assert.equal(paid.body.paidUntil, until);
  assert.equal(paid.body.endsAt, until);
  assert.equal(paid.body.status, 'active');
  assert.ok(e.log.some((l) => l.includes('сделал постоянной') && l.includes(s.id)));
  const rep = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS } });
  assert.deepEqual(rep.body, { status: 'active', endsAt: until, plan: 'paid', paidUntil: until, snapshotAt: null });

  // «Продлить до…» a later date, and by days.
  const later = until + 30 * DAY;
  const ext = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${s.id}/extend`, { headers: owner, body: { until: later } });
  assert.equal(ext.status, 200, JSON.stringify(ext.body));
  assert.equal(ext.body.paidUntil, later);
  assert.equal(ext.body.endsAt, later);
  const ext7 = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${s.id}/extend`, { headers: owner, body: { days: 7 } });
  assert.equal(ext7.body.paidUntil, later + 7 * DAY);

  // The paid period ends: the trial is over with the paid words.
  e.clock.now = later + 7 * DAY;
  const over = await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth });
  assert.deepEqual(over.body, { status: 'expired', endsAt: later + 7 * DAY, message: PAID_ENDED_MESSAGE, plan: 'paid', paidUntil: later + 7 * DAY, snapshotAt: null });

  // Without an end: endsAt = 2100; extending has nothing to do. (Months later: a new sign-in.)
  Object.assign(owner, await platformToken(e, DEMO_PLATFORM[0].key));
  const forever = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${s.id}/plan`, { headers: owner, body: { plan: 'paid', paidUntil: null } });
  assert.equal(forever.body.status, 'active');
  assert.equal(forever.body.paidUntil, null);
  assert.equal(forever.body.endsAt, PAID_FOREVER_AT);
  const noEnd = await e.call(handlePlatform, 'POST', `/platform/trials/${s.id}/extend`, { headers: owner, body: { days: 7 } });
  assert.equal(noEnd.status, 409);
  assert.equal(noEnd.body.error.code, 'PAID_NO_END');
  const terms = await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth });
  assert.deepEqual(terms.body, { status: 'active', endsAt: PAID_FOREVER_AT, plan: 'paid', paidUntil: null, snapshotAt: null });

  // Ending a permanent one: read-only with the paid words.
  const ended = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${s.id}/end`, { headers: owner });
  assert.equal(ended.body.status, 'ended');
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth })).body.message, PAID_ENDED_MESSAGE);

  // Back to a trial for 14 days.
  const back = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${s.id}/plan`, { headers: owner, body: { plan: 'trial', days: 14 } });
  assert.equal(back.body.plan, 'trial');
  assert.equal(back.body.paidUntil, null);
  assert.equal(back.body.status, 'active');
  assert.equal(back.body.endsAt, e.clock.now + 14 * DAY);

  // A trial's «Продлить до…»: at most 90 days past its end.
  const tooFar = await e.call(handlePlatform, 'POST', `/platform/trials/${s.id}/extend`, { headers: owner, body: { until: e.clock.now + 105 * DAY } });
  assert.equal(tooFar.status, 422);
  assert.equal(tooFar.body.error.code, 'UNTIL_INVALID');
  const okUntil = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${s.id}/extend`, { headers: owner, body: { until: e.clock.now + 30 * DAY } });
  assert.equal(okUntil.body.endsAt, e.clock.now + 30 * DAY);
});

test('trial: a gzip copy and the owner summary are kept (the latest one); terms tell when the copy came', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const db = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(300_000, 1)]);
  const gz = gzipSync(db);
  assert.ok(gz.length < 10_000, 'compresses');
  e.clock.now += HOUR;
  const r = await e.call(handleTrial, 'POST', '/trial/report', {
    headers: s.auth,
    body: { id: s.id, stats: STATS, snapshot: gz.toString('base64'), snapshotEncoding: 'gzip', summary: { ...SUMMARY, extra: 1 } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.snapshotAt, e.clock.now);
  const snapAt = e.clock.now;
  const got = await e.call(handlePlatform, 'GET', `/platform/trials/${s.id}/snapshot`, { headers: owner });
  assert.equal(got.body.encoding, 'gzip');
  assert.ok(gunzipSync(Buffer.from(got.body.snapshot, 'base64')).equals(db));
  const [row] = await e.s.db.all<{ summary: TrialSummary; bytes: number }>('SELECT summary, snapshot_bytes AS bytes FROM trials WHERE id = ?::uuid', [s.id]);
  assert.deepEqual(row!.summary, SUMMARY, 'unknown fields dropped');
  assert.equal(row!.bytes, gz.length);

  // A newer copy replaces it; a report without a copy keeps it.
  e.clock.now += HOUR;
  const raw = Buffer.from('SQLite format 3\0second');
  await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, snapshot: raw.toString('base64') } });
  const got2 = await e.call(handlePlatform, 'GET', `/platform/trials/${s.id}/snapshot`, { headers: owner });
  assert.equal(got2.body.encoding, 'raw');
  assert.ok(Buffer.from(got2.body.snapshot, 'base64').equals(raw));
  assert.notEqual(got2.body.snapshotAt, snapAt);
  e.clock.now += HOUR;
  const keep = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS } });
  assert.equal(keep.body.snapshotAt, e.clock.now - HOUR);

  // Bad encodings and summaries.
  const notGzip = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, snapshot: raw.toString('base64'), snapshotEncoding: 'gzip' } });
  assert.equal(notGzip.status, 422);
  const badEnc = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, snapshot: raw.toString('base64'), snapshotEncoding: 'zip' } });
  assert.equal(badEnc.status, 422);
  const badSummary = await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, summary: { ...SUMMARY, topToday: new Array(6).fill(SUMMARY.topToday[0]) } } });
  assert.equal(badSummary.status, 422);
  assert.equal(badSummary.body.error.code, 'SUMMARY_INVALID');
  const list = await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/trials', { headers: owner });
  assert.equal(list.body.trials[0]!.summaryAt, snapAt);
});

test('trial: transfer — a code for the trial, the copy and a new token for the new device, the old device hears TRIAL_MOVED', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  // No copy yet: no code.
  const early = await e.call(handleTrial, 'POST', '/trial/transfer-code', { headers: s.auth, body: { id: s.id } });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'NO_SNAPSHOT');
  assert.equal((await e.call(handleTrial, 'POST', '/trial/transfer-code', { body: { id: s.id } })).status, 401);

  const db = gzipSync(Buffer.from('SQLite format 3\0the coffee shop'));
  await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, snapshot: db.toString('base64'), snapshotEncoding: 'gzip' } });
  const c1 = await e.call(handleTrial, 'POST', '/trial/transfer-code', { headers: s.auth, body: { id: s.id } });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.match(c1.body.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.equal(c1.body.expiresAt, MONDAY_NOON + 24 * HOUR);
  const [stored] = await e.s.db.all<{ h: string }>('SELECT transfer_code_hash AS h FROM trials WHERE id = ?::uuid', [s.id]);
  assert.equal(stored!.h, sha(`ts-transfer:${c1.body.code.replace('-', '')}`), 'only the hash is kept');
  // A new code replaces the old one.
  const c2 = await e.call(handleTrial, 'POST', '/trial/transfer-code', { headers: s.auth, body: { id: s.id } });
  const ip = { 'x-forwarded-for': '192.0.2.50' };
  const stale = await e.call(handleTrial, 'POST', '/trial/transfer', { headers: ip, body: { code: c1.body.code } });
  if (c1.body.code !== c2.body.code) assert.equal(stale.status, 404);

  // Lower case and spaces are fine.
  const code = (c2.body.code as string).toLowerCase().replace('-', ' ');
  const moved = await e.call(handleTrial, 'POST', '/trial/transfer', { headers: ip, body: { code } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.id, s.id);
  assert.notEqual(moved.body.token, s.token);
  assert.equal(moved.body.venue, 'Кофейня «Зерно»');
  assert.equal(moved.body.managerName, 'Айгерим');
  assert.equal(moved.body.snapshotEncoding, 'gzip');
  assert.ok(Buffer.from(moved.body.snapshot, 'base64').equals(db));
  assert.equal(moved.body.terms.status, 'active');
  assertCors(moved.headers, 'transfer');
  assert.ok(e.log.some((l) => l.includes('перенесена') && l.includes(s.id)));

  // The code is used once; the old device is told the coffee shop moved; the new token works.
  assert.equal((await e.call(handleTrial, 'POST', '/trial/transfer', { headers: ip, body: { code } })).status, 404);
  for (const [method, path, body] of [
    ['POST', '/trial/report', { id: s.id, stats: STATS }],
    ['GET', `/trial/terms?id=${s.id}`, undefined],
    ['POST', '/trial/transfer-code', { id: s.id }],
  ] as const) {
    const r = await e.call(handleTrial, method, path, { headers: s.auth, ...(body ? { body } : {}) });
    assert.equal(r.status, 409, path);
    assert.equal(r.body.error.code, 'TRIAL_MOVED');
    assert.equal(r.body.error.message, TRIAL_MOVED_MESSAGE);
  }
  const fresh = { authorization: `Bearer ${moved.body.token}` };
  assert.equal((await e.call(handleTrial, 'POST', '/trial/report', { headers: fresh, body: { id: s.id, stats: STATS } })).status, 200);

  // The moved token of one trial does not say «moved» for another.
  const other = await start(e, { venue: 'Другая' });
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${other.id}`, { headers: s.auth })).status, 401);

  // A code lives 24 hours.
  const c3 = await e.call(handleTrial, 'POST', '/trial/transfer-code', { headers: fresh, body: { id: s.id } });
  e.clock.now += 24 * HOUR;
  const late = await e.call(handleTrial, 'POST', '/trial/transfer', { headers: { 'x-forwarded-for': '192.0.2.51' }, body: { code: c3.body.code } });
  assert.equal(late.status, 404);
  assert.equal(late.body.error.code, 'TRANSFER_CODE_INVALID');
});

test('trial: transfer codes are rate-limited — 10 attempts an hour per address, right or wrong', async (t) => {
  const e = await edgeTest(t);
  const ip = { 'x-forwarded-for': '198.51.100.77' };
  for (let i = 0; i < 10; i++) {
    const r = await e.call(handleTrial, 'POST', '/trial/transfer', { headers: ip, body: { code: i % 2 ? 'ABCD-EFGH' : 'nonsense' } });
    assert.equal(r.status, 404, `attempt ${i}`);
  }
  const over = await e.call(handleTrial, 'POST', '/trial/transfer', { headers: ip, body: { code: 'ABCD-EFGH' } });
  assert.equal(over.status, 429);
  assert.equal(over.body.error.code, 'RATE_LIMITED');
  assert.equal((await e.call(handleTrial, 'POST', '/trial/transfer', { headers: { 'x-forwarded-for': '198.51.100.78' }, body: { code: 'ABCD-EFGH' } })).status, 404);
  e.clock.now += HOUR + 1;
  assert.equal((await e.call(handleTrial, 'POST', '/trial/transfer', { headers: ip, body: { code: 'ABCD-EFGH' } })).status, 404);
});

test('trial: the phone link — its own token shows only the summary; a new link or «выключить» stops the old one', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  assert.equal((await e.call(handleTrial, 'POST', '/trial/view-link', { body: { id: s.id } })).status, 401);
  const l1 = await e.call(handleTrial, 'POST', '/trial/view-link', { headers: s.auth, body: { id: s.id } });
  assert.equal(l1.status, 200, JSON.stringify(l1.body));
  assert.match(l1.body.token, /^[A-Za-z0-9_-]{32}$/);
  const v1 = { authorization: `Bearer ${l1.body.token}` };

  // Before the first summary: the page says «no numbers yet».
  const empty = await e.call(handleTrial, 'GET', '/trial/view', { headers: v1 });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(empty.body, { venue: 'Кофейня «Зерно»', summary: null, summaryAt: null, lastSeenAt: MONDAY_NOON, plan: 'trial', status: 'active' });

  e.clock.now += HOUR;
  await e.call(handleTrial, 'POST', '/trial/report', { headers: s.auth, body: { id: s.id, stats: STATS, summary: SUMMARY, snapshot: Buffer.from('SQLite').toString('base64') } });
  const view = await e.call(handleTrial, 'GET', '/trial/view', { headers: v1 });
  assert.deepEqual(view.body, { venue: 'Кофейня «Зерно»', summary: SUMMARY, summaryAt: e.clock.now, lastSeenAt: e.clock.now, plan: 'trial', status: 'active' });
  assertCors(view.headers, 'view');
  assert.equal(view.headers.get('cache-control'), 'no-store');
  assert.equal((await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/trials', { headers: owner })).body.trials[0]!.viewLink, true);

  // The write token is not a view token, and the view token writes nothing.
  assert.equal((await e.call(handleTrial, 'GET', '/trial/view', { headers: s.auth })).status, 404);
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: v1 })).status, 401);
  assert.equal((await e.call(handleTrial, 'POST', '/trial/report', { headers: v1, body: { id: s.id, stats: STATS } })).status, 401);
  assert.equal((await e.call(handleTrial, 'GET', '/trial/view')).status, 404);

  // A new link: the old one stops.
  const l2 = await e.call(handleTrial, 'POST', '/trial/view-link', { headers: s.auth, body: { id: s.id } });
  assert.notEqual(l2.body.token, l1.body.token);
  const gone = await e.call(handleTrial, 'GET', '/trial/view', { headers: v1 });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, 'VIEW_NOT_FOUND');
  const v2 = { authorization: `Bearer ${l2.body.token}` };
  assert.equal((await e.call(handleTrial, 'GET', '/trial/view', { headers: v2 })).status, 200);

  // A transfer keeps the phone link.
  const code = await e.call(handleTrial, 'POST', '/trial/transfer-code', { headers: s.auth, body: { id: s.id } });
  const moved = await e.call(handleTrial, 'POST', '/trial/transfer', { body: { code: code.body.code } });
  assert.equal((await e.call(handleTrial, 'GET', '/trial/view', { headers: v2 })).status, 200);

  // Off.
  const off = await e.call(handleTrial, 'POST', '/trial/view-link', { headers: { authorization: `Bearer ${moved.body.token}` }, body: { id: s.id, off: true } });
  assert.deepEqual(off.body, { token: null });
  assert.equal((await e.call(handleTrial, 'GET', '/trial/view', { headers: v2 })).status, 404);
});
