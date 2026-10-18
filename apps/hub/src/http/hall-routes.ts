import type { FastifyInstance } from 'fastify';
import type { JournalCategory } from '@bills/domain';
import { JOURNAL_CATEGORIES } from '@bills/domain';
import { getHallLayout, journalPage, lampDetails, saveHallLayout, sessionsBetween } from '../hall.ts';
import type { Hub } from '../hub.ts';
import type { runCommand } from './command.ts';
import { guard } from './command.ts';

/**
 * Floor plan, journal, game history and lamp details for the hall screens.
 * Every route is behind a permission: the plan and the day's games are for all
 * staff (hall.view), editing the plan for managers (hall.edit), the journal is
 * the audit log in plain words (audit.view), lamps belong to equipment (equipment.view).
 */
export function registerHallRoutes(app: FastifyInstance, hub: Hub, command: typeof runCommand): void {
  app.get('/api/hall', { preHandler: guard('hall.view') }, async () => getHallLayout(hub.db));

  app.put('/api/hall', { schema: { body: { type: 'object' } } }, async (req, reply) =>
    command(
      req,
      reply,
      hub,
      (actor) => ({
        status: 200,
        body: saveHallLayout(hub.db, hub.events, hub.clock.now(), actor, req.body),
      }),
      'hall.edit',
    ),
  );

  app.get<{ Querystring: { before?: number; limit?: number; category?: JournalCategory; tableId?: string } }>(
    '/api/journal',
    {
      preHandler: guard('audit.view'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            before: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            category: { type: 'string', enum: [...JOURNAL_CATEGORIES] },
            tableId: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (req) =>
      journalPage(hub.db, {
        before: req.query.before,
        limit: req.query.limit ?? 50,
        category: req.query.category,
        tableId: req.query.tableId,
      }),
  );

  // The table card shows the day's games to every employee, so this is hall.view, not checks.view.
  app.get<{ Querystring: { from: number; to: number } }>(
    '/api/sessions',
    {
      preHandler: guard('hall.view'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: { from: { type: 'integer', minimum: 0 }, to: { type: 'integer', minimum: 0 } },
        },
      },
    },
    async (req) => sessionsBetween(hub.db, hub.clock.now(), req.query.from, req.query.to),
  );

  app.get('/api/lamps', { preHandler: guard('equipment.view') }, async () => lampDetails(hub.db));
}
