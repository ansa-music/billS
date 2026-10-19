/**
 * Types for the HUB modules the in-browser demo imports (`@ts-hub/*` is aliased to
 * apps/hub/src in vite.config.ts). The HUB is typechecked by its own package; here
 * only the few entry points the demo calls are described.
 */

declare module '@ts-hub/db.ts' {
  export function openDb(path: string, now?: number): import('./shims/sqlite.ts').DatabaseSync;
}

declare module '@ts-hub/clock.ts' {
  export const systemClock: { now(): number };
}

declare module '@ts-hub/seed.ts' {
  export function seedDemo(db: unknown, now: number, timezone?: string): boolean;
}

declare module '@ts-hub/demo-license.ts' {
  export const DEMO_LICENSE_KEYS: Readonly<Record<string, string>>;
  export function installDemoLicense(license: unknown, now: number): Promise<boolean>;
}

declare module '@ts-hub/lamps/simulator.ts' {
  export class SimulatorLampDriver {
    constructor(options?: { latencyMs?: number });
  }
}

declare module '@ts-hub/power/ups.ts' {
  export class SimulatorUps {}
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
      ups?: unknown;
      /** Omitted: licenses are not enforced. */
      license?: { mode: 'enforce' | 'off'; publicKeys: Readonly<Record<string, string>>; hubId?: string };
      demo?: boolean;
    });
    readonly license: { init(): Promise<void> };
    readonly events: {
      on(event: 'changed', listener: (e: ChangeEvent) => void): unknown;
      off(event: 'changed', listener: (e: ChangeEvent) => void): unknown;
    };
    readonly auth: {
      issueFixedKeys(keys: ReadonlyArray<{ roles: readonly string[]; name: string; key: string }>): unknown[];
    };
    start(): void;
    close(): void;
  }
}

declare module '@ts-hub/http/app.ts' {
  export function buildApp(
    hub: import('@ts-hub/hub.ts').Hub,
    options: {
      simulator?: unknown;
      upsSimulator?: unknown;
      logger?: boolean;
      dbPath?: string;
      startedAt?: number;
      version?: { version: string; gitSha: string | null };
      demo?: { resetAt: () => number };
    },
  ): import('./mini-fastify.ts').MiniFastify;
}
