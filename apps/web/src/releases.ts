import { useEffect, useState } from 'react';
import type { ClassifiedRelease, GithubRelease } from '@bills/domain';
import { classifyReleaseAssets, releasesApiUrl } from '@bills/domain';

/**
 * The latest GitHub release with the app installers, for the «Приложения»
 * page (#/apps). The same hook as in apps/cloud-web. Straight from the browser to api.github.com (public repo,
 * no token); the answer is kept in sessionStorage for 10 minutes so flipping
 * between pages does not eat the 60-requests-per-hour anonymous limit.
 */

const CACHE_KEY = 'ts.releases.latest';
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;

export type ReleaseState =
  | { status: 'loading' }
  | { status: 'ok'; release: ClassifiedRelease }
  /** The repository has no published release yet (GitHub answers 404). */
  | { status: 'none' }
  | { status: 'error'; message: string };

interface CacheEntry {
  at: number;
  /** null — GitHub said there is no release. */
  release: GithubRelease | null;
}

function readCache(): CacheEntry | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (typeof entry?.at !== 'number' || Date.now() - entry.at > CACHE_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeCache(release: GithubRelease | null): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), release } satisfies CacheEntry));
  } catch {
    // Private mode or full storage: the next visit simply asks GitHub again.
  }
}

function fromEntry(entry: CacheEntry): ReleaseState {
  return entry.release ? { status: 'ok', release: classifyReleaseAssets(entry.release) } : { status: 'none' };
}

async function loadLatest(signal: AbortSignal): Promise<GithubRelease | null> {
  const res = await fetch(releasesApiUrl(), { headers: { Accept: 'application/vnd.github+json' }, signal });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw new Error('GitHub временно ограничил запросы');
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  return (await res.json()) as GithubRelease;
}

export function useLatestRelease(): ReleaseState {
  const [state, setState] = useState<ReleaseState>(() => {
    const cached = readCache();
    return cached ? fromEntry(cached) : { status: 'loading' };
  });

  useEffect(() => {
    if (readCache()) return;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, TIMEOUT_MS);
    loadLatest(ctrl.signal)
      .then((release) => {
        writeCache(release);
        setState(fromEntry({ at: Date.now(), release }));
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted && !timedOut) return; // unmounted
        const message = timedOut ? 'GitHub не ответил вовремя' : e instanceof Error ? e.message : String(e);
        setState({ status: 'error', message: message === 'Failed to fetch' ? 'нет связи с GitHub' : message });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, []);

  return state;
}
