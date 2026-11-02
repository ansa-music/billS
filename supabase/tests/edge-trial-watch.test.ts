import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { TrialStats, TrialWatchState, TrialWatchStatus } from '@bills/domain';
import { TRIAL_WATCH, TRIAL_WATCH_RATE } from '@bills/domain';
import { handleTrial } from '../../apps/cloud/src/edge/trial.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, HOUR, MONDAY_NOON } from './edge-helpers.ts';

const DAY = 24 * HOUR;
const MINUTE = 60_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const STATS: TrialStats = {
  ordersTotal: 3,
  ordersToday: 3,
  revenueTotal: 4_500,
  revenueToday: 4_500,
  productsCount: 9,
  staffCount: 2,
  shiftOpen: true,
  lastOrderAt: MONDAY_NOON - HOUR,
  days: [{ day: '2026-10-12', orders: 3, revenue: 4_500 }],
};

const SQLITE = Buffer.concat([Buffer.from('SQLite format 3\0'), randomBytes(50_000)]);

async function start(e: EdgeTest, venue = 'Кофейня «Зерно»') {
  const res = await e.call(handleTrial, 'POST', '/functions/v1/trial/trial/start', { headers: { 'x-forwarded-for': '198.51.100.4' }, body: { venue } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id as string, auth: { authorization: `Bearer ${res.body.token}` } };
}

type Trial = Awaited<ReturnType<typeof start>>;

async function link(e: EdgeTest, t: Trial) {
  const res = await e.call(handleTrial, 'POST', '/trial/trial/watch/links', { headers: t.auth, body: { id: t.id } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.token as string, phone: { authorization: `Bearer ${res.body.token}`, 'x-forwarded-for': '203.0.113.50' } };
}

async function report(e: EdgeTest, t: Trial, snapshot?: Buffer) {
  const res = await e.call(handleTrial, 'POST', '/trial/report', { headers: t.auth, body: { id: t.id, stats: STATS, ...(snapshot ? { snapshot: snapshot.toString('base64') } : {}) } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as Record<string, unknown>;
}

test('watch: the cash desk issues a link (random, sha256 only, one trial); the phone reads that trial’s latest snapshot', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  const other = await start(e, 'Соседи');

  const l = await link(e, s);
  assert.match(l.token, /^[A-Za-z0-9_-]{32}$/, '24 random bytes, base64url');
  const created = await e.call(handleTrial, 'POST', '/trial/watch/links', { headers: s.auth, body: { id: s.id } });
  assert.equal(created.body.createdAt, MONDAY_NOON);
  assert.notEqual(created.body.token, l.token);
  const rows = await e.s.db.all<{ trial_id: string; token_hash: string }>('SELECT trial_id::text AS trial_id, token_hash FROM trial_viewers ORDER BY created_at');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.trial_id === s.id));
  assert.ok(rows.some((r) => r.token_hash === sha(l.token)));
  assert.ok(!JSON.stringify(rows).includes(l.token), 'the token itself is not stored');

  // Before the cash desk sent a snapshot: the state says so, the snapshot is 404.
  const before = await e.call<TrialWatchState>(handleTrial, 'GET', '/trial/watch', { headers: l.phone });
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.deepEqual(before.body, { venue: 'Кофейня «Зерно»', startedAt: MONDAY_NOON, endsAt: MONDAY_NOON + 14 * DAY, status: 'active', snapshotAt: null, snapshotBytes: null });
  assert.equal(before.headers.get('access-control-allow-origin'), '*');
  assert.equal(before.headers.get('cache-control'), 'no-store');
  const none = await e.call(handleTrial, 'GET', '/trial/watch/snapshot', { headers: l.phone });
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, 'SNAPSHOT_NOT_FOUND');

  e.clock.now += MINUTE;
  await report(e, s, SQLITE);
  await report(e, other, Buffer.from('SQLite format 3\0other'));
  const state = await e.call<TrialWatchState>(handleTrial, 'GET', '/functions/v1/trial/trial/watch', { headers: l.phone });
  assert.equal(state.body.snapshotAt, MONDAY_NOON + MINUTE);
  assert.equal(state.body.snapshotBytes, SQLITE.length);
  const snap = await e.call(handleTrial, 'GET', '/trial/watch/snapshot', { headers: l.phone });
  assert.equal(snap.status, 200);
  assert.equal(snap.body.snapshotAt, MONDAY_NOON + MINUTE);
  assert.ok(Buffer.from(snap.body.snapshot, 'base64').equals(SQLITE), 'this trial’s snapshot, byte for byte');
  assert.equal(snap.headers.get('access-control-allow-origin'), '*');

  // An expired trial can still be watched (read-only anyway).
  e.clock.now = MONDAY_NOON + 15 * DAY;
  const expired = await e.call<TrialWatchState>(handleTrial, 'GET', '/trial/watch', { headers: l.phone });
  assert.equal(expired.body.status, 'expired');
});

