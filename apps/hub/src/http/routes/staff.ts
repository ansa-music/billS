import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.ts';

/** Routes for staff, PIN, audit log: see api.ts (StaffView, AuditListResponse, …). */
export function registerStaffRoutes(app: FastifyInstance, hub: Hub): void {
  void app;
  void hub;
}
