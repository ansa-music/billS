import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SyncEvent } from '@bills/domain';
import { handleNotify } from '../../apps/cloud/src/edge/notify.ts';
import { handleOwner } from '../../apps/cloud/src/edge/owner.ts';
import { handleSync } from '../../apps/cloud/src/edge/sync.ts';
import { handleTelegram } from '../../apps/cloud/src/edge/telegram.ts';
import type { TelegramFetch } from '../../apps/cloud/src/telegram.ts';
import { DEMO_HUBS } from '../../apps/cloud/src/seed.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { clubIdOf, edgeTest, HOUR, linkOwner, MONDAY_NOON, NOTIFY_SECRET, userJwt } from './edge-helpers.ts';

const MIN = 60_000;
const HUB1 = DEMO_HUBS[0];
const BOT_TOKEN = '123456:TEST-token-never-printed';
const WEBHOOK_SECRET = 'tg-webhook-secret-0123456789';
const CABINET = 'https://ts-cabinet.pages.dev';
const ENV = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_BOT_USERNAME: '@TS_test_bot', TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET };

interface ApiCall {
  method: string;
  params: Record<string, any>;
}

/** Fake Bot API: records calls; a chat in `blocked` answers 403 like a user who blocked the bot. */
function fakeTelegram() {
  const calls: ApiCall[] = [];
  const blocked = new Set<string>();
  /** Telegram is down: every call answers 502. */
  const state = { down: false };
  const fetch: TelegramFetch = async (url, init) => {
    if (state.down) return { status: 502, text: async () => 'Bad Gateway' };
    const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    assert.ok(m, `unexpected Telegram URL`);
    assert.equal(m[1], BOT_TOKEN);
    const params = JSON.parse(init.body) as Record<string, any>;
    calls.push({ method: m[2]!, params });
    if (m[2] === 'sendMessage' && blocked.has(String(params.chat_id))) {
      return { status: 403, text: async () => JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) };
    }
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: m[2] === 'getMe' ? { username: 'TS_test_bot' } : { message_id: calls.length } }) };
  };
  const messages = (chatId?: string) =>
    calls.filter((c) => c.method === 'sendMessage' && (chatId === undefined || String(c.params.chat_id) === chatId)).map((c) => c.params);
  return { calls, blocked, state, fetch, messages };
}

async function setup(t: Parameters<typeof edgeTest>[0], env: Record<string, string> = ENV) {
  const tg = fakeTelegram();
  const e = await edgeTest(t, { env, telegramFetch: tg.fetch });
  const uid = await linkOwner(e.s);
  const owner = { authorization: `Bearer ${userJwt(uid)}` };
  return { e, tg, owner };
}

/** What Telegram would POST to the webhook. */
function update(chatId: number, text: string, from: { username?: string; first_name?: string } = { username: 'boss' }) {
  return { update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, text, chat: { id: chatId, type: 'private', ...from }, from } };
}

async function hook(e: EdgeTest, chatId: number, text: string, secret = WEBHOOK_SECRET) {
  return e.call(handleTelegram, 'POST', '/telegram', { headers: { 'x-telegram-bot-api-secret-token': secret }, body: update(chatId, text) });
}

async function linkCode(e: EdgeTest, owner: Record<string, string>): Promise<string> {
  const res = await e.call(handleOwner, 'POST', '/owner/telegram/link', { headers: owner });
  assert.equal(res.status, 200);
  const m = /^https:\/\/t\.me\/TS_test_bot\?start=([A-Za-z0-9_-]{16,64})$/.exec(res.body.url);
  assert.ok(m, res.body.url);
  assert.equal(res.body.expiresAt, e.clock.now + 15 * MIN);
  return m[1]!;
}

async function linked(e: EdgeTest, owner: Record<string, string>) {
  const res = await e.call(handleOwner, 'GET', '/owner/telegram', { headers: owner });
  assert.equal(res.status, 200);
  return res.body;
}

function ev(id: number, at: number, topic: string, entityId: string, data: Record<string, unknown>): SyncEvent {
  return { id, at, topic, payload: { actor: 'system', action: topic, entityType: 'alert', entityId, data } };
}

// ---------------------------------------------------------------------------

