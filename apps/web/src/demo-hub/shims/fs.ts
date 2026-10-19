/**
 * Browser stand-in for `node:fs` (demo build only). The in-browser HUB has no
 * disk: the only files it reads are its own SQL migrations, bundled here, and
 * everything else behaves like a missing file.
 */
const bundled = import.meta.glob<string>('../../../../hub/src/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const MIGRATIONS = new Map<string, string>(
  Object.entries(bundled).map(([path, sql]) => [path.slice(path.lastIndexOf('/') + 1), sql]),
);

function baseName(p: string | URL): string {
  const s = typeof p === 'string' ? p : p.pathname;
  const trimmed = s.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

function enoent(p: string | URL): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, '${String(p)}'`), { code: 'ENOENT' });
}

export function readdirSync(dir: string | URL): string[] {
  if (baseName(dir) === 'migrations') return [...MIGRATIONS.keys()].sort();
  throw enoent(dir);
}

export function readFileSync(file: string | URL, _encoding?: unknown): string {
  const sql = MIGRATIONS.get(baseName(file));
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
  statSync,
  statfsSync,
};
