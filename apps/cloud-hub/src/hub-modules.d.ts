/**
 * Types for the HUB modules the cloud HUB imports (`@ts-hub/*` is aliased to apps/hub/src in build.mjs).
 * The HUB is typechecked by its own package, under Node's types; here only the entry points the Durable
 * Object calls are described (the same way apps/web/src/demo-hub/hub-modules.d.ts does for the trial).
 */

declare module 'sql.js/dist/sql-wasm-browser.js' {
  import initSqlJs from 'sql.js';
  export default initSqlJs;
}

/** sql.js's WebAssembly, compiled at deploy time (wrangler's CompiledWasm rule; build.mjs copies the file). */
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

declare module 'virtual:hub-schema' {
  /** The HUB's schema after all migrations, made at build time (scripts/hub-schema.mjs). */
  export const HUB_SCHEMA: import('./importer.ts').SchemaTemplate;
}

declare module 'virtual:hub-migrations' {
  /** File name → SQL of every apps/hub/src/migrations/NNN_name.sql, bundled by build.mjs. */
  export const MIGRATIONS: Readonly<Record<string, string>>;
  /** The newest migration number in this build. */
  export const NEWEST_MIGRATION: number;
}

declare module '@ts-hub/db.ts' {
  export function openDb(path: string, now?: number): import('./shims/sqlite.ts').DatabaseSync;
  export function migrate(db: import('./shims/sqlite.ts').DatabaseSync, now: number): void;
}

declare module '@ts-hub/idempotency.ts' {
  export function purgeIdempotencyKeys(db: import('./shims/sqlite.ts').DatabaseSync, olderThan: number): number;
}

declare module '@ts-hub/clock.ts' {
  export const systemClock: { now(): number };
}

declare module '@ts-hub/trial.ts' {
  export function trialKey(random?: () => number): string;
  export function setupTrialClub(
    hub: import('@ts-hub/hub.ts').Hub,
    setup: { venue: string; managerName: string; key: string; timezone: string; withMenu: boolean; now: number },
  ): boolean;
}

declare module '@ts-hub/lamps/simulator.ts' {
  export class SimulatorLampDriver {
    constructor(options?: { latencyMs?: number });
  }
}

declare module '@ts-hub/hub.ts' {
  export interface ChangeEvent {
    kind: string;
    tableId?: string;
  }
  export class Hub {
    constructor(deps: {
      db: unknown;
      clock: { now(): number };
      lampDriver: unknown;
      license?: {
        mode: 'enforce' | 'off';
        publicKeys: Readonly<Record<string, string>>;
        hubId?: string;
        terms?: (now: number) => import('@bills/domain').LicenseStatus;
      };
      guardIntervalMs?: number;
      reconcileIntervalMs?: number;
      monitorOptions?: { intervalMs?: number };
      timers?: 'own' | 'external';
      leanReads?: boolean;
      outbox?: boolean;
    });
    readonly license: { init(): Promise<void>; readonly hubId: string; status(): import('@bills/domain').LicenseStatus };
    readonly events: {
      on(event: 'changed', listener: (e: ChangeEvent) => void): unknown;
      off(event: 'changed', listener: (e: ChangeEvent) => void): unknown;
      changed(e: ChangeEvent): void;
    };
    readonly auth: {
      issueFixedKeys(keys: ReadonlyArray<{ roles: readonly string[]; name: string; key: string }>): unknown[];
      resolve(token: string): { actor: { id: string | null; name: string; roles: readonly string[] } } | null;
      revokeKey(keyId: string, actor: { id: string | null; name: string; role: string; roles: string[] }): unknown;
    };
    readonly settings: {
      updateClub(input: { settings?: { display?: { showRoster?: boolean } }; actor: string }): unknown;
    };
    state(): { club: { id: string; name: string }; serverNow: number };
    start(): void;
    tick(now?: number): string[];
    nextWakeAt(now?: number): number | null;
    close(): void;
  }
}

declare module '@ts-hub/http/app.ts' {
  export function buildApp(
    hub: import('@ts-hub/hub.ts').Hub,
    options: {
      logger?: boolean;
      dbPath?: string;
      startedAt?: number;
      version?: { version: string; gitSha: string | null };
      corsOrigins?: readonly string[];
    },
  ): import('../../web/src/demo-hub/mini-fastify.ts').MiniFastify;
}
