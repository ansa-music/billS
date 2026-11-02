import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrialStats, TrialView } from '@bills/domain';
import {
  TRIAL_ENDED_MESSAGE,
  TRIAL_PERMANENT_LEGACY_ENDS_AT,
  TRIAL_RELOAD_ID,
  TRIAL_RELOAD_MESSAGE,
  TRIAL_RELOAD_TOKEN,
} from '@bills/domain';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { handleTelegram } from '../../apps/cloud/src/edge/telegram.ts';
import { handleTrial } from '../../apps/cloud/src/edge/trial.ts';
import { notifyTrialRequest } from '../../apps/cloud/src/platform-notify.ts';
import { RoutingSender } from '../../apps/cloud/src/push.ts';
import type { TelegramFetch } from '../../apps/cloud/src/telegram.ts';
import { TelegramBot } from '../../apps/cloud/src/telegram.ts';
import { DEMO_PLATFORM } from '../../apps/cloud/src/seed.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, HOUR, linkOwner, MONDAY_NOON, recordingSender, userJwt } from './edge-helpers.ts';
import { createSupabaseDb, readMigration } from './harness.ts';
import { approve, newInstallId, platformAuth, startActive, startRequest } from './trial-helpers.ts';

const DAY = 24 * HOUR;
const MIN = 60_000;
const BOT_TOKEN = '123456:TEST-token-never-printed';
const WEBHOOK_SECRET = 'tg-webhook-secret-0123456789';
const CABINET = 'https://ts-cabinet.pages.dev';
const TG_ENV = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_BOT_USERNAME: '@TS_test_bot', TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, TS_CABINET_URL: CABINET };

const STATS: TrialStats = {
  ordersTotal: 1,
  ordersToday: 1,
  revenueTotal: 1_500,
  revenueToday: 1_500,
  productsCount: 9,
  staffCount: 1,
  shiftOpen: false,
  lastOrderAt: null,
  days: [],
};

/** A browser push subscription as the cabinet sends it (the keys are only stored here, never used to encrypt). */
const SUBSCRIPTION = JSON.stringify({
  endpoint: 'https://fcm.googleapis.com/fcm/send/platform-owner-1',
  keys: { p256dh: 'BOr7u1n0lJ3oQ0Cz6Gk3bq3K2vX9Lq6m8bq9mN0pQ1rS2tU3vW4xY5zA6bC7dE8fG9hI0jK1lM2nO3pQ4rS5tU6vW', auth: 'k8JV6sjdbhAi1n3_LDBLvA' },
});

const trialCount = async (e: EdgeTest): Promise<number> => Number((await e.s.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM trials'))[0]!.n);

/** Fake Bot API: records the calls; `down` answers 502, `hang` never answers. */
function fakeTelegram() {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const state = { down: false, hang: false };
  const fetch: TelegramFetch = async (url, init) => {
    if (state.hang) return new Promise(() => {});
    if (state.down) return { status: 502, text: async () => 'Bad Gateway' };
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    assert.ok(m, 'unexpected Telegram URL');
    const params = JSON.parse(init.body) as Record<string, any>;
    calls.push({ method: m[2]!, params });
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: m[2] === 'getMe' ? { username: 'TS_test_bot' } : { message_id: calls.length } }) };
  };
  const messages = (chatId: string) => calls.filter((c) => c.method === 'sendMessage' && String(c.params.chat_id) === chatId).map((c) => c.params);
  return { state, fetch, messages };
}

function update(chatId: number, text: string) {
  return { update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, text, chat: { id: chatId, type: 'private', username: 'ts_owner' }, from: { username: 'ts_owner' } } };
}

async function hook(e: EdgeTest, chatId: number, text: string) {
  const r = await e.call(handleTelegram, 'POST', '/telegram', { headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET }, body: update(chatId, text) });
  assert.equal(r.status, 200);
}

/** «Получать заявки в Telegram» in the platform cabinet, then «Запустить» in Telegram. */
async function linkPlatformChat(e: EdgeTest, owner: Record<string, string>, chatId: number): Promise<void> {
  const link = await e.call(handlePlatform, 'POST', '/platform/telegram/link', { headers: owner });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  const m = /^https:\/\/t\.me\/TS_test_bot\?start=([A-Za-z0-9_-]{16,64})$/.exec(link.body.url);
  assert.ok(m, link.body.url);
  assert.equal(link.body.expiresAt, e.clock.now + 15 * MIN);
  await hook(e, chatId, `/start ${m[1]}`);
}

