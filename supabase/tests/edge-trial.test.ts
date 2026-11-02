import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { TrialStats, TrialView } from '@bills/domain';
import { TRIAL_ENDED_MESSAGE, TRIAL_EXPIRED_MESSAGE, TRIAL_SNAPSHOT_MAX_BYTES } from '@bills/domain';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { handleTrial } from '../../apps/cloud/src/edge/trial.ts';
import { DEMO_PLATFORM } from '../../apps/cloud/src/seed.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, HOUR, linkOwner, MONDAY_NOON, userJwt } from './edge-helpers.ts';

const DAY = 24 * HOUR;
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
  assert.deepEqual(rep.body, { status: 'active', endsAt: MONDAY_NOON + 14 * DAY });
  assert.equal(rep.headers.get('cache-control'), 'no-store');
  assertCors(rep.headers, 'report');

  e.clock.now += HOUR;
  const terms = await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth });
  assert.equal(terms.status, 200);
  assert.deepEqual(terms.body, { status: 'active', endsAt: MONDAY_NOON + 14 * DAY });

  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const list = await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/platform/trials', { headers: owner });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.trials, [
    {
      id: s.id,
      venue: 'Кофейня «Зерно»',
      managerName: 'Айгерим',
      timezone: 'Asia/Almaty',
      startedAt: MONDAY_NOON,
      endsAt: MONDAY_NOON + 14 * DAY,
      status: 'active',
      lastSeenAt: MONDAY_NOON + 2 * HOUR,
      stats: STATS,
      snapshotAt: null,
      snapshotBytes: null,
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
      ['POST', `/platform/trials/${s.id}/end-date`, { date: '2026-11-01' }],
      ['POST', `/platform/trials/${s.id}/end`, undefined],
      ['GET', `/platform/trials/${s.id}/snapshot`, undefined],
    ] as const) {
      const r = await e.call(handlePlatform, method, path, { headers, ...(body ? { body } : {}) });
      assert.equal(r.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
    }
  }
  const [still] = await e.s.db.all<{ status: string; ends_at: number }>(
    'SELECT status, (extract(epoch FROM ends_at) * 1000)::bigint AS ends_at FROM trials WHERE id = ?::uuid',
    [s.id],
  );
  assert.equal(still!.status, 'active');
  assert.equal(Number(still!.ends_at), MONDAY_NOON + 14 * DAY, 'nothing changed by the refused calls');

  e.clock.now = MONDAY_NOON + 14 * DAY;
  const expired = await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth });
  assert.deepEqual(expired.body, { status: 'expired', endsAt: MONDAY_NOON + 14 * DAY, message: TRIAL_EXPIRED_MESSAGE });
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
  assert.deepEqual((await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: s.auth })).body, { status: 'active', endsAt: MONDAY_NOON + 34 * DAY });
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
  assert.deepEqual(terms.body, { status: 'ended', endsAt: e.clock.now, message: TRIAL_ENDED_MESSAGE });

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

async function rowOf(e: EdgeTest, id: string): Promise<{ startedAt: number; endsAt: number; timezone: string | null }> {
  const [r] = await e.s.db.all<{ started_at: number; ends_at: number; timezone: string | null }>(
    `SELECT (extract(epoch FROM started_at) * 1000)::bigint AS started_at, (extract(epoch FROM ends_at) * 1000)::bigint AS ends_at, timezone
     FROM trials WHERE id = ?::uuid`,
    [id],
  );
  return { startedAt: Number(r!.started_at), endsAt: Number(r!.ends_at), timezone: r!.timezone };
}

