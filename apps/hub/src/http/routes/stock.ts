import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AdjustStockRequest,
  CreateIngredientRequest,
  CreateStockCountRequest,
  CreateSupplyRequest,
  DeleteSupplyRequest,
  RemoveIngredientRequest,
  SetRecipeRequest,
  UpdateIngredientRequest,
  WriteOffRequest,
} from '@bills/domain';
import { decide, RECIPE_MAX_LINES, RECIPE_MAX_OPTION_LINES, SUPPLY_MAX_LINES } from '@bills/domain';
import type { Hub } from '../../hub.ts';
import type { StockViewer } from '../../stock.ts';
import { actorOf, businessOf, guard, runCommand } from '../command.ts';

const id = { type: 'string', minLength: 1, maxLength: 100 } as const;
const text = { type: 'string', maxLength: 400 } as const;
// Ranges and units are checked by the service so the message is a readable 422, not a schema 400.
const num = { type: 'number' } as const;
const numOrNull = { type: ['number', 'null'] } as const;
const unit = { type: 'string', maxLength: 10 } as const;

const recipeBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      maxItems: RECIPE_MAX_LINES * 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ingredientId', 'quantity'],
        properties: { ingredientId: id, quantity: num },
      },
    },
    options: {
      type: 'array',
      maxItems: RECIPE_MAX_OPTION_LINES * 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['choiceId', 'mode', 'ingredientId', 'quantity'],
        properties: { choiceId: id, mode: { type: 'string', maxLength: 10 }, ingredientId: id, quantity: num, replacesId: { type: ['string', 'null'], maxLength: 100 } },
      },
    },
  },
} as const;

const supplyBody = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier', 'lines'],
  properties: {
    supplier: text,
    note: text,
    lines: {
      type: 'array',
      maxItems: SUPPLY_MAX_LINES * 2,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quantity', 'amount'],
        properties: {
          ingredientId: id,
          // Something not on the stock yet, created with the delivery.
          newIngredient: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'unit'],
            properties: { name: text, unit },
          },
          quantity: num,
          amount: num,
        },
      },
    },
  },
} as const;

type Range = { from?: string; to?: string; ingredientId?: string };

/**
 * Who asks, for the deliveries: may they change any (`stock.edit` — the director, the administrator)
 * or only their own, for a while (canChangeSupply).
 */
function viewerOf(req: FastifyRequest): StockViewer {
  const actor = actorOf(req);
  return { id: actor.id, mayEditStock: decide(actor.roles, 'stock.edit', req.license?.gate() ?? null, businessOf(req)) === 'ok' };
}

function rangeOf(q: Range): { from?: number; to?: number } {
  const out: { from?: number; to?: number } = {};
  const from = Number(q.from);
  const to = Number(q.to);
  if (q.from !== undefined && Number.isFinite(from)) out.from = from;
  if (q.to !== undefined && Number.isFinite(to)) out.to = to;
  return out;
}

