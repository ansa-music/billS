import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Action, HubState, MeResponse, OpenTableRequest, Role } from '@bills/domain';
import { HubRequestError, UNAUTHORIZED_EVENT, command, fetchJson, fetchState, getAuthToken } from './api.ts';
import { AUTH_CHANGED_EVENT, actorName, readAuth, writeAuth } from './auth.ts';

/**
 * One live connection to the HUB for the whole app: SSE for change events,
 * refetch of /api/state on each, a 15 s poll as backup, and a watchdog that
 * reconnects when the HUB's pings stop (restart behind a proxy, dropped Wi-Fi).
 *
 * Without a session /api/state answers 401. The connection then stops asking
 * (the SSE stream is public and stays open) until the session changes —
 * login, logout or another tab signing in — and refetches at once.
 */
export interface HubConnection {
  state: HubState | null;
  /** serverNow − Date.now(): timers run on the HUB clock, tablets may be off. */
  offset: number;
  online: boolean;
  /** Bumps on every change event from the HUB; screens with their own data refetch on it. */
  version: number;
  /** Bumps when the floor plan was saved (on any screen). */
  layoutVersion: number;
  refresh: () => Promise<void>;
}

export function useHubConnection(): HubConnection {
  const [state, setState] = useState<HubState | null>(null);
  const [offset, setOffset] = useState(0);
  const [online, setOnline] = useState(false);
  const [version, setVersion] = useState(0);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const inFlight = useRef(false);
  const again = useRef(false);
  /** Set after a 401; cleared when the session changes. */
  const unauthorized = useRef(getAuthToken() === null);

  // Coalesces bursts of change events into one request at a time.
  const refresh = useCallback(async () => {
    if (unauthorized.current) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        again.current = false;
        const s = await fetchState();
        setState(s);
        setOffset(s.serverNow - Date.now());
        setOnline(true);
      } while (again.current);
    } catch (e) {
      if (e instanceof HubRequestError && e.status === 401) {
        // The HUB is reachable, we just are not signed in. api.ts has already told auth.ts.
        unauthorized.current = true;
        setOnline(true);
      } else {
        setOnline(false);
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    let events: EventSource;
    let lastSeen = Date.now();

    const connect = () => {
      events = new EventSource('/api/events');
      lastSeen = Date.now();
      events.onopen = () => {
        lastSeen = Date.now();
        void refresh();
        setVersion((v) => v + 1);
      };
      events.addEventListener('ping', () => {
        lastSeen = Date.now();
      });
      events.addEventListener('changed', (e) => {
        lastSeen = Date.now();
        void refresh();
        setVersion((v) => v + 1);
        try {
          if ((JSON.parse((e as MessageEvent<string>).data) as { kind?: string }).kind === 'layout') {
            setLayoutVersion((v) => v + 1);
          }
        } catch {
          // A malformed event still refreshed the state.
        }
      });
      events.onerror = () => {
        setOnline(false);
        // A non-200 answer (HUB restarting behind a proxy) closes the stream for good: reopen it.
        if (events.readyState === EventSource.CLOSED) {
          clearTimeout(retry);
          retry = setTimeout(connect, 2000);
        }
      };
    };
    let retry: ReturnType<typeof setTimeout> | undefined;
    connect();

    // The HUB pings every 15 s. Silence means a dead connection the browser has not noticed
    // (a restarted HUB behind a proxy, a tablet that dropped Wi-Fi): reconnect.
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > 40_000) {
        events.close();
        setOnline(false);
        connect();
      }
    }, 10_000);
    const poll = setInterval(() => void refresh(), 15_000);
    const onAuthChanged = () => {
      unauthorized.current = getAuthToken() === null;
      if (!unauthorized.current) void refresh();
    };
    const onUnauthorized = () => {
      unauthorized.current = true;
    };
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      events.close();
      clearTimeout(retry);
      clearInterval(watchdog);
      clearInterval(poll);
      window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, [refresh]);

  // Once per app start: make sure the stored session is still alive and pick up a renamed
  // or re-roled employee (the role for `can()` comes from the HUB, not from what was typed).
  // A 401 fires UNAUTHORIZED_EVENT inside fetchJson; auth.ts clears the session.
  useEffect(() => {
    const session = readAuth();
    if (!session) return;
    let alive = true;
    fetchJson<MeResponse>('/api/auth/me')
      .then((me) => {
        if (!alive) return;
        const changed =
          JSON.stringify(me.staff) !== JSON.stringify(session.staff) || me.expiresAt !== session.expiresAt;
        if (changed) writeAuth({ token: session.token, staff: me.staff, expiresAt: me.expiresAt });
      })
      .catch(() => {
        // Offline or 401 (handled by the event); nothing more to do here.
      });
    return () => {
      alive = false;
    };
  }, []);

  return { state, offset, online, version, layoutVersion, refresh };
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Everything a page needs; provided once by App after the first state arrived. */
export interface HubContextValue {
  state: HubState;
  serverNow: number;
  /** serverNow − Date.now(). */
  offset: number;
  online: boolean;
  version: number;
  layoutVersion: number;
  refresh: () => Promise<void>;
  /** Who is logged in on this screen (the session names the actor on the HUB; the name goes to logs). */
  actor: string;
  role: Role | null;
  /** Permission check for the current role (see packages/domain permissions.ts). */
  can: (action: Action) => boolean;
  /** Runs a command with a busy flag under `keys` (a transfer locks both tables); errors go to the toast. */
  run: (keys: string | string[], fn: () => Promise<unknown>) => Promise<boolean>;
  isBusy: (key: string) => boolean;
  notify: (message: string) => void;
  /** `prepaidMinutes` opens a timed game, paid after it stops. */
  openTable: (tableId: string, tariffId: string, prepaidMinutes?: number | null) => Promise<boolean>;
  stopSession: (tableId: string, sessionId: string) => Promise<boolean>;
  pauseSession: (tableId: string, sessionId: string) => Promise<boolean>;
  resumeSession: (tableId: string, sessionId: string) => Promise<boolean>;
  transferSession: (tableId: string, sessionId: string, toTableId: string) => Promise<boolean>;
  resolveAlert: (alertId: string) => Promise<boolean>;
}

