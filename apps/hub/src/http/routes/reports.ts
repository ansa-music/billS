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
}
