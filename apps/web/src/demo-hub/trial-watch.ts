/**
 * «Смотреть с телефона»: the calls to the TS cloud (packages/domain/src/trial-watch.ts has the contract).
 * The cash desk asks for a watch link with the trial's own token and can switch every phone off; the
 * phone checks for a newer copy and downloads it with the link's viewer token. Light (no HUB), so the
 * cash desk's dialog can import it.
 */
import type { TrialWatchLink, TrialWatchSnapshot, TrialWatchState, TrialWatchStatus } from '@bills/domain';
import { watchHash } from '@bills/domain';
import { TRIAL_CLOUD_URL } from './trial-cloud.ts';
import type { TrialInfo } from './trial-store.ts';

const TIMEOUT_MS = 20_000;
/** A snapshot is up to 6 MB (8 MB of base64) over a phone's connection. */
const SNAPSHOT_TIMEOUT_MS = 90_000;

/** A call that reached the cloud and was refused (401 — the link is off, 404, 429…), or did not reach it (status 0). */
export class WatchHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, token: string, init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number }): Promise<T> {
  if (!TRIAL_CLOUD_URL) throw new WatchHttpError(0, 'NO_CLOUD', 'В этой сборке нет связи с TS');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${TRIAL_CLOUD_URL}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      let code = 'HTTP';
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
        if (typeof body.error?.code === 'string') code = body.error.code;
        if (typeof body.error?.message === 'string') message = body.error.message;
      } catch {
        // Not JSON: the status says enough.
      }
      throw new WatchHttpError(res.status, code, message);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof WatchHttpError) throw err;
    throw new WatchHttpError(0, 'OFFLINE', 'Нет связи с TS');
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The cash desk

/** This build talks to the TS cloud and this coffee shop is the trial itself (not a copy for viewing). */
export function watchAvailable(info: Pick<TrialInfo, 'localOnly'> | null): boolean {
  return Boolean(TRIAL_CLOUD_URL) && info !== null && !info.localOnly;
}

function linked(info: TrialInfo): { id: string; token: string } {
  if (!info.cloudId || !info.cloudToken) throw new WatchHttpError(0, 'NOT_LINKED', 'Касса ещё не связалась с TS. Проверьте интернет и попробуйте через минуту.');
  return { id: info.cloudId, token: info.cloudToken };
}

let watchSoon: (() => void) | null = null;

/** boot.ts: what to do when a link was just made — the cash desk sends a fresh copy right away. */
export function setWatchSoonHook(fn: () => void): void {
  watchSoon = fn;
}

/** A new watch link (its viewer token is shown once, as a QR code). */
export async function createWatchLink(info: TrialInfo): Promise<TrialWatchLink> {
  const { id, token } = linked(info);
  const link = await call<TrialWatchLink>('/watch/links', token, { method: 'POST', body: { id } });
  watchSoon?.();
  return link;
}

export async function watchLinksStatus(info: TrialInfo): Promise<TrialWatchStatus> {
  const { id, token } = linked(info);
  return call<TrialWatchStatus>(`/watch/links?id=${encodeURIComponent(id)}`, token, { method: 'GET' });
}

/** «Отключить телефоны»: every link of this trial stops working. */
export async function revokeWatchLinks(info: TrialInfo): Promise<number> {
  const { id, token } = linked(info);
  return (await call<{ revoked: number }>('/watch/revoke', token, { method: 'POST', body: { id } })).revoked;
}

/** The address the phone opens: this site with `#/watch/<token>`. */
export function watchUrl(token: string): string {
  return `${window.location.origin}${window.location.pathname}${watchHash(token)}`;
}

// ---------------------------------------------------------------------------
// The phone

export function fetchWatchState(viewerToken: string): Promise<TrialWatchState> {
  return call<TrialWatchState>('/watch', viewerToken, { method: 'GET' });
}

export function fetchWatchSnapshot(viewerToken: string): Promise<TrialWatchSnapshot> {
  return call<TrialWatchSnapshot>('/watch/snapshot', viewerToken, { method: 'GET', timeoutMs: SNAPSHOT_TIMEOUT_MS });
}
