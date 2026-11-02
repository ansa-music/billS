import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { TrialCloudMoveState, TrialStats, TrialView } from '@bills/domain';
import { CLOUD_HUB_NOT_CONFIGURED_MESSAGE, TRIAL_ENDED_MESSAGE, TRIAL_IN_CLOUD_MESSAGE, trialCalendarDay, trialDayEnd } from '@bills/domain';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { handleTrial } from '../../apps/cloud/src/edge/trial.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, HOUR, MONDAY_NOON } from './edge-helpers.ts';
import { fakeHub, HUB_ENV, HUB_TOKEN, HUB_URL } from './cloud-hub-fake.ts';
import { newInstallId, platformAuth, startActive, startRequest } from './trial-helpers.ts';

const DAY = 24 * HOUR;
const MINUTE = 60_000;

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

const sqlite = (tag: string) => Buffer.concat([Buffer.from(`SQLite format 3\0${tag}`), randomBytes(10_000)]);
type Desk = { id: string; token: string; installId: string; auth: Record<string, string> };

let ipSeq = 0;
async function desk(e: EdgeTest, venue = 'Кофейня «Утро»'): Promise<Desk> {
  const s = await startActive(e, { venue, managerName: 'Айгерим', installId: newInstallId(), timezone: 'Asia/Almaty' }, `198.51.100.${++ipSeq % 250}`);
  return { id: s.id, token: s.token, installId: s.installId, auth: s.auth };
}

const report = (e: EdgeTest, d: Pick<Desk, 'id' | 'auth'>, extra: Record<string, unknown> = {}, snapshot?: Buffer) =>
  e.call(handleTrial, 'POST', '/trial/report', {
    headers: d.auth,
    body: { id: d.id, v: 3, stats: STATS, ...extra, ...(snapshot ? { snapshot: snapshot.toString('base64') } : {}) },
  });

const terms = (e: EdgeTest, d: Pick<Desk, 'id' | 'auth'>, v: string | null = '3') =>
  e.call(handleTrial, 'GET', `/trial/terms?id=${d.id}${v ? `&v=${v}` : ''}`, { headers: d.auth });

async function cloudEdge(t: Parameters<typeof edgeTest>[0], env: Record<string, string> = HUB_ENV) {
  const hub = fakeHub();
  const e = await edgeTest(t, { env, cloudHubFetch: hub.fetch });
  const owner = await platformAuth(e);
  const p = <T = any>(method: string, path: string, body?: unknown) => e.call<T>(handlePlatform, method, path, { headers: owner, ...(body !== undefined ? { body } : {}) });
  return { e, hub, owner, p };
}

const cafeUrl = (code: string) => `${HUB_URL}/#/cafe/${code}`;

test('cloud: without CLOUD_HUB_URL / CLOUD_HUB_ADMIN_TOKEN everything is off and says so; the Worker is never called', async (t) => {
  const envs: Array<Record<string, string>> = [{}, { CLOUD_HUB_URL: HUB_URL }, { CLOUD_HUB_ADMIN_TOKEN: HUB_TOKEN }, { CLOUD_HUB_URL: 'not an address', CLOUD_HUB_ADMIN_TOKEN: HUB_TOKEN }];
  for (const env of envs) {
    const { e, hub, p } = await cloudEdge(t, env);
    const d = await desk(e);
    await report(e, d, {}, sqlite('a'));
    const list = await p<{ cloudHub: unknown }>('GET', '/platform/trials');
    assert.deepEqual(list.body.cloudHub, { configured: false, url: env.CLOUD_HUB_URL === HUB_URL ? HUB_URL : null });
    for (const path of [`/platform/trials/${d.id}/cloud/start`, `/platform/trials/${d.id}/cloud`]) {
      const r = await p('POST', path, {});
      assert.equal(r.status, 409, path);
      assert.deepEqual(r.body, { error: { code: 'CLOUD_HUB_NOT_CONFIGURED', message: CLOUD_HUB_NOT_CONFIGURED_MESSAGE } });
    }
    const req = await startRequest(e, { venue: 'Новая', managerName: 'Ерлан' }, '198.51.100.250');
    assert.equal((await p('POST', `/platform/trials/${req.id}/approve-cloud`, {})).status, 409);
    assert.equal(hub.calls.length, 0);
    const [row] = await e.s.db.all<{ status: string }>('SELECT status FROM trials WHERE id = ?::uuid', [req.id]);
    assert.equal(row!.status, 'pending', 'the request is not approved by a refused cloud approval');
  }
});

