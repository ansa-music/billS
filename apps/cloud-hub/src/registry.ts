/**
 * One small Durable Object for the whole Worker (`REGISTRY`, name `admin`): which café an admin call with an
 * `Idempotency-Key` made. The TS platform sends `Idempotency-Key: ts-trial-<id>-<snapshotAt>` with a move (and may
 * with a new café); a retry after a lost answer gets the same café back instead of a second one.
 *
 * Keys are kept 30 days. Only keys and café codes are stored — no café data.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';

const KEEP_MS = 30 * 24 * 3600_000;

export interface ClaimRequest {
  key: string;
  /** The code to use when the key is new. */
  code: string;
}

export interface ClaimResponse {
  code: string;
  /** true: the key was new, `code` is the one just offered; false: an earlier call made `code`. */
  fresh: boolean;
}

export class AdminRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ts_idempotency (key TEXT PRIMARY KEY, code TEXT NOT NULL, at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS ix_ts_idempotency_at ON ts_idempotency (at)');
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/claim' || request.method !== 'POST') return new Response('not found', { status: 404 });
    const { key, code } = (await request.json()) as ClaimRequest;
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const answer = this.ctx.storage.transactionSync((): ClaimResponse => {
      sql.exec('DELETE FROM ts_idempotency WHERE at < ?', now - KEEP_MS);
      const row = sql.exec('SELECT code FROM ts_idempotency WHERE key = ?', key).toArray()[0];
      if (row) return { code: String(row.code), fresh: false };
      sql.exec('INSERT INTO ts_idempotency (key, code, at) VALUES (?, ?, ?)', key, code, now);
      return { code, fresh: true };
    });
    return Response.json(answer);
  }
}
