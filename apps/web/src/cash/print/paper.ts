import { useSyncExternalStore } from 'react';

/** Thermal roll width, mm. */
export type Paper = '58' | '80';

export const PAPERS: readonly Paper[] = ['58', '80'];

const KEY = 'bills.printer.paper';
const DEFAULT_PAPER: Paper = '80';

function isPaper(value: unknown): value is Paper {
  return value === '58' || value === '80';
}

function readStored(): Paper | null {
  try {
    const value = localStorage.getItem(KEY);
    return isPaper(value) ? value : null;
  } catch {
    return null;
  }
}

// Kept in memory too: with storage blocked (private mode) the choice still lasts the session.
// undefined — not read yet; null — this device follows the club.
let device: Paper | null | undefined;
/** The club's width from «Настройки» → «Чек» (receipt.paper), kept current by useHub from /api/state. */
let club: Paper | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The width picked on this device («Принтер: 58 / 80 мм» in «Счета»), or null when it follows the club. */
export function devicePaper(): Paper | null {
  if (device === undefined) device = readStored();
  return device;
}

/** The club's width (state.settings.receipt.paper); useHub sets it with every state from the HUB. */
export function setClubPaper(paper: unknown): void {
  const next = isPaper(paper) ? paper : null;
  if (next === club) return;
  club = next;
  notify();
}

/**
 * The paper width to print on: this device's own pick (a till with a different printer), else
 * the club's width from «Настройки» → «Чек», else 80 mm.
 */
export function getPaper(): Paper {
  return devicePaper() ?? club ?? DEFAULT_PAPER;
}

/** `null` forgets this device's pick: it follows the club again. */
export function setPaper(paper: Paper | null): void {
  device = paper;
  try {
    if (paper) localStorage.setItem(KEY, paper);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: remembered until the page reloads.
  }
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab on the same device changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    device = readStored();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** This device's own pick (null — it follows the club), live. */
export function useDevicePaper(): Paper | null {
  return useSyncExternalStore(subscribe, devicePaper);
}

/** The width this device prints on, live. */
export function usePaper(): Paper {
  return useSyncExternalStore(subscribe, getPaper);
}
