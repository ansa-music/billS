import { createHash, randomBytes } from 'node:crypto';
import type { PushKind, TelegramChatView } from '@bills/domain';
import { cabinetClubUrl, formatMoney, isTelegramStartCode, normalizeBotUsername, TELEGRAM_LINK_TTL_MS } from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { addDays, localDay, localParts } from './localtime.ts';
import type { Log, OwnerChannel, PushMessage } from './push.ts';
import { companyClubs, periodStats } from './reports.ts';
import type { ClubRow } from './settings.ts';
import { businessTypeOf } from './settings.ts';

/**
 * «TS в Telegram» (Supabase cloud): the owner links a Telegram chat from the cabinet and gets
 *
 *   alerts         push_queue ─▶ PushDispatcher ─▶ owner's rules ─▶ TelegramChannel ─▶ sendMessage
 *   evening summary  notify (pg_cron, every 5 min) ─▶ runDailySummaries: at 21:00 club time, once a day
 *   commands       Telegram ─▶ Edge Function `telegram` (webhook) ─▶ handleTelegramUpdate
 *
 * Linking: the cabinet makes a one-time code (sha256 stored, 15 minutes) and opens
 * `https://t.me/<bot>?start=<code>`; the bot gets `/start <code>` and writes owner_telegram.
 * Only `fetch` is used (no SDK), so it runs in Node (tests) and Deno (Edge Functions).
 */

// ---------------------------------------------------------------------------
// Bot API
// ---------------------------------------------------------------------------

export type TelegramFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface TelegramResult<T = unknown> {
  ok: boolean;
  result?: T;
  /** HTTP status; 0 when Telegram could not be reached. */
  status: number;
  description: string;
  /** The chat is gone for the bot (blocked, kicked, deleted): forget it. */
  gone: boolean;
}

export interface InlineButton {
  text: string;
  url: string;
}

export interface TelegramBotOptions {
  token: string;
  /** TELEGRAM_BOT_USERNAME; asked from Telegram (getMe) when missing. */
  username?: string | null;
  fetch?: TelegramFetch;
  /** https://api.telegram.org by default. */
  apiBase?: string;
  log?: Log;
}

export class TelegramBot {
  readonly #token: string;
  readonly #fetch: TelegramFetch;
  readonly #apiBase: string;
  readonly #log: Log;
  #username: string | null;

