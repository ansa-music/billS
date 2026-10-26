#!/usr/bin/env node
// Builds the HUB that ships inside TS for PC (apps/desktop): one folder that runs with a bare
// `node` — no git, no npm install, no internet on the club PC.
//
//   node scripts/bundle-hub.mjs [--out <dir>] [--node win-x64|linux-x64|host] [--no-web-build] [--check]
//
// --check starts the bundle from a temporary folder (empty database, free port) the way the desktop
// app does and waits for /api/health, /api/setup/status and the hall screen on /.
//
// Layout (mirrors apps/hub, so every `new URL(…, import.meta.url)` in the HUB sources still resolves):
//   <out>/package.json         name, version (apps/hub/package.json) and gitSha of the build
//   <out>/src/main.mjs         apps/hub/src/main.ts + @bills/domain + fastify, one ESM file (node:* stay imports)
//   <out>/src/migrations/      the SQL migrations (db.ts reads ./migrations/ next to the code)
//   <out>/web/                 the built hall screen (apps/web/dist), served on / via HUB_WEB_DIST
//   <out>/node.exe | node      with --node: the official Node.js binary, pinned version, SHA-256 checked
//
// The desktop app runs: <out>/node --env-file-if-exists=<data>/hub.env <out>/src/main.mjs with
// HUB_DB_PATH, HUB_HOST, HUB_PORT, HUB_WEB_DIST and HUB_GIT_SHA set (apps/desktop/src-tauri/src/local_hub.rs).
// Default <out>: apps/desktop/hub-bundle (bundled into the installers by apps/desktop/scripts/ci.mjs).
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_OUT = join(ROOT, 'apps', 'desktop', 'hub-bundle');

/** Node.js shipped with TS for PC. The HUB needs node:sqlite (Node 24+). Hashes: SHASUMS256.txt of the release. */
export const NODE_VERSION = '24.22.1';
export const NODE_BINARIES = {
  'win-x64': {
    url: `https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`,
    sha256: 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5',
    file: 'node.exe',
  },
  'linux-x64': {
    url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
    sha256: '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6',
    file: 'node',
    /** Path of the binary inside the archive. */
    member: `node-v${NODE_VERSION}-linux-x64/bin/node`,
  },
};

function fail(message) {
  console.error(`bundle-hub: ${message}`);
  process.exit(1);
}

export function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, node: null, webBuild: true, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = resolve(argv[++i] ?? fail('--out без папки'));
    else if (a === '--node') opts.node = argv[++i] ?? fail('--node без платформы');
    else if (a === '--no-web-build') opts.webBuild = false;
    else if (a === '--check') opts.check = true;
    else throw new Error(`неизвестный параметр ${a}`);
  }
  if (opts.node === 'host') opts.node = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
  if (opts.node && !NODE_BINARIES[opts.node]) throw new Error(`--node: ${Object.keys(NODE_BINARIES).join(' | ')} | host`);
  return opts;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

async function download(url, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(to, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.cause?.message ?? e.message}`);
      console.log(`bundle-hub: ${url}: ${e.message}, повтор через ${attempt * 3} с`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
}

/** Marks which binary is in the bundle, so a rebuild does not download it again. */
const NODE_STAMP = 'node.version';

/** Puts the pinned Node.js binary into `out`; a binary that is already there and matches is kept. */
export async function fetchNode(platform, out) {
  const spec = NODE_BINARIES[platform];
  const target = join(out, spec.file);
  const stamp = `${platform} ${NODE_VERSION} ${spec.sha256}`;
  if (existsSync(target) && existsSync(join(out, NODE_STAMP)) && readFileSync(join(out, NODE_STAMP), 'utf8').trim() === stamp) {
    console.log(`bundle-hub: ${relative(ROOT, target)} уже есть (Node.js ${NODE_VERSION})`);
    return target;
  }
  for (const s of Object.values(NODE_BINARIES)) rmSync(join(out, s.file), { force: true });
  const tmp = mkdtempSync(join(tmpdir(), 'ts-node-'));
  try {
    const archive = join(tmp, spec.member ? 'node.tar.xz' : spec.file);
    console.log(`bundle-hub: скачиваю Node.js ${NODE_VERSION} (${platform}) — ${spec.url}`);
    await download(spec.url, archive);
    const actual = sha256(archive);
    if (actual !== spec.sha256) throw new Error(`${spec.url}: SHA-256 ${actual}, ожидался ${spec.sha256}`);
    let binary = archive;
    if (spec.member) {
      execFileSync('tar', ['-xJf', archive, '-C', tmp, spec.member], { stdio: 'inherit' });
      binary = join(tmp, spec.member);
    }
    rmSync(target, { force: true });
    renameSync(binary, target);
    if (process.platform !== 'win32') chmodSync(target, 0o755);
    writeFileSync(join(out, NODE_STAMP), `${stamp}\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`bundle-hub: ${relative(ROOT, target)} (Node.js ${NODE_VERSION}, SHA-256 проверен)`);
  return target;
}

