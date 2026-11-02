/**
 * A trial coffee shop moves into its cloud café in small steps, so every step stays far below the 10 ms of CPU a
 * Workers Free request may use, and an interrupted move simply goes on where it stopped.
 *
 *   upload   the request body (`{snapshot: base64, …}`) arrives as bytes; the base64 is cut into PART_CHARS parts
 *            and stored as it is — no text decoding, no JSON parse of megabytes, no base64 decoding yet
 *   decode   one part per step: base64 → bytes
 *   open     the bytes open in sql.js (SQLite in WebAssembly — a Durable Object cannot ATTACH a file); checked
 *            (a TS café, not from a newer TS), tables listed parents-first
 *   plan     the columns and size of PLAN_PER_STEP tables per step
 *   ddl      tables and indexes are created, a batch per step (triggers wait for the end)
 *   rows     ROWS_PER_STEP rows per step (or fewer when they are big), table by table, rowids kept
 *   finish   triggers and AUTOINCREMENT counters; then the café's Durable Object opens its HUB on the copy
 *
 * Every step is one storage transaction together with its progress, so a step either happened or did not, and
 * running a step twice (a lost answer, an alarm and a request at once) cannot copy a row twice. The state lives in
 * `ts_import_state`, the parts in `ts_import_part`; both go when the café is ready.
 *
 * A new café goes the same way without a copy (`startTemplate`): the HUB's schema made at build time
 * (scripts/hub-schema.mjs) is created in `ddl` steps, its few rows are written in `finish`.
 *
 * Not copied: `outbox` (events queued for a cloud sync the café never had — the cloud café keeps none) and
 * `idempotency_keys` (retries of the trial's own requests). Their tables are created empty.
 */
import type { CafeTermsInput } from './terms.ts';
import { CloudError } from './errors.ts';
import type { SqlStorageLike } from './shims/sqlite.ts';
import type { Cell, SqlJs, SqlJsDatabase } from './sqljs.ts';
import { isCafeTable, q, SQLITE_HEADER } from './sqljs.ts';

/** Base64 characters per stored part (a multiple of 4, so every part decodes on its own; < 2 MB per value). */
export const PART_CHARS = 512 * 1024;
/** Rows per `rows` step… */
export const ROWS_PER_STEP = 120;
/** …in a step that first had to open the copy again (the café's object restarted meanwhile). */
const ROWS_AFTER_REOPEN = 20;
/** Tables described per `plan` step. */
const PLAN_PER_STEP = 12;
/** …or fewer, once this many bytes of values were copied. */
export const BYTES_PER_STEP = 256 * 1024;
/** CREATE statements per `ddl` step. */
export const DDL_PER_STEP = 24;
/** Steps that failed in a row before the move gives up. */
const MAX_FAILURES = 3;
const SKIP_ROWS = new Set(['outbox', 'idempotency_keys']);

export type ImportPhase = 'decode' | 'open' | 'plan' | 'ddl' | 'rows' | 'finish' | 'done' | 'failed';

/** The HUB's schema after its migrations (scripts/hub-schema.mjs, `virtual:hub-schema`). */
export interface SchemaTemplate {
  ddl: string[];
  triggers: string[];
  seed: Array<{ table: string; cols: string[]; rows: Cell[][] }>;
  newest: number;
}

/** A new café (POST /admin/cafes): what the finishing step sets up once the schema stands. */
export interface ProvisionOptions {
  venue: string;
  managerName: string;
  managerKey: string;
  withMenu: boolean;
  timezone: string;
}

export interface ImportOptions {
  /** Give the director a new six-digit key as well (the old keys keep working either way). */
  newManagerKey?: boolean;
  managerName?: string;
  /** Terms for the café; default: active for NEW_CAFE_DAYS. */
  terms?: CafeTermsInput;
  /** Not a move: a new café from the schema template. */
  provision?: ProvisionOptions;
}

