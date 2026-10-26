// Tests of scripts/bundle-hub.mjs (the HUB built into TS for PC): node --test "apps/desktop/scripts/*.test.mjs"
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_OUT, hubEnv, NODE_BINARIES, NODE_VERSION, neutralizeMainChecks, parseArgs } from '../../../scripts/bundle-hub.mjs';

test('main-module checks of demo.ts and cli.ts never fire inside the bundle', () => {
  const demo = 'const mainPath = fileURLToPath(new URL(\'./main.ts\', import.meta.url));\n' +
    'if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await supervise();';
  const out = neutralizeMainChecks(demo, 'demo.ts').split('\n');
  assert.equal(out[0], "const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));");
  assert.equal(
    out[1],
    'if (process.argv[1] && fileURLToPath(new URL("./__bundled__/demo.ts", import.meta.url).href) === resolve(process.argv[1])) await supervise();',
  );
  const cli = 'if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {';
  assert.match(neutralizeMainChecks(cli, 'cli.ts'), /=== new URL\("\.\/__bundled__\/cli\.ts", import\.meta\.url\)\.href/);
});

test('arguments', () => {
  assert.deepEqual(parseArgs([]), { out: DEFAULT_OUT, node: null, webBuild: true, check: false });
  const o = parseArgs(['--node', 'win-x64', '--no-web-build', '--check']);
  assert.equal(o.node, 'win-x64');
  assert.equal(o.webBuild, false);
  assert.equal(o.check, true);
  assert.ok(['win-x64', 'linux-x64'].includes(parseArgs(['--node', 'host']).node));
  assert.throws(() => parseArgs(['--node', 'mac']));
  assert.throws(() => parseArgs(['--what']));
});

test('pinned Node.js 24 with SHA-256 for both installers', () => {
  assert.match(NODE_VERSION, /^24\.\d+\.\d+$/);
  for (const spec of Object.values(NODE_BINARIES)) {
    assert.match(spec.sha256, /^[0-9a-f]{64}$/);
    assert.ok(spec.url.startsWith(`https://nodejs.org/dist/v${NODE_VERSION}/`));
  }
});

test('HUB environment matches the desktop app (local_hub.rs)', () => {
  assert.deepEqual(hubEnv({ out: '/b', dataDir: '/d', port: 4310 }), {
    HUB_DB_PATH: join('/d', 'hub.db'),
    HUB_HOST: '0.0.0.0',
    HUB_PORT: '4310',
    HUB_WEB_DIST: join('/b', 'web'),
  });
});