  constructor(options: TelegramBotOptions) {
    this.#token = options.token.trim();
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as TelegramFetch);
    this.#apiBase = (options.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.#log = options.log ?? (() => {});
    this.#username = normalizeBotUsername(options.username);
  }

  /** The token never goes to logs or answers. */
  #hide(text: string): string {
    return this.#token ? text.split(this.#token).join('***') : text;
  }

  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<TelegramResult<T>> {
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.#fetch(`${this.#apiBase}/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (e) {
      return { ok: false, status: 0, description: this.#hide(`Telegram недоступен: ${(e as Error).message}`), gone: false };
    }
    const text = await res.text().catch(() => '');
    let body: { ok?: boolean; result?: T; description?: string } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // not JSON: keep the status
    }
    if (res.status >= 200 && res.status < 300 && body.ok !== false) return { ok: true, result: body.result, status: res.status, description: '', gone: false };
    const description = this.#hide(String(body.description ?? text).slice(0, 200));
    const gone = res.status === 403 || (res.status === 400 && /chat not found|user is deactivated|group chat was (deleted|upgraded)/i.test(description));
    return { ok: false, status: res.status, description: `Telegram ${res.status}: ${description}`, gone };
  }

  sendMessage(chatId: string, text: string, button?: InlineButton | null): Promise<TelegramResult> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(button ? { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } } : {}),
    });
  }

  /** Bot username for t.me links: from the secret, else getMe (remembered). */
  async username(): Promise<string | null> {
    if (this.#username) return this.#username;
    const me = await this.call<{ username?: string }>('getMe', {});
    if (!me.ok) {
      this.#log(`Telegram getMe: ${me.description}`);
      return null;
    }
    this.#username = normalizeBotUsername(me.result?.username);
    return this.#username;
  }
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 🔴 urgent, 🟠 important, 🟡 worth a look, ℹ️ the rest. */
const SEVERITY: Partial<Record<PushKind, string>> = {
  POWER_CRITICAL: '🔴',
  POWER_ON_BATTERY: '🔴',
  LIGHT_WITHOUT_GAME: '🟠',
  LAMP_DARK_DURING_GAME: '🟠',
  HUB_OFFLINE: '🟠',
  SHIFT_NOT_CLOSED: '🟠',
  UPS_UNREACHABLE: '🟡',
  LAMP_FAILED: '🟡',
  PREPAID_NOT_STARTED: '🟡',
};

/** One alert: "🟠 <b>Клуб «Демо»: Свет горит без игры</b>\nСтол 3 …". The title already names the venue. */
export function alertText(message: Pick<PushMessage, 'title' | 'body' | 'data'>): string {
  const good = /снова на связи/i.test(message.title);
  const emoji = good ? '✅' : (SEVERITY[message.data.kind] ?? 'ℹ️');
  return `${emoji} <b>${escapeHtml(message.title)}</b>\n${escapeHtml(message.body)}`;
}

export const OPEN_IN_CABINET = 'Открыть в кабинете';

/** Button under a message: the club page, or the cabinet itself without a club. */
export function cabinetButton(cabinetUrl: string | null, clubId?: string | null): InlineButton | null {
  if (!cabinetUrl) return null;
  return { text: OPEN_IN_CABINET, url: clubId ? cabinetClubUrl(cabinetUrl, clubId) : `${cabinetUrl.replace(/\/+$/, '')}/` };
}

// ---------------------------------------------------------------------------
// Linked chats
// ---------------------------------------------------------------------------

interface ChatRow {
  chat_id: string;
  owner_id: string;
  name: string;
  created_at: number;
  muted: number;
}

const chatView = (r: ChatRow): TelegramChatView => ({
  chatId: String(r.chat_id),
  name: r.name || 'Telegram',
  linkedAt: Number(r.created_at),
  muted: Number(r.muted) === 1,
});

export async function listChats(db: SqlDriver, ownerId: string): Promise<TelegramChatView[]> {
  const rows = await db.all<ChatRow>('SELECT * FROM owner_telegram WHERE owner_id = ? ORDER BY created_at, chat_id', [ownerId]);
  return rows.map(chatView);
}

/** Links (or moves) a chat to the owner; messages are on (muted = 0). */
export async function linkChat(db: SqlDriver, now: number, ownerId: string, chatId: string, name: string): Promise<void> {
  await db.run(
    `INSERT INTO owner_telegram (chat_id, owner_id, name, created_at, muted) VALUES (?, ?, ?, ?, 0)
     ON CONFLICT (chat_id) DO UPDATE SET owner_id = excluded.owner_id, name = excluded.name, created_at = excluded.created_at, muted = 0`,
    [chatId, ownerId, name.slice(0, 80), now],
  );
}

/** Forgets a chat; with `ownerId` only when it is that owner's. Returns whether a row went away. */
export async function unlinkChat(db: SqlDriver, chatId: string, ownerId?: string): Promise<boolean> {
  const changed = ownerId
    ? await db.run('DELETE FROM owner_telegram WHERE chat_id = ? AND owner_id = ?', [chatId, ownerId])
    : await db.run('DELETE FROM owner_telegram WHERE chat_id = ?', [chatId]);
  if (changed > 0) await db.run('DELETE FROM telegram_digests WHERE chat_id = ?', [chatId]);
  return changed > 0;
}

// ---------------------------------------------------------------------------
// One-time link codes
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3_600_000;

export function linkCodeHash(code: string): string {
  return createHash('sha256').update(`ts-telegram:${code}`).digest('hex');
}

/** A new code for `/start`: 24 url-safe characters, only its hash is stored. */
export async function createLinkCode(db: SqlDriver, now: number, ownerId: string): Promise<{ code: string; expiresAt: number }> {
  await db.run('DELETE FROM telegram_link_codes WHERE expires_at < ?', [now - DAY_MS]);
  const code = randomBytes(18).toString('base64url');
  const expiresAt = now + TELEGRAM_LINK_TTL_MS;
  await db.run('INSERT INTO telegram_link_codes (code_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
    linkCodeHash(code),
    ownerId,
    now,
    expiresAt,
  ]);
  return { code, expiresAt };
}

export type LinkCodeOutcome = { ok: true; ownerId: string } | { ok: false; reason: 'expired' | 'used' | 'unknown'; ownerId?: string };