const trialCount = async (e: EdgeTest): Promise<number> => Number((await e.s.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM trials'))[0]!.n);

test('trial: the 14 days count from the browser’s startedAt (clamped to the last 60 days, never ahead), not from the registration', async (t) => {
  const e = await edgeTest(t);
  const venue = 'Кофейня «Зерно»';

  // Began in the browser two days ago, registers only now (offline at first, or opened after an update): 12 days left.
  const late = await start(e, { venue, timezone: 'Asia/Almaty', startedAt: MONDAY_NOON - 2 * DAY }, '198.51.100.1');
  assert.deepEqual(late.body, { id: late.id, token: late.token, startedAt: MONDAY_NOON - 2 * DAY, endsAt: MONDAY_NOON + 12 * DAY, status: 'active' });
  assert.deepEqual(await rowOf(e, late.id), { startedAt: MONDAY_NOON - 2 * DAY, endsAt: MONDAY_NOON + 12 * DAY, timezone: 'Asia/Almaty' });
  // Registering again (the answer was lost, the link not saved) makes a second row with the same term: no extra days.
  e.clock.now += 3 * HOUR;
  const again = await start(e, { venue, startedAt: MONDAY_NOON - 2 * DAY }, '198.51.100.1');
  assert.notEqual(again.id, late.id);
  assert.equal(again.body.endsAt, MONDAY_NOON + 12 * DAY);
  e.clock.now = MONDAY_NOON;

  // A clock ahead cannot start the trial in the future.
  const ahead = await start(e, { venue, startedAt: MONDAY_NOON + 3 * DAY }, '198.51.100.2');
  assert.equal(ahead.body.startedAt, MONDAY_NOON);
  assert.equal(ahead.body.endsAt, MONDAY_NOON + 14 * DAY);

  // An old page sends no startedAt (or null): counted from now.
  const old = await start(e, { venue, startedAt: null }, '198.51.100.2');
  assert.equal(old.body.startedAt, MONDAY_NOON);
  assert.equal(old.body.endsAt, MONDAY_NOON + 14 * DAY);

  // Began 14 days ago or earlier: expired right away — the honest result. Older than 60 days is clamped.
  const done = await start(e, { venue, startedAt: MONDAY_NOON - 14 * DAY }, '198.51.100.3');
  assert.deepEqual(done.body, {
    id: done.id,
    token: done.token,
    startedAt: MONDAY_NOON - 14 * DAY,
    endsAt: MONDAY_NOON,
    status: 'expired',
    message: TRIAL_EXPIRED_MESSAGE,
  });
  const ancient = await start(e, { venue, startedAt: MONDAY_NOON - 400 * DAY }, '198.51.100.3');
  assert.equal(ancient.body.startedAt, MONDAY_NOON - 60 * DAY);
  assert.equal(ancient.body.endsAt, MONDAY_NOON - 46 * DAY);
  assert.equal(ancient.body.status, 'expired');
  const terms = await e.call(handleTrial, 'GET', `/trial/terms?id=${ancient.id}`, { headers: ancient.auth });
  assert.deepEqual(terms.body, { status: 'expired', endsAt: MONDAY_NOON - 46 * DAY, message: TRIAL_EXPIRED_MESSAGE });

  // Not a time: 422 before anything is stored or counted against the address.
  const before = await trialCount(e);
  for (const startedAt of ['вчера', '1760000000000', -5, {}, [], true]) {
    const r = await e.call(handleTrial, 'POST', '/trial/start', { headers: { 'x-forwarded-for': '198.51.100.9' }, body: { venue, startedAt } });
    assert.equal(r.status, 422, JSON.stringify(startedAt));
    assert.equal(r.body.error.code, 'STARTED_AT_INVALID');
  }
  assert.equal(await trialCount(e), before);
  for (let i = 0; i < 10; i++) await start(e, { venue: `К${i}`, startedAt: MONDAY_NOON }, '198.51.100.9');

  // The zone is kept only when it is a real one; the cabinet then counts the days in Almaty.
  const mars = await start(e, { venue: 'Марс', timezone: 'Mars/Olympus' }, '198.51.100.4');
  assert.equal((await rowOf(e, mars.id)).timezone, null);
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const list = await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/trials', { headers: owner });
  assert.equal(list.body.trials.find((v) => v.id === mars.id)!.timezone, 'Asia/Almaty');
  assert.equal(list.body.trials.find((v) => v.id === late.id)!.startedAt, MONDAY_NOON - 2 * DAY);
});

test('trial: the platform sets the end date — through that day in the trial’s zone, today…today+90, shortens and re-activates', async (t) => {
  // MONDAY_NOON = 12 Oct 2026 07:00 UTC: 12:00 on the 12th in Almaty (UTC+5), 21:00 on the 11th in Honolulu (UTC−10).
  const e = await edgeTest(t);
  const almaty = await start(e, { venue: 'Алматы', timezone: 'Asia/Almaty' });
  const hono = await start(e, { venue: 'Гонолулу', timezone: 'Pacific/Honolulu' });
  const nozone = await start(e, { venue: 'Без зоны' });
  const owner = await platformToken(e, DEMO_PLATFORM[0].key);
  const setDate = (id: string, body: unknown, headers = owner) => e.call(handlePlatform, 'POST', `/platform/platform/trials/${id}/end-date`, { headers, body });
  const almatyEnd = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 19) - 1;

  // Outside today…today+90 in the trial's zone, not a date, no date: 422, nothing changes.
  for (const body of [{ date: '2026-10-11' }, { date: '2027-01-11' }, { date: '2026-02-30' }, { date: '12.10.2026' }, { date: 20261020 }, {}, { days: 7 }]) {
    const r = await setDate(almaty.id, body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal(r.body.error.code, 'DATE_INVALID');
  }
  assert.equal((await rowOf(e, almaty.id)).endsAt, MONDAY_NOON + 14 * DAY);
  assert.equal((await setDate('00000000-0000-4000-8000-000000000000', { date: '2026-10-20' })).status, 404);
  assert.equal((await setDate('not-a-uuid', { date: '2026-10-20' })).status, 404);

  // The far end of the range, then shorter than the 14 days: the trial runs to the end of that Almaty day.
  const far = await setDate(almaty.id, { date: '2027-01-10' });
  assert.equal(far.status, 200, JSON.stringify(far.body));
  assert.equal(far.body.endsAt, almatyEnd(2027, 1, 10));
  const short = await setDate(almaty.id, { date: '2026-10-20' });
  assert.equal(short.body.status, 'active');
  assert.equal(short.body.endsAt, almatyEnd(2026, 10, 20));
  assert.equal(short.body.timezone, 'Asia/Almaty');
  assert.equal(short.body.startedAt, MONDAY_NOON, 'the start stays');
  assert.ok(e.log.some((l) => l.includes('назначил дату окончания') && l.includes(almaty.id)));
  // The running trial gets the new end with its next report (and from /terms).
  e.clock.now += HOUR;
  const rep = await e.call(handleTrial, 'POST', '/trial/report', { headers: almaty.auth, body: { id: almaty.id, stats: STATS } });
  assert.deepEqual(rep.body, { status: 'active', endsAt: almatyEnd(2026, 10, 20) });
  // Today is allowed: the last hours of the day.
  const today = await setDate(almaty.id, { date: '2026-10-12' });
  assert.equal(today.body.endsAt, almatyEnd(2026, 10, 12));
  assert.equal(today.body.status, 'active');

  // «Today» and «end of day» are the trial's own: the 11th is still today in Honolulu, already yesterday in Almaty.
  const h = await setDate(hono.id, { date: '2026-10-11' });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.endsAt, Date.UTC(2026, 9, 12, 10) - 1);
  assert.equal(h.body.timezone, 'Pacific/Honolulu');
  assert.equal((await setDate(hono.id, { date: '2027-01-09' })).status, 200);
  assert.equal((await setDate(hono.id, { date: '2027-01-10' })).status, 422, 'today+91 in Honolulu');
  // No zone from the browser: Almaty's days.
  const nz = await setDate(nozone.id, { date: '2026-10-12' });
  assert.equal(nz.body.endsAt, almatyEnd(2026, 10, 12));
  assert.equal(nz.body.timezone, 'Asia/Almaty');

  // An ended trial is active again with a date.
  const ended = await e.call<TrialView>(handlePlatform, 'POST', `/platform/trials/${almaty.id}/end`, { headers: owner });
  assert.equal(ended.body.status, 'ended');
  const back = await setDate(almaty.id, { date: '2026-10-30' });
  assert.equal(back.body.status, 'active');
  assert.equal(back.body.endsAt, almatyEnd(2026, 10, 30));
  assert.deepEqual((await e.call(handleTrial, 'GET', `/trial/terms?id=${almaty.id}`, { headers: almaty.auth })).body, {
    status: 'active',
    endsAt: almatyEnd(2026, 10, 30),
  });

  // An expired one too. At 19:00 UTC it is already the 13th in Almaty: the 12th is in the past now.
  e.clock.now = Date.UTC(2026, 9, 12, 19);
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${nozone.id}`, { headers: nozone.auth })).body.status, 'expired');
  assert.equal((await setDate(nozone.id, { date: '2026-10-12' })).status, 422);
  const revived = await setDate(nozone.id, { date: '2026-10-13' });
  assert.equal(revived.body.status, 'active');
  assert.equal(revived.body.endsAt, almatyEnd(2026, 10, 13));
  assert.deepEqual((await e.call(handleTrial, 'GET', `/trial/terms?id=${nozone.id}`, { headers: nozone.auth })).body, {
    status: 'active',
    endsAt: almatyEnd(2026, 10, 13),
  });

  // The support team has the same right as for extend / end.
  const tech = await platformToken(e, DEMO_PLATFORM[1].key);
  const byTech = await setDate(hono.id, { date: '2026-11-01' }, tech);
  assert.equal(byTech.status, 200, JSON.stringify(byTech.body));
  assert.equal(byTech.body.endsAt, Date.UTC(2026, 10, 2, 10) - 1);
});
