import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface VersionInfo {
  /** From apps/hub/package.json. */
  version: string;
  /** Short git commit of the running code, or null when unknown (no git, tarball install). */
  gitSha: string | null;
}

/** Repository root: apps/hub/src/version.ts → ../../../ */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let cached: VersionInfo | undefined;

/**
 * Version of the running HUB. `HUB_GIT_SHA` overrides git lookup (for installs
 * without a `.git` directory); otherwise `git rev-parse` runs once and is cached.
 */
export function versionInfo(env: NodeJS.ProcessEnv = process.env): VersionInfo {
  if (cached) return cached;
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  cached = { version: pkg.version ?? '0.0.0', gitSha: readGitSha(env) };
  return cached;
}

function readGitSha(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.HUB_GIT_SHA?.trim();
  if (fromEnv) return fromEnv.slice(0, 40);
  try {
    const out = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], {
      cwd: REPO_ROOT,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const sha = out.trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function versionString(info: VersionInfo = versionInfo()): string {
  return `TS HUB ${info.version}${info.gitSha ? ` (git ${info.gitSha})` : ''}`;
}
