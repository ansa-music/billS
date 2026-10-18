import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { HubState } from '@bills/domain';
import { command, fetchState } from './api.ts';
import { actorName } from './auth.ts';

/**
 * Live HUB state for every page but the hall screen (which keeps its own copy
 * inside App.tsx): one SSE connection, refetch on change, 15 s poll as backup.
 */
export interface HubConnection {
  state: HubState | null;
  /** serverNow − Date.now(): add it to Date.now() to get the HUB's clock. */
  offset: number;
  online: boolean;
  refresh: () => Promise<void>;
}

const HubContext = createContext<HubConnection | null>(null);

export function HubProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HubState | null>(null);
  const [offset, setOffset] = useState(0);
  const [online, setOnline] = useState(false);
  const inFlight = useRef(false);
  const again = useRef(false);

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
    const events = new EventSource('/api/events');
    events.onopen = () => void refresh();
    events.addEventListener('changed', () => void refresh());
    events.onerror = () => setOnline(false);
    const poll = setInterval(() => void refresh(), 15_000);
    return () => {
      events.close();
      clearInterval(poll);
    };
  }, [refresh]);

  return <HubContext.Provider value={{ state, offset, online, refresh }}>{children}</HubContext.Provider>;
}

export function useHub(): HubConnection {
  const ctx = useContext(HubContext);
  if (!ctx) throw new Error('useHub outside HubProvider');
  return ctx;
}

/** The HUB clock, ticking once a second. */
export function useServerNow(intervalMs = 1000): number {
  const { offset } = useHub();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now + offset;
}

/**
 * Runs commands with the current staff as actor, tracks which keys are busy
 * and reports errors through `onError`. After every command the state is refetched.
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
