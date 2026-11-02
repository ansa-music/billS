import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { handleTrial } from '../../apps/cloud/src/edge/trial.ts';
import { DEMO_PLATFORM } from '../../apps/cloud/src/seed.ts';
import type { EdgeTest } from './edge-helpers.ts';

/** A browser's installId as the trial page makes it: 24 random bytes, base64url. */
export const newInstallId = (): string => randomBytes(24).toString('base64url');

export interface StartedTrial {
  id: string;
  token: string;
  installId: string;
  auth: { authorization: string };
  body: Record<string, unknown>;
}

/** POST /trial/start from a current page (with an installId): a new request, 201. */
export async function startRequest(
  e: EdgeTest,
  body: Record<string, unknown> = { venue: '  Кофейня «Зерно»  ', managerName: 'Айгерим', timezone: 'Asia/Almaty' },
  ip = '198.51.100.4',
): Promise<StartedTrial> {
  const installId = typeof body.installId === 'string' ? body.installId : newInstallId();
  const res = await e.call(handleTrial, 'POST', '/functions/v1/trial/trial/start', { headers: { 'x-forwarded-for': ip }, body: { installId, ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id as string, token: res.body.token as string, installId, auth: { authorization: `Bearer ${res.body.token}` }, body: res.body };
}

/** A platform session (OWNER-… key of the demo seed by default). */
export async function platformAuth(e: EdgeTest, key: string = DEMO_PLATFORM[0].key): Promise<Record<string, string>> {
  const r = await e.call(handlePlatform, 'POST', '/platform/login', { body: { key } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { authorization: `Bearer ${r.body.token}` };
}

/** «Подтвердить» by the platform owner. */
export async function approve(e: EdgeTest, id: string, headers?: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await e.call(handlePlatform, 'POST', `/platform/trials/${id}/approve`, { headers: headers ?? (await platformAuth(e)) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

/** A request the platform owner approved at once: an active trial of 14 days from now. */
export async function startActive(e: EdgeTest, body?: Record<string, unknown>, ip?: string): Promise<StartedTrial> {
  const s = await startRequest(e, body, ip);
  await approve(e, s.id);
  return s;
}
