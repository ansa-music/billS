/**
 * «Смотреть с телефона», the phone's side: the cash desk's latest snapshot from the TS cloud runs in an
 * in-page HUB, read-only, so the director signs in with their own code and sees the usual screens.
 *
 * - Separate from this phone's own trial: the copy lives in memory only (never IndexedDB, never the
 *   «ts-trial-hub» lock), its session is kept under its own key (auth.ts), and it never calls /start or
 *   /report — it cannot pose as the trial.
 * - Read-only: every write except signing in and out is refused before it reaches the HUB
 *   (watchRequestAllowed), and the license the screens see is marked read-only so they switch buttons off.
 * - Fresh: every minute while the page is on screen it asks the cloud when the last snapshot came (a few
 *   bytes) and downloads only a newer one; the new copy replaces the old under the same fetch / events
 *   stand-ins, and the phone's sign-in sessions are carried over, so nobody has to sign in again.
 */
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { TRIAL_WATCH, TRIAL_WATCH_READ_ONLY_MESSAGE, watchRequestAllowed, watchSnapshotNewer } from '@bills/domain';
import { systemClock } from '@ts-hub/clock.ts';
import { openDb } from '@ts-hub/db.ts';
import { buildApp } from '@ts-hub/http/app.ts';
import type { ChangeEvent } from '@ts-hub/hub.ts';
import { Hub } from '@ts-hub/hub.ts';
import { SimulatorLampDriver } from '@ts-hub/lamps/simulator.ts';
import { DEMO_LICENSE_KEYS } from '@ts-hub/demo-license.ts';
import { installEventSource, installFetch } from './boot.ts';
import type { InjectOptions, InjectResponse, MiniFastify } from './mini-fastify.ts';
import type { DatabaseSync } from './shims/sqlite.ts';
import { provideSqlJs } from './shims/sqlite.ts';
import { fetchWatchSnapshot, fetchWatchState, WatchHttpError } from './trial-watch.ts';
import type { WatchProblemKind } from './watch-mode.ts';
import { setWatchRefresh, updateWatchView, watchView } from './watch-mode.ts';

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;

/** Why the copy could not open (WatchProblemKind): the link is off, nothing sent yet, no internet, a broken copy. */
export class WatchProblem extends Error {
  constructor(
    readonly kind: WatchProblemKind,
    message: string,
  ) {
    super(message);
  }
}

/** The license as the phone's screens see it: read-only, in the phone's words. */
const WATCH_LICENSE_MESSAGE = 'это телефон для просмотра, менять можно только на кассе.';

interface Copy {
  db: DatabaseSync;
  hub: Hub;
  app: MiniFastify;
  snapshotAt: number;
}