test('watch: tokens do not cross — a viewer token is not the trial’s, the trial token is not a viewer’s, other trials stay closed', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  const other = await start(e, 'Соседи');
  const l = await link(e, s);

  // The viewer token does not report, read the terms, issue or revoke links.
  const asViewer = { authorization: `Bearer ${l.token}` };
  assert.equal((await e.call(handleTrial, 'POST', '/trial/report', { headers: asViewer, body: { id: s.id, stats: STATS } })).status, 401);
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}`, { headers: asViewer })).status, 401);
  assert.equal((await e.call(handleTrial, 'POST', '/trial/watch/links', { headers: asViewer, body: { id: s.id } })).status, 401);
  assert.equal((await e.call(handleTrial, 'POST', '/trial/watch/revoke', { headers: asViewer, body: { id: s.id } })).status, 401);
  assert.equal((await e.call(handleTrial, 'GET', `/trial/watch/links?id=${s.id}`, { headers: asViewer })).status, 401);

  // The trial's own token, nothing, garbage, a random well-formed token: 401 on the phone's calls.
  const tokenOnly = s.auth.authorization.slice('Bearer '.length);
  for (const headers of [s.auth, {}, { authorization: 'Bearer nope' }, { authorization: `Bearer ${randomBytes(24).toString('base64url')}` }, { authorization: `Bearer ${tokenOnly}` }]) {
    for (const path of ['/trial/watch', '/trial/watch/snapshot']) {
      const r = await e.call(handleTrial, 'GET', path, { headers });
      assert.equal(r.status, 401, `${path} ${JSON.stringify(headers)}`);
      assert.equal(r.body.error.code, 'WATCH_LINK_REVOKED');
      assert.equal(r.headers.get('access-control-allow-origin'), '*');
    }
  }

  // Another trial's token cannot issue links for this trial, nor see or revoke them.
  assert.equal((await e.call(handleTrial, 'POST', '/trial/watch/links', { headers: other.auth, body: { id: s.id } })).status, 401);
  assert.equal((await e.call(handleTrial, 'GET', `/trial/watch/links?id=${s.id}`, { headers: other.auth })).status, 401);
  assert.equal((await e.call(handleTrial, 'POST', '/trial/watch/revoke', { headers: other.auth, body: { id: s.id } })).status, 401);
  for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', 7]) {
    assert.equal((await e.call(handleTrial, 'POST', '/trial/watch/links', { headers: s.auth, body: { id } })).status, 404, String(id));
  }
  assert.equal((await e.call(handleTrial, 'GET', '/trial/watch', { headers: { authorization: `Bearer ${l.token}` } })).status, 200, 'still works');
});

test('watch: the report says `watching` for 10 minutes after the phone’s last check; the cash desk sees the phones', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  assert.deepEqual(await report(e, s), { status: 'active', endsAt: MONDAY_NOON + 14 * DAY }, 'nobody watching: the answer is as before');

  const empty = await e.call<TrialWatchStatus>(handleTrial, 'GET', `/trial/watch/links?id=${s.id}`, { headers: s.auth });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { links: 0, phones: 0, lastViewedAt: null, watching: false });

  const l = await link(e, s);
  await link(e, s);
  assert.equal((await report(e, s)).watching, undefined, 'a link that was never opened is not watching');
  const unopened = await e.call<TrialWatchStatus>(handleTrial, 'GET', `/trial/watch/links?id=${s.id}`, { headers: s.auth });
  assert.deepEqual(unopened.body, { links: 2, phones: 0, lastViewedAt: null, watching: false });

  e.clock.now += MINUTE;
  await e.call(handleTrial, 'GET', '/trial/watch', { headers: l.phone });
  const viewedAt = e.clock.now;
  assert.deepEqual(await report(e, s), { status: 'active', endsAt: MONDAY_NOON + 14 * DAY, watching: true });
  const status = await e.call<TrialWatchStatus>(handleTrial, 'GET', `/trial/watch/links?id=${s.id}`, { headers: s.auth });
  assert.deepEqual(status.body, { links: 2, phones: 1, lastViewedAt: viewedAt, watching: true });

  e.clock.now = viewedAt + TRIAL_WATCH.watchingMs - 1;
  assert.equal((await report(e, s)).watching, true);
  e.clock.now = viewedAt + TRIAL_WATCH.watchingMs;
  assert.equal((await report(e, s)).watching, undefined, '10 minutes without a check: back to the usual pace');

  // Downloading the snapshot counts as looking too.
  await report(e, s, SQLITE);
  await e.call(handleTrial, 'GET', '/trial/watch/snapshot', { headers: l.phone });
  assert.equal((await report(e, s)).watching, true);

  // Another trial is not watched.
  const other = await start(e, 'Соседи');
  assert.equal((await report(e, other)).watching, undefined);
});

test('watch: «Отключить телефоны» revokes every link of the trial at once, and only of this trial', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  const other = await start(e, 'Соседи');
  const a = await link(e, s);
  const b = await link(e, s);
  const o = await link(e, other);
  await e.call(handleTrial, 'GET', '/trial/watch', { headers: a.phone });

  const revoked = await e.call(handleTrial, 'POST', '/trial/watch/revoke', { headers: s.auth, body: { id: s.id } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.deepEqual(revoked.body, { revoked: 2 });
  for (const phone of [a.phone, b.phone]) {
    const r = await e.call(handleTrial, 'GET', '/trial/watch/snapshot', { headers: phone });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'WATCH_LINK_REVOKED');
  }
  assert.equal((await report(e, s)).watching, undefined);
  assert.deepEqual((await e.call(handleTrial, 'GET', `/trial/watch/links?id=${s.id}`, { headers: s.auth })).body, { links: 0, phones: 0, lastViewedAt: null, watching: false });
  assert.equal((await e.call(handleTrial, 'GET', '/trial/watch', { headers: o.phone })).status, 200, 'the other trial’s phone still watches');
  assert.deepEqual((await e.call(handleTrial, 'POST', '/trial/watch/revoke', { headers: s.auth, body: { id: s.id } })).body, { revoked: 0 });

  // A new link works again after the revoke.
  const c = await link(e, s);
  assert.equal((await e.call(handleTrial, 'GET', '/trial/watch', { headers: c.phone })).status, 200);
});

test('watch: at most 10 links per trial — a new one drops the one unused for longest, an opened phone stays', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  const first = await link(e, s);
  e.clock.now += MINUTE;
  const second = await link(e, s);
  e.clock.now += MINUTE;
  await e.call(handleTrial, 'GET', '/trial/watch', { headers: first.phone }); // the first is in use: newest by last view
  for (let i = 0; i < TRIAL_WATCH.maxLinks - 1; i++) {
    e.clock.now += MINUTE;
    await link(e, s);
  }
  const [count] = await e.s.db.all<{ n: number }>('SELECT COUNT(*)::int AS n FROM trial_viewers WHERE trial_id = ?::uuid', [s.id]);
  assert.equal(count!.n, TRIAL_WATCH.maxLinks);
  assert.equal((await e.call(handleTrial, 'GET', '/trial/watch', { headers: second.phone })).status, 401, 'the oldest unused link is gone');
  assert.equal((await e.call(handleTrial, 'GET', '/trial/watch', { headers: first.phone })).status, 200, 'the phone in use stays');
});

test('watch: rate limits — links per trial, checks and snapshots per phone, unknown tokens per address', async (t) => {
  const e = await edgeTest(t);
  const s = await start(e);
  for (let i = 0; i < TRIAL_WATCH_RATE.linksPerTrialHour - 1; i++) {
    e.clock.now += 1;
    await link(e, s);
  }
  e.clock.now += 1;
  const l = await link(e, s);
  const tooMany = await e.call(handleTrial, 'POST', '/trial/watch/links', { headers: s.auth, body: { id: s.id } });
  assert.equal(tooMany.status, 429);
  assert.equal(tooMany.body.error.code, 'RATE_LIMITED');
  assert.equal(tooMany.headers.get('access-control-allow-origin'), '*');

  await report(e, s, SQLITE);
  for (let i = 0; i < TRIAL_WATCH_RATE.snapshotsPerViewerHour; i++) {
    const r = await e.call(handleTrial, 'GET', '/trial/watch/snapshot', { headers: l.phone });
    assert.equal(r.status, 200, `snapshot ${i}`);
  }
  assert.equal((await e.call(handleTrial, 'GET', '/trial/watch/snapshot', { headers: l.phone })).status, 429);
  for (let i = 0; i < TRIAL_WATCH_RATE.checksPerViewerHour; i++) {
    const r = await e.call(handleTrial, 'GET', '/trial/watch', { headers: l.phone });
    assert.equal(r.status, 200, `check ${i}`);
  }
  assert.equal((await e.call(handleTrial, 'GET', '/trial/watch', { headers: l.phone })).status, 429);
  e.clock.now += HOUR + 1;
  assert.equal((await e.call(handleTrial, 'GET', '/trial/watch', { headers: l.phone })).status, 200, 'an hour later');
  assert.equal((await e.call(handleTrial, 'POST', '/trial/watch/links', { headers: s.auth, body: { id: s.id } })).status, 201);

  // Guessing: 30 unknown tokens from one address, then that address is refused even with a good token.
  const guesser = '192.0.2.77';
  for (let i = 0; i < TRIAL_WATCH_RATE.failuresPerIpHour; i++) {
    const r = await e.call(handleTrial, 'GET', '/trial/watch', { headers: { authorization: `Bearer ${randomBytes(24).toString('base64url')}`, 'x-forwarded-for': guesser } });
    assert.equal(r.status, 401, `guess ${i}`);
  }
  const blocked = await e.call(handleTrial, 'GET', '/trial/watch/snapshot', { headers: { authorization: `Bearer ${l.token}`, 'x-forwarded-for': guesser } });
  assert.equal(blocked.status, 429);
  assert.equal((await e.call(handleTrial, 'GET', '/trial/watch', { headers: l.phone })).status, 200, 'another address is fine');
});
