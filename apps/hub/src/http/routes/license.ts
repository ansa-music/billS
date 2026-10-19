import type { FastifyInstance } from 'fastify';
import type { InstallLicenseRequest, LicenseResponse } from '@bills/domain';
import type { Hub } from '../../hub.ts';
import { actorOf, assertCan, runCommand } from '../command.ts';

/**
 * The branch's license (api.ts LicenseResponse / InstallLicenseRequest).
 * GET for anyone signed in (the banner); POST pastes a signed `TS1.…` text —
 * useful for a HUB without a cloud connection. 422 LICENSE_INVALID when the
 * signature, the HUB or the age does not fit.
 */
export function registerLicenseRoutes(app: FastifyInstance, hub: Hub): void {
  app.get('/api/license', async (req): Promise<LicenseResponse> => {
    actorOf(req);
    return hub.license.response();
  });

  app.post<{ Body: InstallLicenseRequest }>(
    '/api/license',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['license'],
          properties: { license: { type: 'string', minLength: 1, maxLength: 20_000 } },
        },
      },
    },
    async (req, reply) => {
      assertCan(req, 'license.install');
      // The signature check is asynchronous (WebCrypto); storing it is an ordinary command.
      const text = req.body.license.trim();
      const payload = await hub.license.verify(text);
      return runCommand(
        req,
        reply,
        hub,
        (actor) => ({ status: 200, body: hub.license.installVerified(text, payload, 'manual', actor) }),
        'license.install',
      );
    },
  );
}
