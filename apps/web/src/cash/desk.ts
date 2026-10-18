import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubState } from '@bills/domain';
import { BillingError } from '@bills/domain';
import { command, getJson, HubRequestError } from '../api.ts';

/** What the cashier panels get from the app shell. */
export interface DeskProps {
  state: HubState;
  /** Staff name from the top bar. */
  actor: string;
  refresh: () => unknown;
  /** Shows a short message in the toast. */
  notify: (message: string) => void;
}

export interface Desk {
  state: HubState;
  /** Sends a command as the current staff member; the hall state is re-read afterwards. */
  send: <T>(path: string, body?: object) => Promise<T>;
  notify: (message: string) => void;
}

export function useDesk({ state, actor, refresh, notify }: DeskProps): Desk {
  const send = useCallback(
    async <T>(path: string, body?: object): Promise<T> => {
      try {
        return await command<T>(path, actor, body);
      } finally {
        void refresh();
      }
    },
    [actor, refresh],
  );
  return { state, send, notify };
}

export interface ActionError {
  code: string;
  message: string;
}

export function toActionError(e: unknown): ActionError {
  if (e instanceof HubRequestError || e instanceof BillingError) return { code: e.code, message: e.message };
  if (e instanceof Error) return { code: 'ERROR', message: e.message };
  return { code: 'ERROR', message: String(e) };
}

/**
 * One action at a time per dialog: a second tap while a request is in flight is ignored.
 * Errors (from the HUB or from local checks thrown inside `fn`) stay in `error` for inline display.
 * Resolves to undefined when the action failed or was ignored.
 */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(toActionError(e));
      return undefined;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  return { pending, error, setError, run };
}

/** GETs a report or a list when mounted; `reload` fetches it again. */
export function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    getJson<T>(path).then(
      (d) => {
        if (alive) setData(d);
      },
      (e: unknown) => {
        if (alive) setError(toActionError(e).message);
      },
    );
    return () => {
      alive = false;
    };
  }, [path, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, reload };
}
