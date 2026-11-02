/**
 * The one source patch of the cloud HUB build (build.mjs): apps/hub/src/db.ts `transaction()` opens and
 * commits with BEGIN IMMEDIATE / COMMIT, which a Durable Object's SQL refuses. In the bundle the same spot
 * calls the storage's own synchronous transaction (shims/sqlite.ts transactionSync) instead; rollback on a
 * throw is the storage's. test/db-adapter.test.ts fails as soon as db.ts changes shape here.
 */
export const TX_BEFORE = "    db.exec('BEGIN IMMEDIATE');\n    result = fn();\n    db.exec('COMMIT');\n";
export const TX_AFTER = '    result = (db as unknown as { transactionSync<R>(f: () => R): R }).transactionSync(fn);\n';

/** db.ts source → the cloud version. Throws when the block is not there exactly once. */
export function patchDbSource(source) {
  const text = source.replace(/\r\n/g, '\n');
  const count = text.split(TX_BEFORE).length - 1;
  if (count !== 1) {
    throw new Error('apps/hub/src/db.ts transaction() changed: update the BEGIN/COMMIT adapter in apps/cloud-hub/scripts/db-adapter.mjs');
  }
  return text.replace(TX_BEFORE, TX_AFTER);
}