interface TablePlan {
  name: string;
  cols: string[];
  /** A rowid table whose rowid is not one of `cols` (no INTEGER PRIMARY KEY): the rowid is copied too. */
  copyRowid: boolean;
  /** WITHOUT ROWID: paged by OFFSET. */
  noRowid: boolean;
  total: number;
  done: number;
  /** The last rowid copied (rowid tables). */
  last: number;
  skip: boolean;
}

export interface ImportState {
  id: string;
  phase: ImportPhase;
  startedAt: number;
  parts: number;
  decoded: number;
  bytes: number;
  /** Café tables, parents first (`open`); described one batch at a time into `tables` (`plan`). */
  order: string[];
  tables: TablePlan[];
  table: number;
  /** CREATE statements for the `ddl` phase and triggers for `finish`. */
  ddl: string[];
  ddlDone: number;
  triggers: string[];
  sequences: Array<[string, number]>;
  /** Rows written in `finish` (the schema template's). */
  seed: SchemaTemplate['seed'];
  rows: number;
  totalRows: number;
  /** Rows written into the café so far (Cloudflare's unit: index rows count too). */
  written?: number;
  fromMigration: number;
  venue: string | null;
  steps: number;
  failures: number;
  error: string | null;
  options: ImportOptions;
}

/** What admin calls see about a move in progress. */
export interface ImportProgress {
  status: 'importing' | 'ready' | 'failed';
  phase: ImportPhase;
  /** Rough share done, 0…1. */
  done: number;
  rows: number;
  totalRows: number;
  /** Rows written into the café so far (Cloudflare bills them; index rows count too). */
  written: number;
  bytes: number;
  steps: number;
  error: string | null;
}

type Bind = ArrayBuffer | string | number | null;

function toBinding(v: Cell): Bind {
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  return v;
}

