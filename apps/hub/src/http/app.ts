import type { OutgoingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { BillingError, DEMO_KEYS, originAllowed } from '@bills/domain';
import type { DemoInfo } from '@bills/domain';
import { HubError } from '../errors.ts';
import type { Hub } from '../hub.ts';
import type { ChangeEvent } from '../events.ts';
import type { SimulatorFault, SimulatorLampDriver } from '../lamps/simulator.ts';
import { SIMULATOR_FAULTS } from '../lamps/simulator.ts';
import { collectHealth, renderMetrics } from '../ops.ts';
import { renderPowerMetrics } from '../power/metrics.ts';
import type { SimulatorUps } from '../power/ups.ts';
import type { VersionInfo } from '../version.ts';
import { versionInfo } from '../version.ts';
import { registerAuth } from './auth.ts';
import type { AuthHookOptions } from './auth.ts';
import { emptyBody, guard, runCommand } from './command.ts';
import { registerHallRoutes } from './hall-routes.ts';
import { registerMoneyRoutes } from './money-routes.ts';
import { registerBarRoutes } from './routes/bar.ts';
import { registerCounterRoutes } from './routes/counter.ts';
import { registerLicenseRoutes } from './routes/license.ts';
import { registerLoyaltyRoutes } from './routes/loyalty.ts';
import { registerTemplateRoutes } from './routes/templates.ts';
import { registerReportRoutes } from './routes/reports.ts';
import { registerInsightsRoutes } from './routes/insights.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerSetupRoutes } from './routes/setup.ts';
import type { SetupController } from './routes/setup.ts';
import { registerStaffRoutes } from './routes/staff.ts';
import { registerStatic } from './static.ts';
import type { TlsStatus } from '@bills/domain';
import { registerTlsRoutes, tlsStatus } from '../tls/routes.ts';
import type { TlsRuntime } from '../tls/routes.ts';

export interface AppOptions extends AuthHookOptions {
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
  /** HTTPS: certificates (HUB_TLS_*) and what GET /api/tls reports; without it /api/tls says `enabled: false`. */
  tls?: { runtime: TlsRuntime | null; status: () => TlsStatus };
  /** Origin patterns (`https://*.pages.dev`) of screens on another domain; Bearer tokens only, no cookies. */
  corsOrigins?: readonly string[];
  /** Public demo club: GET /api/demo tells the screen to show the demo banner and keys. */
  demo?: { resetAt: () => number };
  /** First-boot wizard (/setup, src/setup.ts): connects the HUB to a cloud from the club LAN. */
  setup?: SetupController;
}

export function buildApp(hub: Hub, options: AppOptions = {}): FastifyInstance {
  // Screens poll /api/state on every change: per-request logs would drown real events.
  const runtime = options.tls?.runtime ?? null;
  const app = Fastify({
    logger: options.logger ?? false,
    disableRequestLogging: true,
    forceCloseConnections: true,
    ...(runtime ? { https: { key: runtime.key, cert: runtime.cert } } : {}),
  }) as unknown as FastifyInstance;

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HubError) {
      return reply.status(err.status).send({ error: { ...err.extra, code: err.code, message: err.message } });
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

  // CORS for a club screen served from another domain (Cloudflare/GitHub Pages). Registered before auth, so a
  // preflight (no token) is answered here and never reaches the 401 check.
  const corsOrigins = options.corsOrigins ?? [];
  if (corsOrigins.length) {
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (!originAllowed(origin, corsOrigins)) return;
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      if (req.method === 'OPTIONS') {
        reply.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
        reply.header('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-actor');
        reply.header('access-control-max-age', '600');
        return reply.status(204).send();
      }
    });
  }

  // Resolves the Bearer token on every /api request; routes then check the role.
  registerAuth(app, hub, { trustActorHeader: options.trustActorHeader ?? false });

  const healthCtx = {
    db: hub.db,
    dbPath: options.dbPath ?? ':memory:',
    startedAt: options.startedAt ?? Date.now(),
    version: options.version ?? versionInfo(),
  };
  // Health for operators and monitoring (public); `now` stays the HUB clock, the rest is wall time.
  const demo = options.demo;
  if (demo) {
    app.get('/api/demo', async (): Promise<DemoInfo> => ({ demo: true, keys: DEMO_KEYS, resetAt: demo.resetAt() }));
  }

  app.get('/api/health', async () => ({
    ...collectHealth(healthCtx),
    now: hub.clock.now(),
    power: hub.power.view(),
  }));

  // Prometheus / Uptime Kuma scrape target (public).
  app.get('/metrics', async (_req, reply) =>
    reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(renderMetrics(collectHealth(healthCtx)) + renderPowerMetrics(hub.power.view())),
  );

  registerHallRoutes(app, hub, runCommand);

  app.get('/api/state', { preHandler: guard('hall.view') }, async () => hub.state());

  app.post<{ Params: { tableId: string }; Body: { tariffId?: string; prepaidMinutes?: number } }>(
    '/api/tables/:tableId/open',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { tariffId: { type: 'string' }, prepaidMinutes: { type: 'integer' } },
        },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => {
          const { tariffId, prepaidMinutes } = req.body ?? {};
          const tableId = req.params.tableId;
          return {
            status: 201,
            body:
              prepaidMinutes === undefined
                ? hub.sessions.open({ tableId, tariffId, actor })
                : hub.prepaid.open({ tableId, tariffId, minutes: prepaidMinutes, actor }),
          };
        },
        'table.open',
      ),
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/stop',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({
          status: 200,
          body: hub.stopGame({ sessionId: req.params.sessionId, actor }),
        }),
        'table.stop',
      ),
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/pause',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({
          status: 200,
          body: hub.sessions.pause({ sessionId: req.params.sessionId, actor }),
        }),
        'table.continue',
      ),
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/resume',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({
          status: 200,
          body: hub.sessions.resume({ sessionId: req.params.sessionId, actor }),
        }),
        'table.continue',
      ),
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
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({
          status: 200,
          body: hub.sessions.transfer({ sessionId: req.params.sessionId, toTableId: req.body.toTableId, actor }),
        }),
        'table.continue',
      ),
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
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({
          status: 202,
          body: hub.blink(req.params.tableId, actor, req.body?.times ?? 3),
        }),
        'lamp.blink',
      ),
  );

  // The club's UPS and what to do on power loss.
  app.get('/api/power', { preHandler: guard('hall.view') }, async () => hub.power.view());

  app.post<{ Body: { autoPauseOnPowerLoss?: boolean } }>(
    '/api/power/settings',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, properties: { autoPauseOnPowerLoss: { type: 'boolean' } } },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: hub.setPowerSettings(actor, req.body ?? {}) }),
        'power.edit',
      ),
  );

  // Emergency manual mode: the controller is down, lamps are switched by hand.
  app.get('/api/lamps/manual', { preHandler: guard('hall.view') }, async () => hub.manualMode());

  // Anyone at the desk may switch it on; switching it off is a manager's call (checked in Hub.setManualMode).
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
      runCommand(
        req,
        reply,
        hub,
        (actor, by) => ({
          status: 200,
          body: hub.setManualMode({ enabled: req.body.enabled, reason: req.body.reason, actor, by }),
        }),
        'lamps.manual',
      ),
  );

  app.post<{ Params: { alertId: string } }>(
    '/api/alerts/:alertId/resolve',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 200, body: hub.resolveAlert(req.params.alertId, actor) }), 'alert.resolve'),
  );

  // The cash desk (stage 2) and the pages beyond the hall screen: each module owns its routes.
  registerMoneyRoutes(app, hub);
  registerSettingsRoutes(app, hub);
  registerBarRoutes(app, hub);
  registerCounterRoutes(app, hub);
  registerLoyaltyRoutes(app, hub);
  registerStaffRoutes(app, hub);
  registerReportRoutes(app, hub);
  registerInsightsRoutes(app, hub);
  registerLicenseRoutes(app, hub);
  registerTemplateRoutes(app, hub);

  // Server-sent events: screens refetch /api/state when something changes.
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      // Hijacked: headers set by hooks (CORS) are not sent by Fastify, pass them on by hand.
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    const onChange = (e: ChangeEvent) => res.write(`event: changed\ndata: ${JSON.stringify(e)}\n\n`);
    hub.events.on('changed', onChange);
    // A named event, not a comment: screens reconnect when pings stop (a dead proxy or Wi-Fi).
    const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      hub.events.off('changed', onChange);
    });
  });

  const ups = options.upsSimulator;
  // Always answers, so the equipment page can tell "no simulated UPS" from an error (no 404 in the console).
  app.get('/api/dev/ups', async () => (ups ? { configured: true, ...ups.state } : { configured: false }));
  if (ups) {
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
        return { configured: true, ...ups.state };
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

  registerTlsRoutes(
    app,
    options.tls?.status ?? (() => tlsStatus({ tls: null, httpsPort: null, httpPort: null, mdnsName: null, now: hub.clock.now() })),
    runtime,
  );

  // Before the hall screen: its SPA fallback must not answer /setup.
  if (options.setup) registerSetupRoutes(app, options.setup);

  if (options.staticDir) registerStatic(app, options.staticDir);

  return app;
}
