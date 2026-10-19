import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zonedParts } from '@bills/domain';
import { loadConfig } from './config.ts';

/**
 * Public demo HUB (`npm run demo -w @bills/hub`, Render service `ts-demo-hub`).
 *
 * Runs src/main.ts as a child with HUB_DEMO=1 on a fresh database and restarts
 * it every night at HUB_DEMO_RESET_HOUR (default 4) club time, wiping the
 * database first — whatever visitors did is gone by morning. The child gets the
 * reset time in HUB_DEMO_RESET_AT and reports it on GET /api/demo.
 */

const STEP_MS = 15 * 60 * 1000;

/** Next instant after `now` when the club's wall clock shows hour:00. */
export function nextDemoReset(now: number, timeZone: string, hour: number): number {
  let t = Math.floor(now / STEP_MS) * STEP_MS + STEP_MS;
  for (let i = 0; i < 4 * 24 * 3; i++, t += STEP_MS) {
    if (zonedParts(t, timeZone).minuteOfDay === hour * 60) return t;
  }
  return now + 24 * 60 * 60 * 1000; // a zone that skips that hour today: just wait a day
}

/** Removes the SQLite database with its WAL files and the bootstrap key file next to it. */
export function wipeDemoDatabase(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  rmSync(join(dirname(dbPath), 'first-run-keys.txt'), { force: true });
}

async function supervise(): Promise<void> {
  const config = loadConfig();
  const resetHour = Number(process.env.HUB_DEMO_RESET_HOUR ?? 4);
  if (!Number.isInteger(resetHour) || resetHour < 0 || resetHour > 23) throw new Error('HUB_DEMO_RESET_HOUR must be 0…23');
  const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));
  const execArgv = process.execArgv.filter((a) => !a.startsWith('--watch'));
  let stopping = false;
  let child: ReturnType<typeof spawn> | null = null;

  const stop = () => {
    stopping = true;
    child?.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  while (!stopping) {
    wipeDemoDatabase(config.dbPath);
    const resetAt = nextDemoReset(Date.now(), config.demoTimezone, resetHour);
    console.log(`[demo] fresh demo club; next reset at ${new Date(resetAt).toISOString()}`);
    child = spawn(process.execPath, [...execArgv, mainPath], {
      env: { ...process.env, HUB_DEMO: '1', HUB_DEMO_RESET_AT: String(resetAt) },
      stdio: 'inherit',
    });
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child?.kill('SIGTERM'), Math.max(0, resetAt - Date.now()));
    const [code] = (await exited) as [number | null];
    clearTimeout(timer);
    if (stopping) break;
    if (Date.now() < resetAt - 1000) {
      // Crashed before the reset: start over after a pause instead of spinning.
      console.error(`[demo] HUB exited with code ${code}; restarting in 5 s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await supervise();
