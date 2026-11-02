/**
 * A trial coffee shop moves to the cloud: the SQLite file the browser trial uploads to Supabase
 * (`trials.snapshot`, base64 of sql.js `db.export()`) is opened with sql.js (SQLite in WebAssembly — the
 * Durable Object cannot ATTACH a file) and copied into the café's Durable Object storage: the same tables,
 * rows, indexes and triggers, then the HUB's newer migrations run on top (openDb). Staff keep their keys:
 * the key hashes and the club id come along.
 */
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
import sqlWasm from './sql-wasm.wasm';
import { CloudError } from './errors.ts';
import type { DatabaseSync } from './shims/sqlite.ts';

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
type SqlJsDatabase = InstanceType<SqlJs['Database']>;

let sqlJs: Promise<SqlJs> | null = null;

function loadSqlJs(): Promise<SqlJs> {
  if (sqlJs) return sqlJs;
  // sql.js takes a Worker for a web worker and reads self.location.href once while it starts.
  const g = globalThis as { location?: unknown };
  const fakeLocation = g.location === undefined;
  if (fakeLocation) g.location = { href: 'https://cafe.invalid/' };
  // Workers cannot compile WebAssembly from bytes at run time: the module is compiled at deploy time
  // (wrangler's CompiledWasm rule) and instantiated here.
  sqlJs = initSqlJs({
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
      void WebAssembly.instantiate(sqlWasm, imports).then((instance) => done(instance));
      return {};
    },
  } as unknown as Parameters<typeof initSqlJs>[0]).finally(() => {
    if (fakeLocation) delete g.location;
  });
  return sqlJs;
}

const SQLITE_HEADER = 'SQLite format 3\u0000';

export function decodeSnapshot(base64: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    const bin = atob(base64.replace(/\s+/g, ''));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни повреждена: это не base64.');
  }
  if (bytes.length < 100 || new TextDecoder().decode(bytes.subarray(0, 16)) !== SQLITE_HEADER) {
    throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни повреждена: это не база SQLite.');
  }
  return bytes;
}

export interface ImportReport {
  tables: number;
  rows: number;
  /** schema_migrations of the copy before the newer migrations ran. */
  fromMigration: number;
  venue: string | null;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

type Cell = number | string | Uint8Array | null;

function toBinding(v: Cell): ArrayBuffer | string | number | null {
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  return v;
}

function scalar(src: SqlJsDatabase, sql: string): Cell {
  return (src.exec(sql)[0]?.values[0]?.[0] ?? null) as Cell;
}

/**
 * Copies the trial database into `target` (an empty café) in one storage transaction: all or nothing.
 * `newestMigration`: this build's newest migration — a copy made by a newer TS is refused.
 */
export async function importSnapshot(target: DatabaseSync, bytes: Uint8Array, newestMigration: number): Promise<ImportReport> {
  const SQL = await loadSqlJs();
  let src: SqlJsDatabase;
  try {
    src = new SQL.Database(bytes);
    src.exec('SELECT count(*) FROM sqlite_master');
  } catch {
    throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни не открывается.');
  }
  try {
    const hasMigrations = scalar(src, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'") === 1;
    if (!hasMigrations) throw new CloudError(400, 'SNAPSHOT_INVALID', 'Это не копия кофейни TS.');
    const fromMigration = Number(scalar(src, 'SELECT max(version) FROM schema_migrations') ?? 0);
    if (fromMigration > newestMigration) {
      throw new CloudError(409, 'SNAPSHOT_NEWER', 'Копия сделана более новой версией TS, чем облачная касса. Обновите облачную кассу.');
    }
    const venue = scalar(src, 'SELECT name FROM clubs ORDER BY created_at LIMIT 1');

    const objects = (src.exec("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid")[0]?.values ?? []) as Array<
      [string, string, string]
    >;
    const tables = objects.filter(([type]) => type === 'table');
    const rest = objects.filter(([type]) => type !== 'table');
    let rows = 0;

    target.transactionSync(() => {
      // Children may come before their parents in sqlite_master order: check foreign keys at commit.
      target.query('PRAGMA defer_foreign_keys = ON');
      for (const [, , sql] of tables) target.query(sql);
      for (const [, name] of tables) {
        // Real columns only (no hidden or generated ones): PRAGMA table_xinfo, hidden = 0.
        const info = src.exec(`PRAGMA table_xinfo(${q(name)})`)[0];
        const nameAt = info?.columns.indexOf('name') ?? -1;
        const hiddenAt = info?.columns.indexOf('hidden') ?? -1;
        const cols = (info?.values ?? []).filter((r) => Number(r[hiddenAt]) === 0).map((r) => String(r[nameAt]));
        if (!cols.length) continue;
        const insert = `INSERT INTO ${q(name)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        const stmt = src.prepare(`SELECT ${cols.map(q).join(', ')} FROM ${q(name)}`);
        try {
          while (stmt.step()) {
            target.query(insert, (stmt.get() as Cell[]).map(toBinding));
            rows++;
          }
        } finally {
          stmt.free();
        }
      }
      // AUTOINCREMENT counters, so new journal ids continue after the copied ones.
      const seq = src.exec("SELECT name, seq FROM sqlite_sequence WHERE name IN (SELECT name FROM sqlite_master WHERE type = 'table')")[0]?.values ?? [];
      for (const [name, value] of seq) {
        try {
          target.query('UPDATE sqlite_sequence SET seq = ? WHERE name = ?', [Number(value), String(name)]);
        } catch {
          // No sqlite_sequence yet (no AUTOINCREMENT row copied): nothing to continue.
        }
      }
      for (const [, , sql] of rest) target.query(sql);
    });
    return { tables: tables.length, rows, fromMigration, venue: typeof venue === 'string' ? venue : null };
  } finally {
    src.close();
  }
}
