import { useCallback, useState } from 'react';
import type { Theme } from '@bills/domain';

/** Per-device choice: `auto` follows the club's setting (and the OS when the club says `auto` too). */
export type ThemePreference = 'auto' | 'dark' | 'light';

const KEY = 'bills.theme';
const ORDER: readonly ThemePreference[] = ['auto', 'dark', 'light'];

function read(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** Writes data-theme on <html>: the device preference wins, then the club setting, then the OS. */
export function applyTheme(device: ThemePreference, club: Theme = 'auto'): void {
  const effective = device === 'auto' ? club : device;
  const root = document.documentElement;
  if (effective === 'auto') delete root.dataset.theme;
  else root.dataset.theme = effective;
}

/** Called before the first render so the page never flashes the wrong theme. */
export function applyStoredTheme(): void {
  applyTheme(read());
}

/** Auto (follows the club / device) → dark → light, remembered per device. App applies it. */
export function useTheme(): { theme: ThemePreference; cycle: () => void } {
  const [theme, setTheme] = useState<ThemePreference>(read);
  const cycle = useCallback(() => {
    setTheme((current) => {
      const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'auto';
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // Not remembered; still applied for this visit.
      }
      return next;
    });
  }, []);
  return { theme, cycle };
}
