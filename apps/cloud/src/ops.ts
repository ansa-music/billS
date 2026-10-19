/**
 * Operations on the SQLite file of the cloud: backup, restore, integrity check.
 * Used by the CLI (apps/cloud/src/cli.ts). Works with the plain database file and
 * never depends on the `sqlite3` binary. PostgreSQL installs use pg_dump instead.
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Local time as `YYYY-MM-DD_HH-mm-ss` for file names. */
export function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** `backup <dir>` → `<dir>/cloud-YYYY-MM-DD_HH-mm-ss.db`; `backup <file>` → that file. */
export function resolveBackupTarget(target: string, at: number): string {
  const abs = resolve(target);
  const looksLikeDir = /[\\/]$/.test(target) || (existsSync(abs) && statSync(abs).isDirectory());
  return looksLikeDir ? join(abs, `cloud-${stamp(at)}.db`) : abs;
}

// ---------------------------------------------------------------------------
// Integrity

export interface CloudCounts {
  companies: number;
  owners: number;
  clubs: number;
  hubs: number;
  events: number;
}

export interface IntegrityReport {
  ok: boolean;
  path: string;
  messages: string[];
  schemaVersion: number | null;
  sizeBytes: number;
  /** Present only for a TS cloud database (has schema_migrations). */
  counts?: CloudCounts;
}

function count(db: DatabaseSync, table: string): number {
  const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** `PRAGMA integrity_check` plus a few counters. Never modifies the file. */
export function integrityCheck(path: string): IntegrityReport {
  if (!existsSync(path)) {
    return { ok: false, path, messages: [`Файл не найден: ${path}`], schemaVersion: null, sizeBytes: 0 };
  }
  const sizeBytes = statSync(path).size;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    return { ok: false, path, messages: [err instanceof Error ? err.message : String(err)], schemaVersion: null, sizeBytes };
  }
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const messages = rows.map((r) => r.integrity_check);
    const ok = messages.length === 1 && messages[0] === 'ok';
    const report: IntegrityReport = { ok, path, messages: ok ? [] : messages, schemaVersion: null, sizeBytes };
    if (!ok) return report;
    const hasMigrations = db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (hasMigrations) {
      const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
      report.schemaVersion = v?.v ?? null;
      report.counts = {
        companies: count(db, 'companies'),
        owners: count(db, 'owners'),
        clubs: count(db, 'clubs'),
        hubs: count(db, 'hubs'),
        events: count(db, 'events'),
      };
    }
    return report;
  } catch (err) {
    return { ok: false, path, messages: [err instanceof Error ? err.message : String(err)], schemaVersion: null, sizeBytes };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Backup

export interface BackupResult {
  path: string;
  sizeBytes: number;
  at: number;
}

/**
 * Consistent snapshot of a live database via `VACUUM INTO`: safe while the cloud
 * is running (WAL readers never block the writer). The copy is verified with
 * `PRAGMA integrity_check` and removed when it is not ok.
 */
export function backupDatabase(dbPath: string, target: string, now = Date.now()): BackupResult {
  if (!existsSync(dbPath)) throw new Error(`База не найдена: ${dbPath}`);
  const out = resolveBackupTarget(target, now);
  if (existsSync(out)) throw new Error(`Файл уже существует: ${out}`);
  mkdirSync(dirname(out), { recursive: true });

  const src = new DatabaseSync(dbPath);
  try {
    src.exec('PRAGMA busy_timeout = 10000');
    src.prepare('VACUUM INTO ?').run(out);
  } catch (err) {
    rmSync(out, { force: true });
    throw err;
  } finally {
    src.close();
  }

  const integrity = integrityCheck(out);
  if (!integrity.ok) {
    rmSync(out, { force: true });
    throw new Error(`Копия повреждена, удалена: ${integrity.messages.join('; ')}`);
  }
  return { path: out, sizeBytes: statSync(out).size, at: now };
}

// ---------------------------------------------------------------------------
// Restore

export interface RestorePlan {
  source: string;
  target: string;
  /** Where the current database goes before it is replaced (null when there is none). */
  keepPreviousAs: string | null;
}

export function planRestore(source: string, dbPath: string, now = Date.now()): RestorePlan {
  const target = resolve(dbPath);
  return {
    source: resolve(source),
    target,
    keepPreviousAs: existsSync(target) ? `${target}.before-restore-${stamp(now)}` : null,
  };
}

/**
 * Replaces the database with a backup. The cloud must be stopped: a running
 * process would keep writing to the old file. The current database (with its
 * -wal/-shm files) is moved aside as `cloud.db.before-restore-<stamp>`, so no
 * stale WAL is left next to the restored file.
 */
export function restoreDatabase(source: string, dbPath: string, now = Date.now()): RestorePlan & IntegrityReport {
  const plan = planRestore(source, dbPath, now);
  const check = integrityCheck(plan.source);
  if (!check.ok) throw new Error(`Копия повреждена, восстановление отменено: ${check.messages.join('; ')}`);
  if (check.schemaVersion === null) throw new Error(`Это не база облака TS (нет schema_migrations): ${plan.source}`);

  mkdirSync(dirname(plan.target), { recursive: true });
  if (plan.keepPreviousAs) renameSync(plan.target, plan.keepPreviousAs);
  for (const suffix of ['-wal', '-shm']) {
    const file = plan.target + suffix;
    if (!existsSync(file)) continue;
    if (plan.keepPreviousAs) renameSync(file, plan.keepPreviousAs + suffix);
    else rmSync(file, { force: true });
  }
  copyFileSync(plan.source, plan.target);
  const after = integrityCheck(plan.target);
  if (!after.ok) throw new Error(`После копирования база повреждена: ${after.messages.join('; ')}`);
  return { ...plan, ...after };
}
