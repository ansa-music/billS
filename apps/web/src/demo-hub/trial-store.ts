/**
 * Where the browser trial keeps its coffee shop (VITE_TRIAL=1): IndexedDB, not localStorage —
 * two weeks of orders outgrow localStorage's few megabytes. One record holds the SQLite file
 * and the facts the trial needs before the HUB starts (when it began, the venue, the
 * manager's key for «Показать код»). Small and dependency-free, so the banner can import it
 * without pulling in the HUB.
 */

const DB_NAME = 'ts-trial';
const STORE = 'trial';
const RECORD = 'current';

/** Length of the trial, days. */
export const TRIAL_DAYS = 14;
const DAY_MS = 86_400_000;

/** True when the build is the two-week browser trial (VITE_TRIAL=1, on top of VITE_DEMO_LOCAL=1). */
export const TRIAL = import.meta.env.VITE_TRIAL === '1';

export interface TrialInfo {
  startedAt: number;
  venue: string;
  managerName: string;
  managerKey: string;
}

export interface TrialRecord extends TrialInfo {
  db: Uint8Array;
  savedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB недоступна'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB: запись не удалась'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB: запись прервана'));
    });
  } finally {
    db.close();
  }
}

export async function loadTrial(): Promise<TrialRecord | null> {
  try {
    const rec = await withStore<TrialRecord | undefined>('readonly', (s) => s.get(RECORD) as IDBRequest<TrialRecord | undefined>);
    return rec && rec.db instanceof Uint8Array ? rec : null;
  } catch {
    return null;
  }
}

export async function saveTrial(rec: TrialRecord): Promise<void> {
  await withStore('readwrite', (s) => s.put(rec, RECORD));
}

export async function clearTrial(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(RECORD));
}

/** The facts of the running trial, for the banner (set by boot.ts). */
let current: TrialInfo | null = null;
export function setCurrentTrial(info: TrialInfo): void {
  current = info;
}
export function currentTrial(): TrialInfo | null {
  return current;
}

/** Whole days left, rounded up; 0 once the trial is over. */
export function daysLeft(info: Pick<TrialInfo, 'startedAt'>, now = Date.now()): number {
  return Math.max(0, Math.ceil((info.startedAt + TRIAL_DAYS * DAY_MS - now) / DAY_MS));
}

export function trialEndsAt(info: Pick<TrialInfo, 'startedAt'>): number {
  return info.startedAt + TRIAL_DAYS * DAY_MS;
}

/** «Скачать копию»: the whole coffee shop as one file, to keep or to move to another browser. */
export async function downloadBackup(): Promise<void> {
  const rec = await loadTrial();
  if (!rec) return;
  const payload = JSON.stringify({
    format: 'ts-trial-backup',
    version: 1,
    startedAt: rec.startedAt,
    venue: rec.venue,
    managerName: rec.managerName,
    managerKey: rec.managerKey,
    savedAt: rec.savedAt,
    db: toBase64(rec.db),
  });
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const a = document.createElement('a');
  const day = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `TS-${safeName(rec.venue)}-${day}.ts-backup.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** «Восстановить из копии»: replaces this browser's coffee shop with the file's. */
export async function restoreBackup(file: File): Promise<void> {
  const data = JSON.parse(await file.text()) as Partial<Record<string, unknown>>;
  if (data.format !== 'ts-trial-backup' || typeof data.db !== 'string' || typeof data.startedAt !== 'number') {
    throw new Error('Это не копия TS: выберите файл «….ts-backup.json»');
  }
  await saveTrial({
    db: fromBase64(data.db),
    startedAt: data.startedAt,
    venue: String(data.venue ?? ''),
    managerName: String(data.managerName ?? ''),
    managerKey: String(data.managerKey ?? ''),
    savedAt: Date.now(),
  });
}

// Latin only: Chromium drops a download name with Cyrillic letters and saves the file as «download».
const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
  я: 'ya', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i',
};

function safeName(name: string): string {
  const latin = [...name.toLowerCase()].map((c) => LATIN[c] ?? c).join('');
  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'kofeynya';
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