/** Uses a code once: the first `/start` with it wins, a second one is told it is used. */
export async function consumeLinkCode(db: SqlDriver, now: number, code: string): Promise<LinkCodeOutcome> {
  if (!isTelegramStartCode(code)) return { ok: false, reason: 'unknown' };
  const hash = linkCodeHash(code);
  return db.transaction(async (tx) => {
    const row = (await tx.all<{ owner_id: string; expires_at: number; used_at: number | null }>(
      'SELECT owner_id, expires_at, used_at FROM telegram_link_codes WHERE code_hash = ?',
      [hash],
    ))[0];
    if (!row) return { ok: false, reason: 'unknown' } as const;
    if (row.used_at !== null && row.used_at !== undefined) return { ok: false, reason: 'used', ownerId: row.owner_id } as const;
    if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' } as const;
    const changed = await tx.run('UPDATE telegram_link_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL', [now, hash]);
    return changed > 0 ? ({ ok: true, ownerId: row.owner_id } as const) : ({ ok: false, reason: 'used', ownerId: row.owner_id } as const);
  });
}

// ---------------------------------------------------------------------------
// Alerts: the dispatcher's channel to linked chats
// ---------------------------------------------------------------------------

export class TelegramChannel implements OwnerChannel {
  readonly #db: SqlDriver;
  readonly #bot: TelegramBot;
  readonly #cabinetUrl: string | null;
  readonly #log: Log;

  constructor(db: SqlDriver, bot: TelegramBot, cabinetUrl: string | null, log: Log = () => {}) {
    this.#db = db;
    this.#bot = bot;
    this.#cabinetUrl = cabinetUrl;
    this.#log = log;
  }

