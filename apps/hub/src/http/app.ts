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
import { collectHealth, renderMetrics } from '../ops.ts';
import { renderPowerMetrics } from '../power/metrics.ts';
import type { SimulatorUps } from '../power/ups.ts';
import type { VersionInfo } from '../version.ts';
import { versionInfo } from '../version.ts';
import { registerMoneyRoutes } from './money-routes.ts';
import { registerStatic } from './static.ts';

export interface AppOptions {
  /** Exposes /api/dev/lamps to control the simulator. Never in production. */
  simulator?: SimulatorLampDriver;
  /** Exposes /api/dev/ups to drive the simulated UPS (HUB_UPS=simulator). */
  upsSimulator?: SimulatorUps;
  logger?: boolean;
  /** Database file reported by /api/health (size, free disk, last backup). */
  dbPath?: string;
  /** When the process started; defaults to app creation time. */
  startedAt?: number;
  version?: VersionInfo;
  /** Built hall screen (apps/web/dist) to serve on `/` with an SPA fallback; skipped when the folder is missing. */
  staticDir?: string;
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

  const healthCtx = {
    db: hub.db,
    dbPath: options.dbPath ?? ':memory:',
    startedAt: options.startedAt ?? Date.now(),
    version: options.version ?? versionInfo(),
  };
  // Health for operators and monitoring; `now` stays the HUB clock, the rest is wall time.
  app.get('/api/health', async () => ({ ...collectHealth(healthCtx), now: hub.clock.now(), power: hub.power.view() }));

  // Prometheus / Uptime Kuma scrape target.
  app.get('/metrics', async (_req, reply) =>
    reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(renderMetrics(collectHealth(healthCtx)) + renderPowerMetrics(hub.power.view())),
  );

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

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/pause',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.sessions.pause({ sessionId: req.params.sessionId, actor }),
      })),
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/resume',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.sessions.resume({ sessionId: req.params.sessionId, actor }),
      })),
  );

  app.post<{ Params: { sessionId: string }; Body: { toTableId: string } }>(
    '/api/sessions/:sessionId/transfer',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['toTableId'],
          properties: { toTableId: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.sessions.transfer({ sessionId: req.params.sessionId, toTableId: req.body.toTableId, actor }),
      })),
  );

  // Flashes the lamp: checks the wiring from the screen; stage 2 uses it before prepaid time ends.
  app.post<{ Params: { tableId: string }; Body: { times?: number } }>(
    '/api/tables/:tableId/blink',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, properties: { times: { type: 'integer', minimum: 1, maximum: 10 } } },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 202,
        body: hub.blink(req.params.tableId, actor, req.body?.times ?? 3),
      })),
  );

  // The club's UPS and what to do on power loss.
  app.get('/api/power', async () => hub.power.view());

  app.post<{ Body: { autoPauseOnPowerLoss?: boolean } }>(
    '/api/power/settings',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, properties: { autoPauseOnPowerLoss: { type: 'boolean' } } },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 200, body: hub.setPowerSettings(actor, req.body ?? {}) })),
  );

  // Emergency manual mode: the controller is down, lamps are switched by hand.
  app.get('/api/lamps/manual', async () => hub.manualMode());

  app.post<{ Body: { enabled: boolean; reason?: string } }>(
    '/api/lamps/manual',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' }, reason: { type: 'string', maxLength: 300 } },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.setManualMode({ enabled: req.body.enabled, reason: req.body.reason, actor }),
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

  const ups = options.upsSimulator;
  if (ups) {
    app.get('/api/dev/ups', async () => ({ ...ups.state }));
    app.post<{ Body: { onBattery?: boolean; chargePercent?: number; runtimeSeconds?: number; unreachable?: boolean; poll?: boolean } }>(
      '/api/dev/ups',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              onBattery: { type: 'boolean' },
              chargePercent: { type: 'number', minimum: 0, maximum: 100 },
              runtimeSeconds: { type: 'integer', minimum: 0 },
              unreachable: { type: 'boolean' },
              poll: { type: 'boolean' },
            },
          },
        },
      },
      async (req) => {
        const { poll, ...patch } = req.body;
        ups.set(patch);
        if (poll !== false) await hub.power.poll();
        return { ...ups.state };
      },
    );
  }

  const simulator = options.simulator;
  if (simulator) {
    app.get('/api/dev/lamps', async () => simulator.status());

    app.post<{
      Body: {
        latencyMs?: number;
        offline?: boolean;
        faults?: SimulatorFault[];
        clearFaults?: boolean;
        /** Current sensor override: on by hand (true), dead bulb (false), follow the relay (null). */
        light?: { channel: string; on: boolean | null };
        /** Run one monitor poll right away (demo of the current-sensor alerts). */
        poll?: boolean;
      };
    }>(
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
              light: {
                type: 'object',
                additionalProperties: false,
                required: ['channel', 'on'],
                properties: { channel: { type: 'string', minLength: 1, maxLength: 100 }, on: { type: ['boolean', 'null'] } },
              },
              poll: { type: 'boolean' },
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
        if (b.light) simulator.setLight(b.light.channel, b.light.on);
        if (b.poll) await hub.monitor.poll();
        // Coming back online: resync lamps in an unknown state right away.
        if (b.offline === false) {
          hub.lamps.reconcile();
          hub.lamps.kick();
        }
        return simulator.status();
      },
    );
  }

  if (options.staticDir) registerStatic(app, options.staticDir);

  return app;
}
