/**
 * Operations: backups, restore, integrity checks, health and metrics.
 * Used by the CLI (apps/hub/src/cli.ts) and by GET /api/health, GET /metrics.
 * Everything here works with the plain database file and never depends on the
 * `sqlite3` binary being installed.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Db } from './db.ts';
import { one } from './db.ts';
import type { VersionInfo } from './version.ts';

// ---------------------------------------------------------------------------
// Backups

export interface BackupMarker {
  /** When the backup finished, ms since epoch. */
  at: number;
  iso: string;
  path: string;
  sizeBytes: number;
}

/** Where the "last successful backup" marker lives: next to the database unless overridden. */
export function backupMarkerPath(dbPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.HUB_BACKUP_MARKER ?? join(dirname(resolve(dbPath)), 'last-backup.json');
}

export function readBackupMarker(markerPath: string): BackupMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<BackupMarker>;
    if (typeof parsed.at !== 'number') return null;
    return {
      at: parsed.at,
      iso: parsed.iso ?? new Date(parsed.at).toISOString(),
      path: parsed.path ?? '',
      sizeBytes: parsed.sizeBytes ?? 0,
    };
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** `backup <dir>` → `<dir>/hub-YYYY-MM-DD_HH-mm-ss.db`; `backup <file>` → that file. */
export function resolveBackupTarget(target: string, at: number): string {
  const abs = resolve(target);
  const looksLikeDir = /[\\/]$/.test(target) || (existsSync(abs) && statSync(abs).isDirectory());
  return looksLikeDir ? join(abs, `hub-${stamp(at)}.db`) : abs;
}

export interface BackupOptions {
  /** Defaults to next to the database; `null` skips the marker. */
  markerPath?: string | null;
  now?: number;
}

export interface BackupResult extends BackupMarker {
  integrity: 'ok';
}

/**
 * Consistent snapshot of a live database via `VACUUM INTO`: safe while the HUB
 * is running and writing (readers never block writers in WAL mode). The copy is
 * verified with `PRAGMA integrity_check` before the marker is updated.
 */
export function backupDatabase(dbPath: string, target: string, options: BackupOptions = {}): BackupResult {
  if (!existsSync(dbPath)) throw new Error(`База не найдена: ${dbPath}`);
  const now = options.now ?? Date.now();
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

  const result: BackupResult = {
    at: now,
    iso: new Date(now).toISOString(),
    path: out,
    sizeBytes: statSync(out).size,
    integrity: 'ok',
  };
  const marker = options.markerPath === undefined ? backupMarkerPath(dbPath) : options.markerPath;
  if (marker) writeJsonAtomic(marker, { at: result.at, iso: result.iso, path: result.path, sizeBytes: result.sizeBytes });
  return result;
}

// ---------------------------------------------------------------------------
// Integrity

export interface IntegrityReport {
  ok: boolean;
  path: string;
  messages: string[];
  schemaVersion: number | null;
  sizeBytes: number;
  /** Present only for a billS database (has schema_migrations). */
  counts?: {
    tables: number;
    sessionsLive: number;
    sessionsUnpaid: number;
    alertsOpen: number;
    lampCommandsPending: number;
    outboxPending: number;
  };
}

/** `PRAGMA integrity_check` plus a few counters. Never modifies the file. */
export function integrityCheck(path: string): IntegrityReport {
  if (!existsSync(path)) {
    return { ok: false, path, messages: [`Файл не найден: ${path}`], schemaVersion: null, sizeBytes: 0 };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, path, messages: [message], schemaVersion: null, sizeBytes: statSync(path).size };
  }
  try {
    const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
    const messages = rows.map((r) => r.integrity_check);
    const ok = messages.length === 1 && messages[0] === 'ok';
    const report: IntegrityReport = {
      ok,
      path,
      messages: ok ? [] : messages,
      schemaVersion: null,
      sizeBytes: statSync(path).size,
    };
    if (!ok) return report;
    const hasMigrations = db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (hasMigrations) {
      report.schemaVersion = schemaVersion(db);
      report.counts = counters(db);
    }
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, path, messages: [message], schemaVersion: null, sizeBytes: statSync(path).size };
  } finally {
    db.close();
  }
}

