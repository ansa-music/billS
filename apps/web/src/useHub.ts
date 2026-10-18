import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { HubState } from '@bills/domain';
import { command, fetchState } from './api.ts';

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

  // Coalesces bursts of change events into one request at a time.
  const refresh = useCallback(async () => {
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
    } catch {
      setOnline(false);
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
    return () => {
      events.close();
      clearTimeout(retry);
      clearInterval(watchdog);
      clearInterval(poll);
    };
  }, [refresh]);

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

/** Everything a screen needs; provided once by App. */
export interface HubContextValue {
  state: HubState;
  serverNow: number;
  online: boolean;
  version: number;
  layoutVersion: number;
  actor: string;
  /** Runs a command with a busy flag under `key`; errors go to the toast. */
  run: (key: string, fn: () => Promise<unknown>) => Promise<boolean>;
  isBusy: (key: string) => boolean;
  notify: (message: string) => void;
  openTable: (tableId: string, tariffId: string) => Promise<boolean>;
  stopSession: (tableId: string, sessionId: string) => Promise<boolean>;
  resolveAlert: (alertId: string) => Promise<boolean>;
}

export const HubContext = createContext<HubContextValue | null>(null);

export function useHub(): HubContextValue {
  const ctx = useContext(HubContext);
  if (!ctx) throw new Error('useHub outside HubContext');
  return ctx;
}

export function useCommands(actor: string, refresh: () => Promise<void>, notify: (m: string) => void) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy((b) => new Set(b).add(key));
      try {
        await fn();
        return true;
      } catch (e) {
        notify((e as Error).message);
        return false;
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(key);
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
    openTable: (tableId: string, tariffId: string) =>
      run(tableId, () => command(`/api/tables/${tableId}/open`, actor, { tariffId })),
    stopSession: (tableId: string, sessionId: string) =>
      run(tableId, () => command(`/api/sessions/${sessionId}/stop`, actor)),
    resolveAlert: (alertId: string) => run(`alert:${alertId}`, () => command(`/api/alerts/${alertId}/resolve`, actor)),
  };
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
