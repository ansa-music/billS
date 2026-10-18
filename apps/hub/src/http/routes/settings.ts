import type { FastifyInstance } from 'fastify';
import type {
  CreateTableRequest,
  CreateTariffRequest,
  ReorderTablesRequest,
  UpdateClubRequest,
  UpdateTableRequest,
  UpdateTariffRequest,
} from '@bills/domain';
import { CARD_SIZES, FREE_TABLE_RULES, THEMES, WAITER_VIEWS } from '@bills/domain';
import type { Hub } from '../../hub.ts';
import { guard, runCommand } from '../command.ts';

const TABLE_KINDS = ['pool', 'russian', 'snooker'] as const;

const nullableText = (maxLength: number) => ({ type: ['string', 'null'], maxLength }) as const;
const int = (minimum: number, maximum?: number) =>
  ({ type: 'integer', minimum, ...(maximum !== undefined ? { maximum } : {}) }) as const;

const settingsPatchSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    display: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: nullableText(60),
        // Data URLs of a small logo are allowed (≤ 200 KB, see domain settings).
        logoUrl: nullableText(200_000),
        theme: { type: 'string', enum: [...THEMES] },
        cardSize: { type: 'string', enum: [...CARD_SIZES] },
        waiterSees: { type: 'string', enum: [...WAITER_VIEWS] },
      },
    },
    rules: {
      type: 'object',
      additionalProperties: false,
      properties: {
        freeTableAfterStop: { type: 'string', enum: [...FREE_TABLE_RULES] },
        defaultFreeMinutes: int(0, 60),
        defaultMinimumMinutes: int(0, 24 * 60),
        defaultStepMinutes: int(1, 60),
        defaultRoundingMinor: int(1, 1_000_000),
      },
    },
  },
} as const;

const updateClubSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    timezone: { type: 'string', minLength: 1, maxLength: 64 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    settings: settingsPatchSchema,
  },
} as const;

const tariffConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['currency', 'basePricePerHour', 'windows', 'stepMinutes', 'minimumMinutes', 'freeMinutes', 'roundingMinor'],
  properties: {
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    basePricePerHour: int(0),
    windows: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'days', 'from', 'to', 'pricePerHour'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 40 },
          days: { type: 'array', maxItems: 7, items: int(1, 7) },
          from: { type: 'string', maxLength: 5 },
          to: { type: 'string', maxLength: 5 },
          pricePerHour: int(0),
        },
      },
    },
    stepMinutes: int(1),
    minimumMinutes: int(0),
    freeMinutes: int(0),
    roundingMinor: int(1),
  },
} as const;

const tableFields = {
  name: { type: 'string', minLength: 1, maxLength: 40 },
  kind: { type: 'string', enum: [...TABLE_KINDS] },
  lampChannel: { type: 'string', minLength: 1, maxLength: 40 },
  defaultTariffId: { type: 'string', minLength: 1, maxLength: 64 },
} as const;

/** Routes for club, tables, tariffs: see api.ts (ClubAdminView, UpdateClubRequest, CreateTableRequest, …). */
export function registerSettingsRoutes(app: FastifyInstance, hub: Hub): void {
  app.get('/api/club', { preHandler: guard('settings.view') }, async () => hub.settings.club());

  app.post<{ Body: UpdateClubRequest }>('/api/club', { schema: { body: updateClubSchema } }, async (req, reply) => {
    // Name, time zone and currency belong to the owner; the hall look and
    // game rules (`settings`) may be changed by a manager too.
    const b = req.body ?? {};
    const hasClubFields = b.name !== undefined || b.timezone !== undefined || b.currency !== undefined;
    const action = hasClubFields ? 'club.edit' : 'display.edit';
    return runCommand(req, reply, hub, (actor) => ({ status: 200, body: hub.settings.updateClub({ ...req.body, actor }) }), action);
  });

  app.post<{ Body: CreateTableRequest }>(
    '/api/tables',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'kind', 'lampChannel', 'defaultTariffId'],
          properties: tableFields,
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 201, body: hub.settings.createTable({ ...req.body, actor }) }), 'tables.edit'),
  );

  app.post<{ Body: ReorderTablesRequest }>(
    '/api/tables/reorder',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['tableIds'],
          properties: { tableIds: { type: 'array', maxItems: 500, items: { type: 'string', minLength: 1 } } },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.settings.reorderTables({ tableIds: req.body.tableIds, actor }),
      }), 'tables.edit'),
  );

  app.post<{ Params: { tableId: string }; Body: UpdateTableRequest }>(
    '/api/tables/:tableId/update',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { ...tableFields, isActive: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.settings.updateTable({ ...req.body, tableId: req.params.tableId, actor }),
      }), 'tables.edit'),
  );

  app.post<{ Body: CreateTariffRequest }>(
    '/api/tariffs',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'config'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, config: tariffConfigSchema },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({ status: 201, body: hub.settings.createTariff({ ...req.body, actor }) }), 'tariffs.edit'),
  );

  app.post<{ Params: { tariffId: string }; Body: UpdateTariffRequest }>(
    '/api/tariffs/:tariffId/update',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            config: tariffConfigSchema,
            isActive: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) =>
      runCommand(req, reply, hub, (actor) => ({
        status: 200,
        body: hub.settings.updateTariff({ ...req.body, tariffId: req.params.tariffId, actor }),
      }), 'tariffs.edit'),
  );
}
