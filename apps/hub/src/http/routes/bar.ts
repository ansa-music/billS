import type { FastifyInstance } from 'fastify';
import type {
  CancelOrderRequest,
  CreateCategoryRequest,
  CreateOrderRequest,
  CreateProductRequest,
  UpdateCategoryRequest,
  UpdateProductRequest,
} from '@bills/domain';
import { OPTION_CHOICES_MAX, OPTION_GROUPS_MAX, ORDER_MAX_LINES, ORDER_NOTE_MAX } from '@bills/domain';
import type { Hub } from '../../hub.ts';
import { guard, runCommand } from '../command.ts';

const name = { type: 'string', maxLength: 200 } as const;
const id = { type: 'string', minLength: 1, maxLength: 100 } as const;
// Ranges are checked by the service so the message is a readable 422, not a schema 400.
const stock = { type: ['number', 'null'] } as const;
// Option groups are checked by validateOptionGroups (422 OPTIONS_INVALID with every problem named).
const options = { type: 'array', maxItems: OPTION_GROUPS_MAX * 2, items: { type: 'object' } } as const;

/** Routes for catalog and orders: see api.ts (CatalogView, CreateOrderRequest, …). */
export function registerBarRoutes(app: FastifyInstance, hub: Hub): void {
  app.get('/api/bar/catalog', { preHandler: guard('catalog.view') }, async () => hub.bar.catalog());

  app.post<{ Body: CreateCategoryRequest }>(
    '/api/bar/categories',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name } },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 201, body: hub.bar.createCategory({ ...req.body, actor }) }), 'catalog.edit'),
  );

  app.post<{ Params: { id: string }; Body: UpdateCategoryRequest }>(
    '/api/bar/categories/:id/update',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { name, sortOrder: { type: 'integer' }, isActive: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.bar.updateCategory({ ...req.body, id: req.params.id, actor }),
      }), 'catalog.edit'),
  );

  app.post<{ Body: CreateProductRequest }>(
    '/api/bar/products',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['categoryId', 'name', 'price'],
          properties: { categoryId: id, name, price: { type: 'number' }, stock, options },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 201, body: hub.bar.createProduct({ ...req.body, actor }) }), 'catalog.edit'),
  );

  app.post<{ Params: { id: string }; Body: UpdateProductRequest }>(
    '/api/bar/products/:id/update',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            categoryId: id,
            name,
            price: { type: 'number' },
            stock,
            sortOrder: { type: 'integer' },
            isActive: { type: 'boolean' },
            options,
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.bar.updateProduct({ ...req.body, id: req.params.id, actor }),
      }), 'catalog.edit'),
  );

  app.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/orders',
    { preHandler: guard('catalog.view') },
    async (req) => ({ orders: hub.bar.ordersOfSession(req.params.sessionId) }),
  );

  app.post<{ Params: { sessionId: string }; Body: CreateOrderRequest }>(
    '/api/sessions/:sessionId/orders',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['items'],
          properties: {
            // Quantities are checked by the domain (validateOrderItems) so the
            // waiter gets a readable message per line, not a schema error.
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
            note: { type: 'string', maxLength: ORDER_NOTE_MAX },
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 201,
        body: hub.bar.createOrder({ ...req.body, sessionId: req.params.sessionId, actor }),
      }), 'order.create'),
  );

  app.post<{ Params: { orderId: string }; Body: CancelOrderRequest }>(
    '/api/orders/:orderId/cancel',
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
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.bar.cancelOrder({ orderId: req.params.orderId, reason: req.body.reason, actor }),
      }), 'order.cancel'),
  );
}
