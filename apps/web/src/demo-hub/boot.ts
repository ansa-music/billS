/**
 * The public demo without a server (VITE_DEMO_LOCAL=1): the real HUB (apps/hub/src)
 * runs inside the page on SQLite compiled to WebAssembly. main.tsx imports this
 * module dynamically, only in that build, and waits for startDemoHub() before
 * rendering. From then on window.fetch('/api/…') and new EventSource('/api/events')
 * are answered by the in-page HUB, so the screens run their normal code.
 *
 * The club is saved to localStorage after every change and wiped at the first
 * load after 04:00 (or by «Сбросить демо»).
 */
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { cloudHeaders, DEMO_KEYS, trialPageLicense, trialWithoutReloadLink } from '@bills/domain';
import { systemClock } from '@ts-hub/clock.ts';
import { openDb } from '@ts-hub/db.ts';
import { buildApp } from '@ts-hub/http/app.ts';
import { Hub } from '@ts-hub/hub.ts';
import { SimulatorLampDriver } from '@ts-hub/lamps/simulator.ts';
import { SimulatorUps } from '@ts-hub/power/ups.ts';
import { seedDemo } from '@ts-hub/seed.ts';
import { DEMO_LICENSE_KEYS, installDemoLicense } from '@ts-hub/demo-license.ts';
import type { MiniFastify } from './mini-fastify.ts';
import type { DatabaseSync } from './shims/sqlite.ts';
import { provideSqlJs } from './shims/sqlite.ts';
import { clearSnapshot, loadSnapshot, nextResetAt, resetDemo, saveSnapshot } from './storage.ts';
import { setupTrialClub, trialKey } from '@ts-hub/trial.ts';
import type { TrialInfo, TrialRecord } from './trial-store.ts';
import { loadTrial, newInstallId, saveTrial, setCurrentTrial, setTrialCheckNow, setTrialPersist, TRIAL_DAYS, updateCurrentTrial } from './trial-store.ts';
import type { TrialTerms } from './trial-cloud.ts';
import { startTrialCloud, TRIAL_CLOUD_URL } from './trial-cloud.ts';
import { setWatchSoonHook } from './trial-watch.ts';
import { installEventSource, installFetch } from './page-api.ts';
import { installTrialLinkHost } from './link-host.ts';
import { movedLicenseView, registerTrialSaverHalt } from './trial-move.ts';
import { trialDirector } from './trial-director.ts';

// watch-hub.ts and older callers import the page stand-ins from here.
export { installEventSource, installFetch };

const SAVE_DEBOUNCE_MS = 800;

let started: Promise<void> | null = null;

export function startDemoHub(): Promise<void> {
  started ??= boot();
  return started;
}

async function boot(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });

  let db: DatabaseSync;
  const saved = loadSnapshot();
  try {
    provideSqlJs(SQL, saved);
    db = openDb(':memory:');
  } catch (err) {
    // A snapshot from an incompatible build: start a fresh club instead of a broken page.
    console.warn('[demo] saved demo club could not be opened, starting over', err);
    clearSnapshot();
    provideSqlJs(SQL, null);
    db = openDb(':memory:');
  }

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty';
  seedDemo(db, Date.now(), timezone);

  const simulator = new SimulatorLampDriver();
  const ups = new SimulatorUps();
  // Demo keys (four digits) and a trial license the HUB signs itself with the dev key on every start;
  // a browser without Ed25519 in WebCrypto gets the demo without license checks instead.
  const hub = new Hub({ db, clock: systemClock, lampDriver: simulator, ups, demo: true, license: { mode: 'enforce', publicKeys: DEMO_LICENSE_KEYS } });
  const app = buildApp(hub, {
    simulator,
    upsSimulator: ups,
    logger: false,
    dbPath: ':memory:',
    startedAt: Date.now(),
    version: { version: 'demo', gitSha: null },
    demo: { resetAt: () => nextResetAt(Date.now()) },
  });
  await hub.license.init();
  await installDemoLicense(hub.license, Date.now());
  hub.start();
  // The demo people of DEMO_KEYS (each with their roles) are found or created and get their fixed keys.
  hub.auth.issueFixedKeys(DEMO_KEYS);

  const changed = keepSaved(db, hub);
  scheduleNightlyReset();
  installFetch(app, changed);
  installEventSource(hub);
}

/**
 * Saves the database shortly after every change event and every command (a login
 * changes the database without an event), and when the tab is hidden or closed.
 * Returns the "something changed" trigger.
 */
function keepSaved(db: DatabaseSync, hub: Hub): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    // sql.js cannot serialise in the middle of a transaction; the HUB's are synchronous,
    // so this only happens if a save is triggered from inside one — try again shortly.
    if (db.isTransaction) {
      timer = setTimeout(save, 50);
      return;
    }
    saveSnapshot(db.export());
  };
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };
  hub.events.on('changed', changed);
  const flush = () => {
    if (timer !== undefined) save();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  save();
  return changed;
}