test('cloud: «Перевести в облако» — the on-line desk sends a fresh copy, it is imported, the link is stored, the terms follow, the old desk is told', async (t) => {
  const { e, hub, p } = await cloudEdge(t);
  const d = await desk(e);
  const watch = await e.call(handleTrial, 'POST', '/trial/watch/links', { headers: d.auth, body: { id: d.id } });
  assert.equal(watch.status, 201);
  const codeAnswer = await report(e, d, { needCode: true }, sqlite('first'));
  const cafeCode = codeAnswer.body.cafeCode as string;
  e.clock.now += MINUTE; // heard from a minute ago: on line

  const started = await p<TrialCloudMoveState>('POST', `/platform/platform/trials/${d.id}/cloud/start`, {});
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body, { requestedAt: MONDAY_NOON + MINUTE, snapshotAt: MONDAY_NOON, lastSeenAt: MONDAY_NOON, fresh: false, cloud: null });
  // Not fresh yet: no move without the person agreeing to the older copy.
  const early = await p('POST', `/platform/trials/${d.id}/cloud`, {});
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'CLOUD_NOT_FRESH');
  assert.equal(hub.calls.length, 0);

  // The desk's next report is asked for a copy (the move's own mechanism); with it, the copy is fresh.
  e.clock.now += 3000;
  assert.equal((await report(e, d)).body.sendSnapshot, true);
  const latest = sqlite('latest');
  e.clock.now += 3000;
  await report(e, d, {}, latest);
  const state = await p<TrialCloudMoveState>('GET', `/platform/trials/${d.id}/cloud`);
  assert.equal(state.body.fresh, true);
  assert.equal(state.body.snapshotAt, MONDAY_NOON + MINUTE + 6000);

  e.clock.now += 1000;
  const moved = await p<TrialView>('POST', `/platform/trials/${d.id}/cloud`, {});
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const imports = hub.calls.filter((c) => c.path === '/admin/cafes/import');
  assert.equal(imports.length, 1);
  assert.equal(imports[0]!.headers.authorization, `Bearer ${HUB_TOKEN}`);
  assert.equal(Buffer.from(String(imports[0]!.body!.snapshot), 'base64').equals(latest), true, 'the fresh copy went to the Worker');
  assert.match(imports[0]!.headers['idempotency-key'] ?? '', new RegExp(`^ts-trial-${d.id}-`));
  const code = moved.body.cloud!.code;
  assert.deepEqual(moved.body.cloud, { code, url: cafeUrl(code), at: MONDAY_NOON + MINUTE + 7000, origin: 'move', termsError: null, termsSyncedAt: MONDAY_NOON + MINUTE + 7000 });
  assert.equal(moved.body.status, 'active', 'the trial keeps its status and end');
  assert.deepEqual(hub.cafes.get(code)!.terms, { status: 'active', endsAt: MONDAY_NOON + 14 * DAY, message: null });

  // The old cash desk: 410 TRIAL_MOVED (an old page locks itself read-only) with where the café went.
  const old = await report(e, d, {}, sqlite('after'));
  assert.equal(old.status, 410);
  assert.deepEqual(old.body, { error: { code: 'TRIAL_MOVED', message: TRIAL_IN_CLOUD_MESSAGE, cloud: { code, url: cafeUrl(code) } } });
  assert.equal((await terms(e, d)).status, 410);
  assert.equal((await terms(e, d, null)).body.error.cloud.code, code, 'a page without v too');
  const [snap] = await e.s.db.all<{ s: string }>(`SELECT encode(snapshot, 'base64') AS s FROM trials WHERE id = ?::uuid`, [d.id]);
  assert.equal(Buffer.from(snap!.s.replace(/\s+/g, ''), 'base64').equals(latest), true, 'the old desk cannot overwrite the copy');
  // Its 30-second signal says «moved»; the page then asks the terms and learns it is the cloud.
  e.clock.now = Date.now();
  const signal = await e.s.pg.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE anon');
    return (await tx.query<{ s: string }>('SELECT public.trial_desk_signal($1, $2) AS s', [d.id, d.token])).rows[0]!.s;
  });
  assert.equal(signal, 'moved');
  // A watching phone is told too.
  const phone = await e.call(handleTrial, 'GET', '/trial/watch', { headers: { authorization: `Bearer ${watch.body.token}`, 'x-forwarded-for': '203.0.113.50' } });
  assert.deepEqual(phone.body.cloud, { code, url: cafeUrl(code) });
  // No way back into a browser: the café code and the browser's installId stop working.
  assert.equal((await e.call(handleTrial, 'POST', '/trial/move/start', { headers: { 'x-forwarded-for': '203.0.113.7' }, body: { code: cafeCode } })).status, 401);
  const again = await e.call(handleTrial, 'POST', '/trial/start', { headers: { 'x-forwarded-for': '198.51.100.251' }, body: { venue: 'Кофейня «Утро»', installId: d.installId } });
  assert.equal(again.status, 201, 'the same browser starting again is a new request, never the moved café');
  assert.notEqual(again.body.id, d.id);
  // The cabinet's list shows the link; the log says who moved it and never the tokens.
  const list = await p<{ trials: TrialView[]; cloudHub: unknown }>('GET', '/platform/trials');
  assert.deepEqual(list.body.cloudHub, { configured: true, url: HUB_URL });
  assert.equal(list.body.trials.find((x) => x.id === d.id)!.cloud!.url, cafeUrl(code));
  assert.ok(e.log.some((l) => l.includes('перевёл в облачную кассу')));
  assert.ok(!e.log.join('\n').includes(d.token) && !e.log.join('\n').includes(HUB_TOKEN));
  // The row is the only link to the cloud café: it cannot be deleted even once ended.
  await p('POST', `/platform/trials/${d.id}/end`, {});
  assert.equal((await p('DELETE', `/platform/trials/${d.id}`)).body.error.code, 'TRIAL_IN_CLOUD');
});