export function schemaVersion(db: Db): number | null {
  const row = one<{ v: number | null }>(db, 'SELECT MAX(version) AS v FROM schema_migrations');
  return row?.v ?? null;
}

export interface Counters {
  tables: number;
  sessionsLive: number;
  sessionsOpening: number;
  sessionsActive: number;
  sessionsUnpaid: number;
  alertsOpen: number;
  lampCommandsPending: number;
  lampsUnknown: number;
  outboxPending: number;
}

function count(db: Db, sql: string): number {
  return Number(one<{ n: number }>(db, sql)?.n ?? 0);
}

function tableExists(db: Db, name: string): boolean {
  return Boolean(one(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name));
}

/** Operational counters shared by /metrics, /api/health and the CLI. Tolerates a partially created schema. */
export function counters(db: Db): Counters {
  const safe = (table: string, sql: string) => (tableExists(db, table) ? count(db, sql) : 0);
  return {
    tables: safe('billiard_tables', 'SELECT COUNT(*) AS n FROM billiard_tables WHERE is_active = 1'),
    sessionsLive: safe('table_sessions', "SELECT COUNT(*) AS n FROM table_sessions WHERE status IN ('OPENING', 'ACTIVE')"),
    sessionsOpening: safe('table_sessions', "SELECT COUNT(*) AS n FROM table_sessions WHERE status = 'OPENING'"),
    sessionsActive: safe('table_sessions', "SELECT COUNT(*) AS n FROM table_sessions WHERE status = 'ACTIVE'"),
    sessionsUnpaid: safe('table_sessions', "SELECT COUNT(*) AS n FROM table_sessions WHERE status = 'AWAITING_PAYMENT'"),
    alertsOpen: safe('alerts', 'SELECT COUNT(*) AS n FROM alerts WHERE resolved_at IS NULL'),
    lampCommandsPending: safe('lamp_commands', "SELECT COUNT(*) AS n FROM lamp_commands WHERE status = 'PENDING'"),
    lampsUnknown: safe('lamp_states', "SELECT COUNT(*) AS n FROM lamp_states WHERE reported = 'UNKNOWN'"),
    outboxPending: safe('outbox', 'SELECT COUNT(*) AS n FROM outbox WHERE delivered_at IS NULL'),
  };
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
 * Replaces the database with a backup. The HUB must be stopped: a running
 * process would keep writing to the old file. The current database (with its
 * WAL and SHM files) is kept next to it as `hub.db.before-restore-<stamp>`.
 */
export function restoreDatabase(source: string, dbPath: string, now = Date.now()): RestorePlan & IntegrityReport {
  const plan = planRestore(source, dbPath, now);
  const check = integrityCheck(plan.source);
  if (!check.ok) throw new Error(`Копия повреждена, восстановление отменено: ${check.messages.join('; ')}`);
  if (check.schemaVersion === null) throw new Error(`Это не база billS (нет schema_migrations): ${plan.source}`);

  mkdirSync(dirname(plan.target), { recursive: true });
  if (plan.keepPreviousAs) {
    renameSync(plan.target, plan.keepPreviousAs);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(plan.target + suffix)) renameSync(plan.target + suffix, plan.keepPreviousAs + suffix);
    }
  }
  copyFileSync(plan.source, plan.target);
  const after = integrityCheck(plan.target);
  if (!after.ok) throw new Error(`После копирования база повреждена: ${after.messages.join('; ')}`);
  return { ...plan, ...after };
}

// ---------------------------------------------------------------------------
// Health and metrics

export interface HealthInfo {
  ok: true;
  now: number;
  version: string;
  gitSha: string | null;
  uptimeSeconds: number;
  startedAt: number;
  schemaVersion: number | null;
  dbPath: string;
  /** Main file plus its WAL. */
  dbSizeBytes: number;
  lastBackupAt: number | null;
  /** Same moment as ISO text, readable from a tablet. */
  lastBackupIso: string | null;
  lastBackupPath: string | null;
  freeDiskBytes: number | null;
  counters: Counters;
}

