import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BusinessType,
  CatalogView,
  ClubSettings,
  CounterBoardView,
  CounterOrdersView,
  CounterOrderView,
  CounterStage,
  CreateCounterOrderRequest,
  CreateCounterOrderResponse,
  ProductOptionGroup,
  ProductView,
} from '@bills/domain';
import { command, fetchJson, HUB_URL, hubUrl } from '../api.ts';

/**
 * Coffee shop screens (settings.business.type === 'cafe'): the counter («Касса»),
 * the barista's queue and the guest board. Contract: packages/domain/src/cafe.ts.
 */

/** billiards unless the HUB says otherwise (an older HUB sends no `business`). */
export function businessOf(settings: Partial<ClubSettings> | null | undefined): BusinessType {
  return settings?.business?.type === 'cafe' ? 'cafe' : 'billiards';
}

/** Option groups of a product; [] from a HUB that does not send them yet. */
export function optionsOf(product: ProductView): ProductOptionGroup[] {
  return (product as ProductView & { options?: ProductOptionGroup[] | null }).options ?? [];
}

// ── HUB calls ───────────────────────────────────────────────────────────────

export const fetchCounterOrders = () => fetchJson<CounterOrdersView>('/api/counter/orders');

/** Public: the guest board works on a TV without a key. */
export const fetchCounterBoard = () => fetchJson<CounterBoardView>('/api/counter/board');

/** `key` is kept by the counter until the order goes through, so a retry by hand is not a second order. */
export const createCounterOrder = (actor: string, body: CreateCounterOrderRequest, key: string) =>
  command<CreateCounterOrderResponse>('/api/counter/orders', actor, body, 'POST', key);

export const moveCounterStage = (actor: string, orderId: string, stage: CounterStage) =>
  command<CounterOrderView | { order: CounterOrderView }>(`/api/counter/orders/${orderId}/stage`, actor, { stage });

// ── Live data ───────────────────────────────────────────────────────────────

/**
 * How often the counter screens re-read the HUB while visible. Change events
 * from the HUB (SSE, `trigger`) refresh them at once as well; when the HUB
 * sends dedicated counter events, only this hook needs to change.
 */
export const COUNTER_POLL_MS = 2500;
export const BOARD_POLL_MS = 2000;

/**
 * Loads `load` on mount, whenever `trigger` changes (HUB change events) and every
 * `intervalMs` while the page is visible. One request at a time; the last good
 * data stays on screen while the HUB is unreachable.
 */
export function usePolling<T>(load: () => Promise<T>, intervalMs: number, trigger: unknown = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef(false);
  const alive = useRef(true);

  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const d = await loadRef.current();
      if (alive.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, trigger]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    const t = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [reload, intervalMs]);

  return { data, error, reload };
}

/**
 * The menu for the counter, instant on load: the last copy kept on this device
 * is shown at once and the HUB's answer replaces it in the background. It is
 * re-read on HUB change events (`trigger`), but the screen re-renders only
 * when the menu really changed (stock after a sale, an edit in «Меню»).
 */
export function useCachedCatalog(trigger: unknown): { catalog: CatalogView | null; error: string | null } {
  const key = `bills.cafe.catalog.v1:${HUB_URL}`;
  const raw = useRef<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogView | null>(() => {
    try {
      const text = localStorage.getItem(key);
      if (!text) return null;
      raw.current = text;
      return JSON.parse(text) as CatalogView;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (inFlight.current) {
        again.current = true;
        return;
      }
      inFlight.current = true;
      try {
        do {
          again.current = false;
          const fresh = await fetchJson<CatalogView>('/api/bar/catalog');
          const text = JSON.stringify(fresh);
          if (!alive) return;
          setError(null);
          if (text !== raw.current) {
            raw.current = text;
            setCatalog(fresh);
            try {
              localStorage.setItem(key, text);
            } catch {
              // Full or private storage: the cache just does not survive a reload.
            }
          }
        } while (again.current && alive);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        inFlight.current = false;
      }
    };
    // Bursts of change events (a sale raises several) become one request.
    const t = setTimeout(() => void load(), raw.current === null ? 0 : 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key, trigger]);

  return { catalog, error };
}

/**
 * Bumps when the HUB reports a counter change over SSE (`changed`, kind
 * `counter`): for the guest board, which runs without the app's connection.
 * Polling stays as the fallback.
 */
export function useCounterEvents(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let events: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      events = new EventSource(hubUrl('/api/events'));
      events.onopen = () => setVersion((v) => v + 1);
      events.addEventListener('changed', (e) => {
        try {
          const kind = (JSON.parse((e as MessageEvent<string>).data) as { kind?: string }).kind;
          if (kind === 'counter' || kind === undefined) setVersion((v) => v + 1);
        } catch {
          setVersion((v) => v + 1);
        }
      });
      events.onerror = () => {
        if (events?.readyState === EventSource.CLOSED) {
          clearTimeout(retry);
          retry = setTimeout(connect, 3000);
        }
      };
    };
    connect();
    return () => {
      events?.close();
      clearTimeout(retry);
    };
  }, []);
  return version;
}

/**
 * Options the barista must not miss: plant or lactose-free milk, decaf, no
 * sugar. The most common mistake at the bar is the wrong milk.
 */
const RISKY = /(овсян|миндал|кокос|соев|рисов|фундук|растит|безлакт|без лакт|декаф|без кофеин|без сахар)/i;
export const isRiskyOption = (name: string) => RISKY.test(name);

// ── Sound ───────────────────────────────────────────────────────────────────

const SOUND_KEY = 'bills.cafe.sound';

/** Sound on/off for this device (barista tablet, guest TV). */
export function useSoundSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(SOUND_KEY, next ? 'on' : 'off');
    } catch {
      // Private mode: the setting lasts until the page is closed.
    }
    // A tap on the switch is the user gesture browsers need before any sound.
    if (next) void unlockAudio();
  }, []);
  return [on, set];
}

let audio: AudioContext | null = null;

function context(): AudioContext | null {
  if (audio) return audio;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audio = new Ctor();
  } catch {
    return null;
  }
  return audio;
}

/** Browsers start audio only after a tap; call from a click handler. */
export async function unlockAudio(): Promise<boolean> {
  const ctx = context();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {
    return false;
  }
  return ctx.state === 'running';
}

/** Whether a chime would be heard right now (false until the first tap on a TV). */
export function audioReady(): boolean {
  return audio?.state === 'running';
}

/** Two short tones: «new» — a beep for the barista, «ready» — a rising chime for the guests. */
export function chime(kind: 'new' | 'ready'): void {
  const ctx = context();
  if (!ctx || ctx.state !== 'running') return;
  const notes = kind === 'new' ? [880, 880] : [660, 990];
  const start = ctx.currentTime + 0.01;
  notes.forEach((freq, i) => {
    const at = start + i * 0.22;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.22);
  });
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** 4:07 — minutes and seconds since the order was taken (HUB clock). */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, '0')} мин`;
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** «Капучино · L · Овсяное» → the product name without the options (they are shown on their own line). */
export function productNameOf(item: { title: string; optionNames: string[] }): string {
  const parts = item.title.split(' · ');
  return item.optionNames.length > 0 && parts.length > item.optionNames.length
    ? parts.slice(0, parts.length - item.optionNames.length).join(' · ')
    : item.title;
}
