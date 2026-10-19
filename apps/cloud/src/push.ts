import { createSign, randomUUID } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {
  DeviceView,
  DevicePlatform,
  PushData,
  PushKind,
  PushRule,
  PushSettingsView,
  TestPushResponse,
  WebPushPayload,
} from '@bills/domain';
import { cabinetClubUrl, isNtfyTopicUrl, isPushKind, parseWebPushToken, PUSH_KINDS, pushRuleAllows } from '@bills/domain';
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
  /** Platform of the device the token belongs to; RoutingSender picks the channel by it (FCM when absent). */
  platform?: DevicePlatform;
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

const DEFAULT_DEVICE_NAME: Record<DevicePlatform, string> = {
  android: 'Android',
  ios: 'iPhone',
  web: 'Браузер',
  webpush: 'Браузер',
  ntfy: 'Телефон (ntfy)',
};

/** Registers (or refreshes) a phone. A token already known moves to this owner. */
export async function registerDevice(
  db: SqlDriver,
  now: number,
  ownerId: string,
  req: { token: string; platform: DevicePlatform; name?: string },
): Promise<DeviceView> {
  return db.transaction(async (tx) => {
    const name = req.name?.trim().slice(0, 80) || DEFAULT_DEVICE_NAME[req.platform];
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
          platform: d.platform,
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
        platform: d.platform,
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

// ---------------------------------------------------------------------------
// Senders without Firebase: Web Push (cabinet PWA) and ntfy (Android app)
// ---------------------------------------------------------------------------
//
// Both use only `fetch` and WebCrypto (`globalThis.crypto.subtle`), so they run
// unchanged in Node and in Deno (Supabase Edge Functions).

/** fetch with a binary body; the shape both runtimes' `fetch` accepts. */
export type PushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | Uint8Array<ArrayBuffer> },
) => Promise<{ status: number; text(): Promise<string> }>;

const defaultFetch = (): PushFetch => globalThis.fetch as unknown as PushFetch;

type Bytes = Uint8Array<ArrayBuffer>;

const utf8 = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Bytes {
  const b64 = text.trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const subtle = (): webcrypto.SubtleCrypto => globalThis.crypto.subtle;

/** JWK of a P-256 point given as 65 uncompressed bytes (0x04 || x || y), optionally with the private scalar. */
export function p256Jwk(publicKey: Uint8Array, d?: Uint8Array): webcrypto.JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('P-256: нужен несжатый открытый ключ (65 байт)');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(publicKey.subarray(1, 33)),
    y: b64urlEncode(publicKey.subarray(33, 65)),
    ...(d ? { d: b64urlEncode(d) } : {}),
    ext: true,
  };
}

/** HKDF-SHA-256 (RFC 5869) of `length` bytes. */
export async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

export interface EcKeyPairBytes {
  /** 65 bytes, uncompressed point. */
  publicKey: Bytes;
  /** 32 bytes, the private scalar d. */
  privateKey: Bytes;
}

export interface WebPushEncryptOptions {
  /** 16 random bytes by default; fixed only in tests (RFC 8291 test vector). */
  salt?: Bytes;
  /** A fresh ECDH key pair per message by default; fixed only in tests. */
  serverKeys?: EcKeyPairBytes;
  /** Record size written to the header (RFC 8188); 4096 by default. */
  recordSize?: number;
}

/** Largest plaintext that fits one 4096-byte aes128gcm record (minus header, delimiter and tag). */
export const WEB_PUSH_MAX_PLAINTEXT = 4096 - 86 - 1 - 16;

/**
 * Message encryption for Web Push, RFC 8291 (aes128gcm, RFC 8188), single record:
 * salt(16) || rs(4) || idlen(1) || as_public(65) || AES-128-GCM(plaintext || 0x02).
 */