/** A tab left open overnight starts over at 04:00 too. */
function scheduleNightlyReset(): void {
  const now = Date.now();
  setTimeout(resetDemo, Math.min(nextResetAt(now) - now, 2 ** 31 - 1));
}

/** What the welcome screen asks before a new trial starts. */
export interface NewTrial {
  venue: string;
  managerName: string;
  withMenu: boolean;
}

let trialStarted: Promise<TrialInfo> | null = null;

/** Is there a saved trial coffee shop in this browser? (Then the welcome screen is skipped.) */
export async function hasSavedTrial(): Promise<boolean> {
  return (await loadTrial()) !== null;
}

/**
 * The two-week browser trial (VITE_TRIAL=1): the same in-page HUB as the demo, but the coffee
 * shop is the person's own — kept in IndexedDB with no nightly reset, no demo keys. `fresh` creates
 * it (first visit): the club from the welcome form is set up at once, but with the TS cloud it is a
 * request ('pending', read-only) until TS approves it (trial-cloud.ts); otherwise the saved one is opened.
 */
export function startTrialHub(fresh: NewTrial | null): Promise<TrialInfo> {
  trialStarted ??= bootTrial(fresh);
  return trialStarted;
}

async function bootTrial(fresh: NewTrial | null): Promise<TrialInfo> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const saved = await loadTrial();
  const now = Date.now();
  let info: TrialInfo;
  let db: DatabaseSync;
  if (saved) {
    provideSqlJs(SQL, saved.db);
    db = openDb(':memory:');
    // Records from before the cloud link have no cloud fields: they load as they are. One that an old
    // cached page linked to TRIAL_RELOAD_ID (the cloud told it to reload) becomes a request again.
    const { db: _bytes, savedAt: _savedAt, ...facts } = saved;
    info = trialWithoutReloadLink(facts);
  } else {
    provideSqlJs(SQL, null);
    db = openDb(':memory:');
    info = {
      startedAt: now,
      venue: fresh?.venue.trim() || 'Моя кофейня',
      managerName: fresh?.managerName.trim() || 'Директор',
      managerKey: trialKey(),
      // With the TS cloud a new trial is a request until TS approves it; the installId is saved with the
      // first save below, before trial-cloud.ts sends it. The menu choice goes with the request: a request
      // approved straight into the cloud cash desk gets the sample menu there too.
      ...(TRIAL_CLOUD_URL ? { status: 'pending' as const, installId: newInstallId(), withMenu: fresh?.withMenu ?? true } : {}),
    };
  }
  setCurrentTrial(info);

  // A coffee shop has no lamps or UPS: no simulated UPS, so the topbar shows no power badge.
  const simulator = new SimulatorLampDriver();
  const hub = new Hub({ db, clock: systemClock, lampDriver: simulator, license: { mode: 'enforce', publicKeys: DEMO_LICENSE_KEYS } });
  const app = buildApp(hub, {
    simulator,
    logger: false,
    dbPath: ':memory:',
    startedAt: now,
    version: { version: 'trial', gitSha: null },
  });
  await hub.license.init();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty';
  if (!saved) {
    setupTrialClub(hub, { venue: info.venue, managerName: info.managerName, key: info.managerKey, timezone, withMenu: fresh?.withMenu ?? true, now });
  }
  // After the club exists: the license names this HUB by its club (before it, signing fails and
  // licenses would be switched off for the whole session).
  // A cash desk that was moved to another computer stays read-only (trial-move.ts).
  await installTrialLicense(hub, movedLicenseView(info), now);
  hub.start();

  // Ask the browser not to evict the coffee shop under storage pressure (best effort).
  void navigator.storage?.persist?.().catch(() => false);
  // A copy from the cabinet comes without the manager's code: give the manager a new one to sign in with.
  // A café moved in from another computer (trial-move.ts) keeps its people's codes: none is added.
  if (saved && !info.managerKey && !info.movedIn) {
    const managerKey = trialKey();
    hub.auth.issueFixedKeys([{ roles: ['manager'], name: info.managerName || 'Директор', key: managerKey }]);
    updateCurrentTrial({ managerKey });
  }
  const saver = keepTrialSaved(db, hub, info);
  registerTrialSaverHalt(saver.halt);
  const persist = (patch: Partial<TrialInfo>) => {
    updateCurrentTrial(patch);
    return saver.saveNow();
  };
  setTrialPersist(persist);
  // The director's code for the platform owner (trial-director.ts): which code works now, TS's new one.
  const director = trialDirector({ db, hub, info, persist });
  hub.events.on('changed', (e) => {
    if (e.kind === 'staff') director.check();
  });
  // Every request of this tab and of the linked devices: a key issued to the director is remembered.
  const injector = {
    inject: async (req: Parameters<typeof app.inject>[0]) => {
      const res = await app.inject(req);
      director.noted(req, res);
      return res;
    },
  };
  installFetch(injector, saver.changed);
  installEventSource(hub);
  // «Подключить устройство»: phones and tablets of the staff work through this tab's HUB (link-host.ts).
  if (!info.localOnly) {
    installTrialLinkHost({
      // The café moved to the cloud cash desk: every answer tells the device where it is now (LinkBanner.tsx).
      inject: async (req) => {
        const res = await injector.inject(req);
        return info.cloud ? { ...res, headers: { ...res.headers, ...cloudHeaders(info.cloud) } } : res;
      },
      changed: saver.changed,
      onChange: (listener) => {
        const l = (e: object) => listener(e);
        hub.events.on('changed', l);
        return () => hub.events.off('changed', l);
      },
      secret: () => info.linkSecret ?? null,
      devices: () => info.linkDevices ?? [],
      saveSecret: (linkSecret) => {
        updateCurrentTrial({ linkSecret });
        saver.saveNow();
      },
      rememberDevices: (linkDevices) => updateCurrentTrial({ linkDevices }),
    });
  }

  // The TS cloud: reports of how the trial goes, and its terms back (never waited for).
  const link = startTrialCloud({
    db,
    info,
    timezone,
    onChange: (listener) => hub.events.on('changed', listener),
    persist,
    // The codes for the platform owner: the café code and the director's code that works now.
    codes: () => ({
      ...(info.cafeCode ? { cafeCode: info.cafeCode } : {}),
      ...director.codes(),
      ...(info.directorKeyRefused ? { directorKeyRefused: info.directorKeyRefused } : {}),
    }),
    installDirectorKey: (key) => director.install(key),
    applyTerms: (_terms: TrialTerms) => {
      void installTrialLicense(hub, movedLicenseView(info), Date.now()).catch((err: unknown) => console.warn('[trial] could not apply the new terms', err));
    },
    // «Касса перенесена на другой компьютер»: no new orders here (trial-move.ts).
    onMoved: () => {
      void installTrialLicense(hub, movedLicenseView(info), Date.now()).catch((err: unknown) => console.warn('[trial] could not lock the moved cash desk', err));
    },
    // «Касса переехала в облако»: no new orders here either (TrialCloud.tsx shows the way there).
    onCloud: () => {
      void installTrialLicense(hub, movedLicenseView(info), Date.now()).catch((err: unknown) => console.warn('[trial] could not lock the cash desk moved to the cloud', err));
    },
  });
  if (link) {
    (window as unknown as { __tsTrialReportNow?: () => Promise<unknown> }).__tsTrialReportNow = link.reportNow;
    // «Открыть на телефоне»: a fresh copy goes up right away, so the phone opens on current data.
    setWatchSoonHook(link.watchSoon);
    // «Проверить сейчас» on the waiting screen.
    setTrialCheckNow(link.reportNow);
  }
  return info;
}

