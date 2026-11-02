import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { TrialCodesView, TrialStats, TrialView } from '@bills/domain';
import { TRIAL_ENDED_MESSAGE, TRIAL_PAID_ENDED_MESSAGE, trialCalendarDay, trialDayEnd } from '@bills/domain';
import { RoutingSender } from '../../apps/cloud/src/push.ts';
import { DEMO_PLATFORM } from '../../apps/cloud/src/seed.ts';
import { handleNotify } from '../../apps/cloud/src/edge/notify.ts';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { handleTrial } from '../../apps/cloud/src/edge/trial.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, HOUR, MONDAY_NOON, NOTIFY_SECRET, recordingSender } from './edge-helpers.ts';
import { fakeHub, HUB_ENV } from './cloud-hub-fake.ts';
import { newInstallId, platformAuth, startActive, startRequest } from './trial-helpers.ts';

const DAY = 24 * HOUR;
const ZONE = 'Asia/Almaty';
const STATS: TrialStats = {
  ordersTotal: 1,
  ordersToday: 1,
  revenueTotal: 1_500,
  revenueToday: 1_500,
  productsCount: 9,
  staffCount: 2,
  shiftOpen: false,
  lastOrderAt: null,
  days: [],
};

let ipSeq = 0;
async function desk(e: EdgeTest, venue = 'Кофейня «Утро»') {
  const s = await startActive(e, { venue, managerName: 'Айгерим', installId: newInstallId(), timezone: ZONE }, `198.51.100.${++ipSeq % 250}`);
  return { id: s.id, token: s.token, auth: s.auth };
}
type Desk = Awaited<ReturnType<typeof desk>>;

const report = (e: EdgeTest, d: Desk, extra: Record<string, unknown> = {}, v: number | null = 3) =>
  e.call(handleTrial, 'POST', '/trial/report', { headers: d.auth, body: { id: d.id, ...(v ? { v } : {}), stats: STATS, ...extra } });
const terms = (e: EdgeTest, d: Desk, v: string | null = '3') => e.call(handleTrial, 'GET', `/trial/terms?id=${d.id}${v ? `&v=${v}` : ''}`, { headers: d.auth });
const dayAhead = (e: EdgeTest, days: number) => trialCalendarDay(e.clock.now + days * DAY, ZONE);

async function setup(t: Parameters<typeof edgeTest>[0], options: Parameters<typeof edgeTest>[1] = {}) {
  const e = await edgeTest(t, options);
  const owner = await platformAuth(e);
  const tech = await platformAuth(e, DEMO_PLATFORM[1].key);
  const p = <T = any>(method: string, path: string, body?: unknown, headers = owner) =>
    e.call<T>(handlePlatform, method, path, { headers, ...(body !== undefined ? { body } : {}) });
  return { e, owner, tech, p };
}