export interface HealthContext {
  db: Db;
  dbPath: string;
  startedAt: number;
  version: VersionInfo;
  markerPath?: string;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function freeDiskBytes(path: string): number | null {
  try {
    const dir = existsSync(path) && statSync(path).isDirectory() ? path : dirname(resolve(path));
    const fs = statfsSync(dir);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return null;
  }
}

export function collectHealth(ctx: HealthContext, now = Date.now()): HealthInfo {
  const marker = ctx.dbPath === ':memory:' ? null : readBackupMarker(ctx.markerPath ?? backupMarkerPath(ctx.dbPath));
  const dbSizeBytes = ctx.dbPath === ':memory:' ? 0 : fileSize(ctx.dbPath) + fileSize(`${ctx.dbPath}-wal`);
  return {
    ok: true,
    now,
    version: ctx.version.version,
    gitSha: ctx.version.gitSha,
    uptimeSeconds: Math.max(0, Math.floor((now - ctx.startedAt) / 1000)),
    startedAt: ctx.startedAt,
    schemaVersion: schemaVersion(ctx.db),
    dbPath: ctx.dbPath,
    dbSizeBytes,
    lastBackupAt: marker?.at ?? null,
    lastBackupIso: marker ? new Date(marker.at).toISOString() : null,
    lastBackupPath: marker?.path ?? null,
    freeDiskBytes: ctx.dbPath === ':memory:' ? null : freeDiskBytes(ctx.dbPath),
    counters: counters(ctx.db),
  };
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Prometheus text exposition (version 0.0.4). */
export function renderMetrics(h: HealthInfo): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number | null, labels?: Record<string, string>) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    const label = labels
      ? `{${Object.entries(labels)
          .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
          .join(',')}}`
      : '';
    lines.push(`${name}${label} ${value === null ? 'NaN' : String(value)}`);
  };
  const c = h.counters;
  gauge('bills_hub_up', 'HUB is running and answered this scrape.', 1);
  gauge('bills_hub_info', 'Version of the running HUB.', 1, { version: h.version, git_sha: h.gitSha ?? '' });
  gauge('bills_hub_uptime_seconds', 'Seconds since the HUB process started.', h.uptimeSeconds);
  gauge('bills_tables_active', 'Billiard tables configured in this club.', c.tables);
  gauge('bills_sessions_opening', 'Games waiting for the lamp to confirm.', c.sessionsOpening);
  gauge('bills_sessions_active', 'Games running (lamp confirmed, time is counting).', c.sessionsActive);
  gauge('bills_sessions_unpaid', 'Stopped games awaiting payment.', c.sessionsUnpaid);
  gauge('bills_alerts_open', 'Alerts not yet acknowledged by staff.', c.alertsOpen);
  gauge('bills_lamp_commands_pending', 'Lamp commands queued or retrying.', c.lampCommandsPending);
  gauge('bills_lamps_unknown', 'Lamps whose real state is unknown (controller silent).', c.lampsUnknown);
  gauge('bills_outbox_pending', 'Events not yet delivered to the cloud.', c.outboxPending);
  gauge('bills_db_size_bytes', 'Size of the SQLite database including its WAL.', h.dbSizeBytes);
  gauge('bills_db_schema_version', 'Latest applied migration.', h.schemaVersion);
  gauge(
    'bills_last_backup_timestamp_seconds',
    'Unix time of the last successful backup (0 = never).',
    h.lastBackupAt === null ? 0 : Math.floor(h.lastBackupAt / 1000),
  );
  gauge('bills_disk_free_bytes', 'Free space on the disk holding the database.', h.freeDiskBytes);
  return lines.join('\n') + '\n';
}

/** Newest-first list of backup files in a directory (for `restore` without arguments). */
export function listBackups(dir: string): Array<{ path: string; sizeBytes: number; mtime: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^hub-.*\.db(\.gz|\.zip)?$/.test(f))
    .map((f) => {
      const path = join(dir, f);
      const st = statSync(path);
      return { path, sizeBytes: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}