/** «Склад» of a coffee shop: see packages/domain stock.ts for the shapes. */
export function registerStockRoutes(app: FastifyInstance, hub: Hub): void {
  // The delivery form needs the list too, so whoever receives deliveries (a barista) reads it.
  app.get('/api/stock/ingredients', { preHandler: guard('stock.supply') }, async () => hub.stock.ingredients());

  app.post<{ Body: CreateIngredientRequest }>(
    '/api/stock/ingredients',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'unit'],
          properties: { name: text, unit, quantity: num, costPerUnit: numOrNull, minLevel: numOrNull },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 201, body: hub.stock.createIngredient({ ...req.body, actor }) }), 'stock.edit'),
  );

  app.post<{ Params: { id: string }; Body: UpdateIngredientRequest }>(
    '/api/stock/ingredients/:id/update',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { name: text, unit, costPerUnit: numOrNull, minLevel: numOrNull, isArchived: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: hub.stock.updateIngredient({ ...req.body, id: req.params.id, actor }) }),
        'stock.edit',
      ),
  );

  app.get<{ Params: { id: string } }>('/api/stock/ingredients/:id/removal', { preHandler: guard('stock.edit') }, async (req) =>
    hub.stock.removal(req.params.id),
  );

  app.post<{ Params: { id: string }; Body: RemoveIngredientRequest }>(
    '/api/stock/ingredients/:id/remove',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { fromRecipes: { type: 'boolean' } } } } },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: hub.stock.removeIngredient({ id: req.params.id, fromRecipes: req.body?.fromRecipes === true, actor }) }),
        'stock.edit',
      ),
  );

  app.post<{ Params: { id: string }; Body: AdjustStockRequest }>(
    '/api/stock/ingredients/:id/adjust',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, required: ['quantity', 'reason'], properties: { quantity: num, reason: text } },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 200, body: hub.stock.adjust({ ...req.body, id: req.params.id, actor }) }), 'stock.edit'),
  );

  // The example TS put in (the trial's sample stock) and «Убрать пример со склада».
  app.get('/api/stock/sample', { preHandler: guard('stock.view') }, async () => hub.stock.sample());

  app.post('/api/stock/sample/remove', async (req, reply) =>
    runCommand(req, reply, hub, (actor) => ({ status: 200, body: hub.stock.removeSample({ actor }) }), 'stock.edit'),
  );

  // The first-run checklist: raw materials → recipes → deliveries → sales.
  app.get('/api/stock/setup', { preHandler: guard('stock.view') }, async () => hub.stock.setup());

  app.get('/api/stock/recipes', { preHandler: guard('stock.view') }, async () => hub.stock.recipes());

  app.get<{ Params: { productId: string } }>(
    '/api/stock/recipes/:productId',
    { preHandler: guard('stock.view') },
    async (req) => hub.stock.recipe(req.params.productId),
  );

  app.post<{ Params: { productId: string }; Body: SetRecipeRequest }>(
    '/api/stock/recipes/:productId',
    { schema: { body: recipeBody } },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({
          status: 200,
          body: hub.stock.setRecipe({
            items: req.body.items ?? [],
            options: req.body.options ?? [],
            productId: req.params.productId,
            actor,
          }),
        }),
        'stock.edit',
      ),
  );

  app.get<{ Querystring: Range }>('/api/stock/supplies', { preHandler: guard('stock.supply') }, async (req) =>
    hub.stock.supplies(rangeOf(req.query), viewerOf(req)),
  );

  app.post<{ Body: CreateSupplyRequest }>('/api/stock/supplies', { schema: { body: supplyBody } }, async (req, reply) =>
    runCommand(
      req,
      reply,
      hub,
      (actor, who) => ({ status: 201, body: hub.stock.createSupply({ ...req.body, actor, actorId: who.id, viewer: viewerOf(req) }) }),
      'stock.supply',
    ),
  );

  // Delete or correct a delivery: the director and the administrator always, whoever entered it for 30 minutes.
  app.post<{ Params: { id: string }; Body: DeleteSupplyRequest }>(
    '/api/stock/supplies/:id/delete',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { reason: text } } } },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: hub.stock.deleteSupply({ id: req.params.id, reason: req.body?.reason, actor, viewer: viewerOf(req) }) }),
        'stock.supply',
      ),
  );

  app.post<{ Params: { id: string }; Body: CreateSupplyRequest }>(
    '/api/stock/supplies/:id/update',
    { schema: { body: supplyBody } },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: hub.stock.updateSupply({ ...req.body, id: req.params.id, actor, viewer: viewerOf(req) }) }),
        'stock.supply',
      ),
  );

  app.get<{ Querystring: Range }>('/api/stock/counts', { preHandler: guard('stock.view') }, async (req) =>
    hub.stock.counts(rangeOf(req.query)),
  );

  app.post<{ Body: CreateStockCountRequest }>(
    '/api/stock/counts',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['lines'],
          properties: {
            note: text,
            lines: {
              type: 'array',
              maxItems: 1000,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['ingredientId', 'counted'],
                properties: { ingredientId: id, counted: num },
              },
            },
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 201, body: hub.stock.createCount({ ...req.body, actor }) }), 'stock.edit'),
  );

  app.post<{ Body: WriteOffRequest }>(
    '/api/stock/writeoffs',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ingredientId', 'quantity', 'reason'],
          properties: { ingredientId: id, quantity: num, reason: text },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 201, body: hub.stock.writeOff({ ...req.body, actor }) }), 'stock.writeoff'),
  );

  app.get<{ Querystring: Range }>('/api/stock/movements', { preHandler: guard('stock.view') }, async (req) =>
    hub.stock.movements({ ...rangeOf(req.query), ...(req.query.ingredientId ? { ingredientId: req.query.ingredientId } : {}) }),
  );
}
