/**
 * sql.js in the Worker (sqljs.ts): the browser build, with its WebAssembly compiled at deploy time — Workers
 * cannot compile WebAssembly from bytes at run time (wrangler's CompiledWasm rule; build.mjs copies the file).
 */
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
import sqlWasm from './sql-wasm.wasm';
import type { SqlJs } from './sqljs.ts';

let sqlJs: Promise<SqlJs> | null = null;

export function loadSqlJs(): Promise<SqlJs> {
  if (sqlJs) return sqlJs;
  // sql.js takes a Worker for a web worker and reads self.location.href once while it starts.
  const g = globalThis as { location?: unknown };
  const fakeLocation = g.location === undefined;
  if (fakeLocation) g.location = { href: 'https://cafe.invalid/' };
  const loading = initSqlJs({
    instantiateWasm(imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) {
      void WebAssembly.instantiate(sqlWasm, imports).then((instance) => done(instance));
      return {};
    },
  } as unknown as Parameters<typeof initSqlJs>[0]).finally(() => {
    if (fakeLocation) delete g.location;
  });
  sqlJs = loading;
  // A failed start is tried again next time instead of failing every later call.
  loading.catch(() => {
    if (sqlJs === loading) sqlJs = null;
  });
  return loading;
}
