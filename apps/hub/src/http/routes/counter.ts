import type { FastifyInstance } from 'fastify';
import type { CounterCancelRequest, CounterStageRequest, CreateCounterOrderRequest } from '@bills/domain';
import { COUNTER_STAGES, OPTION_GROUPS_MAX, OPTION_CHOICES_MAX, ORDER_MAX_LINES, PAYMENT_METHODS } from '@bills/domain';
import type { Hub } from '../../hub.ts';
import { guard, runCommand } from '../command.ts';
import { loyaltyApplySchema } from './loyalty.ts';

const id = { type: 'string', minLength: 1, maxLength: 100 } as const;
// Lengths, quantities and the service are checked by the service: a readable 422, not a schema 400.
const createSchema = {
  type: 'object',
  additionalProperties: false,
  // `payment` may be left out: the same as null — the check stays open.
  required: ['items', 'service'],
  properties: {
    items: {
      type: 'array',
      maxItems: ORDER_MAX_LINES * 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['productId', 'qty'],
        properties: {
          productId: id,
          qty: { type: 'number' },
          options: { type: 'array', maxItems: OPTION_GROUPS_MAX * OPTION_CHOICES_MAX, items: id },
        },
      },
    },
    service: { type: 'string', maxLength: 20 },
    guestName: { type: 'string', maxLength: 200 },
    note: { type: 'string', maxLength: 1000 },
    // «Гость» (loyalty): phone, and the gift or bonuses to apply before the payment.
    loyalty: { anyOf: [loyaltyApplySchema, { type: 'null' }] },
    payment: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['parts'],
      properties: {
        parts: {
          type: 'array',
          maxItems: PAYMENT_METHODS.length,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['method', 'amount'],
            properties: {
              method: { type: 'string', enum: [...PAYMENT_METHODS] },
              amount: { type: 'integer', minimum: 0, maximum: 1_000_000_000_00 },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Coffee shop counter (packages/domain cafe.ts). Taking an order includes its payment
 * (`counter.take`: cashier, barista and up); the barista moves stages (`counter.stage`);
 * cancelling is a bar order cancel (`order.cancel`). The guest screen's board is public.
 */
export function registerCounterRoutes(app: FastifyInstance, hub: Hub): void {
  app.post<{ Body: CreateCounterOrderRequest }>('/api/counter/orders', { schema: { body: createSchema } }, async (req, reply) =>
    runCommand(req, reply, hub, (actor) => ({ status: 201, body: hub.counter.create({ ...req.body, actor }) }), 'counter.take'),
  );

  app.get('/api/counter/orders', { preHandler: guard('hall.view') }, async () => hub.counter.list());

  app.post<{ Params: { orderId: string }; Body: CounterStageRequest }>(
    '/api/counter/orders/:orderId/stage',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['stage'],
          properties: { stage: { type: 'string', enum: [...COUNTER_STAGES] } },
        },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: hub.counter.stage({ orderId: req.params.orderId, stage: req.body.stage, actor }) }),
        'counter.stage',
      ),
  );

  app.post<{ Params: { orderId: string }; Body: CounterCancelRequest }>(
    '/api/counter/orders/:orderId/cancel',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason'],
          properties: { reason: { type: 'string', maxLength: 300 } },
        },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: hub.counter.cancel({ orderId: req.params.orderId, reason: req.body.reason, actor }) }),
        'order.cancel',
      ),
  );

  // Public (http/auth.ts): numbers and first names only, for the screen facing the guests.
  app.get('/api/counter/board', async () => hub.counter.board());
}
