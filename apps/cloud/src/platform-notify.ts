/**
 * «Уведомления о заявках» (Supabase cloud, migration 20261103100000_trial_requests.sql): the platform team
 * learns about every new trial request without opening the cabinet.
 *
 *   POST /trial/start (a new request) ─▶ notifyTrialRequest ─▶ Telegram chats of the platform team (platform_telegram)
 *                                                          └▶ Web Push to the platform cabinet (platform_devices)
 *
 * A person of the platform team links a chat («Получать заявки в Telegram»: a one-time /start code, as the
 * owners do) and/or turns Web Push on in the platform cabinet. Both are free: the TS bot (TELEGRAM_BOT_TOKEN)
 * and the VAPID keys the owners' alerts already use. A failure is logged and never fails the start.
 */
import { randomUUID } from 'node:crypto';
import type { DeviceView, PlatformDevicesView, RegisterDeviceRequest, TrialView } from '@bills/domain';
import { parseWebPushToken, trialRequestLine } from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';
import type { Log, PushSender } from './push.ts';
import type { TelegramBot } from './telegram.ts';
import { escapeHtml, trialsButton, unlinkPlatformChat } from './telegram.ts';

// ---------------------------------------------------------------------------
// Web Push devices of the platform team

interface DeviceRow {
  id: string;
  staff_id: string;
  platform: 'webpush';
  token: string;
  name: string;
  created_at: number | string;
  last_seen_at: number | string;
  last_error: string | null;
}

const deviceView = (r: DeviceRow): DeviceView => ({
  id: r.id,
  platform: 'webpush',
  name: r.name,
  createdAt: Number(r.created_at),
  lastSeenAt: Number(r.last_seen_at),
  lastError: r.last_error,
});

export async function platformDevices(db: SqlDriver, staffId: string, pushEnabled: boolean): Promise<PlatformDevicesView> {
  const rows = await db.all<DeviceRow>('SELECT * FROM platform_devices WHERE staff_id = ? ORDER BY created_at, id', [staffId]);
  return { pushEnabled, devices: rows.map(deviceView) };
}

/** POST /platform/devices: this browser's push subscription (Web Push only); a known one moves to this person. */
export async function registerPlatformDevice(db: SqlDriver, now: number, staffId: string, raw: unknown): Promise<DeviceView> {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<RegisterDeviceRequest>;
  if (body.platform !== 'webpush') throw new CloudError(400, 'DEVICE_PLATFORM', 'Для кабинета платформы — только уведомления браузера (webpush)');
  if (typeof body.token !== 'string' || body.token.length > 4000 || !parseWebPushToken(body.token)) {
    throw new CloudError(400, 'DEVICE_TOKEN', 'Подписка браузера повреждена: включите уведомления ещё раз');
  }
  const token = body.token;
  const name = (typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '') || 'Браузер';
  return db.transaction(async (tx) => {
    const existing = await tx.all<DeviceRow>('SELECT * FROM platform_devices WHERE token = ?', [token]);
    if (existing[0]) {
      await tx.run('UPDATE platform_devices SET staff_id = ?, name = ?, last_seen_at = ?, last_error = NULL WHERE id = ?', [staffId, name, now, existing[0].id]);
    } else {
      await tx.run(
        "INSERT INTO platform_devices (id, staff_id, platform, token, name, created_at, last_seen_at) VALUES (?, ?, 'webpush', ?, ?, ?, ?)",
        [randomUUID(), staffId, token, name, now, now],
      );
    }
    const rows = await tx.all<DeviceRow>('SELECT * FROM platform_devices WHERE token = ?', [token]);
    return deviceView(rows[0]!);
  });
}

export async function removePlatformDevice(db: SqlDriver, staffId: string, id: string): Promise<boolean> {
  return (await db.run('DELETE FROM platform_devices WHERE id = ? AND staff_id = ?', [id, staffId])) > 0;
}

// ---------------------------------------------------------------------------
// Sending

/** One message to the platform team: a title, one line, and where a tap leads in the cabinet. */
export interface PlatformNotice {
  title: string;
  body: string;
  /** Relative to the cabinet: `#/platform/trials`. */
  url: string;
}

export interface PlatformNotifyDeps {
  db: SqlDriver;
  /** The cloud's push sender (Web Push when VAPID is set). */
  sender: PushSender | null;
  telegram: TelegramBot | null;
  cabinetUrl: string;
  log: Log;
}

export interface PlatformNotifyResult {
  delivered: number;
  failed: number;
}

/**
 * Sends `notice` to the Telegram chats (not muted) and the Web Push devices of the active platform team —
 * or of one person (`staffId`, the cabinet's «Проверить»). A chat that blocked the bot and a subscription
 * the browser dropped are forgotten; every other failure is logged. Never throws.
 */