function problemOf(err: unknown): WatchProblem {
  if (err instanceof WatchProblem) return err;
  if (err instanceof WatchHttpError) {
    if (err.status === 401) return new WatchProblem('revoked', err.message);
    if (err.status === 404) return new WatchProblem('empty', err.message);
    return new WatchProblem('offline', err.message);
  }
  return new WatchProblem('broken', err instanceof Error ? err.message : String(err));
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** An in-page HUB over a snapshot. Not started: no timers, nothing of its own is written. */
async function openCopy(SQL: SqlJs, bytes: Uint8Array, snapshotAt: number): Promise<Copy> {
  let db: DatabaseSync;
  try {
    provideSqlJs(SQL, bytes);
    db = openDb(':memory:');
  } catch (err) {
    throw new WatchProblem('broken', `Данные кассы не открылись: ${err instanceof Error ? err.message : String(err)}. Обновите страницу на кассе и здесь.`);
  }
  const simulator = new SimulatorLampDriver();
  const hub = new Hub({ db, clock: systemClock, lampDriver: simulator, license: { mode: 'enforce', publicKeys: DEMO_LICENSE_KEYS } });
  const app = buildApp(hub, {
    simulator,
    logger: false,
    dbPath: ':memory:',
    startedAt: Date.now(),
    version: { version: 'trial', gitSha: null },
  });
  await hub.license.init();
  return { db, hub, app, snapshotAt };
}

/**
 * The phone's sign-ins live only in its copy: carried into the new one, so a refresh keeps the person
 * signed in. A session whose key was revoked at the cash desk stops working there (the HUB checks the key).
 */
function carrySessions(from: DatabaseSync, to: DatabaseSync): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = from.prepare('SELECT * FROM auth_sessions WHERE revoked_at IS NULL').all() as Array<Record<string, unknown>>;
  } catch {
    return;
  }
  for (const row of rows) {
    const cols = Object.keys(row);
    try {
      to.prepare(`INSERT OR IGNORE INTO auth_sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
        ...cols.map((c) => row[c] as null | number | string | Uint8Array),
      );
    } catch {
      // A person or key the new copy no longer has: that session ends, a new sign-in is needed.
    }
  }
}

const JSON_HEADERS = (): Record<string, string> => ({ 'content-type': 'application/json; charset=utf-8' });

function answer(statusCode: number, body: string, headers: Record<string, string>): InjectResponse {
  return {
    statusCode,
    headers,
    body,
    payload: body,
    json<T>() {
      return JSON.parse(body) as T;
    },
  };
}

const readOnlyRefusal = (): InjectResponse =>
  answer(403, JSON.stringify({ error: { code: 'WATCH_READ_ONLY', message: TRIAL_WATCH_READ_ONLY_MESSAGE } }), JSON_HEADERS());

/** Where the screens read the license (HubState.license, MeResponse.license, LicenseResponse.status). */
const LICENSE_FIELD: Record<string, 'license' | 'status'> = { '/api/state': 'license', '/api/auth/me': 'license', '/api/license': 'status' };

/** The license in the answer, marked read-only with the phone's words; anything else passes untouched. */
function markReadOnly(url: string, res: InjectResponse): InjectResponse {
  const field = LICENSE_FIELD[url.split('?', 1)[0] ?? ''];
  if (!field || res.statusCode !== 200) return res;
  try {
    const body = JSON.parse(res.body) as Record<string, unknown>;
    const license = body[field];
    if (!license || typeof license !== 'object') return res;
    body[field] = { ...license, readOnly: true, message: WATCH_LICENSE_MESSAGE };
    const { 'content-length': _length, ...headers } = res.headers;
    return answer(res.statusCode, JSON.stringify(body), headers);
  } catch {
    return res;
  }
}

let started: Promise<void> | null = null;

/** Opens the copy for `token`; rejects with a WatchProblem when it cannot. Once per page. */
export function startWatchHub(token: string): Promise<void> {
  started ??= bootWatch(token);
  return started;
}

async function bootWatch(token: string): Promise<void> {
  let SQL: SqlJs;
  let current: Copy;
  try {
    const [sql, state] = await Promise.all([initSqlJs({ locateFile: () => wasmUrl }), fetchWatchState(token)]);
    SQL = sql;
    updateWatchView({ venue: state.venue, checkedAt: Date.now() });
    if (state.snapshotAt === null) {
      throw new WatchProblem('empty', 'Касса ещё не прислала данные. Откройте TS на кассе с интернетом и подождите минуту.');
    }
    const snap = await fetchWatchSnapshot(token);
    current = await openCopy(SQL, fromBase64(snap.snapshot), snap.snapshotAt);
  } catch (err) {
    throw problemOf(err);
  }
  updateWatchView({ snapshotAt: current.snapshotAt, offline: false });

  // One stream of change events for the screens, whichever copy is current.
  const relay = new Set<(e: ChangeEvent) => void>();
  const emit = (e: ChangeEvent) => {
    for (const l of relay) l(e);
  };
  const forward = (e: ChangeEvent) => emit(e);
  current.hub.events.on('changed', forward);

  const app = {
    async inject(options: InjectOptions): Promise<InjectResponse> {
      const method = (options.method ?? 'GET').toUpperCase();
      if (watchView().revoked || !watchRequestAllowed(method, options.url)) return readOnlyRefusal();
      return markReadOnly(options.url, await current.app.inject(options));
    },
  };
  installFetch(app, () => {});
  installEventSource({
    events: {
      on: (_event: 'changed', listener: (e: ChangeEvent) => void) => relay.add(listener),
      off: (_event: 'changed', listener: (e: ChangeEvent) => void) => relay.delete(listener),
    },
  });

  const swap = async (bytes: Uint8Array, snapshotAt: number) => {
    const next = await openCopy(SQL, bytes, snapshotAt);
    carrySessions(current.db, next.db);
    const old = current;
    old.hub.events.off('changed', forward);
    next.hub.events.on('changed', forward);
    current = next;
    // Requests already inside the old copy finish first; then it is closed.
    setTimeout(() => {
      try {
        old.hub.close();
        old.db.close();
      } catch {
        // Already closed.
      }
    }, 5000);
    // The screens refetch on any change event: the state, the counter, the reports.
    emit({ kind: 'counter' });
  };

  let running: Promise<void> | null = null;
  let lastCheck = Date.now();
  const check = async (): Promise<void> => {
    lastCheck = Date.now();
    updateWatchView({ checking: true });
    try {
      const state = await fetchWatchState(token);
      updateWatchView({ venue: state.venue, checkedAt: Date.now(), offline: false });
      if (watchSnapshotNewer(state.snapshotAt, current.snapshotAt)) {
        const snap = await fetchWatchSnapshot(token);
        if (watchSnapshotNewer(snap.snapshotAt, current.snapshotAt)) await swap(fromBase64(snap.snapshot), snap.snapshotAt);
        updateWatchView({ snapshotAt: current.snapshotAt });
      }
    } catch (err) {
      const problem = problemOf(err);
      if (problem.kind === 'revoked') {
        // Switched off at the cash desk: the data leaves this phone too.
        updateWatchView({ revoked: true });
        try {
          current.hub.close();
          current.db.close();
        } catch {
          // Already closed.
        }
        return;
      }
      if (problem.kind === 'broken') console.warn('[watch] the new copy did not open, keeping the old one', err);
      updateWatchView({ offline: problem.kind === 'offline' });
    } finally {
      updateWatchView({ checking: false });
    }
  };
  const checkNow = () => {
    if (watchView().revoked) return;
    running ??= check().finally(() => {
      running = null;
    });
  };
  setWatchRefresh(checkNow);
  // Every minute while the page is on screen; at once when it comes back after a while.
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck >= TRIAL_WATCH.checkEveryMs) checkNow();
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck >= TRIAL_WATCH.checkEveryMs / 2) checkNow();
  });
}