test('requests: the same installId returns the same trial — a lost answer makes no second row; the old token stops working', async (t) => {
  const e = await edgeTest(t);
  const s = await startRequest(e, { venue: 'Coffee book', managerName: 'Аиша', timezone: 'Asia/Almaty' });
  e.clock.now += 10 * MIN;
  const again = await e.call(handleTrial, 'POST', '/trial/start', { headers: { 'x-forwarded-for': '198.51.100.4' }, body: { venue: 'Coffee book', installId: s.installId } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.id, s.id);
  assert.notEqual(again.body.token, s.token);
  assert.equal(again.body.status, 'pending');
  assert.equal(again.body.startedAt, MONDAY_NOON);
  assert.equal(await trialCount(e), 1);
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}&v=2`, { headers: s.auth })).status, 401, 'the lost token is dead');
  const fresh = { authorization: `Bearer ${again.body.token}` };
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}&v=2`, { headers: fresh })).body.status, 'pending');

  // After the approval the same browser still finds it (now active), and still nothing new is stored.
  await approve(e, s.id);
  const later = await e.call(handleTrial, 'POST', '/trial/start', { body: { venue: 'Coffee book', installId: s.installId } });
  assert.equal(later.status, 200);
  assert.equal(later.body.id, s.id);
  assert.equal(later.body.status, 'active');
  assert.equal(await trialCount(e), 1);
  // Only the first start was news for the platform team.
  assert.equal(e.log.filter((l) => l.includes('новая заявка')).length, 1);
});

