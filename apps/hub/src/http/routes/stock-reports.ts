import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.ts';
import { purchaseList, stockAlertsOf } from '../../stock-reports.ts';
import { previewSampleStock, seedSampleStock } from '../../stock-sample.ts';
import { guard, runCommand } from '../command.ts';

const id = { type: 'string', minLength: 1, maxLength: 100 } as const;

/** Reads and the sample on top of «Склад»: packages/domain stock-reports.ts and apps/hub stock-sample.ts. */
export function registerStockReportRoutes(app: FastifyInstance, hub: Hub): void {
  // «Докупить на неделю»: quantities and the approximate cost — senior staff, like the levels and their value.
  app.get('/api/stock/purchase', { preHandler: guard('stock.view') }, async () => purchaseList(hub));

  // What runs out, for the POS tile hints and the barista's strip: names and levels, no prices.
  app.get('/api/stock/alerts', { preHandler: guard('catalog.view') }, async () => stockAlertsOf(hub.db));

  // «Заполнить примером»: what it would add, and adding it (marked as the example; «Убрать пример» takes it away).
  app.get('/api/stock/sample/fill', { preHandler: guard('stock.edit') }, async () => previewSampleStock(hub));

  app.post<{ Body: { productIds?: string[] } }>(
    '/api/stock/sample/fill',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { productIds: { type: 'array', maxItems: 500, items: id } },
        },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({
          status: 200,
          body: seedSampleStock(hub, actor, req.body?.productIds ? { productIds: req.body.productIds } : {}),
        }),
        'stock.edit',
      ),
  );
}
