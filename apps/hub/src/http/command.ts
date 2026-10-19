import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Action } from '@bills/domain';
import { ACTION_MODULE, decide, MODULE_LABEL } from '@bills/domain';
import type { Actor } from '../auth.ts';
import { HubError } from '../errors.ts';
import type { Hub } from '../hub.ts';
import type { LicenseService } from '../license.ts';
import type { CommandResult } from '../idempotency.ts';
import { idempotent } from '../idempotency.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook (http/auth.ts) for every request behind login. */
    actor?: Actor;
    /** The raw session token, for logout. */
    sessionToken?: string;
    /** The HUB's license (set by the auth hook): routes check it with the role. */
    license?: LicenseService;
  }
}

/** The signed-in employee; 401 when the auth hook found nobody. */
export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new HubError(401, 'UNAUTHORIZED', 'Войдите по ключу доступа');
  return req.actor;
}

/**
 * 403 unless the signed-in person's roles may perform the action and the
 * license allows it: FORBIDDEN, LICENSE_READ_ONLY (expired, blocked, missing…)
 * or LICENSE_MODULE_OFF (the bar or the hardware is not in the license).
 */
export function assertCan(req: FastifyRequest, action: Action): Actor {
  const actor = actorOf(req);
  const license = req.license;
  const decision = decide(actor.roles, action, license?.gate() ?? null);
  if (decision === 'forbidden') throw new HubError(403, 'FORBIDDEN', 'Недостаточно прав для этого действия');
  if (decision === 'read_only') {
    const message = license?.status().message ?? 'Лицензия не действует — режим «только чтение»';
    throw new HubError(403, 'LICENSE_READ_ONLY', message);
  }
  if (decision === 'module_off') {
    const mod = ACTION_MODULE[action];
    throw new HubError(403, 'LICENSE_MODULE_OFF', `Модуль «${mod ? MODULE_LABEL[mod] : action}» не входит в лицензию`);
  }
  return actor;
}

/** preHandler for GET routes: `{ preHandler: guard('audit.view') }`. */
export function guard(action: Action) {
  return async (req: FastifyRequest) => {
    assertCan(req, action);
  };
}

/**
 * Runs a state-changing command exactly once per Idempotency-Key. Every POST
 * route goes through here, so a retry after a lost response replays the result.
 * `action` is checked against the signed-in roles and the license before anything runs.
 */
export function runCommand(
  req: FastifyRequest,
  reply: FastifyReply,
  hub: Hub,
  command: (actorName: string, actor: Actor) => CommandResult,
  action?: Action,
) {
  const actor = action ? assertCan(req, action) : actorOf(req);
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new HubError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key (8–200 символов)');
  }
  // The actor is part of the request identity: the same key from another
  // person must not replay someone else's command.
  const hash = createHash('sha256')
    .update(`${req.method} ${req.url}\n${actor.id ?? actor.name}\n${JSON.stringify(req.body ?? null)}`)
    .digest('hex');
  const result = idempotent(hub.db, hub.clock.now(), key, hash, () => command(actor.name, actor));
  return reply.status(result.status).header('idempotent-replayed', String(result.replayed)).send(result.body);
}

export const emptyBody = { type: 'object', additionalProperties: false, properties: {} } as const;
