/**
 * The suites that read money, checks, orders and shifts, run again with lean reads switched on (Harness passes
 * `leanReads: true` when HUB_TEST_LEAN=1; src/lean.ts): the cloud café must see exactly what a club PC sees.
 */
import { spawnSync } from 'node:child_process';

const suites = ['cash', 'counter', 'orders-checks', 'bar', 'prepaid', 'prepaid-extend', 'reports', 'archive', 'loyalty', 'guard', 'stock', 'hall', 'sessions'];
const files = suites.map((s) => `test/${s}.test.ts`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: 'inherit',
  env: { ...process.env, HUB_TEST_LEAN: '1' },
});
process.exit(result.status ?? 1);