test('cloud: an off-line desk is not waited for (the last copy, after the person agrees); no copy — nothing to move; a request is approved into the cloud instead', async (t) => {
  const { e, hub, p } = await cloudEdge(t);
  const off = await desk(e, 'Закрытая');
  await report(e, off, {}, sqlite('old'));
  e.clock.now += 2 * HOUR;
  const s = await p<TrialCloudMoveState>('POST', `/platform/trials/${off.id}/cloud/start`, {});
  assert.deepEqual(s.body, { requestedAt: null, snapshotAt: MONDAY_NOON, lastSeenAt: MONDAY_NOON, fresh: false, cloud: null });
  const [w] = await e.s.db.all<{ wanted: string | null }>('SELECT snapshot_wanted_at AS wanted FROM trials WHERE id = ?::uuid', [off.id]);
  assert.equal(w!.wanted, null, 'an off-line desk is not asked');
  const moved = await p<TrialView>('POST', `/platform/trials/${off.id}/cloud`, {});
  assert.equal(moved.status, 200, 'the cabinet showed the copy time and the person agreed');
  assert.ok(moved.body.cloud);

  // On line but silent: the move waits, «Перевести с данными на …» sends acceptOlder.
  const silent = await desk(e, 'Молчит');
  await report(e, silent, {}, sqlite('silent'));
  e.clock.now += MINUTE;
  assert.ok((await p<TrialCloudMoveState>('POST', `/platform/trials/${silent.id}/cloud/start`, {})).body.requestedAt);
  e.clock.now += 80_000;
  assert.equal((await p('POST', `/platform/trials/${silent.id}/cloud`, {})).body.error.code, 'CLOUD_NOT_FRESH');
  assert.equal((await p('POST', `/platform/trials/${silent.id}/cloud`, { acceptOlder: true })).status, 200);

  const empty = await desk(e, 'Пустая');
  const none = await p('POST', `/platform/trials/${empty.id}/cloud`, {});
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, 'SNAPSHOT_NOT_FOUND');
  const req = await startRequest(e, { venue: 'Заявка' }, '198.51.100.249');
  assert.equal((await p('POST', `/platform/trials/${req.id}/cloud/start`, {})).body.error.code, 'TRIAL_NOT_APPROVED');
  assert.equal((await p('POST', `/platform/trials/${req.id}/cloud`, {})).body.error.code, 'TRIAL_NOT_APPROVED');
  assert.equal(hub.count('POST', /import/), 2);
  // The support team may move too (clients.edit); a stranger may not.
  assert.equal((await e.call(handlePlatform, 'POST', `/platform/trials/${empty.id}/cloud/start`, {})).status, 401);
});

