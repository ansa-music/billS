import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CounterCancelRequest, CounterStageRequest, CreateCounterOrderRequest } from '@bills/domain';
import { COUNTER_STAGES, OPTION_GROUPS_MAX, OPTION_CHOICES_MAX, ORDER_MAX_LINES, PAYMENT_METHODS } from '@bills/domain';
import { HubError } from '../../errors.ts';
import type { Hub } from '../../hub.ts';
import { assertCan, guard, runCommand } from '../command.ts';
import { loyaltyApplySchema } from './loyalty.ts';

const id = { type: 'string', minLength: 1, maxLength: 100 } as const;
// Lengths, quantities and the service are checked by the service: a readable 422, not a schema 400.
export const createSchema = {
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
 * An order taken with its payment also needs the right to take money (`payment.take`): a coffee
 * shop's waiter takes orders on the floor and sends them to the barista without payment, the
 * till (cashier, barista and up) takes the money — at once or later from «Счета».
 */
export function assertCounterPayment(req: FastifyRequest, body: Pick<CreateCounterOrderRequest, 'payment'>): void {
  if (!body.payment) return;
  try {
    assertCan(req, 'payment.take');
  } catch (e) {
    if (e instanceof HubError && e.code === 'FORBIDDEN') {
      throw new HubError(403, 'FORBIDDEN', 'Оплату принимает кассир или бариста — отправьте заказ без оплаты');
    }
    throw e;
  }
}

/**
 * Coffee shop counter (packages/domain cafe.ts). Taking an order (`counter.take`: the waiter,
 * cashier, barista and up) may include its payment, which needs `payment.take` as well
 * (assertCounterPayment); the barista moves stages (`counter.stage`);
 * cancelling (deleting a check) is the manager's and the administrator's (`counter.cancel`):
 * the order stays CANCELLED with who and why. The guest screen's board is public.
 */
export function registerCounterRoutes(app: FastifyInstance, hub: Hub): void {
  app.post<{ Body: CreateCounterOrderRequest }>('/api/counter/orders', { schema: { body: createSchema } }, async (req, reply) => {
    assertCan(req, 'counter.take');
    assertCounterPayment(req, req.body);
    return runCommand(req, reply, hub, (actor) => ({ status: 201, body: hub.counter.create({ ...req.body, actor }) }), 'counter.take');
  });

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
        'counter.cancel',
      ),
  );

  // Public (http/auth.ts): numbers and first names only, for the screen facing the guests.
  app.get('/api/counter/board', async () => hub.counter.board());
}
