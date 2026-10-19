/** Browser stand-in for `node:path` (demo build only): POSIX rules, enough for the HUB's few calls. */
export const sep = '/';

function normalize(parts: string[], absolute: boolean): string {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else out.push(part);
  }
  const joined = out.join('/');
  if (absolute) return `/${joined}`;
  return joined || '.';
}

export function join(...paths: string[]): string {
  const joined = paths.filter(Boolean).join('/');
  return normalize(joined.split(/[\\/]/), joined.startsWith('/'));
}

export function resolve(...paths: string[]): string {
  let acc = '';
  for (const p of paths) acc = p.startsWith('/') ? p : `${acc}/${p}`;
  return normalize(acc.split(/[\\/]/), true);
}

export function dirname(p: string): string {
  const i = p.replace(/[\\/]+$/, '').lastIndexOf('/');
  if (i < 0) return '.';
  return i === 0 ? '/' : p.slice(0, i);
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

export default { sep, join, resolve, dirname, relative };