test('«Купили»: a paying client until a date; the amount and note never reach the café; «Продлить оплату» keeps the history', async (t) => {
  const { e, p } = await setup(t);
  const d = await desk(e);
  const until = dayAhead(e, 30);
  const paid = await p<TrialView>('POST', `/platform/trials/${d.id}/paid`, { until, amount: 15_000_000, note: 'наличными, договорились на год' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.status, 'paid');
  assert.equal(paid.body.endsAt, trialDayEnd(until, ZONE), 'through the whole paid day of the café');
  assert.deepEqual(paid.body.paid, {
    until,
    since: MONDAY_NOON,
    amount: 15_000_000,
    note: 'наличными, договорились на год',
    payments: [{ at: MONDAY_NOON, until, amount: 15_000_000, note: 'наличными, договорились на год', by: 'Владелец TS' }],
    remindedAt: null,
  });

  // The café: «paid» for a current page, «active» with the same end for a v2 page and an old one — never the price.
  const current = await terms(e, d);
  assert.deepEqual(current.body, { status: 'paid', endsAt: trialDayEnd(until, ZONE) });
  assert.deepEqual((await terms(e, d, '2')).body, { status: 'active', endsAt: trialDayEnd(until, ZONE) });
  assert.deepEqual((await terms(e, d, null)).body, { status: 'active', endsAt: trialDayEnd(until, ZONE) });
  const rep = await report(e, d);
  assert.equal(rep.body.status, 'paid');
  const v2 = await report(e, d, {}, 2);
  assert.equal(v2.body.status, 'active');
  for (const answer of [current.body, rep.body, v2.body]) {
    const text = JSON.stringify(answer);
    assert.ok(!text.includes('15000000') && !text.includes('наличными') && !text.includes('paid'.repeat(2)), text);
    assert.ok(!('amount' in answer) && !('note' in answer) && !('paid' in answer));
  }
  assert.ok(!e.log.join('\n').includes('наличными') && !e.log.join('\n').includes('15000000'), 'not even in the log');

  // A paid café is changed by «Продлить оплату», not the trial's buttons.
  assert.equal((await p('POST', `/platform/trials/${d.id}/extend`, { days: 7 })).body.error.code, 'TRIAL_PAID');
  assert.equal((await p('POST', `/platform/trials/${d.id}/end-date`, { date: dayAhead(e, 5) })).body.error.code, 'TRIAL_PAID');
  e.clock.now += 20 * DAY;
  const until2 = dayAhead(e, 365);
  const renewed = await p<TrialView>('POST', `/platform/trials/${d.id}/paid`, { until: until2, amount: null, note: '' });
  assert.equal(renewed.body.status, 'paid');
  assert.equal(renewed.body.paid!.since, MONDAY_NOON, 'when it first bought stays');
  assert.equal(renewed.body.paid!.amount, null);
  assert.deepEqual(renewed.body.paid!.payments.map((x) => x.until), [until2, until], 'newest first');

  // «Сделать постоянной» and «Завершить» work; it stays among the clients who bought (paid is kept), and cannot be deleted.
  const perm = await p<TrialView>('POST', `/platform/trials/${d.id}/permanent`, {});
  assert.equal(perm.body.status, 'permanent');
  assert.ok(perm.body.paid);
  const ended = await p<TrialView>('POST', `/platform/trials/${d.id}/end`, {});
  assert.equal(ended.body.status, 'ended');
  assert.deepEqual((await terms(e, d)).body, { status: 'ended', endsAt: e.clock.now, message: TRIAL_ENDED_MESSAGE });
  assert.equal((await p('DELETE', `/platform/trials/${d.id}`)).body.error.code, 'TRIAL_PAID');
  // Bought again after the end.
  assert.equal((await p<TrialView>('POST', `/platform/trials/${d.id}/paid`, { until: dayAhead(e, 10) })).body.status, 'paid');
});

test('«Купили»: checks — the date (today … 3 years), the amount, the note, a request; the support team may enter it too', async (t) => {
  const { e, p, tech } = await setup(t);
  const d = await desk(e);
  const bad = async (body: unknown, code: string) => {
    const r = await p('POST', `/platform/trials/${d.id}/paid`, body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.equal(r.body.error.code, code);
  };
  await bad({}, 'DATE_INVALID');
  await bad({ until: dayAhead(e, -1) }, 'DATE_INVALID');
  await bad({ until: dayAhead(e, 3 * 366 + 1) }, 'DATE_INVALID');
  await bad({ until: '2026-02-30' }, 'DATE_INVALID');
  await bad({ until: dayAhead(e, 10), amount: -5 }, 'AMOUNT_INVALID');
  await bad({ until: dayAhead(e, 10), amount: 1.5 }, 'AMOUNT_INVALID');
  await bad({ until: dayAhead(e, 10), note: 'x'.repeat(501) }, 'NOTE_INVALID');
  assert.equal((await p('POST', `/platform/trials/${d.id}/paid`, { until: dayAhead(e, 0) })).status, 200, 'paid through today');
  assert.equal((await p('POST', `/platform/trials/${d.id}/paid`, { until: dayAhead(e, 3 * 366) }, tech)).status, 200, 'the support team enters payments too');
  const req = await startRequest(e, { venue: 'Заявка' }, '198.51.100.240');
  assert.equal((await p('POST', `/platform/trials/${req.id}/paid`, { until: dayAhead(e, 10) })).body.error.code, 'TRIAL_NOT_APPROVED');
  assert.equal((await e.call(handlePlatform, 'POST', `/platform/trials/${d.id}/paid`, { body: { until: dayAhead(e, 10) } })).status, 401);
});

test('«Купили»: the day after the paid date the café is read-only with «Оплаченный срок закончился»; a cloud café gets active until that day', async (t) => {
  const hub = fakeHub();
  const { e, p } = await setup(t, { env: HUB_ENV, cloudHubFetch: hub.fetch });
  const d = await desk(e);
  const until = dayAhead(e, 3);
  await p('POST', `/platform/trials/${d.id}/paid`, { until });
  e.clock.now = trialDayEnd(until, ZONE) - 60_000;
  assert.equal((await terms(e, d)).body.status, 'paid', 'the whole paid day works');
  e.clock.now = trialDayEnd(until, ZONE) + 1;
  assert.deepEqual((await terms(e, d)).body, { status: 'expired', endsAt: trialDayEnd(until, ZONE), message: TRIAL_PAID_ENDED_MESSAGE });
  assert.deepEqual((await terms(e, d, '2')).body, { status: 'expired', endsAt: trialDayEnd(until, ZONE), message: TRIAL_PAID_ENDED_MESSAGE });
  const listed = (await p<{ trials: TrialView[] }>('GET', '/platform/trials')).body.trials.find((x) => x.id === d.id)!;
  assert.equal(listed.status, 'expired');
  assert.equal(listed.paid!.until, until);

  const c = await desk(e, 'Облачная');
  await report(e, c, { snapshot: Buffer.concat([Buffer.from('SQLite format 3\0'), randomBytes(2000)]).toString('base64') });
  e.clock.now += HOUR;
  const code = (await p<TrialView>('POST', `/platform/trials/${c.id}/cloud`, {})).body.cloud!.code;
  const cuntil = dayAhead(e, 60);
  const paid = await p<TrialView>('POST', `/platform/trials/${c.id}/paid`, { until: cuntil, amount: 9_900_000, note: 'Kaspi' });
  assert.equal(paid.body.cloud!.termsError, null);
  assert.deepEqual(hub.cafes.get(code)!.terms, { status: 'active', endsAt: trialDayEnd(cuntil, ZONE), message: null });
  assert.ok(!JSON.stringify(hub.calls).includes('Kaspi') && !JSON.stringify(hub.calls).includes('9900000'), 'the Worker never sees the price');
});

test('«Купили»: a week before the end only the platform owner is told, once per term; the café sees nothing', async (t) => {
  const sent: Parameters<typeof recordingSender>[1] = [];
  const { e, owner, tech, p } = await setup(t, { sender: new RoutingSender({ webpush: recordingSender('webpush', sent) }) });
  const sub = (n: string) => JSON.stringify({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'BOr7u1n0lJ3oQ0Cz6Gk3bq3K2vX9Lq6m8bq9mN0pQ1rS2tU3vW4xY5zA6bC7dE8fG9hI0jK1lM2nO3pQ4rS5tU6vW', auth: 'k8JV6sjdbhAi1n3_LDBLvA' } });
  assert.equal((await e.call(handlePlatform, 'POST', '/platform/devices', { headers: owner, body: { platform: 'webpush', token: sub('owner'), name: 'Владелец' } })).status, 200);
  assert.equal((await e.call(handlePlatform, 'POST', '/platform/devices', { headers: tech, body: { platform: 'webpush', token: sub('tech'), name: 'Поддержка' } })).status, 200);
  const cron = () => e.call(handleNotify, 'POST', '/notify', { headers: { 'x-ts-cron': NOTIFY_SECRET } });
  const d = await desk(e);
  const until = dayAhead(e, 10);
  await p('POST', `/platform/trials/${d.id}/paid`, { until, amount: 5_000_000 });
  assert.equal((await cron()).body.paidReminders, 0, 'ten days left: not yet');
  e.clock.now += 4 * DAY; // 6 days and a bit left
  const run = await cron();
  assert.equal(run.body.paidReminders, 1);
  const told = sent.filter((m) => m.title === 'Скоро конец оплаты');
  assert.equal(told.length, 1, 'the owner’s device only, not the support team’s');
  assert.ok(told[0]!.token.includes('/owner'));
  assert.match(told[0]!.body, /«Кофейня «Утро»» — оплачено до .* \(осталось 7 дней\)/);
  assert.ok(!told[0]!.body.includes('50000'), 'no amount in the notice');
  assert.equal((await cron()).body.paidReminders, 0, 'once per term');
  const view = (await p<{ trials: TrialView[] }>('GET', '/platform/trials')).body.trials.find((x) => x.id === d.id)!;
  assert.equal(view.paid!.remindedAt, e.clock.now);
  assert.deepEqual((await terms(e, d)).body, { status: 'paid', endsAt: trialDayEnd(until, ZONE) }, 'the café sees nothing');
  // A new payment: a new term, a new reminder when it comes.
  await p('POST', `/platform/trials/${d.id}/paid`, { until: dayAhead(e, 3) });
  assert.equal((await cron()).body.paidReminders, 1);
});

test('codes: the cash desk reports the café code and the director’s code when they change; only the platform owner sees them, never in logs', async (t) => {
  const { e, p, tech } = await setup(t);
  const d = await desk(e);
  // The café code is kept when the cloud issues it (no report needed).
  const first = await report(e, d, { needCode: true });
  const cafeCode = first.body.cafeCode as string;
  let codes = await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`);
  assert.equal(codes.status, 200);
  assert.deepEqual(codes.body, { cafeCode, cafeCodeKind: 'trial', directorKey: null, directorKeyAt: null, directorKeyStale: false, directorKeyPending: null, directorKeyRefused: false });
  assert.equal(codes.headers.get('cache-control'), 'no-store');

  e.clock.now += 1000;
  await report(e, d, { codes: { cafeCode, directorKey: '482913' } });
  codes = await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`);
  assert.equal(codes.body.directorKey, '482913');
  assert.equal(codes.body.directorKeyAt, MONDAY_NOON + 1000);
  // Junk is dropped: a café code that is not this café's, a weak or malformed key.
  await report(e, d, { codes: { cafeCode: 'K7F392QXM4P8', directorKey: '123456' } });
  await report(e, d, { codes: { directorKey: '12' } });
  codes = await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`);
  assert.equal(codes.body.cafeCode, cafeCode);
  assert.equal(codes.body.directorKey, '482913');
  // The director changed the code in the cash desk and the page does not know the new one.
  await report(e, d, { codes: { directorKeyStale: true } });
  codes = await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`);
  assert.equal(codes.body.directorKeyStale, true);
  assert.equal(codes.body.directorKey, '482913', 'the last known code, marked «может быть изменён»');
  // A director who issued a key in «Сотрудники» has a long one: that is their code now.
  await report(e, d, { codes: { directorKey: 'MGR-ABCD-EFGH-JKMN-PQRS' } });
  assert.equal((await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`)).body.directorKey, 'MGR-ABCD-EFGH-JKMN-PQRS');
  await report(e, d, { codes: { directorKey: '590417' } });
  assert.equal((await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`)).body.directorKeyStale, false);

  // The support team does not see codes; nobody sees them in the list.
  assert.equal((await p('GET', `/platform/trials/${d.id}/codes`, undefined, tech)).status, 403);
  assert.equal((await p('POST', `/platform/trials/${d.id}/director-key`, {}, tech)).status, 403);
  const list = JSON.stringify((await p('GET', '/platform/trials')).body);
  assert.ok(!list.includes('590417') && !list.includes(cafeCode));
  const log = e.log.join('\n');
  assert.ok(log.includes('посмотрел коды кофейни'), 'who looked is logged');
  assert.ok(!log.includes('590417') && !log.includes('482913') && !log.includes(cafeCode), 'what they saw is not');
  const req = await startRequest(e, { venue: 'Заявка' }, '198.51.100.241');
  assert.equal((await p('POST', `/platform/trials/${req.id}/director-key`, {})).body.error.code, 'TRIAL_NOT_APPROVED');
});

