import { createSign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DeviceView, DevicePlatform, PushData, PushKind, PushRule, PushSettingsView, TestPushResponse } from '@bills/domain';
import { isPushKind, PUSH_KINDS, pushRuleAllows } from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';

/**
 * Phase 3: push notifications to the owner's phone.
 *
 *   alert.raised (projection) ─┐
 *   watchdog (HUB silent,      ├─▶ push_queue (same transaction) ─▶ PushDispatcher.flush()
 *   shift left open)          ─┘                                     rules → devices → PushSender
 *
 * The queue is durable: a crash between commit and send leaves PENDING rows that
 * the next flush sends. `dedupe_key` keeps a redelivered event or a second watchdog
 * pass from notifying twice. Without an FCM key the sender is disabled: rows are
 * marked DISABLED and logged, rules and devices are still kept.
 */

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  data: PushData;
}

export type SendResult = { ok: true } | { ok: false; error: string; /** The token is dead: forget the device. */ unregistered: boolean };

export interface PushSender {
  readonly enabled: boolean;
  send(message: PushMessage): Promise<SendResult>;
}

export type Log = (message: string) => void;

/** No FCM key: nothing leaves the cloud, every would-be push is written to the log. */
export class DisabledSender implements PushSender {
  readonly enabled = false;
  readonly #log: Log;

  constructor(log: Log = () => {}) {
    this.#log = log;
  }

  async send(message: PushMessage): Promise<SendResult> {
    this.#log(`Push выключен (нет ключа FCM): «${message.title}» — ${message.body}`);
    return { ok: false, error: 'PUSH_DISABLED', unregistered: false };
  }
}

/** The fields of a Google service account JSON key that FCM needs. */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const base64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url');

/**
 * FCM HTTP v1 (`projects/{id}/messages:send`). The access token comes from the
 * service account by the OAuth 2.0 JWT-bearer flow (RS256 signed by node:crypto,
 * no Google SDK) and is cached until a minute before it expires.
 */
export class FcmSender implements PushSender {
  readonly enabled = true;
  readonly #account: ServiceAccount;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #endpoint: string;
  #accessToken: { value: string; expiresAt: number } | null = null;

  constructor(account: ServiceAccount, options: { fetch?: FetchLike; now?: () => number; endpoint?: string } = {}) {
    this.#account = account;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.#now = options.now ?? Date.now;
    this.#endpoint = options.endpoint ?? 'https://fcm.googleapis.com';
  }

