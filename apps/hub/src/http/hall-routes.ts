import type { FastifyInstance } from 'fastify';
import type { JournalCategory } from '@bills/domain';
import { JOURNAL_CATEGORIES } from '@bills/domain';
import { getHallLayout, journalPage, lampDetails, saveHallLayout, sessionsBetween } from '../hall.ts';
import type { Hub } from '../hub.ts';
import type { runCommand } from './command.ts';

/** Floor plan, journal, game history and lamp details for the hall screens. */
export function registerHallRoutes(app: FastifyInstance, hub: Hub, command: typeof runCommand): void {
  app.get('/api/hall', async () => getHallLayout(hub.db));

  app.put('/api/hall', { schema: { body: { type: 'object' } } }, async (req, reply) =>
    command(req, reply, hub, (actor) => ({
      status: 200,
      body: saveHallLayout(hub.db, hub.events, hub.clock.now(), actor, req.body),
    })),
  );

  app.get<{ Querystring: { before?: number; limit?: number; category?: JournalCategory; tableId?: string } }>(
    '/api/journal',
    {
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

  app.get<{ Querystring: { from: number; to: number } }>(
    '/api/sessions',
    {
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

  app.get('/api/lamps', async () => lampDetails(hub.db));
}
