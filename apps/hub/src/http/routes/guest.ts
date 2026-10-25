import type { FastifyInstance } from 'fastify';
import type { Action, CreateCounterOrderRequest, CreateGuestRequest, GuestSettingsRequest } from '@bills/domain';
import { GUEST_REQUEST_KINDS, OPTION_CHOICES_MAX, OPTION_GROUPS_MAX, ORDER_MAX_LINES } from '@bills/domain';
import { GuestService } from '../../guest.ts';
import type { Hub } from '../../hub.ts';
import { assertCan, emptyBody, guard, runCommand } from '../command.ts';
import { createSchema as counterOrderSchema } from './counter.ts';

const id = { type: 'string', minLength: 1, maxLength: 100 } as const;

const guestRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: [...GUEST_REQUEST_KINDS] },
    minutes: { type: 'integer', minimum: 1, maximum: 720 },
    items: {
      type: 'array',
      maxItems: ORDER_MAX_LINES,
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
    guestName: { type: 'string', maxLength: 200 },
    note: { type: 'string', maxLength: 1000 },
    clientKey: { type: 'string', maxLength: 64 },
  },
} as const;

/**
 * «Страница гостя по QR» (guest.ts). `/api/guest/:token…` is public (http/auth.ts): the token
 * of the sticker is the only key, so a guest reads their own table and creates requests,
 * rate-limited per phone and per token. Staff list, accept and reject requests; the manager
 * (`tables.edit`) prints the QR codes, rotates them and switches the page on or off.
 */
export function registerGuestRoutes(app: FastifyInstance, hub: Hub): GuestService {
  const guest = new GuestService(hub);

  // ── Public: the guest page ────────────────────────────────────────────────
  app.get<{ Params: { token: string }; Querystring: { mine?: string } }>(
    '/api/guest/:token',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { mine: { type: 'string', maxLength: 400 } } },
      },
    },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      const mine = (req.query.mine ?? '').split(',').filter(Boolean);
      return guest.page(req.params.token, mine);
    },
  );

  app.post<{ Params: { token: string }; Body: CreateGuestRequest }>(
    '/api/guest/:token/requests',
    { schema: { body: guestRequestSchema } },
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return reply.status(201).send(guest.createRequest(req.params.token, req.ip || 'local', req.body));
    },
  );

  // ── Staff ─────────────────────────────────────────────────────────────────
  app.get('/api/guest-requests', { preHandler: guard('hall.view') }, async () => guest.list());

  /** A bar request makes an order (`order.create`), an order ahead is the counter's (`counter.take`). */
  const actionFor = (requestId: string): Action => {
    const kind = guest.kindOf(requestId);
    return kind === 'BAR' ? 'order.create' : kind === 'PREORDER' ? 'counter.take' : 'hall.view';
  };

  app.post<{ Params: { requestId: string } }>(
    '/api/guest-requests/:requestId/accept',
    { schema: { body: emptyBody } },
    async (req, reply) => {
      assertCan(req, 'hall.view');
      const action = actionFor(req.params.requestId);
      return runCommand(req, reply, hub, (actor) => ({ status: 200, body: guest.accept(req.params.requestId, actor) }), action);
    },
  );

  app.post<{ Params: { requestId: string }; Body: { reason?: string } }>(
    '/api/guest-requests/:requestId/reject',
    {
      schema: { body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 300 } } } },
    },
    async (req, reply) => {
      assertCan(req, 'hall.view');
      const action = actionFor(req.params.requestId);
      return runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: guest.reject(req.params.requestId, req.body?.reason, actor) }),
        action,
      );
    },
  );

  // «Касса»: the order ahead, loaded into the order panel, taken with its payment like POST /api/counter/orders.
  app.post<{ Params: { requestId: string }; Body: CreateCounterOrderRequest }>(
    '/api/guest-requests/:requestId/counter-order',
    { schema: { body: counterOrderSchema } },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 201, body: guest.counterOrder(req.params.requestId, req.body, actor) }),
        'counter.take',
      ),
  );

  // ── Manager: QR codes ─────────────────────────────────────────────────────
  app.get('/api/guest-links', { preHandler: guard('tables.edit') }, async () => guest.links());

  app.post<{ Body: GuestSettingsRequest }>(
    '/api/guest-links/settings',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' } } },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 200, body: guest.setEnabled(req.body.enabled, actor) }), 'tables.edit'),
  );

  app.post<{ Params: { linkId: string } }>(
    '/api/guest-links/:linkId/rotate',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 200, body: guest.rotate(req.params.linkId, actor) }), 'tables.edit'),
  );

  return guest;
}
