/**
 * The few Cloudflare Workers / Durable Object APIs this Worker uses, on top of the DOM library.
 * (@cloudflare/workers-types replaces the DOM globals wholesale, and packages/domain is written for the
 * DOM and Node; these declarations follow the official ones for exactly the calls made here.)
 */

type SqlStorageValue = ArrayBuffer | string | number | null;

interface SqlStorageCursor<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>> extends Iterable<T> {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly columnNames: string[];
  toArray(): T[];
  one(): T;
}

interface SqlStorage {
  exec<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): SqlStorageCursor<T>;
  /** Bytes the object's SQLite database takes (what Cloudflare bills as stored data). */
  readonly databaseSize: number;
}

interface DurableObjectStorage {
  readonly sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace<_T = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ExportedHandler<Env = unknown> {
  fetch?(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

/** Hibernation API: what a socket keeps across the object's sleep. */
interface WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface ResponseInit {
  /** The client end of a WebSocketPair, with status 101. */
  webSocket?: WebSocket | null;
}

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(): void | Promise<void>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  }
}
