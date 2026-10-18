import { useSyncExternalStore } from 'react';

/** Thermal roll width, mm. */
export type Paper = '58' | '80';

export const PAPERS: readonly Paper[] = ['58', '80'];

const KEY = 'bills.printer.paper';
const DEFAULT_PAPER: Paper = '80';

function isPaper(value: unknown): value is Paper {
  return value === '58' || value === '80';
}

function readStored(): Paper {
  try {
    const value = localStorage.getItem(KEY);
    return isPaper(value) ? value : DEFAULT_PAPER;
  } catch {
    return DEFAULT_PAPER;
  }
}

// Kept in memory too: with storage blocked (private mode) the choice still lasts the session.
let current: Paper | null = null;
const listeners = new Set<() => void>();

/** The paper width chosen on this device; 80 mm until someone picks another. */
export function getPaper(): Paper {
  current ??= readStored();
  return current;
}

export function setPaper(paper: Paper): void {
  current = paper;
  try {
    localStorage.setItem(KEY, paper);
  } catch {
    // Storage unavailable: remembered until the page reloads.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab on the same device changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    current = readStored();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function usePaper(): Paper {
  return useSyncExternalStore(subscribe, getPaper);
}
