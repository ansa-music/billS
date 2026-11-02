/**
 * Bundles the cloud HUB Worker (src/worker.ts + the HUB's own code from apps/hub/src) into dist/worker.js;
 * wrangler then deploys that file (wrangler.toml `main`, `[build] command`).
 *
 * The HUB runs unchanged; only what a Worker lacks is swapped:
 *   node:sqlite     → src/shims/sqlite.ts (Durable Object SQLite storage)
 *   node:fs         → src/shims/fs.ts (the SQL migrations, bundled below as virtual:hub-migrations)
 *   fastify         → apps/web/src/demo-hub/mini-fastify.ts (the trial's in-memory Fastify with inject)
 *   @fastify/static → no-op (screens are Workers static assets)
 *   other node:*    → left to wrangler's nodejs_compat (crypto, events, path, url, net, os, child_process)
 *
 * Two adapters patch source (scripts/db-adapter.mjs): db.ts `transaction()` says BEGIN IMMEDIATE / COMMIT and
 * guard.ts `safely()` says SAVEPOINT, which a Durable Object refuses; here they call the storage's own
 * transactions instead. The build and test/db-adapter.test.ts fail loudly if that code moves.
 */
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { patchDbSource, patchGuardSource } from './scripts/db-adapter.mjs';
import { hubSchemaTemplate } from './scripts/hub-schema.mjs';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const HUB_SRC = at('../hub/src/');
const MIGRATIONS_DIR = at('../hub/src/migrations/');

/** @type {import('esbuild').Plugin} */
const cloudHub = {
  name: 'cloud-hub',
  setup(b) {
    const alias = {
      'node:sqlite': at('src/shims/sqlite.ts'),
      'node:fs': at('src/shims/fs.ts'),
      fastify: at('../web/src/demo-hub/mini-fastify.ts'),
      '@fastify/static': at('src/shims/fastify-static.ts'),
    };
    b.onResolve({ filter: /^(node:sqlite|node:fs|fastify|@fastify\/static)$/ }, (args) => ({ path: alias[args.path] }));
    b.onResolve({ filter: /^@ts-hub\// }, (args) => ({ path: HUB_SRC + args.path.slice('@ts-hub/'.length) }));
    b.onResolve({ filter: /\.wasm$/ }, () => ({ path: './sql-wasm.wasm', external: true }));
    b.onResolve({ filter: /^virtual:hub-migrations$/ }, () => ({ path: 'hub-migrations', namespace: 'virtual' }));
    b.onResolve({ filter: /^virtual:hub-schema$/ }, () => ({ path: 'hub-schema', namespace: 'virtual-schema' }));
    // A new café's schema, made by the HUB's own migrations here and created in small steps there (scripts/hub-schema.mjs).
    b.onLoad({ filter: /.*/, namespace: 'virtual-schema' }, async () => ({
      contents: `export const HUB_SCHEMA = ${JSON.stringify(await hubSchemaTemplate())};\n`,
      loader: 'js',
      watchDirs: [MIGRATIONS_DIR],
    }));
    b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => {
      const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
      const migrations = Object.fromEntries(files.map((f) => [f, readFileSync(MIGRATIONS_DIR + f, 'utf8')]));
      const newest = Math.max(0, ...files.map((f) => Number.parseInt(f, 10)));
      return {
        contents: `export const MIGRATIONS = ${JSON.stringify(migrations)};\nexport const NEWEST_MIGRATION = ${newest};\n`,
        loader: 'js',
        watchDirs: [MIGRATIONS_DIR],
      };
    });
    b.onLoad({ filter: /[\\/]apps[\\/]hub[\\/]src[\\/]db\.ts$/ }, (args) => ({
      contents: patchDbSource(readFileSync(args.path, 'utf8')),
      loader: 'ts',
    }));
    b.onLoad({ filter: /[\\/]apps[\\/]hub[\\/]src[\\/]guard\.ts$/ }, (args) => ({
      contents: patchGuardSource(readFileSync(args.path, 'utf8')),
      loader: 'ts',
    }));
  },
};

mkdirSync(at('dist'), { recursive: true });
copyFileSync(at('../../node_modules/sql.js/dist/sql-wasm-browser.wasm'), at('dist/sql-wasm.wasm'));

// wrangler refuses a missing assets folder: a placeholder until scripts/build-web.mjs builds the screens.
if (!existsSync(at('web-dist/index.html'))) {
  mkdirSync(at('web-dist'), { recursive: true });
  writeFileSync(at('web-dist/index.html'), '<!doctype html><meta charset="utf-8"><title>TS</title><p>Экраны TS не собраны: npm run build:web -w @bills/cloud-hub</p>\n');
}

const result = await build({
  entryPoints: [at('src/worker.ts')],
  outfile: at('dist/worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser', 'import', 'default'],
  external: ['node:*', 'cloudflare:*'],
  // The HUB finds its files next to itself (import.meta.url): give the bundle a stable fake location.
  define: { 'import.meta.url': '"file:///bundle/apps/hub/src/bundle.js"' },
  plugins: [cloudHub],
  metafile: true,
  logLevel: 'warning',
  legalComments: 'none',
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`cloud-hub: dist/worker.js ${(bytes / 1024).toFixed(0)} KiB (+ sql-wasm.wasm ${(readFileSync(at('dist/sql-wasm.wasm')).length / 1024).toFixed(0)} KiB)`);
