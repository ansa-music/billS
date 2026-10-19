import { useCallback, useEffect, useState } from 'react';
import { useStandalone } from './pwa.tsx';

/** Hall-tablet helpers: fullscreen toggle and keeping the screen awake. */

function swallow(p: Promise<unknown> | undefined): void {
  // Older engines return undefined instead of a promise.
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function isFullscreenSupported(): boolean {
  try {
    return Boolean(document.fullscreenEnabled) && typeof document.documentElement.requestFullscreen === 'function';
  } catch {
    return false;
  }
}

function isFullscreenActive(): boolean {
  return document.fullscreenElement != null;
}

export function useFullscreen(): { supported: boolean; active: boolean; toggle: () => void } {
  const [api] = useState(isFullscreenSupported);
  // Installed as an app (PWA standalone) there is no address bar already; the button would be noise.
  const standalone = useStandalone();
  const supported = api && !standalone;
  const [active, setActive] = useState(isFullscreenActive);

  useEffect(() => {
    const onChange = () => setActive(isFullscreenActive());
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    try {
      if (isFullscreenActive()) {
        swallow(document.exitFullscreen());
      } else {
        swallow(document.documentElement.requestFullscreen({ navigationUI: 'hide' }));
      }
    } catch {
      // Not allowed here (no user gesture, iframe without permission, …) — stay as is.
    }
  }, []);

  return { supported, active, toggle };
}

/**
 * Keeps a hall tablet's screen on while the page is visible.
 * Silently does nothing where the Screen Wake Lock API is unavailable —
 * notably over plain http on the club LAN (not a secure context).
 */
export function useWakeLock(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    if (!('wakeLock' in navigator) || !window.isSecureContext) return;

    let sentinel: WakeLockSentinel | null = null;
    let pending = false;
    let disposed = false;

    const acquire = async () => {
      if (disposed || pending || sentinel || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (disposed) {
          swallow(lock.release());
          return;
        }
        sentinel = lock;
        // The browser drops the lock when the page is hidden; forget it so it can be re-requested.
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      } catch {
        // Denied (battery saver, policy, hidden page) — try again on the next visibility change.
      } finally {
        pending = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      const lock = sentinel;
      sentinel = null;
      if (lock) {
        try {
          swallow(lock.release());
        } catch {
          // Already released.
        }
      }
    };
  }, [enabled]);
}
