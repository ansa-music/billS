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

export type ClubTab = 'overview' | 'tariffs' | 'shifts' | 'staff';

export type Route =
  | { kind: 'overview' }
  | { kind: 'apps' }
  | { kind: 'club'; id: string }
  | { kind: 'tariffs'; id: string }
  | { kind: 'shifts'; id: string }
  | { kind: 'staff'; id: string }
  | { kind: 'company' }
  | { kind: 'phone' }
  /** «Сотрудники» in the cabinet's menu: the venue's staff, or a venue to pick. */
  | { kind: 'staff-home' }
  /** «Первые шаги». */
  | { kind: 'start' }
  /** «Начать бесплатно» and the sign-in form; signed in, they show the overview. */
  | { kind: 'signup' }
  | { kind: 'login' }
  /** «Задать пароль» — the invitation / reset letter's link leads here (Supabase). */
  | { kind: 'set-password' };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '') || '/';
  if (path === '/apps') return { kind: 'apps' };
  if (path === '/phone') return { kind: 'phone' };
  if (path === '/company') return { kind: 'company' };
  if (path === '/set-password') return { kind: 'set-password' };
  if (path === '/staff') return { kind: 'staff-home' };
  if (path === '/start') return { kind: 'start' };
  if (path === '/signup') return { kind: 'signup' };
  if (path === '/login') return { kind: 'login' };
  const m = /^\/clubs\/([^/]+)(?:\/(tariffs|shifts|staff))?$/.exec(path);
  if (m && m[1]) {
    const id = decodeURIComponent(m[1]);
    if (m[2] === 'tariffs') return { kind: 'tariffs', id };
    if (m[2] === 'shifts') return { kind: 'shifts', id };
    if (m[2] === 'staff') return { kind: 'staff', id };
    return { kind: 'club', id };
  }
  return { kind: 'overview' };
}

/** Routing by `location.hash`: #/, #/apps, #/start, #/signup, #/login, #/staff, #/clubs/:id, #/clubs/:id/tariffs, #/clubs/:id/shifts, #/clubs/:id/staff, #/company, #/phone, #/set-password. */
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
