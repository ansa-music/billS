import { useEffect, useState } from 'react';
import type { GithubRelease, ReleaseCatalog } from '@bills/domain';
import { buildReleaseCatalog, releasesApiUrl } from '@bills/domain';

/**
 * The latest GitHub release of each app (tags desktop-v…, mobile-v…, general) with the installers, for the «Скачать
 * приложение» page. Straight from the browser to api.github.com (public repo,
 * no token); the answer is kept in sessionStorage for 10 minutes so flipping
 * between pages does not eat the 60-requests-per-hour anonymous limit.
 */

const CACHE_KEY = 'ts.releases.list';
const CACHE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 8000;

export type ReleaseState =
  | { status: 'loading' }
  | { status: 'ok'; release: ReleaseCatalog }
  /** The repository has no published release yet. */
  | { status: 'none' }
  | { status: 'error'; message: string };

interface CacheEntry {
  at: number;
  releases: GithubRelease[];
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

function writeCache(releases: GithubRelease[]): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), releases } satisfies CacheEntry));
  } catch {
    // Private mode or full storage: the next visit simply asks GitHub again.
  }
}

function fromEntry(entry: CacheEntry): ReleaseState {
  const catalog = Array.isArray(entry.releases) ? buildReleaseCatalog(entry.releases) : null;
  return catalog ? { status: 'ok', release: catalog } : { status: 'none' };
}

async function loadReleases(signal: AbortSignal): Promise<GithubRelease[]> {
  const res = await fetch(releasesApiUrl(), { headers: { Accept: 'application/vnd.github+json' }, signal });
  if (res.status === 404) return [];
  if (res.status === 403 || res.status === 429) throw new Error('GitHub временно ограничил запросы');
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const list = (await res.json()) as GithubRelease[];
  // Only what the pages read: the cache stays small.
  return list.map(({ tag_name, name, published_at, html_url, draft, prerelease, assets }) => ({
    tag_name,
    name,
    published_at,
    html_url,
    draft,
    prerelease,
    assets: assets.map(({ name: file, size, browser_download_url }) => ({ name: file, size, browser_download_url })),
  }));
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
    loadReleases(ctrl.signal)
      .then((releases) => {
        writeCache(releases);
        setState(fromEntry({ at: Date.now(), releases }));
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
