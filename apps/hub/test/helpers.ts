import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ManualClock } from '../src/clock.ts';
import type { Db } from '../src/db.ts';
import { all, openDb } from '../src/db.ts';
import { buildApp } from '../src/http/app.ts';
import { Hub } from '../src/hub.ts';
import { SimulatorLampDriver } from '../src/lamps/simulator.ts';
import { seedDemo } from '../src/seed.ts';
import type { HubState, SessionView } from '../src/views.ts';

/** Monday 2026-10-12, 12:00 in Almaty (UTC+5): the base rate of the demo tariff applies. */
export const MONDAY_NOON = Date.UTC(2026, 9, 12, 7, 0);

export const FAST_LAMPS = { attemptTimeoutMs: 200, retryDelaysMs: [10, 10] };

export interface TestHub {
  dbPath: string;
  db: Db;
  clock: ManualClock;
  driver: SimulatorLampDriver;
  hub: Hub;
  app: FastifyInstance;
}

export class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'bills-hub-'));
  readonly dbPath = join(this.dir, 'hub.db');
  readonly clock = new ManualClock(MONDAY_NOON);
  current: TestHub | undefined;

  /** Starts a HUB on the same database file, like a process (re)start. */
  /** `secure` builds the app like main.ts does: tokens only, no X-Actor fallback. */
  async start(driver = new SimulatorLampDriver({ latencyMs: 5 }), options: { secure?: boolean } = {}): Promise<TestHub> {
    const db = openDb(this.dbPath, this.clock.now());
    seedDemo(db, this.clock.now());
    const hub = new Hub({ db, clock: this.clock, lampDriver: driver, lampOptions: FAST_LAMPS });
    const app = buildApp(hub, { simulator: driver, trustActorHeader: !options.secure });
    await app.ready();
    hub.start();
    this.current = { dbPath: this.dbPath, db, clock: this.clock, driver, hub, app };
    return this.current;
  }

  /** Stops without any cleanup of games or lamps — a crash or power cut. */
  async crash(): Promise<void> {
    const c = this.current;
    if (!c) return;
    c.hub.close();
    await c.app.close();
    c.db.close();
    this.current = undefined;
  }

  async dispose(): Promise<void> {
    await this.crash();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function tableId(t: TestHub, name: string): string {
  const table = t.hub.state().tables.find((x) => x.name === name);
  if (!table) throw new Error(`No table ${name}`);
  return table.id;
}

export function tableState(t: TestHub, name: string): HubState['tables'][number] {
  const table = t.hub.state().tables.find((x) => x.name === name);
  if (!table) throw new Error(`No table ${name}`);
  return table;
}

export async function waitFor<T>(probe: () => T | undefined | null | false, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function post(t: TestHub, url: string, body: object = {}, key: string = randomUUID()) {
  const res = await t.app.inject({
    method: 'POST',
    url,
    payload: body,
    headers: { 'idempotency-key': key, 'x-actor': encodeURIComponent('Кассир Айгерим') },
  });
  return { status: res.statusCode, body: res.json() as SessionView & { error?: { code: string } }, headers: res.headers };
}

export function sessionStatus(t: TestHub, id: string): string | undefined {
  return all<{ status: string }>(t.db, 'SELECT status FROM table_sessions WHERE id = ?', id)[0]?.status;
}

export function auditActions(t: TestHub): string[] {
  return all<{ action: string }>(t.db, 'SELECT action FROM audit_log ORDER BY id').map((r) => r.action);
}