test('codes: «Выдать новый код директора» — a browser cash desk installs it on its next report; a refused one is said; a cloud café gets it through the Worker', async (t) => {
  const hub = fakeHub();
  const { e, p } = await setup(t, { env: HUB_ENV, cloudHubFetch: hub.fetch });
  const d = await desk(e);
  await report(e, d, { codes: { directorKey: '482913' } });
  const issued = await p<{ managerKey: string; applied: string; trial: TrialView }>('POST', `/platform/trials/${d.id}/director-key`, {});
  assert.equal(issued.status, 200);
  const key = issued.body.managerKey;
  assert.match(key, /^\d{6}$/);
  assert.equal(issued.body.applied, 'next-report');
  assert.equal((await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`)).body.directorKeyPending, key);
  // Every report's answer carries it until the desk reports it installed.
  assert.equal((await report(e, d)).body.directorKeyNext, key);
  assert.equal((await report(e, d, { codes: { directorKey: '482913' } })).body.directorKeyNext, key);
  const done = await report(e, d, { codes: { directorKey: key } });
  assert.equal(done.body.directorKeyNext, undefined);
  let codes = (await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`)).body;
  assert.deepEqual([codes.directorKey, codes.directorKeyPending, codes.directorKeyRefused], [key, null, false]);
  assert.equal((await report(e, d)).body.directorKeyNext, undefined);
  // Another person of the café has that code: the desk says so, the cabinet asks for another.
  const next = (await p<{ managerKey: string }>('POST', `/platform/trials/${d.id}/director-key`, {})).body.managerKey;
  await report(e, d, { codes: { directorKeyRefused: next } });
  codes = (await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`)).body;
  assert.deepEqual([codes.directorKey, codes.directorKeyPending, codes.directorKeyRefused], [key, null, true]);
  assert.ok(!e.log.join('\n').includes(key) && !e.log.join('\n').includes(next));

  // A cloud café: the Worker sets it at once; its café code is the cloud one.
  await report(e, d, { snapshot: Buffer.concat([Buffer.from('SQLite format 3\0'), randomBytes(2000)]).toString('base64') });
  e.clock.now += HOUR;
  const code = (await p<TrialView>('POST', `/platform/trials/${d.id}/cloud`, {})).body.cloud!.code;
  codes = (await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`)).body;
  assert.deepEqual([codes.cafeCode, codes.cafeCodeKind, codes.directorKey], [code, 'cloud', key], 'the browser’s director code works in the imported café');
  const cloudKey = await p<{ managerKey: string; applied: string }>('POST', `/platform/trials/${d.id}/director-key`, {});
  assert.equal(cloudKey.body.applied, 'cloud');
  assert.equal(cloudKey.body.managerKey, hub.cafes.get(code)!.managerKey);
  assert.equal(hub.count('POST', /\/director-key$/), 1);
  assert.equal((await p<TrialCodesView>('GET', `/platform/trials/${d.id}/codes`)).body.directorKey, cloudKey.body.managerKey);
  hub.failNext(/director-key/, { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Нет такого адреса' } } });
  const refused = await p('POST', `/platform/trials/${d.id}/director-key`, {});
  assert.equal(refused.status, 424, 'a Worker without the new call says so in words');
  assert.match(refused.body.error.message, /Нет такого адреса/);
  // A café approved into the cloud: the cabinet has its director's code from the start.
  const req = await startRequest(e, { venue: 'Новая облачная', managerName: 'Ерлан' }, '198.51.100.242');
  const approved = await p<{ managerKey: string }>('POST', `/platform/trials/${req.id}/approve-cloud`, {});
  assert.equal((await p<TrialCodesView>('GET', `/platform/trials/${req.id}/codes`)).body.directorKey, approved.body.managerKey);
});