export const HubContext = createContext<HubContextValue | null>(null);

export function useHub(): HubContextValue {
  const ctx = useContext(HubContext);
  if (!ctx) throw new Error('useHub outside HubContext');
  return ctx;
}

/** The HUB clock, ticking once a second. */
export function useServerNow(intervalMs = 1000): number {
  const { offset } = useHub();
  return useNow(intervalMs) + offset;
}

/** Hall commands with per-table busy flags; App builds the context from them. */
export function useHallCommands(actor: string, refresh: () => Promise<void>, notify: (m: string) => void) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  // `keys` are the cards to lock while the command runs (a transfer locks both tables).
  const run = useCallback(
    async (keys: string | string[], fn: () => Promise<unknown>) => {
      const locked = Array.isArray(keys) ? keys : [keys];
      setBusy((b) => {
        const next = new Set(b);
        for (const k of locked) next.add(k);
        return next;
      });
      try {
        await fn();
        return true;
      } catch (e) {
        notify((e as Error).message);
        return false;
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          for (const k of locked) next.delete(k);
          return next;
        });
        void refresh();
      }
    },
    [refresh, notify],
  );

  return {
    run,
    isBusy: (key: string) => busy.has(key),
    anyBusy: busy.size > 0,
    openTable: (tableId: string, tariffId: string, prepaidMinutes: number | null = null) => {
      const body: OpenTableRequest = prepaidMinutes != null ? { tariffId, prepaidMinutes } : { tariffId };
      return run(tableId, () => command(`/api/tables/${tableId}/open`, actor, body));
    },
    stopSession: (tableId: string, sessionId: string) =>
      run(tableId, () => command(`/api/sessions/${sessionId}/stop`, actor)),
    pauseSession: (tableId: string, sessionId: string) =>
      run(tableId, () => command(`/api/sessions/${sessionId}/pause`, actor)),
    resumeSession: (tableId: string, sessionId: string) =>
      run(tableId, () => command(`/api/sessions/${sessionId}/resume`, actor)),
    transferSession: (tableId: string, sessionId: string, toTableId: string) =>
      run([tableId, toTableId], () => command(`/api/sessions/${sessionId}/transfer`, actor, { toTableId })),
    resolveAlert: (alertId: string) => run(`alert:${alertId}`, () => command(`/api/alerts/${alertId}/resolve`, actor)),
  };
}

/**
 * Generic commands for the pages beyond the hall (settings, bar, staff): runs
 * a POST with the current staff as actor, tracks which keys are busy and
 * reports errors through `onError`. After every command the state is refetched.
 */
export function useCommands(onError: (message: string) => void): {
  busy: Set<string>;
  isBusy: (key: string) => boolean;
  run: <T>(key: string, path: string, body?: object) => Promise<T | undefined>;
} {
  const { refresh } = useHub();
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const run = useCallback(
    async <T,>(key: string, path: string, body: object = {}): Promise<T | undefined> => {
      setBusy((b) => new Set(b).add(key));
      try {
        return await command<T>(path, actorName(), body);
      } catch (e) {
        onError((e as Error).message);
        return undefined;
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(key);
          return next;
        });
        void refresh();
      }
    },
    [onError, refresh],
  );

  return { busy, isBusy: (key) => busy.has(key), run };
}

/**
 * Refetches `load` on mount and whenever the HUB reports a change (debounced).
 * A failed request is retried every few seconds, so a HUB restart heals by itself.
 */
export function useLive<T>(load: () => Promise<T>, deps: readonly unknown[], version: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const key = JSON.stringify(deps);
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const t = setTimeout(
      () => {
        loadRef
          .current()
          .then((d) => {
            if (!cancelled) {
              setData(d);
              setError(null);
            }
          })
          .catch((e: Error) => {
            if (cancelled) return;
            setError(e.message);
            retry = setTimeout(() => setAttempt((a) => a + 1), 3000);
          });
      },
      version === 0 && attempt === 0 ? 0 : 250,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearTimeout(retry);
    };
  }, [key, version, attempt]);

  // Clear stale data when the query itself changes.
  useEffect(() => setData(null), [key]);

  return { data, error };
}
