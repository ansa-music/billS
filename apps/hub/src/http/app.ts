import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BillingError } from '@bills/domain';
import { HubError } from '../errors.ts';
import type { Hub } from '../hub.ts';
import type { CommandResult } from '../idempotency.ts';
import { idempotent } from '../idempotency.ts';
import type { ChangeEvent } from '../events.ts';
import type { SimulatorFault, SimulatorLampDriver } from '../lamps/simulator.ts';
import { SIMULATOR_FAULTS } from '../lamps/simulator.ts';
import { registerMoneyRoutes } from './money-routes.ts';

export interface AppOptions {
  /** Exposes /api/dev/lamps to control the simulator. Never in production. */
  simulator?: SimulatorLampDriver;
  logger?: boolean;
}

function actorOf(req: FastifyRequest): string {
  // Temporary until staff log in with a PIN (stage 3).
  const raw = req.headers['x-actor'];
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  try {
    return decodeURIComponent(raw).slice(0, 100);
  } catch {
    return 'unknown';
  }
}

export function runCommand(req: FastifyRequest, reply: FastifyReply, hub: Hub, command: (actor: string) => CommandResult) {
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

const emptyBody = { type: 'object', additionalProperties: false, properties: {} } as const;

export function buildApp(hub: Hub, options: AppOptions = {}): FastifyInstance {
  // Screens poll /api/state on every change: per-request logs would drown real events.
  const app = Fastify({ logger: options.logger ?? false, disableRequestLogging: true, forceCloseConnections: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HubError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof BillingError) {
      return reply.status(422).send({ error: { code: err.code, message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка HUB' } });
  });

  app.get('/api/health', async () => ({ ok: true, now: hub.clock.now() }));

  app.get('/api/state', async () => hub.state());

  app.post<{ Params: { tableId: string }; Body: { tariffId?: string } }>(
    '/api/tables/:tableId/open',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, properties: { tariffId: { type: 'string' } } },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 201,
        body: hub.sessions.open({ tableId: req.params.tableId, tariffId: req.body?.tariffId, actor }),
      })),
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/stop',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.sessions.stop({ sessionId: req.params.sessionId, actor }),
      })),
  );

  app.post<{ Params: { alertId: string } }>(
    '/api/alerts/:alertId/resolve',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 200, body: hub.resolveAlert(req.params.alertId, actor) })),
  );

  registerMoneyRoutes(app, hub);

  // Server-sent events: screens refetch /api/state when something changes.
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const onChange = (e: ChangeEvent) => res.write(`event: changed\ndata: ${JSON.stringify(e)}\n\n`);
    hub.events.on('changed', onChange);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      hub.events.off('changed', onChange);
    });
  });

  const simulator = options.simulator;
  if (simulator) {
    app.get('/api/dev/lamps', async () => simulator.status());

    app.post<{ Body: { latencyMs?: number; offline?: boolean; faults?: SimulatorFault[]; clearFaults?: boolean } }>(
      '/api/dev/lamps',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              latencyMs: { type: 'integer', minimum: 0, maximum: 60_000 },
              offline: { type: 'boolean' },
              faults: { type: 'array', items: { type: 'string', enum: [...SIMULATOR_FAULTS] } },
              clearFaults: { type: 'boolean' },
            },
          },
        },
      },
      async (req) => {
        const b = req.body;
        if (b.latencyMs !== undefined) simulator.latencyMs = b.latencyMs;
        if (b.offline !== undefined) simulator.offline = b.offline;
        if (b.clearFaults) simulator.clearFaults();
        if (b.faults) simulator.injectFaults(...b.faults);
        // Coming back online: resync lamps in an unknown state right away.
        if (b.offline === false) {
          hub.lamps.reconcile();
          hub.lamps.kick();
        }
        return simulator.status();
      },
    );
  }

  return app;
}
