/**
 * The source patches of the cloud HUB build (build.mjs). A Durable Object's SQL refuses BEGIN, COMMIT and
 * SAVEPOINT; its storage has its own synchronous transactions instead (shims/sqlite.ts):
 *
 * - db.ts `transaction()` opens and commits with BEGIN IMMEDIATE / COMMIT → the storage's `transactionSync()`
 *   (rollback on a throw is the storage's);
 * - guard.ts `safely()` runs a «Сторож» rule inside SAVEPOINT guard, so a failing rule never breaks the command
 *   that called it → a nested storage transaction (`savepointSync()`), the same promise.
 *
 * test/db-adapter.test.ts fails as soon as either source changes shape here, and so does the build.
 */
export const TX_BEFORE = "    db.exec('BEGIN IMMEDIATE');\n    result = fn();\n    db.exec('COMMIT');\n";
export const TX_AFTER = '    result = (db as unknown as { transactionSync<R>(f: () => R): R }).transactionSync(fn);\n';

export const GUARD_BEFORE =
  "  run(db, 'SAVEPOINT guard');\n  try {\n    fn();\n    run(db, 'RELEASE guard');\n  } catch (e) {\n    try {\n      run(db, 'ROLLBACK TO guard');\n      run(db, 'RELEASE guard');\n    } catch {\n      // The savepoint is gone with the transaction: nothing to undo.\n    }\n";
export const GUARD_AFTER = '  try {\n    (db as unknown as { savepointSync(f: () => void): void }).savepointSync(fn);\n  } catch (e) {\n';

function patchOnce(source, before, after, what) {
  const text = source.replace(/\r\n/g, '\n');
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${what} changed: update the adapter in apps/cloud-hub/scripts/db-adapter.mjs`);
  return text.replace(before, after);
}

/** db.ts source → the cloud version. Throws when the block is not there exactly once. */
export function patchDbSource(source) {
  return patchOnce(source, TX_BEFORE, TX_AFTER, 'apps/hub/src/db.ts transaction()');
}

/** guard.ts source → the cloud version. Throws when the block is not there exactly once. */
export function patchGuardSource(source) {
  return patchOnce(source, GUARD_BEFORE, GUARD_AFTER, 'apps/hub/src/guard.ts safely()');
}