test('telegram webhook: forged calls are refused; without the bot it answers 503', async (t) => {
  const { e, tg } = await setup(t);
  assert.equal((await e.call(handleTelegram, 'POST', '/telegram', { body: update(1, '/today') })).status, 401);
  assert.equal((await hook(e, 1, '/today', 'wrong-secret-wrong-secret')).status, 401);
  assert.equal((await hook(e, 1, '/today', WEBHOOK_SECRET.slice(0, -1))).status, 401);
  assert.equal(tg.calls.length, 0, 'nothing answered to a forged call');
  assert.equal((await e.call(handleTelegram, 'GET', '/telegram')).status, 404);

  const ok = await hook(e, 1, 'привет');
  assert.equal(ok.status, 200);
  assert.match(tg.messages('1')[0]!.text, /Это бот TS/);

  // No secret configured → refuse everything (the webhook cannot tell Telegram from a forger).
  e.ctx.telegramWebhookSecret = null;
  const off = await hook(e, 1, '/today');
  assert.equal(off.status, 503);
  assert.equal(off.body.error.code, 'TELEGRAM_NOT_CONFIGURED');
  assert.doesNotMatch(JSON.stringify(off.body), new RegExp(BOT_TOKEN));
});

test('telegram: cabinet without a bot shows «not connected», link refuses', async (t) => {
  const { e, owner } = await setup(t, {});
  assert.deepEqual(await linked(e, owner), { configured: false, botUsername: null, chats: [] });
  const res = await e.call(handleOwner, 'POST', '/owner/telegram/link', { headers: owner });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'TELEGRAM_NOT_CONFIGURED');
  assert.equal((await e.call(handleOwner, 'GET', '/owner/telegram')).status, 401);
});

test('telegram link: valid code links the chat once; reused and expired codes are refused; /stop unlinks', async (t) => {
  const { e, tg, owner } = await setup(t);
  assert.deepEqual(await linked(e, owner), { configured: true, botUsername: 'TS_test_bot', chats: [] });

  const code = await linkCode(e, owner);
  const stored = await e.s.db.all<{ code_hash: string }>('SELECT code_hash FROM telegram_link_codes');
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0]!.code_hash, code, 'only the hash is stored');

  assert.equal((await hook(e, 1001, `/start ${code}`)).status, 200);
  const hello = tg.messages('1001')[0]!;
  assert.match(hello.text, /^Готово! Буду присылать тревоги и сводку дня по заведениям: Клуб «Демо», Клуб «Север»\./);
  assert.equal(hello.parse_mode, 'HTML');
  assert.deepEqual(hello.reply_markup, { inline_keyboard: [[{ text: 'Открыть в кабинете', url: `${CABINET}/` }]] });
  const status = await linked(e, owner);
  assert.deepEqual(status.chats, [{ chatId: '1001', name: '@boss', linkedAt: e.clock.now, muted: false }]);

  // The same code again, from another chat: refused, nothing linked.
  await hook(e, 2002, `/start ${code}`);
  assert.match(tg.messages('2002')[0]!.text, /уже использована или неверна/);
  assert.equal((await linked(e, owner)).chats.length, 1);
  // A redelivered /start from the linked chat itself is not an error.
  await hook(e, 1001, `/start ${code}`);
  assert.match(tg.messages('1001')[1]!.text, /уже подключён/);
  // Junk code.
  await hook(e, 2002, '/start not-a-real-code');
  assert.match(tg.messages('2002')[1]!.text, /уже использована или неверна/);

  // Expired: 15 minutes.
  const late = await linkCode(e, owner);
  e.clock.now += 15 * MIN + 1;
  await hook(e, 3003, `/start@TS_test_bot ${late}`);
  assert.match(tg.messages('3003')[0]!.text, /Ссылка устарела/);
  assert.equal((await linked(e, owner)).chats.length, 1);

  // /stop unlinks; a second /stop says so.
  await hook(e, 1001, '/stop');
  assert.match(tg.messages('1001').at(-1)!.text, /^Отключено/);
  assert.deepEqual((await linked(e, owner)).chats, []);
  await hook(e, 1001, '/stop');
  assert.match(tg.messages('1001').at(-1)!.text, /и так не подключён/);
  // Unlinked chats get no reports.
  await hook(e, 1001, '/today');
  assert.match(tg.messages('1001').at(-1)!.text, /Это бот TS/);
});

