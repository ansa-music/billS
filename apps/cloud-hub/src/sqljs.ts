/**
 * sql.js (SQLite in WebAssembly) inside the Worker: a Durable Object cannot ATTACH a file, so a café's SQLite
 * file — a trial's snapshot coming in, a «Скачать копию» going out — is opened and written with sql.js.
 * Types only here; the instance comes from `loadSqlJs` (cafe-hub.ts) or, in Node tests, from the `sql.js` package.
 */
import type initSqlJs from 'sql.js';

export type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
export type SqlJsDatabase = InstanceType<SqlJs['Database']>;
/** A cell as sql.js gives and takes it. */
export type Cell = number | string | Uint8Array | null;

export const SQLITE_HEADER = 'SQLite format 3\u0000';

/** `"name"` for SQL. */
export const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Tables that are the café's own data: not SQLite's, not Cloudflare's (`_cf_*`), not the cloud café's (`ts_*`). */
export function isCafeTable(name: string): boolean {
  return !/^(sqlite_|_cf_|ts_)/i.test(name);
}
