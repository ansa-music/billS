/**
 * One café = one Durable Object. It runs the HUB's own code (apps/hub/src) on the object's SQLite storage:
 *
 * - `node:sqlite` is shims/sqlite.ts over `ctx.storage.sql` (synchronous, like node:sqlite), so openDb()
 *   migrates it and every HUB service works unchanged; HUB transactions are storage transactions.
 * - Fastify is the trial's MiniFastify (apps/web/src/demo-hub/mini-fastify.ts): `/api/*` requests go
 *   through `app.inject()` into the HUB's routes, auth hook (keys, sessions, throttle) included.
 * - `/api/events` is a WebSocket on the Hibernation API instead of SSE: idle screens cost nothing, the
 *   object sleeps between requests, and every HUB `changed` event is sent to all sockets. Pings are
 *   answered by the runtime itself (setWebSocketAutoResponse) without waking the object.
 * - The HUB's intervals are captured (timers.ts), so they never keep the object awake.
 *
 * The object only answers once the café is provisioned (`ts_cloud_cafe`): an unknown code costs no storage.
 * `/_ts/*` is reachable only through the Worker (worker.ts checks the admin token).
 */
import { DurableObject } from 'cloudflare:workers';
import { systemClock } from '@ts-hub/clock.ts';
import { openDb } from '@ts-hub/db.ts';
import { buildApp } from '@ts-hub/http/app.ts';
import type { ChangeEvent } from '@ts-hub/hub.ts';
import { Hub } from '@ts-hub/hub.ts';
import { SimulatorLampDriver } from '@ts-hub/lamps/simulator.ts';
import { DEMO_LICENSE_KEYS, installDemoLicense } from '@ts-hub/demo-license.ts';
import { purgeIdempotencyKeys } from '@ts-hub/idempotency.ts';
import { setupTrialClub, trialKey } from '@ts-hub/trial.ts';
import { NEWEST_MIGRATION } from 'virtual:hub-migrations';
import type { MiniFastify } from '../../web/src/demo-hub/mini-fastify.ts';
import { CloudError, errorResponse, toErrorResponse } from './errors.ts';
import type { SqlStats } from './shims/sqlite.ts';
import { DatabaseSync, provideStorage } from './shims/sqlite.ts';
import { decodeSnapshot, importSnapshot } from './snapshot.ts';
import { VirtualTimers } from './timers.ts';
import type { Env } from './env.ts';

const META = 'ts_cloud_cafe';
/** As the HUB (hub.ts): idempotency keys are kept a day. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
/** A cloud café's license: TS approved it; no countdown (the real one would come from TS). */
const LICENSE_YEARS = 10;
const YEAR_MS = 365 * 24 * 3600_000;

export interface ProvisionRequest {
  code: string;
  venue: string;
  managerName: string;
  withMenu?: boolean;
  timezone?: string;
}

export interface ImportRequest {
  code: string;
  /** base64 of the trial's SQLite file (Supabase trials.snapshot). */
  snapshot: string;
  /** Also give the director a new six-digit key (the old keys keep working either way). */
  newManagerKey?: boolean;
  managerName?: string;
}

interface Booted {
  db: DatabaseSync;
  hub: Hub;
  app: MiniFastify;
  bootedAt: number;
  /** Rows the boot itself read and wrote (every wake-up after hibernation pays this). */
  boot: SqlStats;
}

