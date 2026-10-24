// A personal copy of the club for looking around: HUB + hall screen on their own
// ports and their own database, so it keeps running while dev servers on
// 4310 / 5173 are restarted. Stop with Ctrl+C.
//
//   node scripts/local.mjs        (or: npm run local)
//
// Ports and database: --hub-port=4400 --web-port=5400 --db=local (apps/hub/data/<db>.db),
// or LOCAL_HUB_PORT / LOCAL_WEB_PORT / LOCAL_DB. A second copy needs all three different.
//
// --dist: no Vite dev server; the HUB serves the built screen (apps/web/dist, run
// `npm run build` first) like in a club. This is how the installable app (PWA:
// manifest, service worker, install banner) is checked — the dev server has no
// service worker.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const hubPort = flag('hub-port') ?? process.env.LOCAL_HUB_PORT ?? '4400';
const webPort = flag('web-port') ?? process.env.LOCAL_WEB_PORT ?? '5400';
const dbName = (flag('db') ?? process.env.LOCAL_DB ?? 'local').replace(/[^\w-]/g, '');
const serveDist = process.argv.includes('--dist');
const children = [];
let stopping = false;

function start(name, args, cwd, env) {
  // process.execPath: works even when node is not on PATH.
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) console.log(`[${name}] ${line}`);
    });
  }
  child.on('exit', (code) => {
    if (stopping) return;
    console.log(`[${name}] остановился (код ${code}) — останавливаю всё`);
    stop(1);
  });
  children.push(child);
}

function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill();
  process.exit(code);
}

start('hub', ['--watch', 'src/main.ts'], join(root, 'apps/hub'), {
  HUB_PORT: hubPort,
  HUB_DB_PATH: join(root, `apps/hub/data/${dbName}.db`),
  // A real HUB starts empty; the local stand keeps demo data unless HUB_DEMO=0.
  HUB_DEMO: process.env.HUB_DEMO ?? '1',
});
if (!serveDist) {
  start('web', [join(root, 'node_modules/vite/bin/vite.js')], join(root, 'apps/web'), {
    WEB_PORT: webPort,
    HUB_URL: `http://127.0.0.1:${hubPort}`,
  });
}

const screen = serveDist ? `http://localhost:${hubPort}  (собранный apps/web/dist, отдаёт HUB)` : `http://localhost:${webPort}`;
console.log(`\n  Экран зала: ${screen}\n  HUB:        http://localhost:${hubPort}/api/health\n  Остановить: Ctrl+C\n`);
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
