import { useCallback, useEffect, useRef, useState } from 'react';

const REFRESH_EVENT = 'ts:refresh';

/** Every polled screen reloads now (a Realtime alert arrived) instead of waiting for its timer. */
export function requestRefresh(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

/**
 * Loads data once and then every `intervalMs`; the last good value stays on screen
 * while the cloud is unreachable (the shell shows the offline banner).
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await load();
      setData(next);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      inFlight.current = false;
    }
  }, [load]);

  useEffect(() => {
    setData(null);
    setError(null);
    void reload();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    const onRefresh = () => void reload();
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
    };
  }, [reload, intervalMs]);

  return { data, error, reload };
}

export type ClubTab = 'overview' | 'tariffs' | 'shifts';

export type Route =
  | { kind: 'overview' }
  | { kind: 'apps' }
  | { kind: 'club'; id: string }
  | { kind: 'tariffs'; id: string }
  | { kind: 'shifts'; id: string }
  | { kind: 'phone' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '') || '/';
  if (path === '/apps') return { kind: 'apps' };
  if (path === '/phone') return { kind: 'phone' };
  const m = /^\/clubs\/([^/]+)(?:\/(tariffs|shifts))?$/.exec(path);
  if (m && m[1]) {
    const id = decodeURIComponent(m[1]);
    if (m[2] === 'tariffs') return { kind: 'tariffs', id };
    if (m[2] === 'shifts') return { kind: 'shifts', id };
    return { kind: 'club', id };
  }
  return { kind: 'overview' };
}

/** Routing by `location.hash`: #/, #/apps, #/clubs/:id, #/clubs/:id/tariffs, #/clubs/:id/shifts, #/phone. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function clubHref(id: string, tab: ClubTab = 'overview'): string {
  const base = `#/clubs/${encodeURIComponent(id)}`;
  return tab === 'overview' ? base : `${base}/${tab}`;
}
