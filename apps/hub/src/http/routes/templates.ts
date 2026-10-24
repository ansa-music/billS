import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.ts';
import type { TemplateKind } from '../../templates.ts';
import { applyTemplate, TEMPLATE_ACTION, TEMPLATE_KINDS } from '../../templates.ts';
import { runCommand } from '../command.ts';

/**
 * POST /api/templates/apply { kind } — «Заполнить примером» on the empty
 * tariffs and menu screens. Answers { kind, tariffs, categories, products }:
 * how many rows were added (0 when everything was already there).
 */
export function registerTemplateRoutes(app: FastifyInstance, hub: Hub): void {
  app.post<{ Body: { kind: TemplateKind } }>(
    '/api/templates/apply',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: { kind: { type: 'string', enum: [...TEMPLATE_KINDS] } },
        },
      },
    },
    async (req, reply) =>
      runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: applyTemplate(hub, req.body.kind, actor) }),
        TEMPLATE_ACTION[req.body.kind],
      ),
  );
}
