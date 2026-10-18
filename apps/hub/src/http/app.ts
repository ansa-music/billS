import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { HubError } from '../errors.ts';
import type { Hub } from '../hub.ts';
import type { ChangeEvent } from '../events.ts';
import type { SimulatorFault, SimulatorLampDriver } from '../lamps/simulator.ts';
import { SIMULATOR_FAULTS } from '../lamps/simulator.ts';
import { registerAuth } from './auth.ts';
import type { AuthHookOptions } from './auth.ts';
import { registerHallRoutes } from './hall-routes.ts';
import { emptyBody, guard, runCommand } from './command.ts';
import { registerBarRoutes } from './routes/bar.ts';
import { registerReportRoutes } from './routes/reports.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerStaffRoutes } from './routes/staff.ts';

export interface AppOptions extends AuthHookOptions {
  /** Exposes /api/dev/lamps to control the simulator. Never in production. */
  simulator?: SimulatorLampDriver;
  logger?: boolean;
}

export function buildApp(hub: Hub, options: AppOptions = {}): FastifyInstance {
  // Screens poll /api/state on every change: per-request logs would drown real events.
  const app = Fastify({ logger: options.logger ?? false, disableRequestLogging: true, forceCloseConnections: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HubError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Внутренняя ошибка HUB' } });
  });

  // Resolves the Bearer token on every /api request; routes then check the role.
  registerAuth(app, hub, { trustActorHeader: options.trustActorHeader ?? false });

  app.get('/api/health', async () => ({ ok: true, now: hub.clock.now() }));

  registerHallRoutes(app, hub, runCommand);

  app.get('/api/state', { preHandler: guard('hall.view') }, async () => hub.state());

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
      }), 'table.open'),
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/stop',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.sessions.stop({ sessionId: req.params.sessionId, actor }),
      }), 'table.stop'),
  );

  app.post<{ Params: { alertId: string } }>(
    '/api/alerts/:alertId/resolve',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 200, body: hub.resolveAlert(req.params.alertId, actor) }), 'alert.resolve'),
  );

  // Pages beyond the hall screen: each module owns its routes.
  registerSettingsRoutes(app, hub);
  registerBarRoutes(app, hub);
  registerStaffRoutes(app, hub);
  registerReportRoutes(app, hub);

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
    // A named event, not a comment: screens reconnect when pings stop (a dead proxy or Wi-Fi).
    const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15_000);
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
