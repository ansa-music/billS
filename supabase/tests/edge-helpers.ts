import { randomUUID } from 'node:crypto';
import type { PushMessage, PushSender, SendResult } from '../../apps/cloud/src/push.ts';
import { RoutingSender } from '../../apps/cloud/src/push.ts';
import { DEMO_OWNER, seedDemo } from '../../apps/cloud/src/seed.ts';
import type { EdgeContext } from '../../apps/cloud/src/edge/context.ts';
import { edgeContext } from '../../apps/cloud/src/edge/context.ts';
import type { EdgeRequest } from '../../apps/cloud/src/edge/http.ts';
import type { TelegramFetch } from '../../apps/cloud/src/telegram.ts';
import type { SupabaseTestDb } from './harness.ts';
import { createSupabaseDb } from './harness.ts';

/** Monday 2026-10-12, 12:00 in Almaty — the same "now" as apps/cloud tests. */
export const MONDAY_NOON = Date.UTC(2026, 9, 12, 7, 0);
export const HOUR = 3_600_000;
export const NOTIFY_SECRET = 'test-notify-secret-0123456789';

export type Handler = (req: EdgeRequest, ctx: EdgeContext) => Promise<Response>;

export interface EdgeTest {
  s: SupabaseTestDb;
  ctx: EdgeContext;
  clock: { now: number };
  log: string[];
  /** What the fake senders were asked to deliver, by channel. */
  sent: Array<PushMessage & { channel: string }>;
  call<T = any>(
    handler: Handler,
    method: string,
    path: string,
    options?: { headers?: Record<string, string>; body?: unknown; raw?: string },
  ): Promise<{ status: number; body: T; headers: Headers }>;
}

/** A sender that records what it was asked to send. */
export function recordingSender(channel: string, sent: Array<PushMessage & { channel: string }>, result: () => SendResult = () => ({ ok: true })): PushSender {
  return {
    enabled: true,
    async send(message) {
      sent.push({ ...message, channel });
      return result();
    },
  };
}

/** Supabase-shaped database (PGlite) with the demo seed and an EdgeContext over it. */
export async function edgeTest(
  t: { after(fn: () => Promise<void>): void },
  options: { sender?: PushSender; env?: Record<string, string>; telegramFetch?: TelegramFetch } = {},
): Promise<EdgeTest> {
  const s = await createSupabaseDb();
  t.after(() => s.close());
  await seedDemo(s.db, MONDAY_NOON);
  // From the DB agent's migration; created here only if it is not in the tree yet.
  await s.db.run('CREATE TABLE IF NOT EXISTS ts_runtime (key text PRIMARY KEY, value text NOT NULL, updated_at bigint NOT NULL)');
  const clock = { now: MONDAY_NOON };
  const log: string[] = [];
  const sent: Array<PushMessage & { channel: string }> = [];
  const sender =
    options.sender ??
    new RoutingSender({ webpush: recordingSender('webpush', sent), ntfy: recordingSender('ntfy', sent) });
  const ctx = edgeContext(
    s.db,
    { NOTIFY_SECRET, ...options.env },
    { now: () => clock.now, log: (m) => log.push(m), sender, ...(options.telegramFetch ? { telegramFetch: options.telegramFetch } : {}) },
  );
  return {
    s,
    ctx,
    clock,
    log,
    sent,
    async call(handler, method, path, options = {}) {
      const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
      const req = new Request(`http://edge.local${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers },
        ...(body !== undefined ? { body } : {}),
      });
      const res = await handler(req, ctx);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    },
  };
}

/** An unsigned-but-well-formed Supabase user JWT (the platform verifies signatures; tests do not). */
export function userJwt(sub: string, claims: Record<string, unknown> = {}): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub, role: 'authenticated', aud: 'authenticated', exp: 4_000_000_000, ...claims })}.c2ln`;
}

/**
 * Links an Auth user to an owner. `owners.auth_user_id` comes from the DB agent's migration;
 * the column is added here only if that migration is not in the tree yet.
 */
export async function linkOwner(s: SupabaseTestDb, email = DEMO_OWNER.email): Promise<string> {
  await s.db.run('ALTER TABLE owners ADD COLUMN IF NOT EXISTS auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL');
  const existing = await s.db.all<{ id: string }>('SELECT id::text AS id FROM auth.users WHERE lower(email) = lower(?)', [email]);
  const uid = existing[0]?.id ?? (await s.createAuthUser(email));
  await s.db.run('UPDATE owners SET auth_user_id = ?::uuid WHERE lower(email) = lower(?)', [uid, email]);
  return uid;
}

/** A second company with its own owner and club (to check that owners see only their clubs). */
export async function otherCompany(s: SupabaseTestDb): Promise<{ clubId: string; email: string }> {
  const companyId = randomUUID();
  const clubId = randomUUID();
  const email = 'other@example.kz';
  await s.db.run('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', [companyId, 'Другая сеть', MONDAY_NOON]);
  await s.db.run('INSERT INTO owners (id, company_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    randomUUID(),
    companyId,
    email,
    'Другой',
    'x',
    MONDAY_NOON,
  ]);
  await s.db.run('INSERT INTO clubs (id, company_id, name, timezone, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    clubId,
    companyId,
    'Чужой клуб',
    'Asia/Almaty',
    'KZT',
    MONDAY_NOON,
  ]);
  return { clubId, email };
}

export async function clubIdOf(s: SupabaseTestDb, hubId: string): Promise<string> {
  const rows = await s.db.all<{ club_id: string }>('SELECT club_id FROM hubs WHERE id = ?', [hubId]);
  return rows[0]!.club_id;
}
