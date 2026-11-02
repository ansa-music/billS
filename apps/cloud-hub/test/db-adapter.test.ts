import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GUARD_AFTER, GUARD_BEFORE, patchDbSource, patchGuardSource, TX_AFTER, TX_BEFORE } from '../scripts/db-adapter.mjs';

// A Windows checkout may have CRLF; the adapter normalises, so does the test.
const dbSource = readFileSync(new URL('../../hub/src/db.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const guardSource = readFileSync(new URL('../../hub/src/guard.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

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

test('«Сторож» rules still run in a SAVEPOINT the cloud build swaps for a nested storage transaction', () => {
  const patched = patchGuardSource(guardSource);
  assert.ok(patched.includes(GUARD_AFTER));
  assert.ok(!patched.includes("'SAVEPOINT guard'") && !patched.includes("'ROLLBACK TO guard'"));
  // The warning of a failed rule stays the HUB's own.
  assert.ok(patched.includes('[guard] rule ${rule} failed'));
  assert.throws(() => patchGuardSource(guardSource.replace(GUARD_BEFORE, '')), /safely\(\) changed/);
});
