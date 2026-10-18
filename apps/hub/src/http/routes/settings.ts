import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.ts';

/** Routes for club, tables, tariffs: see api.ts (ClubAdminView, UpdateClubRequest, CreateTableRequest, …). */
export function registerSettingsRoutes(app: FastifyInstance, hub: Hub): void {
  void app;
  void hub;
}
