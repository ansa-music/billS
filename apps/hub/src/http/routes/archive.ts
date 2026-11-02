import type { FastifyInstance } from 'fastify';
import type { ArchiveView, DayChecksView } from '@bills/domain';
import { ArchiveService } from '../../archive.ts';
import type { Hub } from '../../hub.ts';
import { guard } from '../command.ts';

const dateQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { date: { type: 'string', maxLength: 10 } },
} as const;

/**
 * «Счета» → «Архив» and the checks of a day. Read-only, `checks.view` (the cash desk and the
 * barista): the checks one by one and what was cancelled or refunded, never day totals of revenue.
 */
export function registerArchiveRoutes(app: FastifyInstance, hub: Hub): void {
  const archive = new ArchiveService({ db: hub.db, clock: hub.clock });
  app.get<{ Querystring: { date?: string } }>(
    '/api/archive',
    { preHandler: guard('checks.view'), schema: { querystring: dateQuery } },
    async (req): Promise<ArchiveView> => archive.day(req.query.date),
  );
  app.get<{ Querystring: { date?: string } }>(
    '/api/checks/day',
    { preHandler: guard('checks.view'), schema: { querystring: dateQuery } },
    async (req): Promise<DayChecksView> => archive.checks(req.query.date),
  );
}