/**
 * In one bundled file every module shares main.mjs's import.meta.url, so the «run me when started
 * directly» checks of demo.ts and cli.ts (`process.argv[1]` compared with import.meta.url) would
 * fire inside the HUB: the demo supervisor would take over. On those lines import.meta.url
 * becomes the URL of a file that does not exist next to the bundle, so the checks stay false on
 * every OS (a valid absolute file URL: fileURLToPath must not throw on Windows).
 */
export function neutralizeMainChecks(source, name) {
  return source
    .split('\n')
    .map((line) =>
      line.includes('process.argv[1]') ? line.replaceAll('import.meta.url', `new URL(${JSON.stringify(`./__bundled__/${name}`)}, import.meta.url).href`) : line,
    )
    .join('\n');
}

const notMainModule = {
  name: 'not-main-module',
  setup(b) {
    b.onLoad({ filter: /[\\/](apps[\\/]hub|packages[\\/]domain)[\\/]src[\\/].*\.ts$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8');
      if (!source.includes('process.argv[1]')) return undefined;
      return { contents: neutralizeMainChecks(source, args.path.split(/[\\/]/).pop()), loader: 'ts' };
    });
  },
};

export async function bundleHub({ out, node, webBuild }) {
  const hubDir = join(ROOT, 'apps', 'hub');
  const webDist = join(ROOT, 'apps', 'web', 'dist');
  if (webBuild) {
    console.log('bundle-hub: сборка экрана зала (npm run build -w @bills/web)');
    execFileSync('npm', ['run', 'build', '-w', '@bills/web'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }
  if (!existsSync(join(webDist, 'index.html'))) throw new Error(`нет ${relative(ROOT, webDist)}/index.html — соберите экран зала (npm run build -w @bills/web)`);

  // A previously downloaded node binary survives a rebuild of the rest.
  const keep = [...Object.values(NODE_BINARIES).map((s) => s.file), NODE_STAMP];
  mkdirSync(out, { recursive: true });
  // Only folders this script made are cleaned: a mistyped --out must not wipe anything else.
  const ours = [...keep, 'src', 'web', 'package.json'];
  const foreign = readdirSync(out).filter((n) => !ours.includes(n));
  if (foreign.length) throw new Error(`${out}: там есть чужие файлы (${foreign.slice(0, 3).join(', ')}) — укажите пустую папку в --out`);
  for (const name of readdirSync(out)) if (!keep.includes(name)) rmSync(join(out, name), { recursive: true, force: true });

  const result = await build({
    entryPoints: [join(hubDir, 'src', 'main.ts')],
    outfile: join(out, 'src', 'main.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['node:*'],
    // CommonJS dependencies (fastify, pino…) call require() and read __dirname: give them both.
    banner: {
      js: [
        '// GENERATED by scripts/bundle-hub.mjs from apps/hub — do not edit.',
        "import { createRequire as __tsCreateRequire } from 'node:module';",
        "import { fileURLToPath as __tsFileURLToPath } from 'node:url';",
        "import { dirname as __tsDirname } from 'node:path';",
        'const require = __tsCreateRequire(import.meta.url);',
        'const __filename = __tsFileURLToPath(import.meta.url);',
        'const __dirname = __tsDirname(__filename);',
      ].join('\n'),
    },
    plugins: [notMainModule],
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });
  const bare = Object.values(result.metafile.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external && !isBuiltin(i.path))
    .map((i) => i.path);
  if (bare.length) throw new Error(`в сборке остались внешние модули: ${[...new Set(bare)].join(', ')}`);

  cpSync(join(hubDir, 'src', 'migrations'), join(out, 'src', 'migrations'), { recursive: true, filter: (p) => !/\.(ts|md)$/.test(p) });
  cpSync(webDist, join(out, 'web'), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(hubDir, 'package.json'), 'utf8'));
  const sha = gitSha();
  writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', gitSha: sha, node: NODE_VERSION }, null, 2)}\n`,
  );
  const migrations = readdirSync(join(out, 'src', 'migrations')).filter((f) => f.endsWith('.sql'));
  if (migrations.length === 0) throw new Error('нет SQL-миграций в apps/hub/src/migrations');
  const kb = Math.round(statSync(join(out, 'src', 'main.mjs')).size / 1024);
  console.log(`bundle-hub: ${relative(ROOT, out)} — src/main.mjs ${kb} KB, ${migrations.length} миграций, web/, git ${sha ?? '—'}`);

  if (node) await fetchNode(node, out);
  return out;
}

function freePort() {
  return new Promise((ok, ko) => {
    const srv = createServer();
    srv.once('error', ko);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

/** Environment of the bundled HUB — the same variables local_hub.rs sets. */
export function hubEnv({ out, dataDir, port, host = '0.0.0.0', gitSha = null }) {
  return {
    HUB_DB_PATH: join(dataDir, 'hub.db'),
    HUB_HOST: host,
    HUB_PORT: String(port),
    HUB_WEB_DIST: join(out, 'web'),
    ...(gitSha ? { HUB_GIT_SHA: gitSha } : {}),
  };
}

/** Starts the bundle on a free port with an empty database and checks what the desktop app relies on. */
export async function checkBundle(out) {
  const local = Object.values(NODE_BINARIES).find((s) => s.file === (process.platform === 'win32' ? 'node.exe' : 'node'));
  const bundled = join(out, local.file);
  const node = existsSync(bundled) ? bundled : process.execPath;
  const dataDir = mkdtempSync(join(tmpdir(), 'ts-hub-check-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...hubEnv({ out, dataDir, port, host: '127.0.0.1' }) };
  let log = '';
  const child = spawn(node, [join(out, 'src', 'main.mjs')], { cwd: dataDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) });
    return { status: res.status, text: await res.text() };
  };
  try {
    const deadline = Date.now() + 30_000;
    let health = null;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        health = await get('/api/health');
        if (health.status === 200) break;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (health?.status !== 200) throw new Error(`HUB не ответил на /api/health (${child.exitCode === null ? 'таймаут' : `вышел с кодом ${child.exitCode}`})`);
    const h = JSON.parse(health.text);
    if (h.ok !== true || typeof h.now !== 'number' || !('power' in h)) throw new Error(`странный ответ /api/health: ${health.text.slice(0, 200)}`);
    const setup = await get('/api/setup/status');
    if (setup.status !== 200 || JSON.parse(setup.text).open !== true) throw new Error(`/api/setup/status: ${setup.status} ${setup.text.slice(0, 200)}`);
    const page = await get('/');
    if (page.status !== 200 || !/<html/i.test(page.text)) throw new Error(`/ не отдаёт экран зала: ${page.status}`);
    if (!existsSync(join(dataDir, 'hub.db'))) throw new Error('база не создана в HUB_DB_PATH');
    console.log(`bundle-hub: проверка пройдена — ${node === bundled ? 'встроенный' : 'системный'} Node, HUB ${h.version}, схема ${h.schemaVersion}`);
  } catch (e) {
    console.error(log.split('\n').slice(-40).join('\n'));
    throw e;
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    fail(`${e.message}. Использование: node scripts/bundle-hub.mjs [--out <папка>] [--node win-x64|linux-x64|host] [--no-web-build]`);
  }
  try {
    await bundleHub(opts);
    if (opts.check) await checkBundle(opts.out);
  } catch (e) {
    fail(e.message);
  }
}
