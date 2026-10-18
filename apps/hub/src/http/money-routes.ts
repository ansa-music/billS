import type { FastifyInstance } from 'fastify';
import type {
  AddCheckItemRequest,
  CancelSessionRequest,
  CashMovementRequest,
  CloseShiftRequest,
  CreateCheckRequest,
  OpenPrepaidRequest,
  OpenShiftRequest,
  PayRequest,
  RefundRequest,
  SetDiscountRequest,
} from '@bills/domain';
import { CASH_MOVEMENT_KINDS, DISCOUNT_KINDS, PAYMENT_METHODS } from '@bills/domain';
import type { Hub } from '../hub.ts';
import { runCommand } from './app.ts';

/** Stage 2: guest checks, payments, refunds, voiding games, cash shifts. */

const emptyBody = { type: 'object', additionalProperties: false, properties: {} } as const;

// Money is integer minor units. Reasons and approvers are checked by the domain rules
// so a blank one gets a clear message instead of a schema error.
const moneySchema = { type: 'integer', minimum: 0, maximum: 1_000_000_000_00 } as const;
const methodSchema = { type: 'string', enum: [...PAYMENT_METHODS] } as const;
const reasonSchema = { type: 'string', maxLength: 500 } as const;
const paymentPartsSchema = {
  type: 'array',
  maxItems: PAYMENT_METHODS.length,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'amount'],
    properties: { method: methodSchema, amount: moneySchema },
  },
} as const;
const approvalBody = {
  type: 'object',
  additionalProperties: false,
  properties: { reason: reasonSchema, approvedBy: { type: 'string', maxLength: 100 } },
} as const;

export function registerMoneyRoutes(app: FastifyInstance, hub: Hub): void {
  app.post<{ Params: { sessionId: string }; Body: CancelSessionRequest }>(
    '/api/sessions/:sessionId/cancel',
    { schema: { body: approvalBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.checks.cancelGame({ sessionId: req.params.sessionId, ...req.body, actor }),
      })),
  );

  // ── Checks and payments ──────────────────────────────────────────────────

  app.post<{ Body: CreateCheckRequest }>(
    '/api/checks',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionIds'],
          properties: {
            sessionIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string' } },
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 201,
        body: hub.checks.create({ sessionIds: req.body.sessionIds, actor }),
      })),
  );

  app.get<{ Params: { checkId: string } }>('/api/checks/:checkId', async (req) => hub.checks.get(req.params.checkId));

  app.post<{ Params: { checkId: string }; Body: AddCheckItemRequest }>(
    '/api/checks/:checkId/items',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sessionId'],
          properties: { sessionId: { type: 'string' } },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.checks.addGame({ checkId: req.params.checkId, sessionId: req.body.sessionId, actor }),
      })),
  );

  app.post<{ Params: { checkId: string; itemId: string } }>(
    '/api/checks/:checkId/items/:itemId/remove',
    { schema: { body: emptyBody } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.checks.removeItem({ checkId: req.params.checkId, itemId: req.params.itemId, actor }),
      })),
  );

  app.post<{ Params: { checkId: string }; Body: SetDiscountRequest }>(
    '/api/checks/:checkId/discount',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['discount'],
          properties: {
            discount: {
              type: ['object', 'null'],
              additionalProperties: false,
              required: ['kind', 'value'],
              properties: {
                kind: { type: 'string', enum: [...DISCOUNT_KINDS] },
                value: { type: 'integer', minimum: 0 },
                reason: reasonSchema,
              },
            },
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.checks.setDiscount({ checkId: req.params.checkId, discount: req.body.discount, actor }),
      })),
  );

  app.post<{ Params: { checkId: string }; Body: PayRequest }>(
    '/api/checks/:checkId/pay',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['parts'],
          properties: { parts: paymentPartsSchema },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.checks.pay({ checkId: req.params.checkId, parts: req.body.parts, actor }),
      })),
  );

  app.post<{ Params: { checkId: string }; Body: RefundRequest }>(
    '/api/checks/:checkId/refund',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['method', 'amount'],
          properties: { method: methodSchema, amount: moneySchema, ...approvalBody.properties },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.checks.refund({ checkId: req.params.checkId, ...req.body, actor }),
      })),
  );

  // ── Prepaid time: open for N minutes and take the whole payment at once ──

  app.post<{ Params: { tableId: string }; Body: OpenPrepaidRequest }>(
    '/api/tables/:tableId/open-prepaid',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['minutes', 'amount', 'parts'],
          properties: {
            tariffId: { type: 'string' },
            minutes: { type: 'integer' },
            amount: moneySchema,
            quotedAt: { type: 'integer' },
            parts: paymentPartsSchema,
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 201,
        body: hub.prepaid.openPaid({ tableId: req.params.tableId, ...req.body, actor }),
      })),
  );

  // ── Cash shift ───────────────────────────────────────────────────────────

  app.post<{ Body: OpenShiftRequest }>(
    '/api/shifts/open',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['openingFloat'],
          properties: { openingFloat: moneySchema },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 201,
        body: hub.shifts.open({ openingFloat: req.body.openingFloat, actor }),
      })),
  );

  app.post<{ Params: { shiftId: string }; Body: CashMovementRequest }>(
    '/api/shifts/:shiftId/cash',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'amount'],
          properties: {
            kind: { type: 'string', enum: [...CASH_MOVEMENT_KINDS] },
            amount: moneySchema,
            reason: reasonSchema,
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.shifts.moveCash({ shiftId: req.params.shiftId, ...req.body, actor }),
      })),
  );

  app.get<{ Params: { shiftId: string } }>('/api/shifts/:shiftId/report', async (req) =>
    hub.shifts.report(req.params.shiftId),
  );

  app.get<{ Params: { shiftId: string } }>('/api/shifts/:shiftId/checks', async (req) =>
    hub.shifts.checks(req.params.shiftId),
  );

  app.post<{ Params: { shiftId: string }; Body: CloseShiftRequest }>(
    '/api/shifts/:shiftId/close',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['countedCash'],
          properties: { countedCash: moneySchema, note: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.shifts.close({ shiftId: req.params.shiftId, ...req.body, actor }),
      })),
  );
}
