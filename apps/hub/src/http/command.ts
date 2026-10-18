import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HubError } from '../errors.ts';
import type { Hub } from '../hub.ts';
import type { CommandResult } from '../idempotency.ts';
import { idempotent } from '../idempotency.ts';

export function actorOf(req: FastifyRequest): string {
  // Temporary until staff log in with a PIN (stage 3).
  const raw = req.headers['x-actor'];
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  try {
    return decodeURIComponent(raw).slice(0, 100);
  } catch {
    return 'unknown';
  }
}

/**
 * Runs a state-changing command exactly once per Idempotency-Key. Every POST
 * route goes through here, so a retry after a lost response replays the result.
 */
export function runCommand(
  req: FastifyRequest,
  reply: FastifyReply,
  hub: Hub,
  command: (actor: string) => CommandResult,
) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new HubError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Нужен заголовок Idempotency-Key (8–200 символов)');
  }
  const hash = createHash('sha256')
    .update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`)
    .digest('hex');
  const result = idempotent(hub.db, hub.clock.now(), key, hash, () => command(actorOf(req)));
  return reply.status(result.status).header('idempotent-replayed', String(result.replayed)).send(result.body);
}

export const emptyBody = { type: 'object', additionalProperties: false, properties: {} } as const;
