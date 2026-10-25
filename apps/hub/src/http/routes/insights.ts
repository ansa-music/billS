import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { InsightsView } from '@bills/domain';
import type { Hub } from '../../hub.ts';
import { InsightsService } from '../../insights.ts';
import { assertCan } from '../command.ts';

/**
 * GET /api/insights — «Умные подсказки» and the stock forecast (apps/hub/src/insights.ts).
 * Read-only, cached for a minute. Senior shift and up (manager, admin, senior; the
 * platform): the cards speak about cash shortages and cancellations, which are not for
 * every cashier. Checked as the report page's `stats.view` plus `audit.view`.
 */
export function registerInsightsRoutes(app: FastifyInstance, hub: Hub): void {
  const insights = new InsightsService({ db: hub.db, clock: hub.clock });
  const allowed = async (req: FastifyRequest) => {
    assertCan(req, 'stats.view');
    assertCan(req, 'audit.view');
  };
  app.get('/api/insights', { preHandler: allowed }, async (): Promise<InsightsView> => insights.view());
}