export async function encryptWebPush(
  plaintext: Uint8Array,
  subscription: { p256dh: Bytes; auth: Bytes },
  options: WebPushEncryptOptions = {},
): Promise<Bytes> {
  if (plaintext.length > WEB_PUSH_MAX_PLAINTEXT) throw new Error('Web Push: сообщение слишком длинное');
  const uaPublic = subscription.p256dh;
  const salt = options.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const rs = options.recordSize ?? 4096;

  let asPublic: Bytes;
  let asPrivate: webcrypto.CryptoKey;
  if (options.serverKeys) {
    asPublic = options.serverKeys.publicKey;
    asPrivate = await subtle().importKey(
      'jwk',
      p256Jwk(options.serverKeys.publicKey, options.serverKeys.privateKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
  } else {
    const pair = (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
    asPublic = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
    asPrivate = pair.privateKey;
  }

  const uaKey = await subtle().importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(subscription.auth, ecdhSecret, concatBytes(utf8('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  const key = await subtle().importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, concatBytes(plaintext, new Uint8Array([2]))),
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  return concatBytes(header, asPublic, ciphertext);
}

/** VAPID keys as printed by `node scripts/vapid-keys.mjs`. */
export interface VapidConfig {
  /** base64url of the 65-byte uncompressed P-256 point. */
  publicKey: string;
  /** base64url of the 32-byte private scalar d. */
  privateKey: string;
  /** `mailto:…` or an https URL: who to contact about this sender (RFC 8292). */
  subject: string;
}

/** VAPID JWT (RFC 8292): ES256 over {aud, exp, sub}, signature as raw r||s. */
export async function vapidJwt(vapid: VapidConfig, audience: string, expSeconds: number): Promise<string> {
  const publicKey = b64urlDecode(vapid.publicKey);
  const key = await subtle().importKey(
    'jwk',
    p256Jwk(publicKey, b64urlDecode(vapid.privateKey)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(utf8(JSON.stringify({ aud: audience, exp: expSeconds, sub: vapid.subject })));
  const signature = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${header}.${claims}`)));
  return `${header}.${claims}.${b64urlEncode(signature)}`;
}

/** Checks the VAPID keys once at start-up, so a typo in a secret shows up in the log, not at the first alert. */
export function checkVapidConfig(vapid: VapidConfig): void {
  let pub: Uint8Array;
  let priv: Uint8Array;
  try {
    pub = b64urlDecode(vapid.publicKey);
    priv = b64urlDecode(vapid.privateKey);
  } catch {
    throw new Error('VAPID: ключи должны быть в base64url');
  }
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY: нужен несжатый ключ P-256 (65 байт)');
  if (priv.length !== 32) throw new Error('VAPID_PRIVATE_KEY: нужен ключ P-256 (32 байта)');
  if (!/^(mailto:|https:\/\/)/.test(vapid.subject)) throw new Error('VAPID_SUBJECT: нужен mailto: или https:// адрес');
}

export interface WebPushOptions {
  fetch?: PushFetch;
  now?: () => number;
  /** How long the push service keeps an undelivered message; one day by default. */
  ttlSeconds?: number;
  /** Cabinet address: the click opens `<cabinet>/#/clubs/<id>`. */
  cabinetUrl?: string | null;
  encrypt?: WebPushEncryptOptions;
}

/**
 * Web Push to the cabinet PWA (Chrome/Android, Firefox, Safari/iOS 16.4+ installed PWA).
 * Token = JSON of the browser's PushSubscription. 404/410 from the push service
 * mean the subscription is gone: the device is forgotten.
 */
export class WebPushSender implements PushSender {
  readonly enabled = true;
  readonly #vapid: VapidConfig;
  readonly #fetch: PushFetch;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #cabinetUrl: string | null;
  readonly #encrypt: WebPushEncryptOptions;
  readonly #jwts = new Map<string, { value: string; exp: number }>();

  constructor(vapid: VapidConfig, options: WebPushOptions = {}) {
    checkVapidConfig(vapid);
    this.#vapid = vapid;
    this.#fetch = options.fetch ?? defaultFetch();
    this.#now = options.now ?? Date.now;
    this.#ttl = options.ttlSeconds ?? 24 * 3600;
    this.#cabinetUrl = options.cabinetUrl?.trim() || null;
    this.#encrypt = options.encrypt ?? {};
  }

  async #jwt(audience: string): Promise<string> {
    const nowSec = Math.floor(this.#now() / 1000);
    const cached = this.#jwts.get(audience);
    if (cached && cached.exp - 3600 > nowSec) return cached.value;
    const exp = nowSec + 12 * 3600;
    const value = await vapidJwt(this.#vapid, audience, exp);
    this.#jwts.set(audience, { value, exp });
    return value;
  }

  /** The JSON the service worker receives. */
  payloadOf(message: PushMessage): WebPushPayload {
    return {
      title: message.title,
      body: message.body,
      data: {
        ...message.data,
        ...(this.#cabinetUrl && message.data.clubId ? { url: cabinetClubUrl(this.#cabinetUrl, message.data.clubId) } : {}),
      },
    };
  }

  async send(message: PushMessage): Promise<SendResult> {
    const sub = parseWebPushToken(message.token);
    if (!sub) return { ok: false, error: 'Web Push: подписка браузера повреждена', unregistered: true };
    let body: Bytes;
    let jwt: string;
    try {
      const payload = this.payloadOf(message);
      let text = utf8(JSON.stringify(payload));
      if (text.length > WEB_PUSH_MAX_PLAINTEXT) text = utf8(JSON.stringify({ ...payload, body: payload.body.slice(0, 500) }));
      body = await encryptWebPush(text, { p256dh: b64urlDecode(sub.keys.p256dh), auth: b64urlDecode(sub.keys.auth) }, this.#encrypt);
      jwt = await this.#jwt(new URL(sub.endpoint).origin);
    } catch (e) {
      return { ok: false, error: `Web Push: ${(e as Error).message}`, unregistered: false };
    }
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.#fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          authorization: `vapid t=${jwt}, k=${this.#vapid.publicKey}`,
          ttl: String(this.#ttl),
          urgency: 'high',
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
        },
        body,
      });
    } catch (e) {
      return { ok: false, error: `Web Push: сервис недоступен: ${(e as Error).message}`, unregistered: false };
    }
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `Web Push ${res.status}: ${text.slice(0, 200)}`,
      unregistered: res.status === 404 || res.status === 410,
    };
  }
}

/** ntfy priority: 5 = urgent, 4 = high, 3 = default. */
const NTFY_PRIORITY: Partial<Record<PushKind, number>> = {
  POWER_CRITICAL: 5,
  POWER_ON_BATTERY: 5,
  LIGHT_WITHOUT_GAME: 4,
  LAMP_DARK_DURING_GAME: 4,
  HUB_OFFLINE: 4,
  SHIFT_NOT_CLOSED: 4,
  UPS_UNREACHABLE: 4,
  LAMP_FAILED: 4,
  PREPAID_NOT_STARTED: 4,
};

/** ntfy tags that are emoji short codes, shown in front of the title. */
const NTFY_TAGS: Partial<Record<PushKind, string>> = {
  POWER_CRITICAL: 'rotating_light',
  POWER_ON_BATTERY: 'zap',
  LIGHT_WITHOUT_GAME: 'bulb',
  LAMP_DARK_DURING_GAME: 'warning',
  HUB_OFFLINE: 'satellite',
  SHIFT_NOT_CLOSED: 'moneybag',
  UPS_UNREACHABLE: 'battery',
  LAMP_FAILED: 'bulb',
  PREPAID_NOT_STARTED: 'hourglass',
};

/** HTTP headers are Latin-1: non-ASCII text goes as an RFC 2047 encoded-word, which ntfy decodes. */
export function headerText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  let bin = '';
  for (const b of utf8(text)) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

export interface NtfyOptions {
  fetch?: PushFetch;
  /** Access token of a protected ntfy server (`NTFY_TOKEN`). */
  token?: string | null;
  /** Cabinet address: tapping the notification opens `<cabinet>/#/clubs/<id>`. */
  cabinetUrl?: string | null;
}

/** ntfy (ntfy.sh or self-hosted): POST the text to the topic URL kept as the device token. */
export class NtfySender implements PushSender {
  readonly enabled = true;
  readonly #fetch: PushFetch;
  readonly #token: string | null;
  readonly #cabinetUrl: string | null;

  constructor(options: NtfyOptions = {}) {
    this.#fetch = options.fetch ?? defaultFetch();
    this.#token = options.token?.trim() || null;
    this.#cabinetUrl = options.cabinetUrl?.trim() || null;
  }

  async send(message: PushMessage): Promise<SendResult> {
    if (!isNtfyTopicUrl(message.token)) return { ok: false, error: 'ntfy: неверный адрес темы', unregistered: true };
    const kind = message.data.kind;
    const headers: Record<string, string> = {
      title: headerText(message.title),
      tags: NTFY_TAGS[kind] ?? 'bell',
      priority: String(NTFY_PRIORITY[kind] ?? 3),
      'content-type': 'text/plain; charset=utf-8',
    };
    if (this.#cabinetUrl && message.data.clubId) headers.click = cabinetClubUrl(this.#cabinetUrl, message.data.clubId);
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    let res: { status: number; text(): Promise<string> };
    try {
      res = await this.#fetch(message.token, { method: 'POST', headers, body: utf8(message.body) });
    } catch (e) {
      return { ok: false, error: `ntfy недоступен: ${(e as Error).message}`, unregistered: false };
    }
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const text = await res.text().catch(() => '');
    return { ok: false, error: `ntfy ${res.status}: ${text.slice(0, 200)}`, unregistered: false };
  }
}

type Channel = 'webpush' | 'ntfy' | 'fcm';

/**
 * Picks the channel by the device platform: `webpush` → Web Push, `ntfy` → ntfy,
 * `android`/`ios`/`web` → FCM. A channel that is not configured is skipped and logged.
 */
export class RoutingSender implements PushSender {
  readonly #routes: Partial<Record<Channel, PushSender>> = {};
  readonly #log: Log;

  constructor(routes: Partial<Record<Channel, PushSender | null>>, log: Log = () => {}) {
    for (const [name, sender] of Object.entries(routes) as Array<[Channel, PushSender | null | undefined]>) {
      if (sender) this.#routes[name] = sender;
    }
    this.#log = log;
  }

  get enabled(): boolean {
    return Object.values(this.#routes).some((s) => s.enabled);
  }

  /** Channels that will actually send, for start-up logs. */
  get channels(): Channel[] {
    return (Object.entries(this.#routes) as Array<[Channel, PushSender]>).filter(([, s]) => s.enabled).map(([name]) => name);
  }

  async send(message: PushMessage): Promise<SendResult> {
    const platform = message.platform ?? 'android';
    const channel: Channel = platform === 'webpush' ? 'webpush' : platform === 'ntfy' ? 'ntfy' : 'fcm';
    const sender = this.#routes[channel];
    if (!sender || !sender.enabled) {
      this.#log(`Push на устройство ${platform} не настроен (${channel}): «${message.title}» не отправлено`);
      return { ok: false, error: `PUSH_DISABLED: канал ${channel} не настроен`, unregistered: false };
    }
    return sender.send(message);
  }
}

/**
 * Senders from environment variables (Supabase secrets or .env):
 * VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (+ VAPID_SUBJECT, else TS_CABINET_URL) → Web Push;
 * ntfy is always on unless NTFY_DISABLED=1 (NTFY_TOKEN optional);
 * CLOUD_FCM_SERVICE_ACCOUNT_JSON → FCM. TS_CABINET_URL is where a tap leads.
 */
export function pushSenderFromEnv(env: Record<string, string | undefined>, log: Log = () => {}): RoutingSender {
  const cabinetUrl = env.TS_CABINET_URL?.trim() || null;
  let webpush: PushSender | null = null;
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (publicKey && privateKey) {
    const subject = env.VAPID_SUBJECT?.trim() || cabinetUrl || '';
    try {
      webpush = new WebPushSender({ publicKey, privateKey, subject }, { cabinetUrl });
    } catch (e) {
      log(`Web Push выключен: ${(e as Error).message}`);
    }
  }
  const ntfy = env.NTFY_DISABLED === '1' ? null : new NtfySender({ token: env.NTFY_TOKEN ?? null, cabinetUrl });
  let fcm: PushSender | null = null;
  try {
    const account = env.CLOUD_FCM_SERVICE_ACCOUNT_JSON?.trim() ? loadServiceAccount(env) : null;
    if (account) fcm = new FcmSender(account);
  } catch (e) {
    log(`FCM выключен: ${(e as Error).message}`);
  }
  return new RoutingSender({ webpush, ntfy, fcm }, log);
}
