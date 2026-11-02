import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.ts';
import { guard } from '../command.ts';

/** Routes for the owner summary: see api.ts (OwnerSummary). Read-only, no idempotency. */
export function registerReportRoutes(app: FastifyInstance, hub: Hub): void {
  app.get<{ Querystring: { date?: string } }>(
    '/api/reports/summary',
    {
      preHandler: guard('reports.view'),
      schema: {
        querystring: {
          type: 'object',
          properties: { date: { type: 'string' } },
        },
      },
    },
    async (req) => hub.reports.summary(req.query.date),
  );

  const range = {
    type: 'object',
    properties: { from: { type: 'string', maxLength: 10 }, to: { type: 'string', maxLength: 10 } },
  } as const;

  // «Себестоимость и прибыль» and «Что продаётся»: money of the venue, like the X report (stats.view).
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/reports/profit',
    { preHandler: guard('stats.view'), schema: { querystring: range } },
    async (req) => hub.reports.profit(req.query.from, req.query.to),
  );

  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/reports/sales',
    { preHandler: guard('stats.view'), schema: { querystring: range } },
    async (req) => hub.reports.sales(req.query.from, req.query.to),
  );
}