/**
 * The trial license of the in-page HUB (trialPageLicense): until the end the cloud set (or startedAt +
 * TRIAL_DAYS before it answered); a request waiting for TS and a trial that is over are valid until now,
 * so the counter is read-only; a permanent one («Полная версия») never runs out.
 */
async function installTrialLicense(hub: Hub, info: TrialInfo, now: number): Promise<void> {
  const { validUntil, permanent } = trialPageLicense(info, now, TRIAL_DAYS);
  await installDemoLicense(hub.license, now, {
    startedAt: info.startedAt,
    days: TRIAL_DAYS,
    endsAt: validUntil,
    companyName: info.venue,
    ...(permanent ? { permanent: true } : {}),
  });
}

/**
 * Like keepSaved, into IndexedDB; the first save happens right away so a new trial survives a reload.
 * `saveNow` resolves once this save is written (the installId is on disk before the first /start).
 */
function keepTrialSaved(db: DatabaseSync, hub: Hub, info: TrialInfo): { changed: () => void; saveNow: () => Promise<void>; halt: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();
  // Halted when a café moved in from another computer replaces this one (trial-move.ts), until the reload.
  let halted = false;
  const save = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (halted) return writing;
    if (db.isTransaction) {
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => void save().then(resolve), 50);
      });
    }
    const rec: TrialRecord = { ...info, db: db.export(), savedAt: Date.now() };
    writing = writing.then(() => (halted ? undefined : saveTrial(rec))).catch((err: unknown) => console.warn('[trial] could not save the coffee shop', err));
    return writing;
  };
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };
  hub.events.on('changed', changed);
  const flush = () => {
    if (timer !== undefined) save();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  save();
  return {
    changed,
    saveNow: save,
    halt: () => {
      halted = true;
      clearTimeout(timer);
    },
  };
}
