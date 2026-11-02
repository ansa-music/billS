/**
 * `node:fs` for the cloud HUB (build.mjs aliases it here). A Durable Object has no disk: the only files the
 * HUB reads are its SQL migrations, which build.mjs bundles from apps/hub/src/migrations; everything else
 * behaves like a missing file, and writes (backups, key files) do nothing.
 */
import { MIGRATIONS } from 'virtual:hub-migrations';

const files = new Map<string, string>(Object.entries(MIGRATIONS));

function baseName(p: string | URL): string {
  const s = typeof p === 'string' ? p : p.pathname;
  const trimmed = s.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

function enoent(p: string | URL): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${String(p)}'`), { code: 'ENOENT' });
}

export function readdirSync(dir: string | URL): string[] {
  if (baseName(dir) === 'migrations') return [...files.keys()].sort();
  throw enoent(dir);
}

export function readFileSync(file: string | URL, _encoding?: unknown): string {
  const sql = files.get(baseName(file));
  if (sql === undefined) throw enoent(file);
  return sql;
}

export function existsSync(_p: string | URL): boolean {
  return false;
}

export function mkdirSync(): void {}
export function appendFileSync(): void {}
export function writeFileSync(): void {}
export function rmSync(): void {}
export function renameSync(): void {}
export function copyFileSync(): void {}
export function unlinkSync(): void {}

export function statSync(p: string | URL): never {
  throw enoent(p);
}

export function statfsSync(p: string | URL): never {
  throw enoent(p);
}

export default {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  statSync,
  statfsSync,
};
