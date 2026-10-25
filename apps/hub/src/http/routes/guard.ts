import type { FastifyInstance } from 'fastify';
import type { GuardSettingsPatch } from '@bills/domain';
import { GUARD_LIMITS } from '@bills/domain';
import type { Hub } from '../../hub.ts';
import { guard, runCommand } from '../command.ts';

const int = ([minimum, maximum]: readonly [number, number]) => ({ type: 'integer', minimum, maximum }) as const;
const part = (properties: Record<string, object>) => ({ type: 'object', additionalProperties: false, properties }) as const;
const enabled = { type: 'boolean' } as const;

const L = GUARD_LIMITS;
const settingsSchema = part({
  refund: part({ enabled, minAmount: int(L.minAmount), minPercent: int(L.percent), lateMinutes: int(L.lateMinutes) }),
  cancels: part({ enabled, minCount: int(L.minCount), minPercent: int(L.percent) }),
  cash: part({ enabled, minDifference: int(L.minDifference) }),
  manualMode: part({ enabled, minutes: int(L.manualMinutes) }),
  discounts: part({ enabled, maxPercent: int(L.percent), perShift: int(L.perShift) }),
  reopen: part({ enabled, minutes: int(L.reopenMinutes) }),
});

/** «Сторож»: thresholds of the suspicious-operation alerts. Manager only (club.edit). */
export function registerGuardRoutes(app: FastifyInstance, hub: Hub): void {
  app.get('/api/guard/settings', { preHandler: guard('club.edit') }, async () => hub.guardSettings());

  app.post<{ Body: GuardSettingsPatch }>('/api/guard/settings', { schema: { body: settingsSchema } }, async (req, reply) =>
    runCommand(req, reply, hub, (actor) => ({ status: 200, body: hub.setGuardSettings(actor, req.body) }), 'club.edit'),
  );
}
