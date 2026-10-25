import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Action, CheckLoyaltyRequest, LoyaltyAdjustRequest, LoyaltySettings } from '@bills/domain';
import { LOYALTY_PROGRAMS } from '@bills/domain';
import type { Hub } from '../../hub.ts';
import { HubError } from '../../errors.ts';
import { LoyaltyService } from '../../loyalty.ts';
import { assertCan, emptyBody, guard, runCommand } from '../command.ts';

/** `loyalty` of a counter order and the body of POST /api/checks/:id/loyalty. */
export const loyaltyApplySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['phone'],
  properties: {
    phone: { type: 'string', minLength: 1, maxLength: 40 },
    name: { type: 'string', maxLength: 200 },
    redeem: { type: 'integer', minimum: 0, maximum: 1_000_000_000_00 },
    free: { type: 'boolean' },
    expectDiscount: { type: 'integer', minimum: 0, maximum: 1_000_000_000_00 },
  },
} as const;

const settingsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    program: { type: 'string', enum: [...LOYALTY_PROGRAMS] },
    cashbackPercent: { type: 'integer', minimum: 1, maximum: 50 },
    stampsEvery: { type: 'integer', minimum: 2, maximum: 20 },
    stampCategoryIds: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 100 } },
    maxRedeemPercent: { type: 'integer', minimum: 0, maximum: 100 },
    expiryDays: { type: 'integer', minimum: 0, maximum: 3650 },
  },
} as const;

const adjustSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    bonus: { type: 'integer', minimum: -1_000_000_000_00, maximum: 1_000_000_000_00 },
    stamps: { type: 'integer', minimum: -1000, maximum: 1000 },
    name: { type: ['string', 'null'], maxLength: 200 },
    reason: { type: 'string', maxLength: 500 },
  },
} as const;

/** The counter (counter.take) and the cash desk (payment.take) both look guests up and apply rewards. */
const TILL: readonly Action[] = ['counter.take', 'payment.take'];

function assertAny(req: FastifyRequest, actions: readonly Action[]) {
  let last: unknown;
  for (const a of actions) {
    try {
      return assertCan(req, a);
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof HubError ? last : new HubError(403, 'FORBIDDEN', 'Недостаточно прав для этого действия');
}

/**
 * «Лояльность без приложения» (packages/domain loyalty.ts, apps/hub/src/loyalty.ts).
 *  - till (counter.take or payment.take): look a number up, attach a guest and a reward to a check;
 *  - manager (club.edit): program settings, «Гости» with full numbers, manual adjustments.
 * Everything runs on the HUB: no cloud, no SMS.
 */
export function registerLoyaltyRoutes(app: FastifyInstance, hub: Hub): void {
  const loyalty = new LoyaltyService({ db: hub.db, clock: hub.clock, events: hub.events });

  app.get('/api/loyalty/settings', { preHandler: guard('hall.view') }, async () => loyalty.settings());

  app.post<{ Body: Partial<LoyaltySettings> }>('/api/loyalty/settings', { schema: { body: settingsSchema } }, async (req, reply) =>
    runCommand(req, reply, hub, (actor) => ({ status: 200, body: loyalty.saveSettings({ patch: req.body, actor }) }), 'club.edit'),
  );

  app.get<{ Querystring: { phone?: string } }>('/api/loyalty/lookup', async (req) => {
    assertAny(req, TILL);
    return loyalty.lookup(req.query.phone ?? '');
  });

  app.get<{ Params: { checkId: string } }>('/api/checks/:checkId/loyalty', async (req) => {
    assertAny(req, TILL);
    return loyalty.check(req.params.checkId);
  });

  app.post<{ Params: { checkId: string }; Body: CheckLoyaltyRequest }>(
    '/api/checks/:checkId/loyalty',
    { schema: { body: { ...loyaltyApplySchema, required: [] } } },
    async (req, reply) => {
      assertAny(req, TILL);
      return runCommand(req, reply, hub, (actor) => ({ status: 200, body: loyalty.apply({ ...req.body, checkId: req.params.checkId, actor }) }));
    },
  );

  app.post<{ Params: { checkId: string } }>('/api/checks/:checkId/loyalty/remove', { schema: { body: emptyBody } }, async (req, reply) => {
    assertAny(req, TILL);
    return runCommand(req, reply, hub, (actor) => ({ status: 200, body: loyalty.detach({ checkId: req.params.checkId, actor }) }));
  });

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/loyalty/guests', { preHandler: guard('club.edit') }, async (req) =>
    loyalty.guests(req.query.q, req.query.limit ? Number(req.query.limit) || 100 : 100),
  );

  app.get<{ Params: { guestId: string } }>('/api/loyalty/guests/:guestId', { preHandler: guard('club.edit') }, async (req) =>
    loyalty.guest(req.params.guestId),
  );

  app.post<{ Params: { guestId: string }; Body: LoyaltyAdjustRequest }>(
    '/api/loyalty/guests/:guestId/adjust',
    { schema: { body: adjustSchema } },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 200, body: loyalty.adjust({ ...req.body, guestId: req.params.guestId, actor }) }), 'club.edit'),
  );
}