export async function notifyPlatform(deps: PlatformNotifyDeps, notice: PlatformNotice, staffId?: string): Promise<PlatformNotifyResult> {
  let delivered = 0;
  let failed = 0;
  const only = staffId ? ' AND s.id = ?' : '';
  const params = staffId ? [staffId] : [];
  if (deps.telegram) {
    try {
      const chats = await deps.db.all<{ chat_id: string; name: string }>(
        `SELECT t.chat_id, t.name FROM platform_telegram t JOIN platform_staff s ON s.id = t.staff_id
         WHERE t.muted = 0 AND s.is_active = 1${only} ORDER BY t.created_at`,
        params,
      );
      const text = `☕ <b>${escapeHtml(notice.title)}</b>\n${escapeHtml(notice.body)}`;
      for (const chat of chats) {
        const chatId = String(chat.chat_id);
        const res = await deps.telegram.sendMessage(chatId, text, trialsButton(deps.cabinetUrl));
        if (res.ok) {
          delivered++;
          continue;
        }
        failed++;
        if (res.gone) {
          deps.log(`Telegram: чат «${chat.name}» больше недоступен боту, отключён от заявок`);
          await unlinkPlatformChat(deps.db, chatId);
        } else {
          deps.log(`Telegram: заявка не доставлена в «${chat.name}»: ${res.description}`);
        }
      }
    } catch (e) {
      failed++;
      deps.log(`Telegram: заявки: ${(e as Error).message}`);
    }
  }
  if (deps.sender?.enabled) {
    try {
      const devices = await deps.db.all<DeviceRow>(
        `SELECT d.* FROM platform_devices d JOIN platform_staff s ON s.id = d.staff_id WHERE s.is_active = 1${only} ORDER BY d.created_at`,
        params,
      );
      for (const d of devices) {
        const res = await deps.sender.send({
          token: d.token,
          platform: 'webpush',
          title: notice.title,
          body: notice.body,
          data: { kind: 'OTHER', clubId: '', url: notice.url },
        });
        if (res.ok) {
          delivered++;
          await deps.db.run('UPDATE platform_devices SET last_error = NULL WHERE id = ?', [d.id]);
          continue;
        }
        failed++;
        if (res.unregistered) {
          deps.log(`Push: подписка «${d.name}» кабинета платформы больше не действует, удалена`);
          await deps.db.run('DELETE FROM platform_devices WHERE id = ?', [d.id]);
        } else {
          deps.log(`Push: заявка не доставлена на «${d.name}»: ${res.error}`);
          await deps.db.run('UPDATE platform_devices SET last_error = ? WHERE id = ?', [res.error.slice(0, 300), d.id]);
        }
      }
    } catch (e) {
      failed++;
      deps.log(`Push: заявки: ${(e as Error).message}`);
    }
  }
  return { delivered, failed };
}

export const TRIALS_PATH = '#/platform/trials';
export const NEW_REQUEST_TITLE = 'Новая заявка на пробную версию';

/** «Новая заявка на пробную версию: «coffee book» · Аиша · Алматы», plus «похоже на повтор» when it is one. */
export function trialRequestNotice(view: Pick<TrialView, 'venue' | 'managerName' | 'timezone' | 'duplicateOf'>, dayText: (ms: number) => string): PlatformNotice {
  const line = trialRequestLine(view);
  const dup = view.duplicateOf;
  const since = dup ? (dup.status === 'pending' ? `заявка от ${dayText(dup.startedAt)}` : `с ${dayText(dup.startedAt)}`) : '';
  const repeat = dup ? `\nПохоже на повтор: «${dup.venue}» (${dup.managerName ? `${dup.managerName}, ` : ''}${since})` : '';
  return { title: NEW_REQUEST_TITLE, body: `${line}${repeat}`, url: TRIALS_PATH };
}

/** «1 ноября» in the trial's zone (Almaty by default). */
export function trialDayText(timeZone: string): (ms: number) => string {
  const f = new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long' });
  return (ms) => f.format(ms);
}

/**
 * Tells the platform team about a new request; waits at most `timeoutMs` so a slow Telegram never holds
 * the café's start for long. Never throws: the request is stored whatever happens here.
 */
export async function notifyTrialRequest(deps: PlatformNotifyDeps, view: TrialView, timeoutMs = 4000): Promise<PlatformNotifyResult | null> {
  try {
    const notice = trialRequestNotice(view, trialDayText(view.timezone));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([notifyPlatform(deps, notice), timeout]);
    clearTimeout(timer);
    if (result === null) deps.log(`Заявка ${view.id}: уведомление не успело уйти за ${timeoutMs} мс`);
    return result;
  } catch (e) {
    deps.log(`Заявка ${view.id}: уведомление не отправлено: ${(e as Error).message}`);
    return null;
  }
}