test('telegram alerts: delivered to the linked chat with severity, venue and a cabinet button; rules and /mute silence them', async (t) => {
  const { e, tg, owner } = await setup(t);
  await hook(e, 1001, `/start ${await linkCode(e, owner)}`);
  const clubId = await clubIdOf(e.s, HUB1.id);
  const sync = (events: SyncEvent[]) =>
    e.call(handleSync, 'POST', '/sync/events', { headers: { authorization: `Bearer ${HUB1.key}` }, body: { hubId: HUB1.id, settingsVersion: 0, events } });

  await sync([ev(1, MONDAY_NOON, 'alert.raised', 'alert-1', { kind: 'LIGHT_WITHOUT_GAME', tableId: 't2', message: 'Стол 2: свет горит, а игры нет' })]);
  const alert = tg.messages('1001').at(-1)!;
  assert.equal(alert.text, '🟠 <b>Клуб «Демо»: Свет горит без игры</b>\nСтол 2: свет горит, а игры нет');
  assert.deepEqual(alert.reply_markup, { inline_keyboard: [[{ text: 'Открыть в кабинете', url: `${CABINET}/#/clubs/${encodeURIComponent(clubId)}` }]] });
  const row = (await e.s.db.all<{ status: string; delivered: number }>("SELECT status, delivered FROM push_queue WHERE alert_id = 'alert-1'"))[0]!;
  assert.deepEqual(row, { status: 'SENT', delivered: 1 });

  // The owner switched this kind off for this club: nothing goes to Telegram.
  const off = await e.call(handleOwner, 'PUT', '/owner/push/rules', { headers: owner, body: { rules: [{ kind: 'LIGHT_WITHOUT_GAME', clubId, enabled: false }] } });
  assert.equal(off.status, 200);
  const before = tg.messages('1001').length;
  await sync([ev(2, MONDAY_NOON + MIN, 'alert.raised', 'alert-2', { kind: 'LIGHT_WITHOUT_GAME', tableId: 't3', message: 'Стол 3: свет горит, а игры нет' })]);
  assert.equal(tg.messages('1001').length, before);

  // A kind still on, but the chat is paused with /mute.
  await hook(e, 1001, '/mute');
  const muted = tg.messages('1001').length;
  await sync([ev(3, MONDAY_NOON + 2 * MIN, 'alert.raised', 'alert-3', { kind: 'POWER_ON_BATTERY', message: 'Нет электричества' })]);
  assert.equal(tg.messages('1001').length, muted);
  assert.equal((await linked(e, owner)).chats[0].muted, true);
  await hook(e, 1001, '/unmute');
  await sync([ev(4, MONDAY_NOON + 3 * MIN, 'alert.raised', 'alert-4', { kind: 'POWER_CRITICAL', message: 'Батарея 10%' })]);
  assert.match(tg.messages('1001').at(-1)!.text, /^🔴 <b>Клуб «Демо»: Батарея ИБП почти разряжена<\/b>/);

  // Watchdog alerts (HUB silent) go the same way, and «back online» is ✅.
  e.clock.now += 11 * MIN;
  const run = await e.call(handleNotify, 'POST', '/notify', { headers: { 'x-ts-cron': NOTIFY_SECRET } });
  assert.equal(run.status, 200);
  assert.match(tg.messages('1001').at(-1)!.text, /^🟠 <b>Клуб «Демо»: HUB клуба пропал со связи<\/b>/);
  await e.call(handleSync, 'GET', '/sync/settings?since=0', { headers: { authorization: `Bearer ${HUB1.key}` } });
  assert.match(tg.messages('1001').at(-1)!.text, /^✅ <b>Клуб «Демо»: HUB снова на связи<\/b>/);

  // The test push from the cabinet reaches Telegram too.
  const testPush = await e.call(handleOwner, 'POST', '/owner/push/test', { headers: owner });
  assert.equal(testPush.body.pushEnabled, true);
  assert.match(tg.messages('1001').at(-1)!.text, /проверка уведомлений/);
});

test('telegram: a chat that blocked the bot is forgotten; the cabinet can unlink a chat', async (t) => {
  const { e, tg, owner } = await setup(t);
  await hook(e, 1001, `/start ${await linkCode(e, owner)}`);
  await hook(e, 2002, `/start ${await linkCode(e, owner)}`);
  assert.equal((await linked(e, owner)).chats.length, 2);

  tg.blocked.add('2002');
  await e.call(handleSync, 'POST', '/sync/events', {
    headers: { authorization: `Bearer ${HUB1.key}` },
    body: { hubId: HUB1.id, settingsVersion: 0, events: [ev(1, MONDAY_NOON, 'alert.raised', 'a1', { kind: 'POWER_CRITICAL', message: 'Батарея 5%' })] },
  });
  assert.deepEqual((await linked(e, owner)).chats.map((c: { chatId: string }) => c.chatId), ['1001']);
  assert.ok(e.log.some((l) => /больше недоступен боту/.test(l)));
  assert.ok(!e.log.some((l) => l.includes(BOT_TOKEN)), 'the token never reaches the log');

  const del = await e.call(handleOwner, 'DELETE', '/owner/telegram/chats/1001', { headers: owner });
  assert.equal(del.status, 200);
  assert.match(tg.messages('1001').at(-1)!.text, /отключён от TS в кабинете/);
  assert.deepEqual((await linked(e, owner)).chats, []);
  assert.equal((await e.call(handleOwner, 'DELETE', '/owner/telegram/chats/1001', { headers: owner })).status, 404);
});