test('cloud: never twice — a second click and a click at the same time show the same café; the Worker imported once', async (t) => {
  const { e, hub, p } = await cloudEdge(t);
  const d = await desk(e);
  await report(e, d, {}, sqlite('one'));
  e.clock.now += HOUR; // off line: no wait
  const release = hub.hold();
  const first = p<TrialView>('POST', `/platform/trials/${d.id}/cloud`, {});
  // While the first talks to the Worker: the second is told to wait, the terms cannot change under it.
  await new Promise((r) => setTimeout(r, 50));
  const second = await p('POST', `/platform/trials/${d.id}/cloud`, {});
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'CLOUD_BUSY');
  assert.equal((await p('POST', `/platform/trials/${d.id}/extend`, { days: 7 })).body.error.code, 'CLOUD_BUSY');
  release();
  const done = await first;
  assert.equal(done.status, 200);
  const code = done.body.cloud!.code;
  const third = await p<TrialView>('POST', `/platform/trials/${d.id}/cloud`, {});
  assert.equal(third.status, 200);
  assert.equal(third.body.cloud!.code, code);
  const restart = await p<TrialCloudMoveState>('POST', `/platform/trials/${d.id}/cloud/start`, {});
  assert.equal(restart.body.cloud!.code, code);
  assert.equal(hub.count('POST', /^\/admin\/cafes\/import$/), 1);
  assert.equal(hub.cafes.size, 1);
});

test('cloud: the Worker’s refusals reach the cabinet in words (424, never «no internet»); nothing is stored and a retry works', async (t) => {
  const { e, hub, p } = await cloudEdge(t);
  const d = await desk(e);
  await report(e, d, {}, sqlite('x'));
  e.clock.now += HOUR;
  hub.failNext(/import/, { status: 500, body: { error: { code: 'INTERNAL', message: 'Внутренняя ошибка облачной кассы' } } });
  const broke = await p('POST', `/platform/trials/${d.id}/cloud`, {});
  assert.equal(broke.status, 424);
  assert.equal(broke.body.error.code, 'CLOUD_HUB_ERROR');
  assert.match(broke.body.error.message, /Внутренняя ошибка облачной кассы.*HTTP 500/);
  hub.failNext(/import/, 'offline');
  assert.equal((await p('POST', `/platform/trials/${d.id}/cloud`, {})).body.error.code, 'CLOUD_HUB_OFFLINE');
  hub.failNext(/import/, { status: 401, body: {} });
  assert.equal((await p('POST', `/platform/trials/${d.id}/cloud`, {})).body.error.code, 'CLOUD_HUB_UNAUTHORIZED');
  hub.failNext(/import/, { status: 413, body: {} });
  assert.equal((await p('POST', `/platform/trials/${d.id}/cloud`, {})).body.error.code, 'CLOUD_HUB_TOO_LARGE');
  hub.failNext(/import/, { status: 201, body: { tables: 3 } });
  assert.equal((await p('POST', `/platform/trials/${d.id}/cloud`, {})).body.error.code, 'CLOUD_HUB_BAD_ANSWER');
  const [row] = await e.s.db.all<{ cloud_code: string | null; busy: string | null }>('SELECT cloud_code, cloud_busy_at AS busy FROM trials WHERE id = ?::uuid', [d.id]);
  assert.deepEqual(row, { cloud_code: null, busy: null });
  assert.equal((await report(e, d)).status, 200, 'the browser cash desk keeps working');
  assert.equal((await p('POST', `/platform/trials/${d.id}/cloud`, {})).status, 200);
});

