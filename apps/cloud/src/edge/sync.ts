import type { SyncEventsRequest, SyncSnapshotRequest } from '@bills/domain';
import { CloudError } from '../errors.ts';
import { hubBackOnline } from '../push.ts';
import type { HubRow } from '../sync.ts';
import { acceptEvents, acceptSnapshot, findHubByKey, loadClub, settingsSince } from '../sync.ts';
import type { EdgeContext } from './context.ts';
import { flushQuietly, reportPushConfigured } from './context.ts';
import type { EdgeRequest, Schema } from './http.ts';
import { bearerToken, errorResponse, json, notFound, readJson, routeOf, validate } from './http.ts';

/**
 * Edge Function `sync`: the HUB ↔ cloud protocol of apps/cloud/src/http/app.ts,
 * byte-compatible, so a HUB only needs CLOUD_URL=https://<ref>.supabase.co/functions/v1.
 * Serverless: the push queue is flushed before answering (no background work).
 */

const MAX_BATCH = 1000;

const syncEventsSchema: Schema = {
  type: 'object',
  required: ['hubId', 'settingsVersion', 'events'],
  additionalProperties: false,
  properties: {
    hubId: { type: 'string', minLength: 1 },
    settingsVersion: { type: 'integer', minimum: 0 },
    events: {
      type: 'array',
      maxItems: MAX_BATCH,
      items: {
        type: 'object',
        required: ['id', 'at', 'topic', 'payload'],
        properties: {
          id: { type: 'integer', minimum: 1 },
          at: { type: 'integer' },
          topic: { type: 'string', minLength: 1 },
          payload: {
            type: 'object',
            required: ['actor', 'action', 'entityType', 'entityId'],
            properties: {
              actor: { type: 'string' },
              action: { type: 'string' },
              entityType: { type: 'string' },
              entityId: { type: 'string' },
              data: { type: 'object' },
            },
          },
        },
      },
    },
  },
};

const clubSchema: Schema = {
  type: 'object',
  required: ['name', 'timezone', 'currency'],
  properties: { name: { type: 'string' }, timezone: { type: 'string' }, currency: { type: 'string' } },
};

const snapshotSchema: Schema = {
  type: 'object',
  required: ['hubId', 'settingsVersion', 'club', 'tariffs', 'tables'],
  properties: {
    hubId: { type: 'string', minLength: 1 },
    settingsVersion: { type: 'integer', minimum: 0 },
    club: clubSchema,
    tariffs: { type: 'array', items: { type: 'object' } },
    tables: { type: 'array', items: { type: 'object' } },
  },
};

async function hubByKey(ctx: EdgeContext, req: EdgeRequest): Promise<HubRow> {
  if (req.headers.get('authorization')?.startsWith('Bearer ') !== true) {
    throw new CloudError(401, 'UNAUTHORIZED', 'Нужен ключ HUB (Authorization: Bearer)');
  }
  const key = bearerToken(req);
  const hub = key ? await findHubByKey(ctx.db, key) : null;
  if (!hub) throw new CloudError(401, 'UNAUTHORIZED', 'Неизвестный ключ HUB');
  return hub;
}

async function requireHub(ctx: EdgeContext, req: EdgeRequest, hubId: string): Promise<HubRow> {
  const hub = await hubByKey(ctx, req);
  if (hub.id !== hubId) throw new CloudError(403, 'HUB_MISMATCH', 'Ключ выдан другому HUB');
  return hub;
}

export async function handleSync(req: EdgeRequest, ctx: EdgeContext): Promise<Response> {
  try {
    const { path, query } = routeOf(req.url);

    if (req.method === 'POST' && path === '/sync/events') {
      const body = validate<SyncEventsRequest>(await readJson(req), syncEventsSchema);
      const hub = await requireHub(ctx, req, body.hubId);
      const res = await acceptEvents(ctx.db, ctx.now(), hub, body);
      await flushQuietly(ctx);
      await reportPushConfigured(ctx);
      return json(200, res);
    }

    if (req.method === 'POST' && path === '/sync/snapshot') {
      const body = validate<SyncSnapshotRequest>(await readJson(req), snapshotSchema);
      const hub = await requireHub(ctx, req, body.hubId);
      const outcome = await acceptSnapshot(ctx.db, ctx.now(), hub, body);
      await flushQuietly(ctx);
      await reportPushConfigured(ctx);
      return json(outcome.status, outcome.body);
    }

    if (req.method === 'GET' && path === '/sync/settings') {
      // No body here: the key alone identifies the HUB; `hubId` is optional and checked when given.
      const hub = await hubByKey(ctx, req);
      const hubId = query.get('hubId');
      if (hubId !== null && hubId !== hub.id) throw new CloudError(403, 'HUB_MISMATCH', 'Ключ выдан другому HUB');
      const since = Number(query.get('since') ?? 0);
      if (!Number.isInteger(since) || since < 0) throw new CloudError(400, 'BAD_REQUEST', 'since должен быть целым числом');
      const club = await loadClub(ctx.db, hub.club_id);
      if (!club) throw new CloudError(500, 'CLUB_MISSING', 'Клуб этого HUB не найден');
      await ctx.db.transaction(async (tx) => {
        await tx.run('UPDATE hubs SET last_seen_at = ? WHERE id = ?', [ctx.now(), hub.id]);
        await hubBackOnline(tx, ctx.now(), hub, club.name);
      });
      const res = await settingsSince(ctx.db, club, since);
      await flushQuietly(ctx);
      await reportPushConfigured(ctx);
      return json(200, res);
    }

    return notFound();
  } catch (e) {
    return errorResponse(e, ctx.log);
  }
}
