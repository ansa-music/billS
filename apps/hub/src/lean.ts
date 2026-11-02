import type { Db } from './db.ts';

/**
 * Habits of a HUB that pays for every row it reads and writes: the cloud café (apps/cloud-hub), where
 * Cloudflare bills a Durable Object's SQLite by rows. On a club PC and in the browser trial rows are free and
 * none of this is switched on (Hub deps `leanReads`, `outbox`; both off by default).
 *
 * Kept per database, because the code that reads and journals takes the database and nothing else.
 *
 * - **Lean reads** (`leanReads: true`): GET /api/state reads only what can change, not the café's whole history:
 *   - the expected cash of the open shift is kept as a running tally and only payments and cash movements newer
 *     than the last ones counted are read (views.ts `toShiftView`); the same numbers as `shiftTotals(shiftLedger)`;
 *   - open checks come by their status index (`ix_checks_status`), not by scanning every check of the club;
 *   - open bar orders come through live games and the status index, not by scanning every order ever taken.
 * - **No outbox** (`outbox: false`): a HUB that never syncs with the TS cloud does not queue journal entries for
 *   it (journal.ts `record`); the audit log is written as always. Every entry saves 2–3 written rows (the outbox
 *   row, its index and the AUTOINCREMENT counter), and `/api/state` stops counting an outbox that only grows.
 */

const leanDbs = new WeakSet<object>();
const noOutboxDbs = new WeakSet<object>();

export function setLeanReads(db: Db, on: boolean): void {
  if (on) leanDbs.add(db);
  else leanDbs.delete(db);
}

export function leanReads(db: Db): boolean {
  return leanDbs.has(db);
}

export function setOutbox(db: Db, enabled: boolean): void {
  if (enabled) noOutboxDbs.delete(db);
  else noOutboxDbs.add(db);
}

export function outboxEnabled(db: Db): boolean {
  return !noOutboxDbs.has(db);
}