test('cloud: «Продлить», «Дата окончания», «Сделать постоянной», «Завершить» reach the cloud café; a failure stays visible with «Повторить»', async (t) => {
  const { e, hub, p } = await cloudEdge(t);
  const d = await desk(e);
  await report(e, d, {}, sqlite('t'));
  e.clock.now += HOUR;
  const code = (await p<TrialView>('POST', `/platform/trials/${d.id}/cloud`, {})).body.cloud!.code;
  const cafe = () => hub.cafes.get(code)!;

  const extended = await p<TrialView>('POST', `/platform/trials/${d.id}/extend`, { days: 7 });
  assert.equal(extended.status, 200);
  assert.deepEqual(cafe().terms, { status: 'active', endsAt: MONDAY_NOON + 21 * DAY, message: null });
  assert.equal(extended.body.cloud!.url, cafeUrl(code));

  const day = trialCalendarDay(e.clock.now + 30 * DAY, 'Asia/Almaty');
  await p('POST', `/platform/trials/${d.id}/end-date`, { date: day });
  assert.deepEqual(cafe().terms, { status: 'active', endsAt: trialDayEnd(day, 'Asia/Almaty'), message: null });

  await p('POST', `/platform/trials/${d.id}/permanent`, {});
  assert.deepEqual(cafe().terms, { status: 'permanent', endsAt: null, message: null });

  await p('POST', `/platform/trials/${d.id}/end`, {});
  assert.deepEqual(cafe().terms, { status: 'ended', endsAt: e.clock.now, message: TRIAL_ENDED_MESSAGE });

  // The Worker is down: the change stands in the cabinet, the mismatch is shown, «Повторить» fixes it.
  hub.failNext(/terms/, { status: 503, body: { error: { message: 'Перегружено' } } });
  const failed = await p<TrialView>('POST', `/platform/trials/${d.id}/extend`, { days: 3 });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.status, 'active');
  assert.match(failed.body.cloud!.termsError ?? '', /Перегружено/);
  assert.equal(cafe().terms!.status, 'ended', 'the cloud café still has the old terms');
  const listed = (await p<{ trials: TrialView[] }>('GET', '/platform/trials')).body.trials.find((x) => x.id === d.id)!;
  assert.match(listed.cloud!.termsError ?? '', /Перегружено/, 'the warning survives a reload');
  e.clock.now += MINUTE;
  const retried = await p<TrialView>('POST', `/platform/trials/${d.id}/cloud/terms`, {});
  assert.equal(retried.status, 200);
  assert.equal(retried.body.cloud!.termsError, null);
  assert.equal(retried.body.cloud!.termsSyncedAt, e.clock.now);
  assert.equal(cafe().terms!.status, 'active');
  // «Повторить» of a trial that is not in the cloud.
  const other = await desk(e, 'Другая');
  assert.equal((await p('POST', `/platform/trials/${other.id}/cloud/terms`, {})).body.error.code, 'TRIAL_NOT_IN_CLOUD');
});