  async #token(): Promise<string> {
    const now = this.#now();
    if (this.#accessToken && this.#accessToken.expiresAt - 60_000 > now) return this.#accessToken.value;
    const tokenUri = this.#account.token_uri ?? DEFAULT_TOKEN_URI;
    const iat = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({ iss: this.#account.client_email, scope: FCM_SCOPE, aud: tokenUri, iat, exp: iat + 3600 }),
    );
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(this.#account.private_key);
    const assertion = `${header}.${claims}.${base64url(signature)}`;
    const res = await this.#fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`OAuth ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('OAuth: нет access_token в ответе');
    this.#accessToken = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  async send(message: PushMessage): Promise<SendResult> {
    let accessToken: string;
    try {
      accessToken = await this.#token();
    } catch (e) {
      return { ok: false, error: (e as Error).message, unregistered: false };
    }
    const data: Record<string, string> = { kind: message.data.kind, clubId: message.data.clubId };
    if (message.data.alertId) data.alertId = message.data.alertId;
    const payload = {
      message: {
        token: message.token,
        notification: { title: message.title, body: message.body },
        data,
        android: { priority: 'HIGH', notification: { channel_id: 'alerts', sound: 'default' } },
        apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
      },
    };
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.#fetch(`${this.#endpoint}/v1/projects/${encodeURIComponent(this.#account.project_id)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return { ok: false, error: `FCM недоступен: ${(e as Error).message}`, unregistered: false };
    }
    if (res.status === 200) return { ok: true };
    const text = await res.text();
    if (res.status === 401) this.#accessToken = null;
    // FCM says a token is gone with 404 NOT_FOUND / errorCode UNREGISTERED.
    const unregistered = res.status === 404 || text.includes('UNREGISTERED');
    return { ok: false, error: `FCM ${res.status}: ${text.slice(0, 200)}`, unregistered };
  }
}

/** Reads the service account from CLOUD_FCM_SERVICE_ACCOUNT_JSON or the file CLOUD_FCM_SERVICE_ACCOUNT. */
export function loadServiceAccount(env: NodeJS.ProcessEnv = process.env): ServiceAccount | null {
  const inline = env.CLOUD_FCM_SERVICE_ACCOUNT_JSON?.trim();
  const file = env.CLOUD_FCM_SERVICE_ACCOUNT?.trim();
  const raw = inline || (file ? readFileSync(file, 'utf8') : '');
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error('Ключ сервисного аккаунта FCM: нужны project_id, client_email и private_key');
  }
  return {
    project_id: parsed.project_id,
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    ...(parsed.token_uri ? { token_uri: parsed.token_uri } : {}),
  };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface PushItem {
  dedupeKey: string;
  clubId: string;
  kind: PushKind;
  alertId?: string | null;
  title: string;
  body: string;
  /** When it happened in the club. */
  at: number;
}

const labelOf = (kind: PushKind): string => PUSH_KINDS.find((k) => k.kind === kind)?.label ?? 'Тревога';

/** Puts a notification in the queue; a second call with the same dedupe key is a no-op. */
export async function enqueuePush(tx: SqlDriver, now: number, item: PushItem): Promise<boolean> {
  const changed = await tx.run(
    `INSERT INTO push_queue (id, dedupe_key, club_id, kind, alert_id, title, body, at, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [randomUUID(), item.dedupeKey, item.clubId, item.kind, item.alertId ?? null, item.title, item.body, item.at, now],
  );
  return changed > 0;
}

/** Title of an alert push: "Клуб «Демо»: Свет горит без игры". */
export function alertTitle(clubName: string, kind: PushKind): string {
  return `${clubName}: ${labelOf(kind)}`;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface RuleRow {
  club_id: string;
  kind: string;
  enabled: number;
}

export async function loadRules(db: SqlDriver, ownerId: string): Promise<PushRule[]> {
  const rows = await db.all<RuleRow>('SELECT club_id, kind, enabled FROM push_rules WHERE owner_id = ? ORDER BY kind, club_id', [ownerId]);
  return rows
    .filter((r) => isPushKind(r.kind))
    .map((r) => ({ kind: r.kind as PushKind, clubId: r.club_id === '' ? null : r.club_id, enabled: Number(r.enabled) === 1 }));
}

export async function saveRules(db: SqlDriver, ownerId: string, rules: PushRule[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM push_rules WHERE owner_id = ?', [ownerId]);
    const seen = new Set<string>();
    for (const r of rules) {
      const clubId = r.clubId ?? '';
      const key = `${clubId}|${r.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await tx.run('INSERT INTO push_rules (owner_id, club_id, kind, enabled) VALUES (?, ?, ?, ?)', [ownerId, clubId, r.kind, r.enabled]);
    }
  });
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

interface DeviceRow {
  id: string;
  owner_id: string;
  platform: DevicePlatform;
  token: string;
  name: string;
  created_at: number;
  last_seen_at: number;
  last_error: string | null;
}

const toDeviceView = (r: DeviceRow): DeviceView => ({
  id: r.id,
  platform: r.platform,
  name: r.name,
  createdAt: Number(r.created_at),
  lastSeenAt: Number(r.last_seen_at),
  lastError: r.last_error,
});

/** Registers (or refreshes) a phone. A token already known moves to this owner. */
export async function registerDevice(
  db: SqlDriver,
  now: number,
  ownerId: string,
  req: { token: string; platform: DevicePlatform; name?: string },
): Promise<DeviceView> {
  return db.transaction(async (tx) => {
    const name = req.name?.trim().slice(0, 80) || (req.platform === 'ios' ? 'iPhone' : req.platform === 'android' ? 'Android' : 'Браузер');
    const existing = await tx.all<DeviceRow>('SELECT * FROM owner_devices WHERE token = ?', [req.token]);
    if (existing[0]) {
      await tx.run('UPDATE owner_devices SET owner_id = ?, platform = ?, name = ?, last_seen_at = ?, last_error = NULL WHERE id = ?', [
        ownerId,
        req.platform,
        name,
        now,
        existing[0].id,
      ]);
    } else {
      await tx.run(
        'INSERT INTO owner_devices (id, owner_id, platform, token, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [randomUUID(), ownerId, req.platform, req.token, name, now, now],
      );
    }
    const rows = await tx.all<DeviceRow>('SELECT * FROM owner_devices WHERE token = ?', [req.token]);
    return toDeviceView(rows[0]!);
  });
}

export async function listDevices(db: SqlDriver, ownerId: string): Promise<DeviceView[]> {
  const rows = await db.all<DeviceRow>('SELECT * FROM owner_devices WHERE owner_id = ? ORDER BY created_at', [ownerId]);
  return rows.map(toDeviceView);
}

export async function removeDevice(db: SqlDriver, ownerId: string, deviceId: string): Promise<boolean> {
  return (await db.run('DELETE FROM owner_devices WHERE id = ? AND owner_id = ?', [deviceId, ownerId])) > 0;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

interface QueueRow {
  id: string;
  club_id: string;
  kind: string;
  alert_id: string | null;
  title: string;
  body: string;
  at: number;
}

export interface DispatcherOptions {
  /** Alerts older than this when first seen (a HUB catching up after a day offline) are not pushed. */
  maxAgeMs?: number;
  log?: Log;
}

export interface FlushResult {
  processed: number;
  delivered: number;
  failed: number;
}

export class PushDispatcher {
  readonly #db: SqlDriver;
  readonly #sender: PushSender;
  readonly #now: () => number;
  readonly #maxAgeMs: number;
  readonly #log: Log;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(db: SqlDriver, sender: PushSender, now: () => number, options: DispatcherOptions = {}) {
    this.#db = db;
    this.#sender = sender;
    this.#now = now;
    this.#maxAgeMs = options.maxAgeMs ?? 2 * 60 * 60 * 1000;
    this.#log = options.log ?? (() => {});
  }

  get enabled(): boolean {
    return this.#sender.enabled;
  }

  /** Sends what is PENDING. Calls run one after another, so a row is never sent twice. */
  flush(): Promise<FlushResult> {
    const next = this.#chain.then(() => this.#flushOnce());
    this.#chain = next.catch((e: unknown) => this.#log(`Ошибка рассылки push: ${(e as Error).message}`));
    return next;
  }

  /** Fire-and-forget flush after a commit; errors only go to the log. */
  kick(): void {
    this.flush().catch(() => {});
  }

  async #flushOnce(): Promise<FlushResult> {
    const result: FlushResult = { processed: 0, delivered: 0, failed: 0 };
    const rows = await this.#db.all<QueueRow>(
      "SELECT id, club_id, kind, alert_id, title, body, at FROM push_queue WHERE status = 'PENDING' ORDER BY created_at, at, dedupe_key LIMIT 200",
    );
    for (const row of rows) {
      result.processed++;
      const now = this.#now();
      if (now - Number(row.at) > this.#maxAgeMs) {
        await this.#finish(row.id, 'STALE', now, 0, 0);
        continue;
      }
      if (!this.#sender.enabled) {
        this.#log(`Push выключен (нет ключа FCM), не отправлено: «${row.title}» — ${row.body}`);
        await this.#finish(row.id, 'DISABLED', now, 0, 0);
        continue;
      }
      const kind = isPushKind(row.kind) ? row.kind : 'OTHER';
      const devices = await this.#recipients(row.club_id, kind);
      let delivered = 0;
      let failed = 0;
      for (const d of devices) {
        const ok = await this.#deliver(d, {
          token: d.token,
          title: row.title,
          body: row.body,
          data: { kind, clubId: row.club_id, ...(row.alert_id ? { alertId: row.alert_id } : {}) },
        });
        if (ok) delivered++;
        else failed++;
      }
      await this.#finish(row.id, devices.length ? 'SENT' : 'SKIPPED', now, delivered, failed);
      result.delivered += delivered;
      result.failed += failed;
    }
    return result;
  }

  async #finish(id: string, status: string, now: number, delivered: number, failed: number): Promise<void> {
    await this.#db.run('UPDATE push_queue SET status = ?, sent_at = ?, delivered = ?, failed = ? WHERE id = ?', [
      status,
      now,
      delivered,
      failed,
      id,
    ]);
  }

  /** Devices of every owner of the club's company whose rules let this kind through. */
  async #recipients(clubId: string, kind: PushKind): Promise<DeviceRow[]> {
    const owners = await this.#db.all<{ id: string }>(
      'SELECT o.id FROM owners o JOIN clubs c ON c.company_id = o.company_id WHERE c.id = ? ORDER BY o.created_at',
      [clubId],
    );
    const out: DeviceRow[] = [];
    for (const o of owners) {
      if (!pushRuleAllows(await loadRules(this.#db, o.id), kind, clubId)) continue;
      out.push(...(await this.#db.all<DeviceRow>('SELECT * FROM owner_devices WHERE owner_id = ? ORDER BY created_at', [o.id])));
    }
    return out;
  }

  async #deliver(device: DeviceRow, message: PushMessage): Promise<boolean> {
    const res = await this.#sender.send(message);
    if (res.ok) {
      await this.#db.run('UPDATE owner_devices SET last_error = NULL WHERE id = ?', [device.id]);
      return true;
    }
    if (res.unregistered) {
      this.#log(`Push: токен устройства «${device.name}» больше не действует, устройство удалено`);
      await this.#db.run('DELETE FROM owner_devices WHERE id = ?', [device.id]);
    } else {
      this.#log(`Push не доставлен на «${device.name}»: ${res.error}`);
      await this.#db.run('UPDATE owner_devices SET last_error = ? WHERE id = ?', [res.error.slice(0, 300), device.id]);
    }
    return false;
  }

  /** "Send a test push" from the cabinet: straight to the owner's devices, rules ignored. */
  async test(ownerId: string, clubId: string): Promise<TestPushResponse> {
    const devices = await this.#db.all<DeviceRow>('SELECT * FROM owner_devices WHERE owner_id = ? ORDER BY created_at', [ownerId]);
    if (!this.#sender.enabled) {
      this.#log('Push выключен (нет ключа FCM): тестовое уведомление не отправлено');
      return { pushEnabled: false, sent: 0, failed: 0 };
    }
    let sent = 0;
    let failed = 0;
    for (const d of devices) {
      const ok = await this.#deliver(d, {
        token: d.token,
        title: 'TS: проверка уведомлений',
        body: 'Если вы это видите — тревоги клуба будут приходить на этот телефон.',
        data: { kind: 'OTHER', clubId },
      });
      if (ok) sent++;
      else failed++;
    }
    return { pushEnabled: true, sent, failed };
  }

  async settings(ownerId: string): Promise<PushSettingsView> {
    return {
      pushEnabled: this.#sender.enabled,
      kinds: [...PUSH_KINDS],
      rules: await loadRules(this.#db, ownerId),
      devices: await listDevices(this.#db, ownerId),
    };
  }
}

// ---------------------------------------------------------------------------
// Watchdogs: what the cloud notices on its own
// ---------------------------------------------------------------------------

export interface WatchdogOptions {
  /** A HUB not heard for this long is offline. */
  hubOfflineMs: number;
  /** A cash shift open longer than this is "not closed". */
  shiftOpenMs: number;
}

const minutesText = (ms: number): string => {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
};

/** One pass: queues HUB_OFFLINE and SHIFT_NOT_CLOSED once per episode. Returns how many were queued. */
export async function runWatchdogs(db: SqlDriver, now: number, options: WatchdogOptions): Promise<number> {
  let queued = 0;
  const silent = await db.all<{ id: string; name: string; club_id: string; club_name: string; last_seen_at: number }>(
    `SELECT h.id, h.name, h.club_id, c.name AS club_name, h.last_seen_at
       FROM hubs h JOIN clubs c ON c.id = h.club_id
      WHERE h.last_seen_at IS NOT NULL AND h.last_seen_at < ? AND h.offline_alerted_at IS NULL`,
    [now - options.hubOfflineMs],
  );
  for (const h of silent) {
    await db.transaction(async (tx) => {
      const lastSeen = Number(h.last_seen_at);
      const added = await enqueuePush(tx, now, {
        dedupeKey: `hub-offline:${h.id}:${lastSeen}`,
        clubId: h.club_id,
        kind: 'HUB_OFFLINE',
        title: alertTitle(h.club_name, 'HUB_OFFLINE'),
        body: `HUB «${h.name}» не выходит на связь ${minutesText(now - lastSeen)}. Проверьте интернет и питание в клубе.`,
        at: now,
      });
      if (added) queued++;
      await tx.run('UPDATE hubs SET offline_alerted_at = ? WHERE id = ?', [now, h.id]);
    });
  }

  const open = await db.all<{ id: string; club_id: string; club_name: string; number: number; opened_at: number; opened_by: string }>(
    `SELECT s.id, s.club_id, c.name AS club_name, s.number, s.opened_at, s.opened_by
       FROM shifts s JOIN clubs c ON c.id = s.club_id
      WHERE s.status = 'OPEN' AND s.opened_at < ? AND s.open_alerted_at IS NULL`,
    [now - options.shiftOpenMs],
  );
  for (const s of open) {
    await db.transaction(async (tx) => {
      const added = await enqueuePush(tx, now, {
        dedupeKey: `shift-open:${s.id}`,
        clubId: s.club_id,
        kind: 'SHIFT_NOT_CLOSED',
        title: alertTitle(s.club_name, 'SHIFT_NOT_CLOSED'),
        body: `Смена${Number(s.number) ? ` №${s.number}` : ''} открыта ${minutesText(now - Number(s.opened_at))} (открыл: ${s.opened_by}). Закройте смену и снимите Z-отчёт.`,
        at: now,
      });
      if (added) queued++;
      await tx.run('UPDATE shifts SET open_alerted_at = ? WHERE id = ?', [now, s.id]);
    });
  }
  return queued;
}

/** Called when a HUB is heard again after a HUB_OFFLINE push: says so and re-arms the watchdog. */
export async function hubBackOnline(
  tx: SqlDriver,
  now: number,
  hub: { id: string; name: string; club_id: string; offline_alerted_at: number | null },
  clubName: string,
): Promise<void> {
  if (hub.offline_alerted_at === null || hub.offline_alerted_at === undefined) return;
  await tx.run('UPDATE hubs SET offline_alerted_at = NULL WHERE id = ?', [hub.id]);
  await enqueuePush(tx, now, {
    dedupeKey: `hub-online:${hub.id}:${Number(hub.offline_alerted_at)}`,
    clubId: hub.club_id,
    kind: 'HUB_OFFLINE',
    title: `${clubName}: HUB снова на связи`,
    body: `HUB «${hub.name}» снова передаёт данные в облако.`,
    at: now,
  });
}
