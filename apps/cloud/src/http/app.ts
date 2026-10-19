import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  CloudKeyLoginRequest,
  CloudLoginRequest,
  CloudLoginResponse,
  CreateOwnerKeyRequest,
  CreateOwnerKeyResponse,
  RegisterDeviceRequest,
  UpdatePushRulesRequest,
  OwnerView,
  SyncEventsRequest,
  SyncSnapshotRequest,
  UpdateTariffsRequest,
} from '@bills/domain';
import { isPushKind, loginQrText } from '@bills/domain';
import {
  authenticateOwner,
  authenticateOwnerKey,
  createOwnerKey,
  createSession,
  listOwnerKeys,
  revokeOwnerKey,
  deleteSession,
  OWNER_COOKIE,
  ownerByToken,
  parseCookies,
  serializeCookie,
  SESSION_TTL_MS,
} from '../auth.ts';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { SqlDriver } from '../db/driver.ts';
import { CloudError } from '../errors.ts';
import { registerStatic } from './static.ts';
import { isValidDay, localDay } from '../localtime.ts';
import { clubDetails, clubOfCompany, clubSessions, overview } from '../reports.ts';
import type { ClubRow } from '../settings.ts';
import { DisabledSender, hubBackOnline, PushDispatcher, registerDevice, removeDevice, saveRules } from '../push.ts';
import type { HubRow } from '../sync.ts';
import { acceptEvents, acceptSnapshot, findHubByKey, loadClub, settingsSince, updateTariffs } from '../sync.ts';

export interface AppDeps {
  db: SqlDriver;
  clock?: Clock;
  logger?: boolean;
  /** Mark the owner cookie `Secure`; only behind HTTPS. */
  secureCookies?: boolean;
  /** Built owner cabinet (apps/cloud-web/dist) to serve on `/`; nothing is served when missing. */
  staticDir?: string;
  /** Push queue and sender; without it pushes are off (logged). */
  push?: PushDispatcher;
  /** Address the phone should use, put into the login QR; by default taken from the request. */
  publicUrl?: string | null;
  /** Origins allowed to call the API from a browser context (the app's WebView). */
  corsOrigins?: string[];
}

/** WebView origins of the Capacitor app (Android https://localhost, iOS capacitor://localhost). */
export const APP_ORIGINS = ['https://localhost', 'capacitor://localhost', 'http://localhost'];

const MAX_BATCH = 1000;

const syncEventsSchema = {
  type: 'object',
  required: ['hubId', 'settingsVersion', 'events'],
  additionalProperties: false,
  properties: {
    hubId: { type: 'string', minLength: 1 },
    settingsVersion: { type: 'integer', minimum: 0 },
    events: {
      type: 'array',
      maxItems: MAX_BATCH,
      items: {
        type: 'object',
        required: ['id', 'at', 'topic', 'payload'],
        properties: {
          id: { type: 'integer', minimum: 1 },
          at: { type: 'integer' },
          topic: { type: 'string', minLength: 1 },
          payload: {
            type: 'object',
            required: ['actor', 'action', 'entityType', 'entityId'],
            properties: {
              actor: { type: 'string' },
              action: { type: 'string' },
              entityType: { type: 'string' },
              entityId: { type: 'string' },
              data: { type: 'object' },
            },
          },
        },
      },
    },
  },
} as const;

const clubSchema = {
  type: 'object',
  required: ['name', 'timezone', 'currency'],
  properties: { name: { type: 'string' }, timezone: { type: 'string' }, currency: { type: 'string' } },
} as const;

const snapshotSchema = {
  type: 'object',
  required: ['hubId', 'settingsVersion', 'club', 'tariffs', 'tables'],
  properties: {
    hubId: { type: 'string', minLength: 1 },
    settingsVersion: { type: 'integer', minimum: 0 },
    club: clubSchema,
    tariffs: { type: 'array', items: { type: 'object' } },
    tables: { type: 'array', items: { type: 'object' } },
  },
} as const;

const loginSchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: { email: { type: 'string', minLength: 1 }, password: { type: 'string', minLength: 1 } },
} as const;

const keyLoginSchema = {
  type: 'object',
  required: ['key'],
  additionalProperties: false,
  properties: { key: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

const deviceSchema = {
  type: 'object',
  required: ['token', 'platform'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 4096 },
    platform: { type: 'string', enum: ['android', 'ios', 'web'] },
    name: { type: 'string', maxLength: 200 },
  },
} as const;

const rulesSchema = {
  type: 'object',
  required: ['rules'],
  additionalProperties: false,
  properties: {
    rules: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        required: ['kind', 'clubId', 'enabled'],
        properties: {
          kind: { type: 'string' },
          clubId: { type: ['string', 'null'] },
          enabled: { type: 'boolean' },
        },
      },
    },
  },
} as const;

const tariffsSchema = {
  type: 'object',
  required: ['tariffs'],
  properties: { tariffs: { type: 'array', items: { type: 'object' } } },
} as const;

export function buildApp(deps: AppDeps): FastifyInstance {
  const { db } = deps;
  const clock = deps.clock ?? systemClock;
  const push = deps.push ?? new PushDispatcher(db, new DisabledSender(), () => clock.now());
  const corsOrigins = new Set(deps.corsOrigins ?? APP_ORIGINS);
  const app = Fastify({ logger: deps.logger ?? false, disableRequestLogging: true, forceCloseConnections: true, bodyLimit: 8 * 1024 * 1024 });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof CloudError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка облака' } });
  });

  // Unknown URLs: JSON 404, or index.html for the cabinet's client-side routes (see static.ts).
  registerStatic(app, deps.staticDir);

  // The app's WebView calls the cloud from its own origin with a bearer token (no cookies):
  // answer CORS for the listed origins only.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !corsOrigins.has(origin)) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      reply.header('access-control-allow-headers', 'authorization, content-type, x-ts-app');
      reply.header('access-control-max-age', '600');
      return reply.status(204).send();
    }
  });

  // --- auth helpers ---------------------------------------------------------

  async function requireHub(req: FastifyRequest, hubId: string): Promise<HubRow> {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new CloudError(401, 'UNAUTHORIZED', 'Нужен ключ HUB (Authorization: Bearer)');
    }
    const key = header.slice('Bearer '.length).trim();
    const hub = key ? await findHubByKey(db, key) : null;
    if (!hub) throw new CloudError(401, 'UNAUTHORIZED', 'Неизвестный ключ HUB');
    if (hub.id !== hubId) throw new CloudError(403, 'HUB_MISMATCH', 'Ключ выдан другому HUB');
    return hub;
  }

  /** The browser cabinet sends the cookie, the phone app `Authorization: Bearer <session token>`. */
  function ownerToken(req: FastifyRequest): string | null {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null;
    return parseCookies(req.headers.cookie)[OWNER_COOKIE] ?? null;
  }

  const isApp = (req: FastifyRequest): boolean => req.headers['x-ts-app'] === '1';

  /** The app gets the token in the body; the browser gets an HttpOnly cookie and never sees it. */
  async function startSession(req: FastifyRequest, reply: FastifyReply, owner: OwnerView): Promise<CloudLoginResponse> {
    const token = await createSession(db, owner.id, clock.now());
    if (isApp(req)) return { ...owner, token };
    setOwnerCookie(reply, token);
    return owner;
  }

  function publicUrl(req: FastifyRequest): string {
    if (deps.publicUrl) return deps.publicUrl;
    const forwarded = req.headers['x-forwarded-proto'];
    const proto = typeof forwarded === 'string' && forwarded ? forwarded.split(',')[0]!.trim() : req.protocol;
    return `${proto}://${req.headers.host ?? 'localhost'}`;
  }

  async function requireOwner(req: FastifyRequest): Promise<OwnerView> {
    const token = ownerToken(req);
    const owner = token ? await ownerByToken(db, token, clock.now()) : null;
    if (!owner) throw new CloudError(401, 'UNAUTHORIZED', 'Войдите в кабинет');
    return owner;
  }

  async function requireClub(owner: OwnerView, clubId: string): Promise<ClubRow> {
    const club = await clubOfCompany(db, owner.company.id, clubId);
    if (!club) throw new CloudError(404, 'CLUB_NOT_FOUND', 'Клуб не найден');
    return club;
  }

  function setOwnerCookie(reply: FastifyReply, token: string | null): void {
    reply.header(
      'set-cookie',
      serializeCookie(OWNER_COOKIE, token ?? '', {
        maxAgeSeconds: token ? SESSION_TTL_MS / 1000 : 0,
        ...(deps.secureCookies ? { secure: true } : {}),
      }),
    );
  }

  // --- health ---------------------------------------------------------------

  app.get('/api/health', async () => ({ ok: true, now: clock.now() }));

  // --- HUB sync -------------------------------------------------------------

  app.post<{ Body: SyncEventsRequest }>('/sync/events', { schema: { body: syncEventsSchema } }, async (req) => {
    const hub = await requireHub(req, req.body.hubId);
    const res = await acceptEvents(db, clock.now(), hub, req.body);
    push.kick();
    return res;
  });

  app.post<{ Body: SyncSnapshotRequest }>('/sync/snapshot', { schema: { body: snapshotSchema } }, async (req, reply) => {
    const hub = await requireHub(req, req.body.hubId);
    const outcome = await acceptSnapshot(db, clock.now(), hub, req.body);
    push.kick();
    return reply.status(outcome.status).send(outcome.body);
  });

  app.get<{ Querystring: { since?: string; hubId?: string } }>('/sync/settings', async (req) => {
    // No body here: the key alone identifies the HUB; `hubId` is optional and checked when given.
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new CloudError(401, 'UNAUTHORIZED', 'Нужен ключ HUB (Authorization: Bearer)');
    }
    const hub = await findHubByKey(db, header.slice('Bearer '.length).trim());
    if (!hub) throw new CloudError(401, 'UNAUTHORIZED', 'Неизвестный ключ HUB');
    if (req.query.hubId !== undefined && req.query.hubId !== hub.id) {
      throw new CloudError(403, 'HUB_MISMATCH', 'Ключ выдан другому HUB');
    }
    const since = Number(req.query.since ?? 0);
    if (!Number.isInteger(since) || since < 0) throw new CloudError(400, 'BAD_REQUEST', 'since должен быть целым числом');
    const club = await loadClub(db, hub.club_id);
    if (!club) throw new CloudError(500, 'CLUB_MISSING', 'Клуб этого HUB не найден');
    await db.transaction(async (tx) => {
      await tx.run('UPDATE hubs SET last_seen_at = ? WHERE id = ?', [clock.now(), hub.id]);
      await hubBackOnline(tx, clock.now(), hub, club.name);
    });
    push.kick();
    return settingsSince(db, club, since);
  });

  // --- owner auth -----------------------------------------------------------

  app.post<{ Body: CloudLoginRequest }>('/api/auth/login', { schema: { body: loginSchema } }, async (req, reply) => {
    const owner = await authenticateOwner(db, req.body.email, req.body.password);
    if (!owner) throw new CloudError(401, 'INVALID_CREDENTIALS', 'Неверная почта или пароль');
    return startSession(req, reply, owner);
  });

  app.post<{ Body: CloudKeyLoginRequest }>('/api/auth/key', { schema: { body: keyLoginSchema } }, async (req, reply) => {
    const owner = await authenticateOwnerKey(db, clock.now(), req.body.key);
    if (!owner) throw new CloudError(401, 'INVALID_KEY', 'Ключ не подходит: неверный или отозван');
    return startSession(req, reply, owner);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = ownerToken(req);
    if (token) await deleteSession(db, token);
    if (!isApp(req)) setOwnerCookie(reply, null);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => requireOwner(req));

  // --- owner cabinet --------------------------------------------------------

  app.get('/api/owner/overview', async (req) => {
    const owner = await requireOwner(req);
    return overview(db, clock.now(), owner);
  });

  app.get<{ Params: { id: string } }>('/api/owner/clubs/:id', async (req) => {
    const owner = await requireOwner(req);
    const club = await requireClub(owner, req.params.id);
    return clubDetails(db, clock.now(), club);
  });

  app.get<{ Params: { id: string }; Querystring: { day?: string } }>('/api/owner/clubs/:id/sessions', async (req) => {
    const owner = await requireOwner(req);
    const club = await requireClub(owner, req.params.id);
    const day = req.query.day ?? localDay(clock.now(), club.timezone);
    if (!isValidDay(day)) throw new CloudError(400, 'BAD_REQUEST', 'day должен быть датой YYYY-MM-DD');
    return clubSessions(db, club, day);
  });

  app.put<{ Params: { id: string }; Body: UpdateTariffsRequest }>(
    '/api/owner/clubs/:id/tariffs',
    { schema: { body: tariffsSchema } },
    async (req) => {
      const owner = await requireOwner(req);
      const club = await requireClub(owner, req.params.id);
      return updateTariffs(db, clock.now(), club, req.body);
    },
  );

  // --- phone: keys, devices, push rules ---------------------------------------

  app.get('/api/owner/keys', async (req) => {
    const owner = await requireOwner(req);
    return listOwnerKeys(db, owner.id);
  });

  app.post<{ Body: CreateOwnerKeyRequest | undefined }>('/api/owner/keys', async (req): Promise<CreateOwnerKeyResponse> => {
    const owner = await requireOwner(req);
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    const { key, view } = await createOwnerKey(db, clock.now(), owner.id, label);
    return { key, view, qr: loginQrText(publicUrl(req), key) };
  });

  app.delete<{ Params: { id: string } }>('/api/owner/keys/:id', async (req) => {
    const owner = await requireOwner(req);
    if (!(await revokeOwnerKey(db, clock.now(), owner.id, req.params.id))) {
      throw new CloudError(404, 'KEY_NOT_FOUND', 'Ключ не найден или уже отозван');
    }
    return { ok: true };
  });

  app.get('/api/owner/push', async (req) => {
    const owner = await requireOwner(req);
    return push.settings(owner.id);
  });

  app.put<{ Body: UpdatePushRulesRequest }>('/api/owner/push/rules', { schema: { body: rulesSchema } }, async (req) => {
    const owner = await requireOwner(req);
    for (const r of req.body.rules) {
      if (!isPushKind(r.kind)) throw new CloudError(400, 'PUSH_KIND', `Неизвестный вид уведомления: ${r.kind}`);
      if (r.clubId !== null) await requireClub(owner, r.clubId);
    }
    await saveRules(db, owner.id, req.body.rules);
    return push.settings(owner.id);
  });

  app.post<{ Body: RegisterDeviceRequest }>('/api/owner/devices', { schema: { body: deviceSchema } }, async (req) => {
    const owner = await requireOwner(req);
    return registerDevice(db, clock.now(), owner.id, req.body);
  });

  app.delete<{ Params: { id: string } }>('/api/owner/devices/:id', async (req) => {
    const owner = await requireOwner(req);
    if (!(await removeDevice(db, owner.id, req.params.id))) throw new CloudError(404, 'DEVICE_NOT_FOUND', 'Устройство не найдено');
    return { ok: true };
  });

  app.post('/api/owner/push/test', async (req) => {
    const owner = await requireOwner(req);
    const clubs = await db.all<{ id: string }>('SELECT id FROM clubs WHERE company_id = ? ORDER BY created_at LIMIT 1', [
      owner.company.id,
    ]);
    return push.test(owner.id, clubs[0]?.id ?? '');
  });

  return app;
}
