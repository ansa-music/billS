/**
 * «Скачать копию» of a cloud café: the same file the browser trial's «Восстановить из копии» reads
 * (`{format: 'ts-trial-backup', version: 1, …, db: base64 of the SQLite file}`, apps/web demo-hub/trial-store.ts),
 * so a café's data is never locked in the cloud — any browser can open it with the free trial page.
 *
 * Built in small steps like the import (importer.ts), each far below the 10 ms of CPU of a Workers Free request:
 *
 *   start   the last rowid of every table is noted — the copy holds what was there when it started (orders
 *           taken meanwhile are in the next copy)
 *   schema  the café's tables and indexes into an empty sql.js database, a batch per step
 *   rows    EXPORT_ROWS_PER_STEP rows per step from the café's SQLite into sql.js
 *   pack    the file once (sql.js export), then one base64 part per step into `ts_export_part`
 *   ready   `file()` streams the JSON around the stored parts — no big string is ever built
 *
 * The work in progress lives in memory: if the café's object restarts meanwhile, the next call starts over.
 * The finished file stays in storage until the next copy replaces it.
 */
import type { SqlStorageLike } from './shims/sqlite.ts';
import type { Cell, SqlJs, SqlJsDatabase } from './sqljs.ts';
import { isCafeTable, q } from './sqljs.ts';

export const EXPORT_ROWS_PER_STEP = 120;
export const EXPORT_BYTES_PER_STEP = 256 * 1024;
/** CREATE statements per `schema` step (sql.js runs DDL slowly: ~0.1–0.3 ms each). */
export const EXPORT_DDL_PER_STEP = 16;
/** Bytes per base64 part (a multiple of 3: parts join into one valid base64 text). */
export const EXPORT_PART_BYTES = 3 * 128 * 1024;

export interface BackupHead {
  startedAt: number;
  venue: string;
  managerName: string;
  /** The terms as the trial page knows them, so the restored copy has the same rights as the cloud café. */
  status: 'active' | 'ended' | 'permanent';
  endsAt: number | null;
  message: string | null;
}

export interface ExportProgress {
  status: 'preparing' | 'ready';
  phase: 'schema' | 'rows' | 'pack' | 'ready';
  id: string;
  done: number;
  rows: number;
  totalRows: number;
  bytes: number | null;
  createdAt: number;
}

interface TableCopy {
  name: string;
  /** Read from the café when the table's turn comes. */
  cols: string[] | null;
  noRowid: boolean;
  /** Last rowid (or row count without rowid) at the start. */
  until: number;
  last: number;
  done: number;
  total: number;
}

interface Work {
  id: string;
  createdAt: number;
  head: BackupHead;
  db: SqlJsDatabase;
  tables: TableCopy[];
  table: number;
  ddl: string[];
  ddlDone: number;
  triggers: string[];
  rows: number;
  totalRows: number;
  phase: 'schema' | 'rows' | 'pack';
  file: Uint8Array | null;
  packed: number;
}

type Bind = ArrayBuffer | string | number | null;

function cell(v: unknown): Cell {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (v === undefined) return null;
  return v as Cell;
}

function sizeOf(v: Cell): number {
  if (v === null) return 1;
  if (typeof v === 'number') return 8;
  if (typeof v === 'string') return v.length;
  return v.byteLength;
}

const B64 = new TextEncoder().encode('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');

/**
 * The engine's own encoder where it has one (Uint8Array.prototype.toBase64), else a table loop into ASCII bytes —
 * several times faster than building a binary string for btoa.
 */
export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (const whole = bytes.length - (bytes.length % 3); i < whole; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = B64[n >> 18]!;
    out[o++] = B64[(n >> 12) & 63]!;
    out[o++] = B64[(n >> 6) & 63]!;
    out[o++] = B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest) {
    const n = (bytes[i]! << 16) | (rest === 2 ? bytes[i + 1]! << 8 : 0);
    out[o++] = B64[n >> 18]!;
    out[o++] = B64[(n >> 12) & 63]!;
    out[o++] = rest === 2 ? B64[(n >> 6) & 63]! : 61;
    out[o++] = 61;
  }
  return new TextDecoder().decode(out);
}

export class Exporter {
  readonly #storage: SqlStorageLike;
  readonly #loadSqlJs: () => Promise<SqlJs>;
  #work: Work | null = null;

  constructor(storage: SqlStorageLike, loadSqlJs: () => Promise<SqlJs>) {
    this.#storage = storage;
    this.#loadSqlJs = loadSqlJs;
  }

  /** A copy is being made (its next step is due). */
  get busy(): boolean {
    return this.#work !== null;
  }

