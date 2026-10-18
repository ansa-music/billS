import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Action } from '@bills/domain';
import { can } from '@bills/domain';
import type { Actor } from '../auth.ts';
import { HubError } from '../errors.ts';
import type { Hub } from '../hub.ts';
import type { CommandResult } from '../idempotency.ts';
import { idempotent } from '../idempotency.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook (http/auth.ts) for every request behind login. */
    actor?: Actor;
    /** The raw session token, for logout. */
    sessionToken?: string;
  }
}

/** The signed-in employee; 401 when the auth hook found nobody. */
export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw new HubError(401, 'UNAUTHORIZED', 'Войдите по ключу доступа');
  return req.actor;
}

/** 403 unless the signed-in role may perform the action. */
export function assertCan(req: FastifyRequest, action: Action): Actor {
  const actor = actorOf(req);
  if (!can(actor.role, action)) throw new HubError(403, 'FORBIDDEN', 'Недостаточно прав для этого действия');
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
 * `action` is checked against the signed-in role before anything runs.
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
