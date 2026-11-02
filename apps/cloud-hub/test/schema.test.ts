/**
 * A new cloud café gets its schema from the build (scripts/hub-schema.mjs) in small steps instead of running every
 * HUB migration in one request: the result must be exactly the database the HUB's own openDb() makes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import initSqlJs from 'sql.js';
import { openDb } from '../../hub/src/db.ts';
import { hubSchemaTemplate } from '../scripts/hub-schema.mjs';
import type { ImportState } from '../src/importer.ts';
import { DDL_PER_STEP, Importer } from '../src/importer.ts';
import { FakeStorage } from './fake-storage.ts';

type Db = { prepare(sql: string): { all(): Array<Record<string, unknown>> } };

function schemaOf(db: Db): string[] {
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'ts_%' ORDER BY type, name")
    .all()
    .map((r) => JSON.stringify(r));
}

function rowsOf(db: Db, table: string): string[] {
  return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all().map((r) => JSON.stringify(r));
}

test('the schema template makes the same database as the HUB migrations, in steps of a few statements', async (t) => {
  const template = await hubSchemaTemplate();
  const storage = new FakeStorage();
  const importer = new Importer(storage, () => initSqlJs(), template.newest);
  let state: ImportState = importer.startTemplate(template as never, {}, 0, 'new');
  let steps = 0;
  let slowest = 0;
  while (state.phase !== 'done' && state.phase !== 'failed') {
    const t0 = performance.now();
    state = await importer.step();
    slowest = Math.max(slowest, performance.now() - t0);
    steps++;
  }
  assert.equal(state.phase, 'done', state.error ?? '');
  importer.clear();
  assert.equal(steps, Math.ceil(template.ddl.length / DDL_PER_STEP) + 2);

  const migrated = openDb(':memory:', 0);
  assert.deepEqual(schemaOf(storage.db), schemaOf(migrated));
  for (const { table } of template.seed) assert.deepEqual(rowsOf(storage.db, table), rowsOf(migrated, table), table);
  assert.ok(template.seed.some((s) => s.table === 'schema_migrations'));
  migrated.close();
  t.diagnostic(`${template.ddl.length} statements, ${steps} steps, slowest ${slowest.toFixed(1)} ms`);
});
