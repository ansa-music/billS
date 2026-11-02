/**
 * One café = one Durable Object. It runs the HUB's own code (apps/hub/src) on the object's SQLite storage:
 *
 * - `node:sqlite` is shims/sqlite.ts over `ctx.storage.sql` (synchronous, like node:sqlite), so openDb()
 *   migrates it and every HUB service works unchanged; HUB transactions are storage transactions.
 * - Fastify is the trial's MiniFastify (apps/web/src/demo-hub/mini-fastify.ts): `/api/*` requests go through
 *   `app.inject()` into the HUB's routes, auth hook (keys, sessions, throttle) included.
 * - `/api/events` is a WebSocket on the Hibernation API instead of SSE: idle screens cost nothing, the object
 *   sleeps between requests, and every HUB `changed` event is sent to all sockets. Pings are answered by the
 *   runtime itself (setWebSocketAutoResponse) without waking the object.
 * - The HUB runs with the opt-ins made for a billed cloud (apps/hub/src/hub.ts, lean.ts):
 *   - `timers: 'external'` — no intervals; `hub.tick()` on every request and from the object's alarm, which is
 *     set only while some background job has a deadline (`hub.nextWakeAt()`); nothing is written on a wake-up;
 *   - `leanReads` — GET /api/state reads what can change, not the café's history;
 *   - `outbox: false` — no queue for a cloud sync the café never does;
 *   - `license.terms` — the license gate comes from the terms TS set (terms.ts), not from a signed license.
 * - Moving a trial in (importer.ts) and «Скачать копию» (exporter.ts) run in small steps, driven by the
 *   Worker's calls and by the alarm, so no request comes near the 10 ms of CPU of the Workers Free plan.
 *
 * The object answers only once the café is provisioned (`ts_cloud_cafe`): an unknown code costs no storage.
 * `/_ts/*` is reachable only through the Worker's /admin routes (worker.ts checks the admin token).
 */
import { DurableObject } from 'cloudflare:workers';
import { LOGIN_THROTTLE } from '@bills/domain';
import { systemClock } from '@ts-hub/clock.ts';
import { openDb } from '@ts-hub/db.ts';
import { buildApp } from '@ts-hub/http/app.ts';
import type { ChangeEvent } from '@ts-hub/hub.ts';
import { Hub } from '@ts-hub/hub.ts';
import { SimulatorLampDriver } from '@ts-hub/lamps/simulator.ts';
import { setupTrialClub, trialKey } from '@ts-hub/trial.ts';
import { NEWEST_MIGRATION } from 'virtual:hub-migrations';
import { HUB_SCHEMA } from 'virtual:hub-schema';
import type { MiniFastify } from '../../web/src/demo-hub/mini-fastify.ts';
import type { Env } from './env.ts';
import { CloudError, errorResponse, toErrorResponse } from './errors.ts';
import type { BackupHead, ExportProgress } from './exporter.ts';
import { Exporter } from './exporter.ts';
import { loginSource } from './http.ts';
import type { ImportOptions, ImportState } from './importer.ts';
import { importOptionsOf, importProgress, Importer, splitImportBody } from './importer.ts';
import type { SqlStats } from './shims/sqlite.ts';
import { DatabaseSync, provideStorage, setCostDebug } from './shims/sqlite.ts';
import { loadSqlJs } from './sqljs-load.ts';
import type { CafeTerms, CafeTermsInput } from './terms.ts';
import { defaultTerms, parseTerms, termsLicense } from './terms.ts';

const META = 'ts_cloud_cafe';
/** An alarm for a HUB deadline never comes sooner than this after now (a deadline that does not clear itself). */
const MIN_ALARM_GAP_MS = 30_000;
/** A finished «Скачать копию» is handed out again for this long instead of being made anew. */
const EXPORT_REUSE_MS = 60_000;
/** Wrong keys from one IP (every device behind it) in LOGIN_THROTTLE.windowMs before that IP waits. */
export const IP_LOGIN_FAILURES_MAX = 30;

