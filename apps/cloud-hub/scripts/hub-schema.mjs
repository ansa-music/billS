/**
 * The HUB's schema as a new cloud café gets it (build.mjs bundles it as `virtual:hub-schema`): the CREATE
 * statements and the few rows the HUB's migrations leave in an empty database, taken from a database the HUB's
 * own openDb() migrated, here in Node at build time.
 *
 * Running the 20-odd migrations inside a Durable Object takes ~30 ms of CPU in one request — three times what the
 * Workers Free plan allows. Created from this list in small batches (importer.ts, `startTemplate`), a new café
 * costs a few milliseconds per step, and the HUB then finds every migration applied (test/schema.test.ts proves
 * the result is the same database).
 */
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const DB_TS = fileURLToPath(new URL('../../hub/src/db.ts', import.meta.url));

/** @returns {Promise<{ ddl: string[]; triggers: string[]; seed: Array<{ table: string; cols: string[]; rows: unknown[][] }>; newest: number }>} */
export async function hubSchemaTemplate() {
  const { openDb } = await import(pathToFileURL(DB_TS).href);
  const db = openDb(':memory:', 0);
  try {
    const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
    const tables = objects.filter((o) => o.type === 'table');
    const seed = [];
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}" ORDER BY rowid`).all();
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      seed.push({ table: t.name, cols, rows: rows.map((r) => cols.map((c) => r[c])) });
    }
    const newest = Number(db.prepare('SELECT max(version) AS v FROM schema_migrations').get().v ?? 0);
    return {
      ddl: [...tables.map((t) => t.sql), ...objects.filter((o) => o.type === 'index').map((o) => o.sql)],
      triggers: objects.filter((o) => o.type === 'trigger').map((o) => o.sql),
      seed,
      newest,
    };
  } finally {
    db.close();
  }
}