test('requests: approve / reject (with a message) / permanent / delete — platform rights like extend and end; the page sees each', async (t) => {
  const e = await edgeTest(t);
  // Sessions expire: both sign in again after the clock jumps ahead.
  let owner = await platformAuth(e);
  let tech = await platformAuth(e, DEMO_PLATFORM[1].key);
  const a = await startRequest(e, { venue: 'Первая' });
  const b = await startRequest(e, { venue: 'Вторая' });
  const c = await startRequest(e, { venue: 'Третья' });
  const act = (id: string, what: string, headers: Record<string, string> = owner, body?: unknown) =>
    e.call<TrialView & { error?: { code: string } }>(handlePlatform, 'POST', `/platform/trials/${id}/${what}`, { headers, ...(body === undefined ? {} : { body }) });
  const terms = async (s: { id: string; auth: Record<string, string> }, v = true) =>
    (await e.call(handleTrial, 'GET', `/trial/terms?id=${s.id}${v ? '&v=2' : ''}`, { headers: s.auth })).body;

  // Refused: no session, a client's manager, the trial's own token.
  const uid = await linkOwner(e.s);
  for (const headers of [{}, { authorization: `Bearer ${userJwt(uid)}` }, a.auth]) {
    for (const what of ['approve', 'reject', 'permanent']) assert.equal((await act(a.id, what, headers)).status, 401, `${what} ${JSON.stringify(headers)}`);
    assert.equal((await e.call(handlePlatform, 'DELETE', `/platform/trials/${a.id}`, { headers })).status, 401);
  }
  assert.equal((await terms(a)).status, 'pending', 'nothing changed by the refused calls');

  // A request cannot be extended, dated or ended — it is approved, rejected or deleted.
  for (const [what, body] of [['extend', { days: 7 }], ['end-date', { date: '2026-10-20' }], ['end', undefined]] as const) {
    const r = await act(a.id, what, owner, body);
    assert.equal(r.status, 409, what);
    assert.equal(r.body.error!.code, 'TRIAL_NOT_APPROVED');
  }

  // «Отклонить» with a message: the page reads it; an old page reads it as «ended».
  assert.equal((await act(b.id, 'reject', owner, { message: 'x'.repeat(301) })).status, 422);
  e.clock.now += HOUR;
  const rejected = await act(b.id, 'reject', owner, { message: '  у вас уже есть пробная версия — откройте её там, где начинали  ' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.status, 'rejected');
  assert.equal(rejected.body.ownerMessage, 'у вас уже есть пробная версия — откройте её там, где начинали');
  assert.equal(rejected.body.decidedAt, e.clock.now);
  assert.deepEqual(await terms(b), { status: 'rejected', endsAt: MONDAY_NOON + 14 * DAY, message: 'у вас уже есть пробная версия — откройте её там, где начинали' });
  assert.deepEqual(await terms(b, false), { status: 'ended', endsAt: e.clock.now, message: 'у вас уже есть пробная версия — откройте её там, где начинали' });
  assert.equal((await act(b.id, 'reject')).status, 409, 'only a pending request is rejected');
  assert.equal((await act(b.id, 'extend', owner, { days: 3 })).status, 409);
  assert.ok(e.log.some((l) => l.includes('отклонил заявку') && l.includes(b.id)));
  // Without a message: the page uses its own words.
  const quiet = await act(c.id, 'reject', tech, {});
  assert.equal(quiet.body.ownerMessage, null);
  assert.deepEqual(await terms(c), { status: 'rejected', endsAt: MONDAY_NOON + 14 * DAY });

  // TS changed its mind: a rejected request is approved after all — 14 days from now.
  const yes = await act(c.id, 'approve', tech);
  assert.equal(yes.body.status, 'active');
  assert.equal(yes.body.startedAt, e.clock.now);
  assert.equal(yes.body.endsAt, e.clock.now + 14 * DAY);
  assert.equal(yes.body.ownerMessage, null);
  assert.equal((await act(c.id, 'approve')).status, 409, 'approving twice');
  // A running trial is not deleted: it is ended first.
  const running = await e.call(handlePlatform, 'DELETE', `/platform/trials/${c.id}`, { headers: tech });
  assert.equal(running.status, 409);
  assert.equal(running.body.error.code, 'TRIAL_RUNNING');

  // «Сделать постоянной» on a request: it starts now, without an end.
  e.clock.now += HOUR;
  const perm = await act(a.id, 'permanent');
  assert.equal(perm.status, 200, JSON.stringify(perm.body));
  assert.equal(perm.body.status, 'permanent');
  assert.equal(perm.body.startedAt, e.clock.now);
  assert.ok(e.log.some((l) => l.includes('сделал постоянной') && l.includes(a.id)));
  assert.equal((await terms(a)).status, 'permanent');
  // An old page (no v) hears «active» until 2100: its license never runs out.
  assert.deepEqual(await terms(a, false), { status: 'active', endsAt: TRIAL_PERMANENT_LEGACY_ENDS_AT });
  const rep = await e.call(handleTrial, 'POST', '/trial/report', { headers: a.auth, body: { id: a.id, stats: STATS } });
  assert.deepEqual(rep.body, { status: 'active', endsAt: TRIAL_PERMANENT_LEGACY_ENDS_AT });
  const repNew = await e.call(handleTrial, 'POST', '/trial/report', { headers: a.auth, body: { id: a.id, v: 2, stats: STATS } });
  assert.equal(repNew.body.status, 'permanent');
  // Permanent never expires, whatever ends_at was.
  e.clock.now += 400 * DAY;
  owner = await platformAuth(e);
  tech = await platformAuth(e, DEMO_PLATFORM[1].key);
  assert.equal((await terms(a)).status, 'permanent');
  // A permanent one cannot be deleted; a date puts it back on a term, «Продлить» counts from today, «Завершить» ends it.
  assert.equal((await e.call(handlePlatform, 'DELETE', `/platform/trials/${a.id}`, { headers: owner })).status, 409);
  const ext = await act(a.id, 'extend', owner, { days: 7 });
  assert.equal(ext.body.status, 'active');
  assert.equal(ext.body.endsAt, e.clock.now + 7 * DAY);
  assert.equal((await act(a.id, 'permanent')).body.status, 'permanent');
  const ended = await act(a.id, 'end');
  assert.equal(ended.body.status, 'ended');
  assert.deepEqual(await terms(a), { status: 'ended', endsAt: e.clock.now, message: TRIAL_ENDED_MESSAGE });
  // An ended one can be made permanent too.
  assert.equal((await act(a.id, 'permanent')).body.status, 'permanent');
  assert.equal((await act(a.id, 'permanent')).body.status, 'permanent', 'twice is fine');

  // «Удалить»: the rejected request goes with its snapshot and watch links.
  await e.call(handleTrial, 'POST', '/trial/report', { headers: b.auth, body: { id: b.id, stats: STATS, snapshot: Buffer.from('SQLite format 3\0').toString('base64') } });
  assert.equal((await e.call(handleTrial, 'POST', '/trial/watch/links', { headers: b.auth, body: { id: b.id } })).status, 201);
  const del = await e.call(handlePlatform, 'DELETE', `/platform/trials/${b.id}`, { headers: owner });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.deepEqual(del.body, { deleted: b.id, venue: 'Вторая' });
  assert.ok(e.log.some((l) => l.includes('удалил') && l.includes(b.id)));
  assert.equal(Number((await e.s.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM trial_viewers'))[0]!.n), 0);
  const gone = await e.call(handleTrial, 'GET', `/trial/terms?id=${b.id}&v=2`, { headers: b.auth });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.error.code, 'TRIAL_NOT_FOUND');
  assert.equal((await e.call(handlePlatform, 'DELETE', `/platform/trials/${b.id}`, { headers: owner })).status, 404);
  // Once over (here: expired long ago), the support team may delete it as well.
  e.clock.now += 30 * DAY;
  owner = await platformAuth(e);
  tech = await platformAuth(e, DEMO_PLATFORM[1].key);
  assert.equal((await terms(c)).status, 'expired');
  assert.equal((await e.call(handlePlatform, 'DELETE', `/platform/trials/${c.id}`, { headers: tech })).status, 200, 'expired → deletable');
  const d = await startRequest(e, { venue: 'Четвёртая' });
  assert.equal((await e.call(handlePlatform, 'DELETE', `/platform/trials/${d.id}`, { headers: owner })).status, 200, 'a pending request → deletable');
  const list = await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/trials', { headers: owner });
  assert.deepEqual(list.body.trials.map((v) => [v.venue, v.status]), [['Первая', 'permanent']]);
});

test('requests: «похоже на повтор» — the same venue (any case and spaces), or the same manager from the same address', async (t) => {
  const e = await edgeTest(t);
  const owner = await platformAuth(e);
  const a = await startActive(e, { venue: 'Coffee book', managerName: 'Аиша', timezone: 'Asia/Almaty' }, '198.51.100.1');
  e.clock.now += HOUR;
  const b = await startRequest(e, { venue: '  coffee   BOOK ', managerName: 'Аиша' }, '198.51.100.2');
  e.clock.now += HOUR;
  const c = await startRequest(e, { venue: 'Кофе Тау', managerName: ' аиша ' }, '198.51.100.1');
  e.clock.now += HOUR;
  const d = await startRequest(e, { venue: 'Другая', managerName: 'Аиша' }, '198.51.100.3');
  const list = await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/trials', { headers: owner });
  // Requests first (newest first), then the trials.
  assert.deepEqual(list.body.trials.map((v) => v.id), [d.id, c.id, b.id, a.id]);
  const original = { id: a.id, venue: 'Coffee book', managerName: 'Аиша', status: 'active', startedAt: MONDAY_NOON };
  const dupOf = (id: string) => list.body.trials.find((v) => v.id === id)!.duplicateOf;
  assert.deepEqual(dupOf(b.id), original);
  assert.deepEqual(dupOf(c.id), original, 'same manager, same address');
  assert.equal(dupOf(d.id), null, 'same name from another address is another person');
  assert.equal(dupOf(a.id), null);
});

test('requests: a page from before requests (no installId) is told to reload — nothing stored, its own parser takes the answer, no loop', async (t) => {
  const e = await edgeTest(t);
  // The live page's parser before requests (apps/web trial-cloud.ts parseTerms + trial-store.ts isStatus), verbatim.
  const oldIsStatus = (v: unknown) => v === 'active' || v === 'ended' || v === 'expired';
  const oldParseTerms = (body: unknown) => {
    if (!body || typeof body !== 'object') return null;
    const o = body as Record<string, unknown>;
    if (!oldIsStatus(o.status) || typeof o.endsAt !== 'number' || !Number.isFinite(o.endsAt)) return null;
    const message = typeof o.message === 'string' ? o.message.trim() : '';
    return { status: o.status, endsAt: o.endsAt, ...(message ? { message } : {}) };
  };
  // A request would be dropped as «unexpected» — and that page would /start again in 5 minutes, without an installId.
  assert.equal(oldParseTerms({ status: 'pending', endsAt: MONDAY_NOON }), null);
  assert.equal(oldParseTerms({ status: 'permanent', endsAt: MONDAY_NOON }), null);

  for (let i = 0; i < 30; i++) {
    const r = await e.call(handleTrial, 'POST', '/trial/start', {
      headers: { 'x-forwarded-for': '203.0.113.77' },
      body: { venue: 'Coffee book', managerName: 'Аиша', timezone: 'Asia/Almaty', startedAt: MONDAY_NOON - HOUR },
    });
    assert.equal(r.status, 201, `start ${i}: never 429, nothing stored`);
    assert.deepEqual(r.body, { id: TRIAL_RELOAD_ID, token: TRIAL_RELOAD_TOKEN, startedAt: MONDAY_NOON, status: 'ended', endsAt: MONDAY_NOON, message: TRIAL_RELOAD_MESSAGE });
    // What that page does with it: keeps the id and token (so it never starts again), counter read-only, says reload.
    assert.deepEqual(oldParseTerms(r.body), { status: 'ended', endsAt: MONDAY_NOON, message: TRIAL_RELOAD_MESSAGE });
  }
  assert.equal(await trialCount(e), 0);
  assert.equal(Number((await e.s.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM trial_attempts'))[0]!.n), 0);
  assert.ok(!e.log.some((l) => l.includes('новая заявка')));
  // Its reports then go to the reload id: 404, which that page logs and retries later — nothing is ever created.
  const rep = await e.call(handleTrial, 'POST', '/trial/report', { headers: { authorization: `Bearer ${TRIAL_RELOAD_TOKEN}` }, body: { id: TRIAL_RELOAD_ID, stats: STATS } });
  assert.equal(rep.status, 404);
  assert.equal(await trialCount(e), 0);

  // The old page of a trial that already runs keeps working: the answers stay in its words.
  const running = await startActive(e, { venue: 'Старая касса' });
  const old = await e.call(handleTrial, 'POST', '/trial/report', { headers: running.auth, body: { id: running.id, stats: STATS } });
  assert.deepEqual(oldParseTerms(old.body), { status: 'active', endsAt: MONDAY_NOON + 14 * DAY });
  const owner = await platformAuth(e);
  await e.call(handlePlatform, 'POST', `/platform/trials/${running.id}/permanent`, { headers: owner });
  const perm = await e.call(handleTrial, 'GET', `/trial/terms?id=${running.id}`, { headers: running.auth });
  assert.deepEqual(oldParseTerms(perm.body), { status: 'active', endsAt: TRIAL_PERMANENT_LEGACY_ENDS_AT });
});

test('requests: a new request reaches the platform team in Telegram and by Web Push, with a link to «Пробные версии»', async (t) => {
  const tg = fakeTelegram();
  const e = await edgeTest(t, { env: TG_ENV, telegramFetch: tg.fetch });
  const owner = await platformAuth(e);

  // Nothing linked yet: the cabinet shows the bot and no chats; a request starts all the same.
  assert.deepEqual((await e.call(handlePlatform, 'GET', '/platform/telegram', { headers: owner })).body, { configured: true, botUsername: 'TS_test_bot', chats: [] });
  await startRequest(e, { venue: 'Ранняя' }, '198.51.100.20');

  await linkPlatformChat(e, owner, 5005);
  assert.match(tg.messages('5005')[0]!.text, /^Готово! Сюда будут приходить новые заявки на пробные версии TS\./);
  assert.deepEqual(tg.messages('5005')[0]!.reply_markup, { inline_keyboard: [[{ text: 'Открыть пробные версии', url: `${CABINET}/#/platform/trials` }]] });
  const status = await e.call(handlePlatform, 'GET', '/platform/telegram', { headers: owner });
  assert.deepEqual(status.body.chats, [{ chatId: '5005', name: '@ts_owner', linkedAt: MONDAY_NOON, muted: false }]);
  // The chat is not an owner's: /today is not offered, the bot says what this chat is for.
  await hook(e, 5005, '/help');
  assert.match(tg.messages('5005').at(-1)!.text, /^Этот чат получает новые заявки на пробные версии TS\./);

  const dev = await e.call(handlePlatform, 'POST', '/platform/devices', { headers: owner, body: { platform: 'webpush', token: SUBSCRIPTION, name: 'Chrome, Android' } });
  assert.equal(dev.status, 200, JSON.stringify(dev.body));
  assert.equal(dev.body.name, 'Chrome, Android');
  assert.equal((await e.call(handlePlatform, 'POST', '/platform/devices', { headers: owner, body: { platform: 'ntfy', token: 'https://ntfy.sh/x' } })).status, 400);
  assert.equal((await e.call(handlePlatform, 'POST', '/platform/devices', { headers: owner, body: { platform: 'webpush', token: '{}' } })).status, 400);
  const devices = await e.call(handlePlatform, 'GET', '/platform/devices', { headers: owner });
  assert.equal(devices.body.pushEnabled, true);
  assert.equal(devices.body.devices.length, 1);

  // A café owner's session cannot read or link the platform's chats and devices.
  const uid = await linkOwner(e.s);
  for (const [method, path] of [['GET', '/platform/telegram'], ['POST', '/platform/telegram/link'], ['GET', '/platform/devices'], ['POST', '/platform/notify/test']] as const) {
    assert.equal((await e.call(handlePlatform, method, path, { headers: { authorization: `Bearer ${userJwt(uid)}` } })).status, 401, path);
  }

  const sentBefore = e.sent.length;
  await startRequest(e, { venue: 'coffee book', managerName: 'Аиша', timezone: 'Asia/Almaty' }, '198.51.100.21');
  const msg = tg.messages('5005').at(-1)!;
  assert.equal(msg.text, '☕ <b>Новая заявка на пробную версию</b>\n«coffee book» · Аиша · Алматы');
  assert.deepEqual(msg.reply_markup, { inline_keyboard: [[{ text: 'Открыть пробные версии', url: `${CABINET}/#/platform/trials` }]] });
  assert.equal(e.sent.length, sentBefore + 1);
  const push = e.sent.at(-1)!;
  assert.equal(push.channel, 'webpush');
  assert.equal(push.token, SUBSCRIPTION);
  assert.equal(push.title, 'Новая заявка на пробную версию');
  assert.equal(push.body, '«coffee book» · Аиша · Алматы');
  assert.deepEqual(push.data, { kind: 'OTHER', clubId: '', url: '#/platform/trials' });

  // A repeat says what it repeats (no zone from the browser: the trial counts in Almaty).
  e.clock.now += DAY;
  await startRequest(e, { venue: 'Coffee Book ', managerName: 'Аиша' }, '198.51.100.22');
  assert.equal(tg.messages('5005').at(-1)!.text, '☕ <b>Новая заявка на пробную версию</b>\n«Coffee Book» · Аиша · Алматы\nПохоже на повтор: «coffee book» (Аиша, заявка от 12 октября)');
  // Once the first one is approved, a repeat says since when it runs.
  const first = (await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/trials', { headers: owner })).body.trials.find((v) => v.venue === 'coffee book')!;
  await approve(e, first.id, owner);
  await startRequest(e, { venue: 'COFFEE BOOK', managerName: 'Аиша', timezone: 'Asia/Almaty' }, '198.51.100.24');
  assert.equal(tg.messages('5005').at(-1)!.text, `☕ <b>Новая заявка на пробную версию</b>\n«COFFEE BOOK» · Аиша · Алматы\nПохоже на повтор: «coffee book» (Аиша, с 13 октября)`);

  // «Проверить» reaches the same chat and device.
  const check = await e.call(handlePlatform, 'POST', '/platform/notify/test', { headers: owner });
  assert.deepEqual(check.body, { delivered: 2, failed: 0 });
  assert.match(tg.messages('5005').at(-1)!.text, /проверка уведомлений/);

  // /mute pauses the chat (the device still gets it); /stop unlinks it.
  await hook(e, 5005, '/mute');
  assert.match(tg.messages('5005').at(-1)!.text, /^Пауза: заявки на пробные версии не будут приходить/);
  const muted = tg.messages('5005').length;
  await startRequest(e, { venue: 'Тихая' }, '198.51.100.23');
  assert.equal(tg.messages('5005').length, muted);
  await hook(e, 5005, '/stop');
  assert.match(tg.messages('5005').at(-1)!.text, /^Отключено\. Заявки на пробные версии больше не придут/);
  assert.deepEqual((await e.call(handlePlatform, 'GET', '/platform/telegram', { headers: owner })).body.chats, []);

  // Removing the device from the cabinet.
  assert.equal((await e.call(handlePlatform, 'DELETE', `/platform/devices/${dev.body.id}`, { headers: owner })).status, 200);
  assert.equal((await e.call(handlePlatform, 'DELETE', `/platform/devices/${dev.body.id}`, { headers: owner })).status, 404);
});

test('requests: Telegram down, a dead push subscription, a hanging Bot API — the request is stored and answered all the same', async (t) => {
  const tg = fakeTelegram();
  const sent: Parameters<typeof recordingSender>[1] = [];
  let pushAnswer: () => { ok: false; error: string; unregistered: boolean } = () => ({ ok: false, error: 'Web Push 500: boom', unregistered: false });
  const sender = new RoutingSender({ webpush: recordingSender('webpush', sent, () => pushAnswer()) });
  const e = await edgeTest(t, { env: TG_ENV, telegramFetch: tg.fetch, sender });
  const owner = await platformAuth(e);
  await linkPlatformChat(e, owner, 6006);
  await e.call(handlePlatform, 'POST', '/platform/devices', { headers: owner, body: { platform: 'webpush', token: SUBSCRIPTION } });

  tg.state.down = true;
  const s = await startRequest(e, { venue: 'Без связи' });
  assert.equal(s.body.status, 'pending');
  assert.equal(await trialCount(e), 1);
  assert.ok(e.log.some((l) => l.includes('Telegram: заявка не доставлена')));
  assert.ok(e.log.some((l) => l.includes('Push: заявка не доставлена')));
  const [row] = await e.s.db.all<{ last_error: string }>('SELECT last_error FROM platform_devices');
  assert.equal(row!.last_error, 'Web Push 500: boom');

  // The browser dropped the subscription (410): the device is forgotten.
  pushAnswer = () => ({ ok: false, error: 'Web Push 410: gone', unregistered: true });
  await startRequest(e, { venue: 'Вторая' });
  assert.equal(Number((await e.s.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM platform_devices'))[0]!.n), 0);

  // A Bot API that never answers holds the start only for the timeout.
  tg.state.down = false;
  tg.state.hang = true;
  const view = (await e.call<{ trials: TrialView[] }>(handlePlatform, 'GET', '/platform/trials', { headers: owner })).body.trials[0]!;
  const log: string[] = [];
  const bot = new TelegramBot({ token: BOT_TOKEN, username: 'TS_test_bot', fetch: tg.fetch });
  const res = await notifyTrialRequest({ db: e.s.db, sender: null, telegram: bot, cabinetUrl: CABINET, log: (m) => log.push(m) }, view, 50);
  assert.equal(res, null);
  assert.ok(log.some((l) => l.includes('не успело уйти')));
});

test('requests: the migration keeps the trials that exist exactly as they were', async (t) => {
  const MIGRATION = '20261103100000_trial_requests.sql';
  const s = await createSupabaseDb({ skip: (f) => f === MIGRATION });
  t.after(() => s.close());
  await s.db.run(
    `INSERT INTO trials (id, venue, manager_name, timezone, token_hash, status, started_at, ends_at, created_ip) VALUES
     ('11111111-1111-4111-8111-111111111111', 'Идёт', 'А', 'Asia/Almaty', 'h1', 'active', '2026-10-20T07:00:00Z', '2026-11-03T07:00:00Z', '198.51.100.1'),
     ('22222222-2222-4222-8222-222222222222', 'Завершена', '', NULL, 'h2', 'ended', '2026-10-01T07:00:00Z', '2026-10-10T07:00:00Z', NULL)`,
  );
  const read = () => s.db.all('SELECT * FROM trials ORDER BY id');
  const before = await read();
  await s.pg.exec(readMigration(MIGRATION));
  const after = (await read()) as Array<Record<string, unknown>>;
  assert.deepEqual(
    after.map(({ install_hash, requested_at, decided_at, owner_message, ...rest }) => {
      assert.deepEqual([install_hash, requested_at, decided_at, owner_message], [null, null, null, null]);
      return rest;
    }),
    before,
  );
  // Applying it twice is harmless; an unknown status is still refused.
  await s.pg.exec(readMigration(MIGRATION));
  await assert.rejects(s.db.run("UPDATE trials SET status = 'paused' WHERE venue = 'Идёт'"));
  assert.ok(newInstallId().length >= 16);
});
