import type { Db } from './db.ts';
import { one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';

export interface CommandResult {
  status: number;
  body: unknown;
}

/**
 * Runs a command at most once per key. The stored response and the command's
 * changes commit together, so a retry after a lost response replays the result.
 * Business errors are not stored: a retry re-evaluates them.
 */
export function idempotent(
  db: Db,
  now: number,
  key: string,
  requestHash: string,
  command: () => CommandResult,
): CommandResult & { replayed: boolean } {
  return transaction(db, () => {
    const saved = one<{ request_hash: string; status_code: number; response: string }>(
      db,
      'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = ?',
      key,
    );
    if (saved) {
      if (saved.request_hash !== requestHash) {
        throw new HubError(422, 'IDEMPOTENCY_KEY_REUSED', 'Ключ запроса уже использован для другого действия');
      }
      return { status: saved.status_code, body: JSON.parse(saved.response) as unknown, replayed: true };
    }
    const result = command();
    run(
      db,
      'INSERT INTO idempotency_keys (key, request_hash, status_code, response, created_at) VALUES (?, ?, ?, ?, ?)',
      key,
      requestHash,
      result.status,
      JSON.stringify(result.body),
      now,
    );
    return { ...result, replayed: false };
  });
}

export function purgeIdempotencyKeys(db: Db, olderThan: number): number {
  return run(db, 'DELETE FROM idempotency_keys WHERE created_at < ?', olderThan);
}