test('telegram summary: at 21:00 club time once a day — revenue, games, checks, average check, change to last week; /today on demand', async (t) => {
  const { e, tg, owner } = await setup(t);
  await hook(e, 1001, `/start ${await linkCode(e, owner)}`);
  const demo = await clubIdOf(e.s, DEMO_HUBS[0].id);
  const north = await clubIdOf(e.s, DEMO_HUBS[1].id);
  const day = async (clubId: string, d: string, paid: number, games: number, checks: number) =>
    e.s.db.run('INSERT INTO daily_stats (club_id, day, revenue, games, paid_total, checks_paid) VALUES (?, ?, ?, ?, ?, ?)', [clubId, d, paid, games, paid, checks]);
  // Monday 2026-10-12 vs Monday 2026-10-05 (amounts in tiyn).
  await day(demo, '2026-10-12', 125_000_00, 14, 20);
  await day(demo, '2026-10-05', 100_000_00, 10, 16);
  await day(north, '2026-10-12', 30_000_00, 3, 3);
  const notify = () => e.call(handleNotify, 'POST', '/notify', { headers: { 'x-ts-cron': NOTIFY_SECRET } });
  const summaries = () => tg.messages('1001').filter((m) => /Итоги дня/.test(m.text));

  // /today at noon: so far.
  await hook(e, 1001, '/today');
  const today = tg.messages('1001').at(-1)!;
  assert.match(today.text, /^📊 <b>Сегодня, 12\.10 на 12:00<\/b>/);
  assert.match(today.text, /<b>Клуб «Демо»<\/b>\n💰 Выручка: 125\s000\s₸ \(▲ 25% к прошлому понедельнику\)\n🎱 Игры: 14 · 🧾 Чеков: 20 · Средний чек: 6\s250\s₸/);

  // 20:55 in Almaty: not yet.
  e.clock.now = MONDAY_NOON + 8 * HOUR + 55 * MIN;
  assert.equal((await notify()).body.summaries, 0);
  assert.equal(summaries().length, 0);

  // 21:00: one message with both venues.
  e.clock.now = MONDAY_NOON + 9 * HOUR;
  assert.equal((await notify()).body.summaries, 1);
  const [s] = summaries();
  assert.match(s!.text, /^📊 <b>Итоги дня, 12\.10<\/b>\n\n<b>Клуб «Демо»<\/b>\n💰 Выручка: 125\s000\s₸ \(▲ 25% к прошлому понедельнику\)/);
  assert.match(s!.text, /<b>Клуб «Север»<\/b>\n💰 Выручка: 30\s000\s₸ \(неделю назад выручки не было\)\n🎱 Игры: 3 · Средний чек: 10\s000\s₸/);
  assert.deepEqual(s!.reply_markup, { inline_keyboard: [[{ text: 'Открыть в кабинете', url: `${CABINET}/` }]] });

  // The next runs that evening send nothing more.
  e.clock.now += 5 * MIN;
  assert.equal((await notify()).body.summaries, 0);
  e.clock.now = MONDAY_NOON + 11 * HOUR + 50 * MIN; // 23:50
  await notify();
  assert.equal(summaries().length, 1);

  // A failed send is retried on the next run; a muted chat gets nothing.
  e.clock.now = MONDAY_NOON + 24 * HOUR + 9 * HOUR; // Tuesday 21:00
  tg.state.down = true;
  assert.equal((await notify()).body.summaries, 0);
  tg.state.down = false;
  e.clock.now += 5 * MIN;
  assert.equal((await notify()).body.summaries, 1);
  assert.match(summaries().at(-1)!.text, /Итоги дня, 13\.10/);
  assert.match(summaries().at(-1)!.text, /Выручка: 0\s₸ \(неделю назад тоже без выручки\)/);

  await hook(e, 1001, '/mute');
  e.clock.now = MONDAY_NOON + 48 * HOUR + 9 * HOUR; // Wednesday 21:00
  assert.equal((await notify()).body.summaries, 0);
});
