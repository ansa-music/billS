import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IssueKeyRequest, KeyListResponse, LoginAttemptsResponse, LoginRequest, MeResponse } from '@bills/domain';
import type { Hub } from '../hub.ts';
import { actorOf, assertCan, emptyBody, guard, runCommand } from './command.ts';

export interface AuthHookOptions {
  /**
   * Tests only: without a Bearer token, the request acts as a manager named by
   * the X-Actor header (or "test"). Never enabled by main.ts.
   */
  trustActorHeader?: boolean;
}

/**
 * Endpoints that work without a session: health and metrics for monitoring, login itself, and the
 * first-boot wizard (nobody has a key yet; LAN only and closed once set up — see routes/setup.ts).
 */
const PUBLIC = new Set(['/api/health', '/metrics', '/api/auth/login', '/api/demo', '/api/setup', '/api/setup/status']);
/** Endpoints a browser cannot send headers to (SSE) or that exist only with the simulator. */
const PUBLIC_PREFIXES = ['/api/events', '/api/dev/'];

function isPublic(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  // Only the API is behind login: the built hall screen (/, /assets/…) is served to anyone on the LAN.
  if (!path.startsWith('/api/')) return true;
  if (PUBLIC.has(path)) return true;
  return PUBLIC_PREFIXES.some((p) => path.startsWith(p));
}

function bearerOf(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1] ?? null;
}

function actorHeaderOf(req: FastifyRequest): string | null {
  const raw = req.headers['x-actor'];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return decodeURIComponent(raw).slice(0, 100);
  } catch {
    return null;
  }
}

/**
 * Resolves the session token on every /api request. Routes then read
 * `req.actor` through actorOf / assertCan / runCommand.
 */
export function registerAuth(app: FastifyInstance, hub: Hub, options: AuthHookOptions = {}): void {
  app.addHook('onRequest', async (req) => {
    req.license = hub.license;
    const token = bearerOf(req);
    if (token) {
      const resolved = hub.auth.resolve(token);
      if (resolved) {
        req.actor = resolved.actor;
        req.sessionToken = token;
        return;
      }
    }
    if (options.trustActorHeader) {
      // Tests: X-Actor names the actor; without it the request is an anonymous manager.
      req.actor = { id: null, name: actorHeaderOf(req) ?? 'test', role: 'manager', roles: ['manager'] };
      return;
    }
    if (!isPublic(req.url)) actorOf(req); // throws 401
  });

  app.post<{ Body: LoginRequest }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['key'],
          properties: { key: { type: 'string', minLength: 1, maxLength: 60 }, device: { type: 'string', maxLength: 120 } },
        },
      },
    },
    async (req, reply) => {
      const result = hub.auth.login({ key: req.body.key, device: req.body.device, ip: req.ip });
      return reply.status(200).send(result);
    },
  );

  app.get('/api/auth/me', async (req): Promise<MeResponse> => {
    const token = req.sessionToken;
    const resolved = token ? hub.auth.resolve(token) : null;
    if (!resolved) {
      // X-Actor test mode has no session: answer with what we know.
      const actor = actorOf(req);
      const club = hub.state().club;
      return {
        staff: { id: actor.id ?? '', name: actor.name, role: actor.role, roles: actor.roles, clubId: club.id, clubName: club.name },
        expiresAt: 0,
        license: hub.license.shown(),
      };
    }
    return { staff: resolved.staff, expiresAt: resolved.expiresAt, license: hub.license.shown() };
  });

  // Every login attempt of the branch, newest first (the key itself is never stored).
  app.get<{ Querystring: { limit?: number; before?: number } }>(
    '/api/auth/attempts',
    {
      preHandler: guard('staff.view'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 500 }, before: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (req): Promise<LoginAttemptsResponse> => ({ attempts: hub.auth.attempts(req.query.limit ?? 100, req.query.before) }),
  );

  app.post('/api/auth/logout', { schema: { body: emptyBody } }, async (req, reply) => {
    const actor = actorOf(req);
    if (req.sessionToken) hub.auth.logout(req.sessionToken, actor);
    return reply.status(200).send({ ok: true });
  });

  // ── Keys of an employee ──────────────────────────────────────────────────

  app.get<{ Params: { staffId: string } }>('/api/staff/:staffId/keys', async (req): Promise<KeyListResponse> => {
    const actor = assertCan(req, 'staff.view');
    void actor;
    return { keys: hub.auth.listKeys(req.params.staffId) };
  });

  app.post<{ Params: { staffId: string }; Body: IssueKeyRequest }>(
    '/api/staff/:staffId/keys',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', maxLength: 80 },
            expiresInDays: { type: 'integer', minimum: 1, maximum: 3650 },
            key: { type: 'string', maxLength: 20 },
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (_name, actor) => ({
          status: 201,
          body: hub.auth.issueKey({
            staffId: req.params.staffId,
            label: req.body?.label,
            expiresInDays: req.body?.expiresInDays,
            key: req.body?.key,
            actor,
          }),
        }),
        'staff.edit',
      ),
  );

  app.post<{ Params: { keyId: string } }>('/api/keys/:keyId/revoke', { schema: { body: emptyBody } }, async (req, reply) =>
    runCommand(req, reply, hub, (_name, actor) => ({ status: 200, body: hub.auth.revokeKey(req.params.keyId, actor) }), 'staff.edit'),
  );
}