  async deliver(ownerId: string, message: Omit<PushMessage, 'token' | 'platform'>): Promise<{ delivered: number; failed: number }> {
    const chats = await this.#db.all<ChatRow>('SELECT * FROM owner_telegram WHERE owner_id = ? AND muted = 0 ORDER BY created_at', [ownerId]);
    let delivered = 0;
    let failed = 0;
    for (const chat of chats) {
      const chatId = String(chat.chat_id);
      const res = await this.#bot.sendMessage(chatId, alertText(message), cabinetButton(this.#cabinetUrl, message.data.clubId || null));
      if (res.ok) {
        delivered++;
        continue;
      }
      failed++;
      if (res.gone) {
        this.#log(`Telegram: чат «${chat.name}» больше недоступен боту, отключён`);
        await unlinkChat(this.#db, chatId);
      } else {
        this.#log(`Telegram: не доставлено в «${chat.name}»: ${res.description}`);
      }
    }
    return { delivered, failed };
  }
}

// ---------------------------------------------------------------------------
// Summary of the day
// ---------------------------------------------------------------------------

/** The evening summary goes out from this local hour (21:00 club time) until midnight. */
export const SUMMARY_HOUR = 21;

/** "к прошлому понедельнику" … by getUTCDay() (0 = Sunday). */
const LAST_WEEKDAY = [
  'к прошлому воскресенью',
  'к прошлому понедельнику',
  'к прошлому вторнику',
  'к прошлой среде',
  'к прошлому четвергу',
  'к прошлой пятнице',
  'к прошлой субботе',
];

/** "в прошлый понедельник" … by getUTCDay(). */
const SAME_WEEKDAY = [
  'в прошлое воскресенье',
  'в прошлый понедельник',
  'в прошлый вторник',
  'в прошлую среду',
  'в прошлый четверг',
  'в прошлую пятницу',
  'в прошлую субботу',
];

function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const ddmm = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/** "▲ 12% к прошлому понедельнику"; plain words when last week had no revenue to compare with. */
export function weekChange(current: number, lastWeek: number, day: string): string {
  if (lastWeek <= 0) return current > 0 ? 'неделю назад выручки не было' : 'неделю назад тоже без выручки';
  const pct = Math.round(((current - lastWeek) / lastWeek) * 100);
  const where = LAST_WEEKDAY[weekdayOf(day)]!;
  if (pct === 0) return `столько же, сколько ${SAME_WEEKDAY[weekdayOf(day)]!}`;
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% ${where}`;
}

/** One venue for a local day: revenue with the week-ago change, games or orders, the average check. */
export async function clubDayText(db: SqlDriver, club: ClubRow, day: string): Promise<string> {
  const [today, weekAgo] = await Promise.all([periodStats(db, club.id, day, day), periodStats(db, club.id, addDays(day, -7), addDays(day, -7))]);
  const money = (n: number) => formatMoney(n, club.currency);
  const cafe = businessTypeOf(club) === 'cafe';
  const counts = cafe
    ? [`🧾 Заказы: ${today.checksPaid}`]
    : [`🎱 Игры: ${today.games}`, ...(today.checksPaid !== today.games ? [`🧾 Чеков: ${today.checksPaid}`] : [])];
  return [
    `<b>${escapeHtml(club.name)}</b>`,
    `💰 Выручка: ${money(today.revenue)} (${weekChange(today.revenue, weekAgo.revenue, day)})`,
    `${counts.join(' · ')} · Средний чек: ${money(today.averageCheck)}`,
  ].join('\n');
}

/** Several venues in one message, separated by a blank line. */
async function clubsText(db: SqlDriver, clubs: Array<{ club: ClubRow; day: string }>): Promise<string> {
  const parts: string[] = [];
  for (const c of clubs) parts.push(await clubDayText(db, c.club, c.day));
  return parts.join('\n\n');
}

/** The evening message: "📊 Итоги дня, 12.10" + every venue that reached 21:00. */
export async function dailySummaryText(db: SqlDriver, clubs: Array<{ club: ClubRow; day: string }>): Promise<string> {
  return `📊 <b>Итоги дня, ${ddmm(clubs[0]!.day)}</b>\n\n${await clubsText(db, clubs)}`;
}

/** /today: what each venue of the company has so far. */
export async function todayText(db: SqlDriver, now: number, companyId: string): Promise<string> {
  const clubs = await companyClubs(db, companyId);
  if (clubs.length === 0) return 'Заведений пока нет. Добавьте их в кабинете TS.';
  const first = localParts(now, clubs[0]!.timezone);
  const time = `${String(first.hour).padStart(2, '0')}:${String(first.minute).padStart(2, '0')}`;
  const body = await clubsText(db, clubs.map((club) => ({ club, day: localDay(now, club.timezone) })));
  return `📊 <b>Сегодня, ${ddmm(localDay(now, clubs[0]!.timezone))} на ${time}</b>\n\n${body}`;
}

/**
 * Called by `notify` (every 5 minutes): each linked, not muted chat gets one message a day with
 * the venues whose local time is past 21:00 and that were not summarized yet. A failed send is
 * retried on the next call; a chat that blocked the bot is forgotten. Returns messages sent.
 */
export async function runDailySummaries(db: SqlDriver, now: number, bot: TelegramBot, cabinetUrl: string | null, log: Log = () => {}): Promise<number> {
  const chats = await db.all<ChatRow & { company_id: string }>(
    'SELECT t.*, o.company_id FROM owner_telegram t JOIN owners o ON o.id = t.owner_id WHERE t.muted = 0 ORDER BY t.created_at',
  );
  const clubsOf = new Map<string, ClubRow[]>();
  let sent = 0;
  for (const chat of chats) {
    const chatId = String(chat.chat_id);
    let clubs = clubsOf.get(chat.company_id);
    if (!clubs) {
      clubs = await companyClubs(db, chat.company_id);
      clubsOf.set(chat.company_id, clubs);
    }
    const due: Array<{ club: ClubRow; day: string }> = [];
    for (const club of clubs) {
      if (localParts(now, club.timezone).hour < SUMMARY_HOUR) continue;
      const day = localDay(now, club.timezone);
      const added = await db.run('INSERT INTO telegram_digests (chat_id, club_id, day, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [
        chatId,
        club.id,
        day,
        now,
      ]);
      if (added > 0) due.push({ club, day });
    }
    if (due.length === 0) continue;
    const res = await bot.sendMessage(chatId, await dailySummaryText(db, due), cabinetButton(cabinetUrl, due.length === 1 ? due[0]!.club.id : null));
    if (res.ok) {
      sent++;
      continue;
    }
    if (res.gone) {
      log(`Telegram: чат «${chat.name}» больше недоступен боту, отключён`);
      await unlinkChat(db, chatId);
      continue;
    }
    log(`Telegram: сводка дня не доставлена в «${chat.name}»: ${res.description}`);
    for (const d of due) await db.run('DELETE FROM telegram_digests WHERE chat_id = ? AND club_id = ? AND day = ?', [chatId, d.club.id, d.day]);
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Bot commands (webhook updates)
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number | string; type?: string; title?: string; username?: string; first_name?: string };
    from?: { username?: string; first_name?: string };
  };
}

export interface TelegramDeps {
  db: SqlDriver;
  now: number;
  bot: TelegramBot;
  cabinetUrl: string | null;
  log: Log;
}

const HOW_TO_LINK = 'Откройте кабинет TS → «Уведомления» → «Получать в Telegram» и нажмите кнопку.';

const HELP = [
  'Команды:',
  '/today — сводка за сегодня',
  '/mute — пауза: не присылать сообщения',
  '/unmute — снова присылать',
  '/stop — отключить этот чат',
].join('\n');

/** "/start@TS_bot abc" → { command: 'start', arg: 'abc' }; null for plain text. */
export function parseCommand(text: string): { command: string; arg: string } | null {
  const m = /^\/([A-Za-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { command: m[1]!.toLowerCase(), arg: (m[2] ?? '').trim() } : null;
}

function chatName(message: NonNullable<TelegramUpdate['message']>): string {
  const chat = message.chat ?? {};
  if (chat.type && chat.type !== 'private') return chat.title?.trim() || 'Группа';
  const username = chat.username ?? message.from?.username;
  if (username) return `@${username}`;
  return (chat.first_name ?? message.from?.first_name ?? '').trim() || 'Telegram';
}

async function ownerOfChat(db: SqlDriver, chatId: string): Promise<{ owner_id: string; company_id: string; muted: number } | null> {
  const rows = await db.all<{ owner_id: string; company_id: string; muted: number }>(
    'SELECT t.owner_id, o.company_id, t.muted FROM owner_telegram t JOIN owners o ON o.id = t.owner_id WHERE t.chat_id = ?',
    [chatId],
  );
  return rows[0] ?? null;
}

async function clubNames(db: SqlDriver, ownerId: string): Promise<string> {
  const rows = await db.all<{ name: string }>(
    'SELECT c.name FROM clubs c JOIN owners o ON o.company_id = c.company_id WHERE o.id = ? ORDER BY c.created_at, c.name',
    [ownerId],
  );
  return rows.length ? rows.map((r) => escapeHtml(r.name)).join(', ') : 'заведений пока нет';
}

/** One update from Telegram: answers commands, never throws for bad input. */
export async function handleTelegramUpdate(deps: TelegramDeps, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  const rawChatId = message?.chat?.id;
  if (!message || rawChatId === undefined || rawChatId === null || typeof message.text !== 'string') return;
  const chatId = String(rawChatId);
  const { db, now, bot, cabinetUrl } = deps;
  const reply = async (text: string, withButton = false) => {
    const res = await bot.sendMessage(chatId, text, withButton ? cabinetButton(cabinetUrl) : null);
    if (!res.ok) deps.log(`Telegram: ответ боту не отправлен: ${res.description}`);
  };
  const cmd = parseCommand(message.text);
  const linked = await ownerOfChat(db, chatId);

  if (cmd?.command === 'start' && cmd.arg) {
    const outcome = await consumeLinkCode(db, now, cmd.arg);
    if (outcome.ok) {
      await linkChat(db, now, outcome.ownerId, chatId, chatName(message));
      deps.log(`Telegram: чат подключён к владельцу ${outcome.ownerId}`);
      await reply(
        `Готово! Буду присылать тревоги и сводку дня по заведениям: ${await clubNames(db, outcome.ownerId)}.\n\n${HELP}`,
        true,
      );
    } else if (outcome.reason === 'used' && linked && linked.owner_id === outcome.ownerId) {
      await reply('Этот чат уже подключён к TS. Тревоги и сводка дня приходят сюда.');
    } else if (outcome.reason === 'expired') {
      await reply(`Ссылка устарела: она действует 15 минут. ${HOW_TO_LINK}`);
    } else {
      await reply(`Эта ссылка уже использована или неверна. Возьмите новую: ${HOW_TO_LINK.toLowerCase()}`);
    }
    return;
  }

  if (cmd?.command === 'stop') {
    if (await unlinkChat(db, chatId)) await reply('Отключено. Тревоги и сводка больше не придут в этот чат. Подключить снова можно в кабинете TS.');
    else await reply('Этот чат и так не подключён к TS.');
    return;
  }

  if (!linked) {
    await reply(`Это бот TS: тревоги и сводка дня по вашим заведениям. Чтобы подключить этот чат, ${HOW_TO_LINK.charAt(0).toLowerCase()}${HOW_TO_LINK.slice(1)}`);
    return;
  }

  if (cmd?.command === 'today') {
    await reply(await todayText(db, now, linked.company_id), true);
    return;
  }
  if (cmd?.command === 'mute' || cmd?.command === 'unmute') {
    const muted = cmd.command === 'mute';
    await db.run('UPDATE owner_telegram SET muted = ? WHERE chat_id = ?', [muted ? 1 : 0, chatId]);
    await reply(muted ? 'Пауза: тревоги и сводка не будут приходить, пока не отправите /unmute.' : 'Снова присылаю тревоги и сводку дня.');
    return;
  }
  await reply(`${linked.muted ? 'Сейчас пауза (/unmute — снова присылать).\n\n' : 'Этот чат подключён к TS.\n\n'}${HELP}`);
}
