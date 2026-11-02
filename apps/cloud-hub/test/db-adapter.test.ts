import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { patchDbSource, TX_AFTER, TX_BEFORE } from '../scripts/db-adapter.mjs';

// A Windows checkout may have CRLF; the adapter normalises, so does the test.
const dbSource = readFileSync(new URL('../../hub/src/db.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the HUB transaction() still has the BEGIN/COMMIT block the cloud build swaps', () => {
  const patched = patchDbSource(dbSource);
  assert.ok(patched.includes(TX_AFTER));
  assert.ok(!patched.includes("db.exec('BEGIN IMMEDIATE')"));
  // Rollback and afterCommit stay the HUB's own.
  assert.ok(patched.includes('state.afterCommit = [];'));
});

test('a changed db.ts fails the build instead of shipping BEGIN to a Durable Object', () => {
  assert.throws(() => patchDbSource(dbSource.replace(TX_BEFORE, "    db.exec('BEGIN');\n    result = fn();\n    db.exec('COMMIT');\n")), /transaction\(\) changed/);
  assert.throws(() => patchDbSource(dbSource + TX_BEFORE), /transaction\(\) changed/);
});