  #exec(sql: string, ...bindings: Bind[]): Array<Record<string, unknown>> {
    return this.#storage.sql.exec(sql, ...bindings).toArray() as Array<Record<string, unknown>>;
  }

  #ready(): (ExportProgress & { head: BackupHead; parts: number }) | null {
    const has = this.#exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ts_export_meta'").length > 0;
    if (!has) return null;
    const row = this.#exec('SELECT v FROM ts_export_meta WHERE k = ?', 'file')[0];
    return row ? (JSON.parse(String(row.v)) as ExportProgress & { head: BackupHead; parts: number }) : null;
  }

  /** A finished copy younger than `maxAgeMs`, or the work in progress, or null. */
  progress(now: number, maxAgeMs: number): ExportProgress | null {
    const w = this.#work;
    if (w) return this.#progressOf(w);
    const ready = this.#ready();
    if (ready && now - ready.createdAt <= maxAgeMs) {
      const { head: _h, parts: _p, ...p } = ready;
      return p;
    }
    return null;
  }

  #progressOf(w: Work): ExportProgress {
    const share =
      w.phase === 'schema'
        ? (0.05 * w.ddlDone) / Math.max(1, w.ddl.length)
        : w.phase === 'rows'
          ? 0.05 + 0.85 * (w.rows / Math.max(1, w.totalRows))
          : 0.9 + (0.1 * w.packed) / Math.max(1, Math.ceil((w.file?.length ?? 1) / EXPORT_PART_BYTES));
    return { status: 'preparing', phase: w.phase, id: w.id, done: Math.round(share * 100) / 100, rows: w.rows, totalRows: w.totalRows, bytes: null, createdAt: w.createdAt };
  }

  /**
   * One step: starts a copy when none is in progress (`fresh`: even if a recent one is ready), else goes on.
   * Returns where it stands; `ready` once `file()` can be sent.
   */
  async step(now: number, head: () => BackupHead, options: { fresh: boolean; maxAgeMs: number; id: string }): Promise<ExportProgress> {
    if (!this.#work) {
      const ready = this.progress(now, options.maxAgeMs);
      if (ready && !options.fresh) return ready;
      const SQL = await this.#loadSqlJs();
      if (!this.#work) this.#start(SQL, now, head(), options.id);
      return this.#progressOf(this.#work!);
    }
    const w = this.#work;
    try {
      if (w.phase === 'schema') this.#schema(w);
      else if (w.phase === 'rows') this.#rows(w);
      else this.#pack(w);
    } catch (err) {
      this.#work = null;
      w.db.close();
      throw err;
    }
    if (this.#work) return this.#progressOf(this.#work);
    return this.progress(now, Number.MAX_SAFE_INTEGER)!;
  }

  #start(SQL: SqlJs, now: number, head: BackupHead, id: string): void {
    const objects = this.#exec("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid") as Array<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string;
    }>;
    const tables = objects.filter((o) => o.type === 'table' && isCafeTable(o.name));
    const names = new Set(tables.map((t) => t.name));
    const copies: TableCopy[] = tables.map((t) => {
      const noRowid = /\bWITHOUT\s+ROWID\b/i.test(t.sql);
      const until = Number(this.#exec(noRowid ? `SELECT count(*) AS n FROM ${q(t.name)}` : `SELECT max(rowid) AS n FROM ${q(t.name)}`)[0]?.n ?? 0);
      return { name: t.name, cols: null, noRowid, until, last: 0, done: 0, total: until };
    });
    const db = new SQL.Database();
    // A file being built in memory: no journal, no syncing.
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF');
    this.#work = {
      id,
      createdAt: now,
      head,
      db,
      tables: copies,
      table: 0,
      ddl: [...tables.map((t) => t.sql), ...objects.filter((o) => o.type === 'index' && names.has(o.tbl_name)).map((o) => o.sql)],
      ddlDone: 0,
      triggers: objects.filter((o) => o.type === 'trigger' && names.has(o.tbl_name)).map((o) => o.sql),
      rows: 0,
      // max(rowid) over-counts tables with gaps: only the progress bar sees it.
      totalRows: copies.reduce((n, t) => n + t.total, 0),
      phase: 'schema',
      file: null,
      packed: 0,
    };
  }

  #schema(w: Work): void {
    const end = Math.min(w.ddl.length, w.ddlDone + EXPORT_DDL_PER_STEP);
    w.db.exec('BEGIN');
    for (let i = w.ddlDone; i < end; i++) w.db.exec(w.ddl[i]!);
    w.db.exec('COMMIT');
    w.ddlDone = end;
    if (end >= w.ddl.length) w.phase = 'rows';
  }

  #rows(w: Work): void {
    let rows = 0;
    let bytes = 0;
    w.db.exec('BEGIN');
    while (w.table < w.tables.length && rows < EXPORT_ROWS_PER_STEP && bytes < EXPORT_BYTES_PER_STEP) {
      const t = w.tables[w.table]!;
      if (t.until === 0) {
        w.table++;
        continue;
      }
      t.cols ??= (this.#exec(`PRAGMA table_xinfo(${q(t.name)})`) as Array<{ name: string; hidden: number }>)
        .filter((c) => Number(c.hidden) === 0)
        .map((c) => String(c.name));
      const tcols = t.cols;
      const limit = EXPORT_ROWS_PER_STEP - rows;
      const cols = tcols.map(q).join(', ');
      const got = t.noRowid
        ? this.#exec(`SELECT ${cols} FROM ${q(t.name)} LIMIT ? OFFSET ?`, Math.min(limit, t.until - t.done), t.done)
        : this.#exec(`SELECT rowid AS "__ts_rowid", ${cols} FROM ${q(t.name)} WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`, t.last, t.until, limit);
      if (got.length) {
        const insert = w.db.prepare(
          `INSERT INTO ${q(t.name)} (${t.noRowid ? '' : 'rowid, '}${cols}) VALUES (${[...(t.noRowid ? [] : ['?']), ...tcols.map(() => '?')].join(', ')})`,
        );
        try {
          for (const r of got) {
            const values = tcols.map((c) => cell(r[c]));
            insert.run(t.noRowid ? values : [Number(r.__ts_rowid), ...values]);
            for (const v of values) bytes += sizeOf(v);
            if (!t.noRowid) t.last = Number(r.__ts_rowid);
            t.done++;
          }
        } finally {
          insert.free();
        }
        rows += got.length;
        w.rows += got.length;
      }
      if (got.length < limit || (t.noRowid && t.done >= t.until) || (!t.noRowid && t.last >= t.until)) w.table++;
    }
    w.db.exec('COMMIT');
    if (w.table >= w.tables.length) {
      for (const sql of w.triggers) w.db.exec(sql);
      const seq = this.#exec("SELECT name, seq FROM sqlite_sequence WHERE name IN (SELECT name FROM sqlite_master WHERE type = 'table')").filter((r) =>
        isCafeTable(String(r.name)),
      );
      for (const r of seq) {
        w.db.run('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?', [Number(r.seq), String(r.name)]);
        if (w.db.getRowsModified() === 0) w.db.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [String(r.name), Number(r.seq)]);
      }
      w.phase = 'pack';
    }
  }

  #pack(w: Work): void {
    if (!w.file) {
      w.file = w.db.export();
      w.db.close();
      this.#storage.transactionSync(() => {
        this.#exec('CREATE TABLE IF NOT EXISTS ts_export_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
        this.#exec('CREATE TABLE IF NOT EXISTS ts_export_part (n INTEGER PRIMARY KEY, b64 TEXT NOT NULL)');
        this.#exec('DELETE FROM ts_export_part');
        this.#exec('DELETE FROM ts_export_meta');
      });
      return;
    }
    const parts = Math.ceil(w.file.length / EXPORT_PART_BYTES);
    const n = w.packed;
    this.#exec('INSERT OR REPLACE INTO ts_export_part (n, b64) VALUES (?, ?)', n, toBase64(w.file.subarray(n * EXPORT_PART_BYTES, (n + 1) * EXPORT_PART_BYTES)));
    w.packed++;
    if (w.packed >= parts) {
      const ready = {
        status: 'ready' as const,
        phase: 'ready' as const,
        id: w.id,
        done: 1,
        rows: w.rows,
        totalRows: w.rows,
        bytes: w.file.length,
        createdAt: w.createdAt,
        head: w.head,
        parts,
      };
      this.#exec('INSERT OR REPLACE INTO ts_export_meta (k, v) VALUES (?, ?)', 'file', JSON.stringify(ready));
      this.#work = null;
    }
  }

  /** The finished copy as the backup file (a stream), or null when none is ready. */
  file(): { name: string; body: ReadableStream<Uint8Array>; bytes: number } | null {
    const ready = this.#ready();
    if (!ready) return null;
    const h = ready.head;
    const meta = {
      format: 'ts-trial-backup',
      version: 1,
      startedAt: h.startedAt,
      venue: h.venue,
      managerName: h.managerName,
      // The director gets a new code when the copy opens in a browser; everyone else keeps theirs.
      managerKey: '',
      savedAt: ready.createdAt,
      status: h.status,
      ...(h.endsAt !== null ? { endsAt: h.endsAt } : {}),
      ...(h.message ? { message: h.message } : {}),
    };
    const head = JSON.stringify(meta).slice(0, -1) + ',"db":"';
    const enc = new TextEncoder();
    const exec = (n: number) => this.#exec('SELECT b64 FROM ts_export_part WHERE n = ?', n)[0]?.b64;
    let n = -1;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (n === -1) controller.enqueue(enc.encode(head));
        else if (n < ready.parts) {
          const b64 = exec(n);
          if (typeof b64 !== 'string') {
            controller.error(new Error('backup part missing'));
            return;
          }
          controller.enqueue(enc.encode(b64));
        } else {
          controller.enqueue(enc.encode('"}'));
          controller.close();
        }
        n++;
      },
    });
    const day = new Date(ready.createdAt + 5 * 3_600_000).toISOString().slice(0, 10);
    // Parts are whole groups of 3 bytes, so together they are the base64 of the whole file.
    const bytes = enc.encode(head).length + Math.ceil((ready.bytes ?? 0) / 3) * 4 + 2;
    return { name: `TS-${latinName(h.venue)}-${day}.ts-backup.json`, body, bytes };
  }
}

// As apps/cloud-web trials.ts latinName: Chromium drops a download name with Cyrillic letters.
const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};

export function latinName(name: string): string {
  const latin = [...name.toLowerCase()].map((c) => LATIN[c] ?? c).join('');
  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kofeynya';
}
