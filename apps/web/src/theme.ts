import { useCallback, useState } from 'react';

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

function apply(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'auto') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

/** Called before the first render so the page never flashes the wrong theme. */
export function applyStoredTheme(): void {
  apply(read());
}

/** Auto (follows the device) → dark → light, remembered per device. */
export function useTheme(): { theme: ThemePreference; cycle: () => void } {
  const [theme, setTheme] = useState<ThemePreference>(read);
  const cycle = useCallback(() => {
    setTheme((current) => {
      const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'auto';
      apply(next);
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
