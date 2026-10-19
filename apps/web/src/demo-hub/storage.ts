/**
 * Where the in-browser demo club lives between visits: the SQLite file, base64
 * in localStorage. Small and dependency-free, so the demo banner can import it
 * without pulling in the HUB.
 */

const DB_KEY = 'ts.demo.db';
const SAVED_AT_KEY = 'ts.demo.savedAt';

/** The demo is wiped every night at this hour, the visitor's local time. */
export const RESET_HOUR = 4;

/** True when the build runs the HUB inside the page (VITE_DEMO_LOCAL=1). */
export const DEMO_LOCAL = import.meta.env.VITE_DEMO_LOCAL === '1';

/** The most recent nightly reset at or before `now`. */
export function lastResetAt(now: number): number {
  const d = new Date(now);
  d.setHours(RESET_HOUR, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** The next nightly reset after `now`. */
export function nextResetAt(now: number): number {
  const d = new Date(now);
  d.setHours(RESET_HOUR, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
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

/** The saved club, or null when there is none or it was saved before the last nightly reset. */
export function loadSnapshot(now = Date.now()): Uint8Array | null {
  try {
    const savedAt = Number(localStorage.getItem(SAVED_AT_KEY));
    const data = localStorage.getItem(DB_KEY);
    if (!data || !Number.isFinite(savedAt) || savedAt < lastResetAt(now)) {
      clearSnapshot();
      return null;
    }
    return fromBase64(data);
  } catch {
    return null;
  }
}

export function saveSnapshot(bytes: Uint8Array, now = Date.now()): void {
  try {
    localStorage.setItem(DB_KEY, toBase64(bytes));
    localStorage.setItem(SAVED_AT_KEY, String(now));
  } catch (err) {
    // Storage full or blocked (private mode): the demo still works, it just is not kept.
    console.warn('[demo] could not save the demo club', err);
  }
}

export function clearSnapshot(): void {
  try {
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem(SAVED_AT_KEY);
  } catch {
    // Nothing stored or storage blocked: nothing to clear.
  }
}

/** «Сбросить демо»: forget the saved club and start over with a fresh one. */
export function resetDemo(): void {
  clearSnapshot();
  window.location.reload();
}
