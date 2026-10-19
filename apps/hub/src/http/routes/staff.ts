import type { FastifyInstance } from 'fastify';
import type { CreateStaffRequest, StaffListResponse, UpdateStaffRequest, VerifyPinRequest } from '@bills/domain';
import { ROLES } from '@bills/domain';
import type { Hub } from '../../hub.ts';
import { guard, runCommand } from '../command.ts';

const roleSchema = { type: 'string', enum: [...ROLES] } as const;
const rolesSchema = { type: 'array', minItems: 1, maxItems: ROLES.length, items: { type: 'string', maxLength: 20 } } as const;

/** `roles` (the set); `role` alone is still accepted from older screens. */
function rolesOfBody(body: { roles?: readonly unknown[]; role?: string }): readonly unknown[] | undefined {
  if (body.roles !== undefined) return body.roles;
  return body.role !== undefined ? [body.role] : undefined;
}
const tableIdsSchema = { type: 'array', maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 100 } } as const;

interface AuditQueryString {
  actor?: string;
  tableId?: string;
  action?: string;
  from?: number;
  to?: number;
  limit?: number;
  before?: number;
}

/**
 * Routes for staff, PIN, audit log: see api.ts (StaffView, AuditListResponse, …).
 * Who may hire whom (canAssignRoles) is checked in StaffService for the
 * signed-in person.
 */
export function registerStaffRoutes(app: FastifyInstance, hub: Hub): void {
  app.get('/api/staff', { preHandler: guard('staff.view') }, async (): Promise<StaffListResponse> => ({ staff: hub.staff.list() }));

  app.post<{ Body: CreateStaffRequest & { role?: string } }>(
    '/api/staff',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            roles: rolesSchema,
            role: roleSchema,
            pin: { type: 'string', maxLength: 20 },
            tableIds: tableIdsSchema,
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor, by) => ({
        status: 201,
        body: hub.staff.create({
          name: req.body.name,
          roles: rolesOfBody(req.body) ?? [],
          pin: req.body.pin,
          tableIds: req.body.tableIds,
          actor,
          by: by.id ? by : undefined,
        }),
      }), 'staff.edit'),
  );

  app.post<{ Params: { staffId: string }; Body: UpdateStaffRequest & { role?: string } }>(
    '/api/staff/:staffId/update',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            roles: rolesSchema,
            role: roleSchema,
            pin: { type: ['string', 'null'], maxLength: 20 },
            isActive: { type: 'boolean' },
            tableIds: tableIdsSchema,
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor, by) => ({
        status: 200,
        body: hub.staff.update({
          staffId: req.params.staffId,
          by: by.id ? by : undefined,
          name: req.body.name,
          roles: rolesOfBody(req.body),
          pin: req.body.pin,
          isActive: req.body.isActive,
          tableIds: req.body.tableIds,
          actor,
        }),
      }), 'staff.edit'),
  );

  app.post<{ Params: { staffId: string }; Body: VerifyPinRequest }>(
    '/api/staff/:staffId/verify-pin',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['pin'],
          properties: { pin: { type: 'string', maxLength: 20 } },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.staff.verifyPin(req.params.staffId, req.body.pin, actor),
      })),
  );

  app.get<{ Querystring: AuditQueryString }>(
    '/api/audit',
    {
      preHandler: guard('audit.view'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            actor: { type: 'string', maxLength: 200 },
            tableId: { type: 'string', maxLength: 100 },
            action: { type: 'string', maxLength: 100 },
            from: { type: 'integer', minimum: 0 },
            to: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            before: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (req) => {
      const q = req.query;
      return hub.staff.audit({
        actor: q.actor || undefined,
        tableId: q.tableId || undefined,
        action: q.action || undefined,
        from: q.from,
        to: q.to,
        limit: q.limit,
        before: q.before,
      });
    },
  );
}