export interface ProvisionRequest {
  code: string;
  venue: string;
  managerName: string;
  withMenu?: boolean;
  timezone?: string;
  terms?: CafeTermsInput;
}

export type CafeStatus = 'ready' | 'importing' | 'failed';

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

function bearerOf(request: Request): string | null {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;
}

export class CafeHub extends DurableObject<Env> {
  #booted: Booted | null = null;
  readonly #importer: Importer;
  readonly #exporter: Exporter;
  #terms: CafeTerms | null = null;
  #venue: string | null = null;
  /** The alarm as this object last set or read it; undefined — not known since the wake-up. */
  #alarmAt: number | null | undefined = undefined;
  /** HUB change events since the alarm was last brought in line with the HUB's deadlines. */
  #changed = false;
  #requests = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#importer = new Importer(ctx.storage, loadSqlJs, NEWEST_MIGRATION);
    this.#exporter = new Exporter(ctx.storage, loadSqlJs);
    setCostDebug(Number(env.COST_DEBUG ?? 0));
    // Screens send "ping" every 15 s; the runtime answers without waking (or billing) the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    void ctx.blockConcurrencyWhile(async () => {
      if (this.#status() === 'ready') await this.#boot();
    });
  }

  // ── Meta ────────────────────────────────────────────────────────────────────

  #hasMeta(): boolean {
    return this.ctx.storage.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${META}'`).toArray().length > 0;
  }

  #meta(key: string): string | null {
    if (!this.#hasMeta()) return null;
    const row = this.ctx.storage.sql.exec(`SELECT v FROM ${META} WHERE k = ?`, key).toArray()[0];
    return row ? String(row.v) : null;
  }

  #setMeta(entries: Record<string, string>): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    for (const [k, v] of Object.entries(entries)) this.ctx.storage.sql.exec(`INSERT OR REPLACE INTO ${META} (k, v) VALUES (?, ?)`, k, v);
  }

  /** null: no café under this code. */
  #status(): CafeStatus | null {
    return this.#meta('status') as CafeStatus | null;
  }

  #loadTerms(): CafeTerms {
    if (!this.#terms) {
      const raw = this.#meta('terms');
      this.#terms = raw ? (JSON.parse(raw) as CafeTerms) : defaultTerms(Date.now());
      this.#venue = this.#meta('venue');
    }
    return this.#terms;
  }

  // ── The HUB ─────────────────────────────────────────────────────────────────

  /** Opens the HUB on this object's storage (after every wake-up from hibernation, too). Writes nothing. */
  async #boot(): Promise<Booted> {
    if (this.#booted) return this.#booted;
    const now = Date.now();
    this.#loadTerms();
    provideStorage(this.ctx.storage);
    const db = openDb(':memory:', now);
    const hub = new Hub({
      db,
      clock: systemClock,
      // A coffee shop has no lamps; the simulator answers the HUB's lamp code without hardware.
      lampDriver: new SimulatorLampDriver({ latencyMs: 0 }),
      license: { mode: 'enforce', publicKeys: {}, terms: (at: number) => termsLicense(this.#loadTerms(), at, this.#venue) },
      monitorOptions: { intervalMs: 0 },
      timers: 'external',
      leanReads: true,
      outbox: false,
    });
    const app = buildApp(hub, {
      logger: false,
      dbPath: ':memory:',
      startedAt: now,
      version: { version: 'cloud', gitSha: null },
    });
    await hub.license.init();
    hub.start();
    hub.events.on('changed', (e) => {
      this.#changed = true;
      this.#broadcast(e);
    });
    this.#booted = { db, hub, app, bootedAt: now, boot: { ...db.stats } };
    return this.#booted;
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

  /**
   * One alarm for everything the object has to do by itself: the next step of a move or a copy (now), else the
   * HUB's earliest deadline (a «Сторож» rule, a prepaid game, a booking), else none. Set only when it changes.
   */
  async #syncAlarm(now: number): Promise<void> {
    let want: number | null = null;
    const status = this.#status();
    if (status === 'importing' || this.#exporter.busy) want = now;
    else if (this.#booted) {
      const due = this.#booted.hub.nextWakeAt(now);
      if (due !== null) want = Math.max(due, now + MIN_ALARM_GAP_MS);
    }
    if (this.#alarmAt === undefined) this.#alarmAt = await this.ctx.storage.getAlarm();
    if (want === this.#alarmAt || (want !== null && this.#alarmAt !== null && want >= this.#alarmAt && this.#alarmAt > now)) return;
    if (want === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(want);
    this.#alarmAt = want;
  }

  override async alarm(): Promise<void> {
    this.#alarmAt = null;
    const now = Date.now();
    const status = this.#status();
    if (status === 'importing') await this.#importStep(now, false);
    else if (this.#exporter.busy) await this.#exporter.step(now, () => this.#backupHead(), { fresh: false, maxAgeMs: EXPORT_REUSE_MS, id: crypto.randomUUID() });
    else if (status === 'ready') (await this.#boot()).hub.tick(now);
    await this.#syncAlarm(Date.now());
  }

  // ── Requests ────────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/_ts/')) return await this.#admin(request, url);
      const status = this.#status();
      if (status === 'importing') return errorResponse(503, 'CAFE_MOVING', 'Кофейня переезжает в облако. Подождите минуту и попробуйте снова.', { 'retry-after': '20' });
      if (status !== 'ready') return errorResponse(404, 'CAFE_NOT_FOUND', 'Кофейня не найдена. Проверьте код кофейни.');
      const booted = await this.#boot();
      if (url.pathname === '/api/events') return this.#events(request);
      if (url.pathname === '/api/cloud') return Response.json(this.#hello(booted));
      if (url.pathname === '/api/cloud/backup' && request.method === 'POST') return await this.#backupStep(booted, request);
      if (url.pathname === '/api/cloud/backup/file' && request.method === 'GET') return this.#backupFile(booted, request);
      return await this.#api(booted, request, url);
    } catch (err) {
      return toErrorResponse(err);
    }
  }

  /** The café's public facts for the «Код кофейни» screen: its name and whether it takes orders. */
  #hello(booted: Booted): object {
    const license = booted.hub.license.status();
    return { venue: this.#venue, business: 'cafe', readOnly: license.readOnly, message: license.readOnly ? license.message : null };
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
    const now = Date.now();
    // The HUB's background work that came due (cheap: each job at most once per its period while awake).
    booted.hub.tick(now);
    const ip = request.headers.get('x-ts-ip') ?? 'cloud';
    let remoteAddress = ip;
    if (url.pathname === '/api/auth/login') {
      const refused = this.#ipLocked(booted, ip, now);
      if (refused) return refused;
      // The throttle counts this device behind the café's shared IP on its own (http.ts loginSource).
      remoteAddress = loginSource(ip, request.headers.get('x-ts-device'));
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      if (key !== 'x-ts-ip' && key !== 'x-ts-device') headers[key] = value;
    });
    const method = request.method.toUpperCase();
    const payload = method === 'GET' || method === 'HEAD' ? undefined : await request.text();
    const res = await booted.app.inject({
      method,
      url: url.pathname + url.search,
      headers,
      ...(payload ? { payload } : {}),
      remoteAddress,
    });
    if (this.#changed) {
      this.#changed = false;
      await this.#syncAlarm(Date.now());
    }
    const out = new Headers(res.headers);
    const s = booted.db.stats;
    // What this request cost in Cloudflare's units: rows read / rows written / SQL statements.
    out.set('x-ts-cost', `rr=${s.rowsRead - before.rowsRead};rw=${s.rowsWritten - before.rowsWritten};st=${s.statements - before.statements}`);
    // Local tuning (COST_DEBUG): which statements of this request cost the most.
    if (booted.db.costly.length) out.set('x-ts-cost-top', encodeURIComponent(booted.db.costly.splice(0).slice(0, 12).join(' | ')));
    const empty = res.statusCode === 204 || res.statusCode === 304;
    return new Response(empty ? null : res.body, { status: res.statusCode, headers: out });
  }

  /**
   * Every device behind one IP together: after IP_LOGIN_FAILURES_MAX wrong keys in the throttle window the IP
   * waits — the per-device throttle cannot be dodged by a new device id each time. The HUB's own branch-wide
   * pause of short keys stays as it is.
   */
  #ipLocked(booted: Booted, ip: string, now: number): Response | null {
    const row = booted.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(at) AS first FROM login_attempts
         WHERE at > ? AND ok = 0 AND result NOT IN ('locked', 'branch_locked') AND (ip = ? OR substr(ip, 1, ?) = ?)`,
      )
      .get(now - LOGIN_THROTTLE.windowMs, ip, ip.length + 1, `${ip}#`);
    if (Number(row?.n ?? 0) < IP_LOGIN_FAILURES_MAX) return null;
    const retryAfterMs = Math.max(1000, Number(row?.first ?? now) + LOGIN_THROTTLE.windowMs - now);
    const minutes = Math.ceil(retryAfterMs / 60_000);
    return Response.json(
      { error: { code: 'LOGIN_LOCKED', message: `Слишком много неверных ключей из этой сети. Попробуйте через ${minutes} мин.`, retryAfterMs } },
      { status: 429, headers: { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) } },
    );
  }

  // ── «Скачать копию» (the director, from the screens) ───────────────────────────

  #director(booted: Booted, request: Request): void {
    const token = bearerOf(request);
    const who = token ? booted.hub.auth.resolve(token) : null;
    if (!who) throw new CloudError(401, 'UNAUTHORIZED', 'Войдите по ключу доступа');
    if (!who.actor.roles.includes('manager')) throw new CloudError(403, 'FORBIDDEN', 'Скачать копию может только директор.');
  }

  #backupHead(): BackupHead {
    const terms = this.#loadTerms();
    return {
      startedAt: Number(this.#meta('createdAt') ?? Date.now()),
      venue: this.#venue ?? 'Кофейня',
      managerName: this.#meta('managerName') ?? 'Директор',
      status: terms.status,
      endsAt: terms.endsAt,
      message: terms.message,
    };
  }

  /** One step of making the copy; the screen repeats the call until `ready`, then fetches the file. */
  async #backupStep(booted: Booted, request: Request): Promise<Response> {
    this.#director(booted, request);
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { fresh?: boolean };
    const progress = await this.#exporter.step(Date.now(), () => this.#backupHead(), {
      fresh: body.fresh === true,
      maxAgeMs: EXPORT_REUSE_MS,
      id: crypto.randomUUID(),
    });
    return Response.json(progress, { status: progress.status === 'ready' ? 200 : 202 });
  }

  #backupFile(booted: Booted, request: Request): Response {
    this.#director(booted, request);
    return this.#fileResponse();
  }

  #fileResponse(): Response {
    const file = this.#exporter.file();
    if (!file) throw new CloudError(404, 'BACKUP_NOT_READY', 'Копия ещё не готова.');
    return new Response(file.body, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${file.name}"`,
        'content-length': String(file.bytes),
        'cache-control': 'no-store',
      },
    });
  }

  // ── TS's admin operations (/_ts/*, through the Worker's /admin routes) ─────────

  async #admin(request: Request, url: URL): Promise<Response> {
    const op = url.pathname.slice('/_ts/'.length);
    const now = Date.now();
    switch (`${request.method} ${op}`) {
      case 'GET stats':
        return Response.json(this.#stats(now));
      case 'POST provision':
        return Response.json(await this.#provision((await request.json()) as ProvisionRequest, now), { status: 201 });
      case 'POST import/upload':
        return Response.json(await this.#importUpload(request, now), { status: 202 });
      case 'POST import/step':
        return Response.json(await this.#importStep(now, true));
      case 'PUT terms':
        return Response.json(await this.#setTerms(await request.json(), now));
      case 'POST director-key':
        return Response.json(await this.#directorKey());
      case 'POST export/step': {
        if (this.#status() !== 'ready') throw new CloudError(404, 'CAFE_NOT_FOUND', 'Кофейня не найдена');
        await this.#boot();
        const p = await this.#exporter.step(now, () => this.#backupHead(), { fresh: false, maxAgeMs: EXPORT_REUSE_MS, id: crypto.randomUUID() });
        await this.#syncAlarm(now);
        return Response.json(p);
      }
      case 'GET export/file':
        return this.#fileResponse();
      default:
        throw new CloudError(404, 'NOT_FOUND', 'Нет такой операции');
    }
  }

  /**
   * A new empty café with one director and a six-digit key (the way the trial welcome screen makes one). Its
   * schema comes from the build (virtual:hub-schema) in small steps like a move, not from running every HUB
   * migration in one request; the Worker drives the steps, the last one sets the café up.
   */
  async #provision(input: ProvisionRequest, now: number): Promise<object> {
    if (this.#status() !== null) throw new CloudError(409, 'CAFE_EXISTS', 'Кофейня с этим кодом уже есть.');
    if (input.terms) parseTerms(input.terms, now);
    const timezone = typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : 'Asia/Almaty';
    const options: ImportOptions = {
      ...(input.terms ? { terms: input.terms } : {}),
      provision: {
        venue: (input.venue ?? '').trim().slice(0, 80) || 'Моя кофейня',
        managerName: (input.managerName ?? '').trim().slice(0, 80) || 'Директор',
        managerKey: trialKey(secureRandom),
        withMenu: input.withMenu ?? true,
        timezone,
      },
    };
    const state = this.#importer.startTemplate(HUB_SCHEMA, options, now, crypto.randomUUID());
    this.#setMeta({ code: input.code, createdAt: String(now), origin: 'new', status: 'importing' });
    await this.#syncAlarm(now);
    return { code: input.code, ...importProgress(state) };
  }

  /** The request body of POST /admin/cafes/import, stored in parts: no JSON parse of megabytes. */
  async #importUpload(request: Request, now: number): Promise<object> {
    if (this.#status() !== null) throw new CloudError(409, 'CAFE_EXISTS', 'Кофейня с этим кодом уже есть.');
    const code = request.headers.get('x-ts-code') ?? '';
    const body = new Uint8Array(await request.arrayBuffer());
    // The SQLite file itself (application/octet-stream, options in X-TS-Import) or the JSON with base64.
    const raw = (request.headers.get('content-type') ?? '').startsWith('application/octet-stream');
    let rest: Record<string, unknown>;
    let base64: Uint8Array | null = null;
    if (raw) {
      try {
        rest = JSON.parse(request.headers.get('x-ts-import') || '{}') as Record<string, unknown>;
      } catch {
        throw new CloudError(400, 'BAD_JSON', 'X-TS-Import — не JSON');
      }
    } else {
      ({ base64, rest } = splitImportBody(body));
    }
    const options = importOptionsOf(rest);
    // Bad terms are refused now, before anything is stored.
    if (options.terms) parseTerms(options.terms, now);
    const id = crypto.randomUUID();
    const state = base64 ? this.#importer.upload(base64, options, now, id) : this.#importer.uploadRaw(body, options, now, id);
    this.#setMeta({ code, createdAt: String(now), origin: 'trial', status: 'importing' });
    await this.#syncAlarm(now);
    return { code, ...importProgress(state) };
  }

  /**
   * One step of a move (importer.ts), or its last step: the HUB opens on the copy (newer migrations run),
   * the terms, the director's name and the roster setting are set, the parts go. Idempotent.
   */
  async #importStep(now: number, handout: boolean): Promise<object> {
    const status = this.#status();
    if (status === 'ready') return { code: this.#meta('code'), ...this.#readyReport(handout) };
    if (status !== 'importing') throw new CloudError(404, 'IMPORT_NOT_FOUND', 'Переезда этой кофейни нет.');
    const state = this.#importer.state();
    if (!state) throw new CloudError(500, 'IMPORT_LOST', 'Состояние переезда потеряно.');
    if (state.phase !== 'done') {
      const next = await this.#importer.step();
      if (next.phase === 'failed') return { code: this.#meta('code'), ...(await this.#failImport(next, now)) };
      return { code: this.#meta('code'), ...importProgress(next) };
    }
    await this.#finishImport(state, now);
    return { code: this.#meta('code'), ...this.#readyReport(handout) };
  }

  /**
   * A move that cannot finish (not a TS café, a copy from a newer TS, a step failing again and again): everything
   * copied so far goes, the code stays burned with the reason — TS starts a new move with a new code.
   */
  async #failImport(state: ImportState, now: number): Promise<object> {
    const code = this.#meta('code') ?? '';
    const progress = importProgress(state);
    console.warn('[cloud hub] import failed:', state.error);
    await this.ctx.storage.deleteAll();
    this.#alarmAt = undefined;
    this.#setMeta({ code, createdAt: String(now), origin: state.options.provision ? 'new' : 'trial', status: 'failed', error: state.error ?? 'Переезд не удался.' });
    return progress;
  }

  /**
   * The last step of a move or of a new café: the HUB opens on the copied (or template) schema — newer migrations
   * run —, a new café gets its club, director and sample menu, the terms and the roster setting are set, the parts
   * go. A director's key made here is handed out once, by the next admin answer (`managerKeyOnce`).
   */
  async #finishImport(state: ImportState, now: number): Promise<void> {
    const terms = state.options.terms ? parseTerms(state.options.terms, now) : defaultTerms(now);
    const p = state.options.provision;
    const venue = p?.venue ?? state.venue ?? 'Моя кофейня';
    this.#terms = terms;
    this.#venue = venue;
    this.#setMeta({ venue, terms: JSON.stringify(terms) });
    const { hub, db } = await this.#boot();
    let managerName: string;
    let managerKey: string | undefined;
    if (p) {
      managerName = p.managerName;
      managerKey = p.managerKey;
      setupTrialClub(hub, { venue, managerName, key: managerKey, timezone: p.timezone, withMenu: p.withMenu, now });
    } else {
      managerName =
        state.options.managerName?.trim().slice(0, 80) ||
        String(db.prepare("SELECT name FROM staff WHERE deleted_at IS NULL AND is_active = 1 AND roles LIKE '%manager%' ORDER BY created_at LIMIT 1").get()?.name ?? 'Директор');
      if (state.options.newManagerKey) {
        managerKey = trialKey(secureRandom);
        hub.auth.issueFixedKeys([{ roles: ['manager'], name: managerName, key: managerKey }]);
      }
    }
    // «Кто на смене?» is public on the café's address: off in the cloud until the director turns it on.
    hub.settings.updateClub({ settings: { display: { showRoster: false } }, actor: 'TS' });
    this.#setMeta({
      status: 'ready',
      managerName,
      importedRows: String(state.rows),
      importedSteps: String(state.steps + 1),
      fromMigration: String(state.fromMigration),
      ...(managerKey ? { managerKeyOnce: managerKey } : {}),
    });
    this.#importer.clear();
    await this.#syncAlarm(now);
  }

  /** What admin calls get about a ready café; `handout`: the director's new key too, the first time only. */
  #readyReport(handout: boolean): object {
    let managerKey: string | null = null;
    if (handout) {
      managerKey = this.#meta('managerKeyOnce');
      if (managerKey) this.ctx.storage.sql.exec(`DELETE FROM ${META} WHERE k = 'managerKeyOnce'`);
    }
    return {
      status: 'ready',
      venue: this.#venue ?? this.#meta('venue'),
      managerName: this.#meta('managerName'),
      ...(managerKey ? { managerKey } : {}),
      rows: Number(this.#meta('importedRows') ?? 0),
      steps: Number(this.#meta('importedSteps') ?? 0),
      fromMigration: Number(this.#meta('fromMigration') ?? 0),
      terms: this.#loadTerms(),
      license: this.#licenseView(Date.now()),
    };
  }

  #licenseView(now: number): object {
    const s = termsLicense(this.#loadTerms(), now, this.#venue);
    return { state: s.state, readOnly: s.readOnly, message: s.message, validUntil: s.validUntil, daysLeft: s.daysLeft };
  }

  /**
   * «Выдать новый код директора» (the cabinet): a new six-digit key for the director — the person TS set the café
   * up for (`managerName`), else the first active director —; their other keys and the sessions opened with them
   * are revoked, so a code that leaked stops working at once.
   */
  async #directorKey(): Promise<object> {
    if (this.#status() !== 'ready') throw new CloudError(this.#status() === 'importing' ? 409 : 404, 'CAFE_NOT_READY', 'Кофейня ещё не готова (или не найдена).');
    const { hub, db } = await this.#boot();
    const directors = db
      .prepare("SELECT id, name, roles FROM staff WHERE is_active = 1 AND deleted_at IS NULL AND origin = 'hub' AND roles LIKE '%\"manager\"%' ORDER BY created_at, name")
      .all() as Array<{ id: string; name: string; roles: string }>;
    const director = directors.find((d) => d.name === this.#meta('managerName')) ?? directors[0];
    if (!director) throw new CloudError(409, 'NO_DIRECTOR', 'В кофейне нет директора, которому можно выдать код.');
    let managerKey: string | null = null;
    db.transactionSync(() => {
      // Their own keys: the HUB lets anyone revoke their own, which is what TS does on the director's behalf.
      const self = { id: director.id, name: 'TS', role: 'manager', roles: ['manager'] };
      const keys = db.prepare("SELECT id FROM access_keys WHERE staff_id = ? AND revoked_at IS NULL AND origin = 'hub'").all(director.id) as Array<{ id: string }>;
      for (const k of keys) hub.auth.revokeKey(k.id, self);
      for (let i = 0; i < 20 && !managerKey; i++) {
        const key = trialKey(secureRandom);
        if (hub.auth.issueFixedKeys([{ roles: JSON.parse(director.roles) as string[], name: director.name, key }]).length) managerKey = key;
      }
      if (!managerKey) throw new CloudError(500, 'KEY_TAKEN', 'Не удалось подобрать свободный код — попробуйте ещё раз.');
    });
    return { managerKey, managerName: director.name };
  }

  async #setTerms(input: unknown, now: number): Promise<object> {
    if (this.#status() !== 'ready') throw new CloudError(this.#status() === 'importing' ? 409 : 404, 'CAFE_NOT_READY', 'Кофейня ещё не готова (или не найдена).');
    const terms = parseTerms(input, now);
    this.#setMeta({ terms: JSON.stringify(terms) });
    this.#terms = terms;
    const { hub } = await this.#boot();
    // Every screen re-reads /api/state at once and shows (or lifts) «только чтение».
    hub.events.changed({ kind: 'license' });
    return { code: this.#meta('code'), terms, license: this.#licenseView(now) };
  }

  #stats(now: number): object {
    const status = this.#status();
    if (status === null) return { provisioned: false, status: null };
    const b = this.#booted;
    const importing = status === 'importing' ? this.#importer.state() : null;
    const failed = status === 'failed' ? { status: 'failed', error: this.#meta('error') } : null;
    const exporting: ExportProgress | null = this.#exporter.progress(now, Number.MAX_SAFE_INTEGER);
    return {
      provisioned: status === 'ready',
      status,
      code: this.#meta('code'),
      origin: this.#meta('origin'),
      venue: this.#meta('venue'),
      createdAt: Number(this.#meta('createdAt') ?? 0),
      ...(status === 'ready' ? { terms: this.#loadTerms(), license: this.#licenseView(now) } : {}),
      ...(importing ? { import: importProgress(importing) } : failed ? { import: failed } : {}),
      ...(exporting ? { export: exporting } : {}),
      databaseBytes: this.ctx.storage.sql.databaseSize,
      sockets: this.ctx.getWebSockets().length,
      bootedAt: b?.bootedAt ?? null,
      bootCost: b?.boot ?? null,
      sinceBoot: b ? { requests: this.#requests, ...b.db.stats } : null,
      nextWakeAt: b ? b.hub.nextWakeAt(now) : null,
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
