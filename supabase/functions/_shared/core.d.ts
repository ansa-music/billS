// Types of the generated core.js (apps/cloud/src/edge/index.ts), the part the functions use.
// Kept by hand on purpose: the functions only touch this small surface.

export interface SqlDriver {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<number>;
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<{ query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>; release(err?: Error | boolean): void }>;
  end?(): Promise<void>;
}

/** Opaque here: built by `edgeContext`, passed to the handlers. */
export interface EdgeContext {
  db: SqlDriver;
  now: () => number;
  log: (message: string) => void;
}

export function createPostgresDriver(pool: PgPoolLike): SqlDriver;
export function edgeContext(db: SqlDriver, env: Record<string, string | undefined>): EdgeContext;
export function handleSync(req: Request, ctx: EdgeContext): Promise<Response>;
export function handleOwner(req: Request, ctx: EdgeContext): Promise<Response>;
export function handlePlatform(req: Request, ctx: EdgeContext): Promise<Response>;
export function handleInviteManager(req: Request, ctx: EdgeContext): Promise<Response>;
export function handleSignup(req: Request, ctx: EdgeContext): Promise<Response>;
export function handleNotify(req: Request, ctx: EdgeContext): Promise<Response>;
export function handleTelegram(req: Request, ctx: EdgeContext): Promise<Response>;