function sizeOf(v: Cell): number {
  if (v === null) return 1;
  if (typeof v === 'number') return 8;
  if (typeof v === 'string') return v.length;
  return v.byteLength;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SNAPSHOT_KEY = new TextEncoder().encode('"snapshot"');

/** Where `"snapshot"` starts in the body, by bytes (no text decoding of megabytes). */
function findKey(body: Uint8Array): number {
  for (let at = body.indexOf(QUOTE); at >= 0; at = body.indexOf(QUOTE, at + 1)) {
    let same = true;
    for (let i = 1; i < SNAPSHOT_KEY.length && same; i++) same = body[at + i] === SNAPSHOT_KEY[i];
    if (same) return at;
  }
  return -1;
}

const isSpace = (b: number | undefined) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

/**
 * The parts of a JSON body as bytes: the snapshot's base64 (ASCII, never decoded or parsed here) and the small
 * fields around it, parsed as JSON.
 */
export function splitImportBody(body: Uint8Array): { base64: Uint8Array; rest: Record<string, unknown> } {
  const key = findKey(body);
  if (key < 0) throw new CloudError(400, 'SNAPSHOT_MISSING', 'Нет копии кофейни: поле snapshot (base64 файла SQLite).');
  let start = key + SNAPSHOT_KEY.length;
  while (isSpace(body[start])) start++;
  if (body[start] !== 0x3a) throw new CloudError(400, 'BAD_JSON', 'Тело запроса — не JSON');
  start++;
  while (isSpace(body[start])) start++;
  if (body[start] !== QUOTE) throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни повреждена: это не base64.');
  start++;
  const end = body.indexOf(QUOTE, start);
  if (end < 0) throw new CloudError(400, 'BAD_JSON', 'Тело запроса — не JSON');
  let base64 = body.subarray(start, end);
  // JSON may escape «/» as «\/» or wrap lines with «\n»; base64 itself has neither (rare: the slow way).
  if (base64.indexOf(BACKSLASH) >= 0) {
    const text = new TextDecoder().decode(base64).replace(/\\\//g, '/').replace(/\\[nr]/g, '');
    base64 = new TextEncoder().encode(text);
  }
  const dec = new TextDecoder();
  let rest: Record<string, unknown>;
  try {
    rest = JSON.parse(`${dec.decode(body.subarray(0, key))}"snapshot":null${dec.decode(body.subarray(end + 1))}`) as Record<string, unknown>;
  } catch {
    throw new CloudError(400, 'BAD_JSON', 'Тело запроса — не JSON');
  }
  const tail = dec.decode(base64.subarray(Math.max(0, base64.length - 8)));
  if (!base64.length || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(tail)) {
    throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни повреждена: это не base64.');
  }
  return { base64, rest };
}

/** base64 (ASCII bytes) → bytes: the engine's own decoder where it has one (Uint8Array.fromBase64), else atob. */
export function fromBase64(ascii: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(ascii);
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (native) return native(text);
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The small fields of an import body that mean something (terms are checked by the caller). */
export function importOptionsOf(rest: Record<string, unknown>): ImportOptions {
  return {
    ...(rest.newManagerKey === true ? { newManagerKey: true } : {}),
    ...(typeof rest.managerName === 'string' ? { managerName: rest.managerName } : {}),
    ...(rest.terms !== undefined && rest.terms !== null ? { terms: rest.terms as CafeTermsInput } : {}),
  };
}

export class Importer {
  readonly #storage: SqlStorageLike;
  readonly #loadSqlJs: () => Promise<SqlJs>;
  readonly #newestMigration: number;
  /** The opened copy, kept between steps while this object lives (reopened from the parts otherwise). */
  #open: { id: string; db: SqlJsDatabase } | null = null;

  /** `newestMigration`: this build's newest HUB migration — a copy made by a newer TS is refused. */
  constructor(storage: SqlStorageLike, loadSqlJs: () => Promise<SqlJs>, newestMigration: number) {
    this.#storage = storage;
    this.#loadSqlJs = loadSqlJs;
    this.#newestMigration = newestMigration;
  }

  /** Rows written by the current step (what Cloudflare bills; index rows included). */
  #written = 0;

  #exec(sql: string, ...bindings: Bind[]): Array<Record<string, unknown>> {
    const cursor = this.#storage.sql.exec(sql, ...bindings);
    const rows = cursor.toArray() as Array<Record<string, unknown>>;
    this.#written += cursor.rowsWritten;
    return rows;
  }

  #ensureTables(): void {
    this.#exec('CREATE TABLE IF NOT EXISTS ts_import_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)');
    this.#exec('CREATE TABLE IF NOT EXISTS ts_import_part (n INTEGER PRIMARY KEY, b64 BLOB, bin BLOB)');
  }

  /** The move in progress (or finished, until `clear()`), or null. */
  state(): ImportState | null {
    const has = this.#exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ts_import_state'").length > 0;
    if (!has) return null;
    const row = this.#exec('SELECT state FROM ts_import_state WHERE id = 1')[0];
    return row ? (JSON.parse(String(row.state)) as ImportState) : null;
  }

  #save(state: ImportState): void {
    this.#exec('INSERT OR REPLACE INTO ts_import_state (id, state) VALUES (1, ?)', JSON.stringify(state));
  }

  /** Stores the snapshot (base64) in parts and starts the move. One request; no decoding, no SQL of the café. */
  upload(base64: Uint8Array, options: ImportOptions, now: number, id: string): ImportState {
    return this.#store(base64, false, options, now, id);
  }

  /** The same with the SQLite file itself (no base64): nothing to decode, the move starts at `open`. */
  uploadRaw(file: Uint8Array, options: ImportOptions, now: number, id: string): ImportState {
    if (file.length < 100 || new TextDecoder().decode(file.subarray(0, 16)) !== SQLITE_HEADER) {
      throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни повреждена: это не база SQLite.');
    }
    return this.#store(file, true, options, now, id);
  }

  #store(data: Uint8Array, raw: boolean, options: ImportOptions, now: number, id: string): ImportState {
    const parts = Math.ceil(data.length / PART_CHARS);
    if (parts === 0) throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни пуста.');
    const state: ImportState = {
      ...this.#emptyState(id, now, options),
      phase: raw ? 'open' : 'decode',
      parts,
      decoded: raw ? parts : 0,
      bytes: raw ? data.length : 0,
    };
    this.#storage.transactionSync(() => {
      this.#ensureTables();
      this.#exec('DELETE FROM ts_import_part');
      for (let n = 0; n < parts; n++) {
        const part = data.slice(n * PART_CHARS, (n + 1) * PART_CHARS).buffer as ArrayBuffer;
        this.#exec(`INSERT INTO ts_import_part (n, ${raw ? 'bin' : 'b64'}) VALUES (?, ?)`, n, part);
      }
      this.#save(state);
    });
    return state;
  }

  /** A new café: the schema template in `ddl` steps, its rows in `finish` (no copy to upload or open). */
  startTemplate(template: SchemaTemplate, options: ImportOptions, now: number, id: string): ImportState {
    const state: ImportState = {
      ...this.#emptyState(id, now, options),
      phase: 'ddl',
      ddl: template.ddl,
      triggers: template.triggers,
      seed: template.seed,
      fromMigration: template.newest,
    };
    this.#storage.transactionSync(() => {
      this.#ensureTables();
      this.#exec('DELETE FROM ts_import_part');
      this.#save(state);
    });
    return state;
  }

  #emptyState(id: string, now: number, options: ImportOptions): ImportState {
    return {
      id,
      phase: 'decode',
      startedAt: now,
      parts: 0,
      decoded: 0,
      bytes: 0,
      order: [],
      tables: [],
      table: 0,
      ddl: [],
      ddlDone: 0,
      triggers: [],
      sequences: [],
      seed: [],
      rows: 0,
      totalRows: 0,
      fromMigration: 0,
      venue: null,
      steps: 0,
      failures: 0,
      error: null,
      options,
    };
  }

  /**
   * One step of the move. Returns the new state; `done` once the copy is complete (the caller then opens the HUB
   * on it and calls `clear()`). A failing step is rolled back; after MAX_FAILURES in a row, or at once for a
   * snapshot that is not a TS café, the state turns `failed` with the reason.
   */
  async step(): Promise<ImportState> {
    const state = this.state();
    if (!state) throw new CloudError(404, 'IMPORT_NOT_FOUND', 'Переезда кофейни нет.');
    if (state.phase === 'done' || state.phase === 'failed') return state;
    // sql.js loads before the synchronous part (the only await of a step), only for the steps that read the copy.
    const SQL = state.phase === 'open' || state.phase === 'plan' || (state.phase === 'rows' && state.tables.length > 0) ? await this.#loadSqlJs() : null;
    try {
      return this.#storage.transactionSync(() => {
        this.#written = 0;
        const next = this.#run(state, SQL);
        next.written = (next.written ?? 0) + this.#written;
        next.steps++;
        next.failures = 0;
        this.#save(next);
        return next;
      });
    } catch (err) {
      const fatal = err instanceof CloudError && err.status < 500;
      const failed: ImportState = {
        ...state,
        failures: state.failures + 1,
        error: err instanceof Error ? err.message : String(err),
      };
      if (fatal || failed.failures >= MAX_FAILURES) failed.phase = 'failed';
      this.#save(failed);
      if (failed.phase === 'failed') this.#open = null;
      return failed;
    }
  }

  #run(state: ImportState, SQL: SqlJs | null): ImportState {
    switch (state.phase) {
      case 'decode':
        return this.#decode(state);
      case 'open':
        return this.#openPhase(state, SQL!);
      case 'plan':
        return this.#plan(state, SQL!);
      case 'ddl':
        return this.#ddl(state);
      case 'rows':
        return this.#rows(state, SQL);
      case 'finish':
        return this.#finish(state);
      default:
        return state;
    }
  }

  #decode(state: ImportState): ImportState {
    const n = state.decoded;
    const row = this.#exec('SELECT b64 FROM ts_import_part WHERE n = ?', n)[0];
    if (!row || !(row.b64 instanceof ArrayBuffer)) throw new CloudError(500, 'IMPORT_PART_MISSING', `Нет части ${n + 1} копии.`);
    let bytes: Uint8Array;
    try {
      bytes = fromBase64(new Uint8Array(row.b64));
    } catch {
      throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни повреждена: это не base64.');
    }
    if (n === 0 && (bytes.length < 100 || new TextDecoder().decode(bytes.subarray(0, 16)) !== SQLITE_HEADER)) {
      throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни повреждена: это не база SQLite.');
    }
    this.#exec('UPDATE ts_import_part SET bin = ?, b64 = NULL WHERE n = ?', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, n);
    const decoded = n + 1;
    return { ...state, decoded, bytes: state.bytes + bytes.length, phase: decoded >= state.parts ? 'open' : 'decode' };
  }

  /** The copy in sql.js: from memory while this object lives, else put together from the decoded parts. */
  #source(state: ImportState, SQL: SqlJs): SqlJsDatabase {
    return this.#sourceOf(state, SQL).db;
  }

  #sourceOf(state: ImportState, SQL: SqlJs): { db: SqlJsDatabase; reopened: boolean } {
    if (this.#open?.id === state.id) return { db: this.#open.db, reopened: false };
    this.#open?.db.close();
    this.#open = null;
    const bytes = new Uint8Array(state.bytes);
    let at = 0;
    for (const r of this.#exec('SELECT bin FROM ts_import_part ORDER BY n')) {
      const part = new Uint8Array(r.bin as ArrayBuffer);
      bytes.set(part, at);
      at += part.byteLength;
    }
    let db: SqlJsDatabase;
    try {
      db = new SQL.Database(bytes);
      db.exec('SELECT count(*) FROM sqlite_master');
    } catch {
      throw new CloudError(400, 'SNAPSHOT_INVALID', 'Копия кофейни не открывается.');
    }
    this.#open = { id: state.id, db };
    return { db, reopened: true };
  }

  #openPhase(state: ImportState, SQL: SqlJs): ImportState {
    const src = this.#source(state, SQL);
    const scalar = (sql: string): Cell => (src.exec(sql)[0]?.values[0]?.[0] ?? null) as Cell;
    if (scalar("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'") !== 1) {
      throw new CloudError(400, 'SNAPSHOT_INVALID', 'Это не копия кофейни TS.');
    }
    const fromMigration = Number(scalar('SELECT max(version) FROM schema_migrations') ?? 0);
    if (fromMigration > this.#newestMigration) {
      throw new CloudError(409, 'SNAPSHOT_NEWER', 'Копия сделана более новой версией TS, чем облачная касса. Обновите облачную кассу.');
    }
    const venue = scalar('SELECT name FROM clubs ORDER BY created_at LIMIT 1');
    const objects = (src.exec("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid")[0]?.values ?? []) as Array<
      [string, string, string, string]
    >;
    const tables = objects.filter(([type, name]) => type === 'table' && isCafeTable(name));
    const names = new Set(tables.map(([, name]) => name));
    const indexes = objects.filter(([type, , tbl]) => type === 'index' && names.has(tbl));
    const triggers = objects.filter(([type, , tbl]) => type === 'trigger' && names.has(tbl)).map(([, , , sql]) => sql);

    // Parents before children: across steps a child row must find its parent already copied.
    const parents = new Map<string, Set<string>>();
    for (const [, name] of tables) {
      const fk = src.exec(`PRAGMA foreign_key_list(${q(name)})`)[0];
      const at = fk?.columns.indexOf('table') ?? -1;
      parents.set(name, new Set((fk?.values ?? []).map((r) => String(r[at])).filter((p) => p !== name && names.has(p))));
    }
    const ordered: string[] = [];
    const placed = new Set<string>();
    let progress = true;
    while (ordered.length < tables.length && progress) {
      progress = false;
      for (const [, name] of tables) {
        if (placed.has(name)) continue;
        if ([...parents.get(name)!].every((p) => placed.has(p))) {
          ordered.push(name);
          placed.add(name);
          progress = true;
        }
      }
    }
    // A cycle (none in the HUB's schema): the rest in file order; deferred keys cover a cycle within one step.
    for (const [, name] of tables) if (!placed.has(name)) ordered.push(name);
    const sqlOf = new Map(tables.map(([, name, , sql]) => [name, sql]));
    const seq =
      (src.exec("SELECT name, seq FROM sqlite_sequence WHERE name IN (SELECT name FROM sqlite_master WHERE type = 'table')")[0]?.values as
        | Array<[string, number]>
        | undefined) ?? [];
    return {
      ...state,
      phase: 'plan',
      fromMigration,
      venue: typeof venue === 'string' ? venue : null,
      order: ordered,
      tables: [],
      ddl: [...ordered.map((n) => sqlOf.get(n)!), ...indexes.map(([, , , sql]) => sql)],
      ddlDone: 0,
      triggers,
      sequences: seq.filter(([name]) => names.has(String(name)) && !SKIP_ROWS.has(String(name))).map(([n, v]) => [String(n), Number(v)]),
    };
  }

  #plan(state: ImportState, SQL: SqlJs): ImportState {
    const src = this.#source(state, SQL);
    const scalar = (sql: string): Cell => (src.exec(sql)[0]?.values[0]?.[0] ?? null) as Cell;
    const batch = state.order.slice(state.tables.length, state.tables.length + PLAN_PER_STEP);
    const plans: TablePlan[] = batch.map((name) => {
      const info = src.exec(`PRAGMA table_xinfo(${q(name)})`)[0];
      const col = (c: string) => info?.columns.indexOf(c) ?? -1;
      const rows = info?.values ?? [];
      // Real columns only (no hidden or generated ones).
      const cols = rows.filter((r) => Number(r[col('hidden')]) === 0).map((r) => String(r[col('name')]));
      const pk = rows.filter((r) => Number(r[col('pk')]) > 0);
      const intPk = pk.length === 1 && String(pk[0]![col('type')]).toUpperCase() === 'INTEGER';
      const noRowid = /\bWITHOUT\s+ROWID\b/i.test(state.ddl[state.order.indexOf(name)] ?? '');
      const skip = SKIP_ROWS.has(name);
      // max(rowid) is one seek, count(*) a scan: the total only feeds the progress and ends a table early.
      const total = skip ? 0 : Number(scalar(noRowid ? `SELECT count(*) FROM ${q(name)}` : `SELECT max(rowid) FROM ${q(name)}`) ?? 0);
      return { name, cols, copyRowid: !noRowid && !intPk, noRowid, total, done: 0, last: 0, skip };
    });
    const tables = [...state.tables, ...plans];
    const planned = tables.length >= state.order.length;
    return { ...state, tables, totalRows: tables.reduce((n, t) => n + t.total, 0), phase: planned ? 'ddl' : 'plan' };
  }

  #ddl(state: ImportState): ImportState {
    const end = Math.min(state.ddl.length, state.ddlDone + DDL_PER_STEP);
    for (let i = state.ddlDone; i < end; i++) this.#exec(state.ddl[i]!);
    return { ...state, ddlDone: end, phase: end >= state.ddl.length ? 'rows' : 'ddl' };
  }

  #rows(state: ImportState, SQL: SqlJs | null): ImportState {
    if (!SQL || state.tables.length === 0) return { ...state, phase: 'finish' };
    const { db: src, reopened } = this.#sourceOf(state, SQL);
    const tables = state.tables.map((t) => ({ ...t }));
    let table = state.table;
    // Opening the copy again took most of this step's budget.
    let rows = reopened ? ROWS_PER_STEP - ROWS_AFTER_REOPEN : 0;
    const before = rows;
    let bytes = 0;
    // Children inserted in this step before their parents (a cycle) are checked at commit.
    this.#exec('PRAGMA defer_foreign_keys = ON');
    while (table < tables.length && rows < ROWS_PER_STEP && bytes < BYTES_PER_STEP) {
      const t = tables[table]!;
      if (t.skip || t.done >= t.total) {
        table++;
        continue;
      }
      const cols = t.cols.map(q).join(', ');
      const limit = ROWS_PER_STEP - rows;
      const select = t.noRowid
        ? `SELECT ${cols} FROM ${q(t.name)} LIMIT ${limit} OFFSET ${t.done}`
        : `SELECT rowid, ${cols} FROM ${q(t.name)} WHERE rowid > ${t.last} ORDER BY rowid LIMIT ${limit}`;
      const target = `INSERT INTO ${q(t.name)} (${t.copyRowid ? 'rowid, ' : ''}${cols}) VALUES (${[...(t.copyRowid ? ['?'] : []), ...t.cols.map(() => '?')].join(', ')})`;
      const stmt = src.prepare(select);
      let got = 0;
      try {
        while (rows < ROWS_PER_STEP && bytes < BYTES_PER_STEP && stmt.step()) {
          const values = stmt.get() as Cell[];
          const rowid = t.noRowid ? null : Number(values[0]);
          const cells = t.noRowid ? values : values.slice(1);
          this.#exec(target, ...(t.copyRowid ? [rowid] : []), ...cells.map(toBinding));
          for (const c of cells) bytes += sizeOf(c);
          if (rowid !== null) t.last = rowid;
          t.done++;
          rows++;
          got++;
        }
      } finally {
        stmt.free();
      }
      // Fewer rows than counted (the table ended early): it is done.
      if (got === 0 || (got < limit && rows < ROWS_PER_STEP && bytes < BYTES_PER_STEP)) {
        t.done = t.total;
        table++;
      }
    }
    while (table < tables.length && (tables[table]!.skip || tables[table]!.done >= tables[table]!.total)) table++;
    return { ...state, tables, table, rows: state.rows + rows - before, phase: table >= tables.length ? 'finish' : 'rows' };
  }

  #finish(state: ImportState): ImportState {
    for (const { table, cols, rows } of state.seed) {
      const insert = `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      for (const r of rows) this.#exec(insert, ...r.map(toBinding));
    }
    for (const sql of state.triggers) this.#exec(sql);
    // AUTOINCREMENT counters, so new ids continue after the copied ones (even past deleted ones).
    for (const [name, value] of state.sequences) {
      try {
        this.#exec('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?', value, name);
      } catch {
        // No sqlite_sequence yet: no AUTOINCREMENT row was copied.
      }
    }
    this.#open?.db.close();
    this.#open = null;
    return { ...state, phase: 'done' };
  }

  /** The move is over (ready or given up): its parts and state go. */
  clear(): void {
    this.#open?.db.close();
    this.#open = null;
    this.#exec('DROP TABLE IF EXISTS ts_import_part');
    this.#exec('DROP TABLE IF EXISTS ts_import_state');
  }
}

export function importProgress(state: ImportState): ImportProgress {
  const weights = { decode: 0.05, open: 0.06, plan: 0.07, ddl: 0.1, rows: 0.95, finish: 0.97, done: 1, failed: 0 } as const;
  let done: number = weights[state.phase];
  if (state.phase === 'decode') done = (0.05 * state.decoded) / Math.max(1, state.parts);
  if (state.phase === 'rows') done = 0.1 + 0.85 * (state.rows / Math.max(1, state.totalRows));
  return {
    // `done` is the copy, not yet the café: the Durable Object's last step opens the HUB on it (then `ready`).
    status: state.phase === 'failed' ? 'failed' : 'importing',
    phase: state.phase,
    done: Math.round(done * 100) / 100,
    rows: state.rows,
    totalRows: state.totalRows,
    written: state.written ?? 0,
    bytes: state.bytes,
    steps: state.steps,
    error: state.phase === 'failed' ? state.error : null,
  };
}
