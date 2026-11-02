/**
 * Builds the TS screens (apps/web) for the cloud cash desk into apps/cloud-hub/web-dist, which the Worker
 * serves as static assets on the same origin as the café API (wrangler.toml [assets]).
 *
 *   node scripts/build-web.mjs            → VITE_CLOUD_HUB=1, API on the same site (/c/<café code>/api)
 *   VITE_CLOUD_HUB_URL=https://… node …   → screens hosted elsewhere (Pages) calling the Worker over CORS
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const outDir = fileURLToPath(new URL('../web-dist', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'build', '-w', '@bills/web', '--', '--outDir', outDir, '--emptyOutDir'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_CLOUD_HUB: '1' },
});
// Pages' catch-all rewrite: the Worker's assets do this with not_found_handling, and /c/* must reach the Worker.
rmSync(fileURLToPath(new URL('../web-dist/_redirects', import.meta.url)), { force: true });
process.exit(result.status ?? 1);