function secureRandom(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

export class CafeHub extends DurableObject<Env> {
  #booted: Booted | null = null;
  readonly #timers = new VirtualTimers();
  #requests = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Screens send "ping" every 15 s; the runtime answers without waking (or billing) the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    void ctx.blockConcurrencyWhile(async () => {
      if (this.#provisioned()) await this.#boot();
    });
  }

  #provisioned(): boolean {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${META}'`).toArray().length > 0;
  }

  #meta(key: string): string | null {
    const row = this.ctx.storage.sql.exec(`SELECT v FROM ${META} WHERE k = ?`, key).toArray()[0];
    return row ? String(row.v) : null;
  }

  #setMeta(entries: Record<string, string>): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    for (const [k, v] of Object.entries(entries)) this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO ${META} (k, v) VALUES (?, ?)`, k, v);
  }

  /** Opens the HUB on this object's storage (after every wake-up from hibernation, too). */
  async #boot(): Promise<Booted> {
    if (this.#booted) return this.#booted;
    const now = Date.now();
    provideStorage(this.ctx.storage);
    const db = openDb(':memory:', now);
    const hub = new Hub({
      db,
      clock: systemClock,
      // A coffee shop has no lamps; the simulator answers the HUB's lamp code without hardware.
      lampDriver: new SimulatorLampDriver({ latencyMs: 0 }),
      license: { mode: 'enforce', publicKeys: DEMO_LICENSE_KEYS },
      guardIntervalMs: 0,
      monitorOptions: { intervalMs: 0 },
    });
    const app = buildApp(hub, {
      logger: false,
      dbPath: ':memory:',
      startedAt: now,
      version: { version: 'cloud', gitSha: null },
    });
    await hub.license.init();
    // Hub.start() without lamps.recover(): there are no lamps in the cloud, and recover() journals
    // «hub.recovered» on every start — here the object starts again after every hibernation, so the
    // café's journal would fill with them (and each costs ~5 rows written). The rest of start():
    this.#timers.capture(now, () => {
      // The purge scans the keys of a whole day: a few times a day is enough, not on every wake-up.
      if (now - Number(this.#meta('purgedAt') ?? 0) > PURGE_EVERY_MS) {
        purgeIdempotencyKeys(db, now - IDEMPOTENCY_TTL_MS);
        this.#setMeta({ purgedAt: String(now) });
      }
      hub.prepaid.start();
    });
    hub.events.on('changed', (e) => this.#broadcast(e));
    this.#booted = { db, hub, app, bootedAt: now, boot: { ...db.stats } };
    return this.#booted;
  }

  async #installLicense(hub: Hub, venue: string, now: number): Promise<void> {
    await installDemoLicense(hub.license, now, { startedAt: now, endsAt: now + LICENSE_YEARS * YEAR_MS, companyName: venue, permanent: true });
  }

  #broadcast(e: ChangeEvent): void {
    const message = JSON.stringify({ t: 'changed', e });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // A socket closing right now: the screen reconnects and refetches.
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/_ts/')) return await this.#admin(request, url);
      const booted = this.#booted;
      if (!booted) return errorResponse(404, 'CAFE_NOT_FOUND', 'Кофейня не найдена. Проверьте код кофейни.');
      if (url.pathname === '/api/events') return this.#events(request);
      return await this.#api(booted, request, url);
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  /** Live updates: a hibernatable WebSocket per screen (the web app's EventSource stand-in opens it). */
  #events(request: Request): Response {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return errorResponse(426, 'WEBSOCKET_ONLY', 'Обновления облачной кассы идут через WebSocket.');
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ openedAt: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async #api(booted: Booted, request: Request, url: URL): Promise<Response> {
    this.#requests++;
    const before = { ...booted.db.stats };
    const started = Date.now();
    // The HUB's background work that came due while the object slept (timers.ts).
    this.#timers.runDue(started);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const method = request.method.toUpperCase();
    const payload = method === 'GET' || method === 'HEAD' ? undefined : await request.text();
    const res = await booted.app.inject({
      method,
      url: url.pathname + url.search,
      headers,
      ...(payload ? { payload } : {}),
      // Who is asking, for the HUB's login throttle (set by the Worker from CF-Connecting-IP).
      remoteAddress: request.headers.get('x-ts-ip') ?? 'cloud',
    });
    const out = new Headers(res.headers);
    const s = booted.db.stats;
    // What this request cost in Cloudflare's units: rows read / rows written / SQL statements.
    out.set('x-ts-cost', `rr=${s.rowsRead - before.rowsRead};rw=${s.rowsWritten - before.rowsWritten};st=${s.statements - before.statements}`);
    const empty = res.statusCode === 204 || res.statusCode === 304;
    return new Response(empty ? null : res.body, { status: res.statusCode, headers: out });
  }

  async #admin(request: Request, url: URL): Promise<Response> {
    const op = url.pathname.slice('/_ts/'.length);
    if (op === 'stats' && request.method === 'GET') return Response.json(this.#stats());
    if (request.method !== 'POST') throw new CloudError(405, 'METHOD', 'Нужен POST');
    if (op === 'provision') return Response.json(await this.#provision((await request.json()) as ProvisionRequest), { status: 201 });
    if (op === 'import') return Response.json(await this.#import((await request.json()) as ImportRequest), { status: 201 });
    throw new CloudError(404, 'NOT_FOUND', 'Нет такой операции');
  }

  /** A new empty café with one director and a six-digit key (the way the trial welcome screen makes one). */
  async #provision(input: ProvisionRequest): Promise<{ code: string; venue: string; managerName: string; managerKey: string }> {
    if (this.#provisioned()) throw new CloudError(409, 'CAFE_EXISTS', 'Кофейня с этим кодом уже есть.');
    const now = Date.now();
    const venue = (input.venue ?? '').trim().slice(0, 80) || 'Моя кофейня';
    const managerName = (input.managerName ?? '').trim().slice(0, 80) || 'Директор';
    const managerKey = trialKey(secureRandom);
    this.#setMeta({ code: input.code, createdAt: String(now), origin: 'new' });
    const { hub } = await this.#boot();
    setupTrialClub(hub, { venue, managerName, key: managerKey, timezone: input.timezone || 'Asia/Almaty', withMenu: input.withMenu ?? true, now });
    await this.#installLicense(hub, venue, now);
    return { code: input.code, venue, managerName, managerKey };
  }

  /** A trial café with all its data: menu, orders, shifts, staff and their keys. */
  async #import(input: ImportRequest): Promise<{ code: string; venue: string | null; tables: number; rows: number; fromMigration: number; managerKey?: string }> {
    if (this.#provisioned()) throw new CloudError(409, 'CAFE_EXISTS', 'Кофейня с этим кодом уже есть.');
    const bytes = decodeSnapshot(input.snapshot ?? '');
    const now = Date.now();
    provideStorage(this.ctx.storage);
    // A bare connection for the copy: openDb() (migrations) runs after it, on the copied schema.
    const raw = new DatabaseSync(':memory:');
    const report = await importSnapshot(raw, bytes, NEWEST_MIGRATION);
    this.#setMeta({ code: input.code, createdAt: String(now), origin: 'trial', importedRows: String(report.rows) });
    const { hub } = await this.#boot();
    const venue = report.venue ?? 'Моя кофейня';
    await this.#installLicense(hub, venue, now);
    let managerKey: string | undefined;
    if (input.newManagerKey) {
      managerKey = trialKey(secureRandom);
      hub.auth.issueFixedKeys([{ roles: ['manager'], name: (input.managerName ?? '').trim() || 'Директор', key: managerKey }]);
    }
    return { code: input.code, ...report, ...(managerKey ? { managerKey } : {}) };
  }

  #stats(): object {
    const b = this.#booted;
    return {
      provisioned: this.#provisioned(),
      code: this.#provisioned() ? this.#meta('code') : null,
      origin: this.#provisioned() ? this.#meta('origin') : null,
      databaseBytes: this.ctx.storage.sql.databaseSize,
      sockets: this.ctx.getWebSockets().length,
      bootedAt: b?.bootedAt ?? null,
      bootCost: b?.boot ?? null,
      sinceBoot: b ? { requests: this.#requests, ...b.db.stats } : null,
      capturedTimers: this.#timers.size,
      newestMigration: NEWEST_MIGRATION,
    };
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Screens only send "ping" (answered by the runtime). Anything else: answer so a stuck client notices.
    if (message === 'ping') ws.send('pong');
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }
}
