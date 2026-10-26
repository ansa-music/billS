import type { FastifyInstance } from 'fastify';
import type { ExtendGuestRequestBody, ExtendPrepaidRequest } from '@bills/domain';
import { PAYMENT_METHODS, PREPAID_MAX_MINUTES } from '@bills/domain';
import { GuestService } from '../../guest.ts';
import type { Hub } from '../../hub.ts';
import { assertCan, runCommand } from '../command.ts';

const moneySchema = { type: 'integer', minimum: 0, maximum: 1_000_000_000_00 } as const;
const partsSchema = {
  type: 'array',
  maxItems: PAYMENT_METHODS.length,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'amount'],
    properties: { method: { type: 'string', enum: [...PAYMENT_METHODS] }, amount: moneySchema },
  },
} as const;

/**
 * «Продлить предоплаченную игру на N минут» (PrepaidService.extend). Who may sell prepaid
 * time may extend it: `table.open`, as POST /api/tables/:id/open-prepaid. The guest's
 * «Продлить» is accepted through the same service, so the guest page shows the new time.
 */
export function registerExtendRoutes(app: FastifyInstance, hub: Hub): void {
  const guest = new GuestService(hub);

  app.post<{ Params: { sessionId: string }; Body: ExtendPrepaidRequest }>(
    '/api/sessions/:sessionId/extend',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['minutes'],
          properties: {
            minutes: { type: 'integer', minimum: 0, maximum: PREPAID_MAX_MINUTES },
            amount: moneySchema,
            parts: partsSchema,
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: hub.prepaid.extend({ sessionId: req.params.sessionId, ...req.body, actor }) }),
        'table.open',
      ),
  );

  app.post<{ Params: { requestId: string }; Body: ExtendGuestRequestBody }>(
    '/api/guest-requests/:requestId/extend',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, properties: { amount: moneySchema, parts: partsSchema } },
      },
    },
    async (req, reply) => {
      assertCan(req, 'hall.view');
      return runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: guest.extend(req.params.requestId, req.body ?? {}, actor) }),
        'table.open',
      );
    },
  );
}