test('cloud: «Подтвердить в облаке» — a request becomes a new cloud café; its waiting page gets the link and the director’s key once', async (t) => {
  const { e, hub, p } = await cloudEdge(t);
  const req = await startRequest(e, { venue: 'Кофейня «Тау»', managerName: 'Ерлан', timezone: 'Asia/Aqtobe', withMenu: false }, '198.51.100.30');
  const page = { id: req.id, auth: req.auth };
  e.clock.now += 10 * MINUTE;
  const approved = await p<{ trial: TrialView; managerKey: string }>('POST', `/platform/trials/${req.id}/approve-cloud`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const created = hub.calls.find((c) => c.path === '/admin/cafes')!;
  assert.deepEqual(created.body, { venue: 'Кофейня «Тау»', managerName: 'Ерлан', withMenu: false, timezone: 'Asia/Aqtobe' });
  const { trial, managerKey } = approved.body;
  const code = trial.cloud!.code;
  assert.equal(managerKey, hub.cafes.get(code)!.managerKey);
  assert.equal(trial.status, 'active');
  assert.equal(trial.startedAt, e.clock.now);
  assert.equal(trial.endsAt, e.clock.now + 14 * DAY);
  assert.equal(trial.cloud!.origin, 'new');
  assert.deepEqual(hub.cafes.get(code)!.terms, { status: 'active', endsAt: e.clock.now + 14 * DAY, message: null });

  // The waiting page: «ended» here (no browser café), the link and the key — for a current page and an old one.
  const waiting = await terms(e, page);
  assert.deepEqual(waiting.body, { status: 'ended', endsAt: e.clock.now + 14 * DAY, message: TRIAL_IN_CLOUD_MESSAGE, cloud: { code, url: cafeUrl(code), managerKey } });
  assert.equal((await terms(e, page, '2')).body.status, 'ended');
  assert.equal((await terms(e, page, null)).body.status, 'ended', 'an old page goes read-only, never opens the browser café');
  // An old page that reports its empty browser café stores nothing.
  const rep = await report(e, page, {}, sqlite('form only'));
  assert.equal(rep.status, 200);
  assert.equal(rep.body.cloud.code, code);
  const [row] = await e.s.db.all<{ snapshot_at: string | null; stats: unknown }>('SELECT snapshot_at, stats FROM trials WHERE id = ?::uuid', [req.id]);
  assert.deepEqual(row, { snapshot_at: null, stats: null });

  // A second click shows the same café and, while the page has not taken it, the key.
  const again = await p<{ trial: TrialView; managerKey: string | null }>('POST', `/platform/trials/${req.id}/approve-cloud`, {});
  assert.equal(again.body.trial.cloud!.code, code);
  assert.equal(again.body.managerKey, managerKey);
  assert.equal(hub.count('POST', /^\/admin\/cafes$/), 1);

  // The page kept the key: the cloud forgets it and retires the token.
  const seen = await e.call(handleTrial, 'POST', '/trial/cloud/seen', { headers: page.auth, body: { id: req.id } });
  assert.deepEqual(seen.body, { ok: true });
  const after = await terms(e, page);
  assert.equal(after.status, 410);
  assert.deepEqual(after.body.error.cloud, { code, url: cafeUrl(code) }, 'no key any more');
  const [kept] = await e.s.db.all<{ cloud_key: string | null }>('SELECT cloud_key FROM trials WHERE id = ?::uuid', [req.id]);
  assert.equal(kept!.cloud_key, null);
  assert.equal((await p<{ managerKey: string | null }>('POST', `/platform/trials/${req.id}/approve-cloud`, {})).body.managerKey, null);
  assert.ok(!e.log.join('\n').includes(managerKey), 'the key never reaches the log');

  // A request from an old page (no withMenu) gets the sample menu, the default of the form; an approved trial is refused.
  const old = await startRequest(e, { venue: 'Старая страница', managerName: '' }, '198.51.100.31');
  await p('POST', `/platform/trials/${old.id}/approve-cloud`, {});
  assert.deepEqual(hub.calls.filter((c) => c.path === '/admin/cafes')[1]!.body, { venue: 'Старая страница', managerName: 'Директор', withMenu: true, timezone: 'Asia/Almaty' });
  const running = await desk(e, 'Уже работает');
  assert.equal((await p('POST', `/platform/trials/${running.id}/approve-cloud`, {})).body.error.code, 'TRIAL_NOT_PENDING');
  // The Worker refuses: the request stays a request.
  const third = await startRequest(e, { venue: 'Третья' }, '198.51.100.32');
  hub.failNext(/^POST \/admin\/cafes$/, { status: 500, body: { error: { message: 'Сбой' } } });
  assert.equal((await p('POST', `/platform/trials/${third.id}/approve-cloud`, {})).status, 424);
  const [st] = await e.s.db.all<{ status: string; cloud_code: string | null }>('SELECT status, cloud_code FROM trials WHERE id = ?::uuid', [third.id]);
  assert.deepEqual(st, { status: 'pending', cloud_code: null });
});
