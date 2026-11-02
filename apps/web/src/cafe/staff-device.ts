import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import { audioReady, unlockAudio } from './cafe.ts';

/**
 * A staff tablet or phone at the bar (the barista's KDS, the guest board): sound that really
 * plays, a screen that does not go dark, and a screen-filling layout.
 */

/** Taps and keys that count as a user gesture for audio (a touch `pointerdown` does not). */
const GESTURES = ['pointerup', 'touchend', 'click', 'keydown'] as const;

/**
 * Browsers keep sound off until the first tap on the page. While `enabled` (the sound switch
 * of this device is on) and the sound is still locked, the very first tap or key anywhere
 * unlocks it — the barista does not have to find a button. `unlocked` drives the hint
 * «коснитесь экрана, чтобы включить звук». A tablet that slept or switched apps may lock it
 * again (iOS «interrupted»): the hint comes back and the next tap unlocks it again.
 */
export function useAudioUnlock(enabled: boolean): { unlocked: boolean; unlock: () => Promise<boolean> } {
  const [unlocked, setUnlocked] = useState(audioReady);

  const unlock = useCallback(async () => {
    preferPlayback();
    const ok = await unlockAudio();
    setUnlocked(ok);
    return ok;
  }, []);

  useEffect(() => {
    if (!enabled || unlocked) return;
    const onGesture = () => void unlock();
    for (const type of GESTURES) document.addEventListener(type, onGesture, { capture: true, passive: true });
    return () => {
      for (const type of GESTURES) document.removeEventListener(type, onGesture, { capture: true });
    };
  }, [enabled, unlocked, unlock]);

  // Coming back to the page (screen on, another app closed): is the sound still running?
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') setUnlocked(audioReady());
    };
    document.addEventListener('visibilitychange', check);
    const t = setInterval(check, 5000);
    return () => {
      document.removeEventListener('visibilitychange', check);
      clearInterval(t);
    };
  }, []);

  return { unlocked, unlock };
}

/**
 * iOS 17+ Safari: a «playback» audio session plays even with the ring switch on silent —
 * a beep the barista cannot hear is no beep. Elsewhere there is no such API: nothing to do.
 */
function preferPlayback(): void {
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session && session.type !== 'playback') session.type = 'playback';
  } catch {
    // Not allowed here: the default session still plays when the switch is on ring.
  }
}

export type AwakeStatus = 'on' | 'off' | 'unsupported';

/**
 * Keeps the screen on while the page is visible (Screen Wake Lock API) and says whether it
 * worked: 'on'; 'off' — the browser refused (battery saver; it is asked again on the next tap
 * and when the page is shown again); 'unsupported' — no API here, notably over plain http on
 * the café's network (not a secure context): the screen then follows the tablet's own
 * auto-lock setting, and the KDS says so once.
 */
export function useScreenAwake(enabled = true): AwakeStatus {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator && window.isSecureContext;
  const [status, setStatus] = useState<AwakeStatus>(supported ? 'off' : 'unsupported');

  useEffect(() => {
    if (!enabled || !supported) return;
    let sentinel: WakeLockSentinel | null = null;
    let pending = false;
    let disposed = false;

    const acquire = async () => {
      if (disposed || pending || sentinel || document.visibilityState !== 'visible') return;
      pending = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (disposed) {
          void lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
        setStatus('on');
        // The browser drops the lock when the page is hidden: forget it, ask again when shown.
        lock.addEventListener('release', () => {
          if (sentinel === lock) {
            sentinel = null;
            if (!disposed) setStatus('off');
          }
        });
      } catch {
        if (!disposed) setStatus('off');
      } finally {
        pending = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    // A refusal without a user gesture (some browsers) is retried on the next tap.
    const onTap = () => void acquire();
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('fullscreenchange', onVisible);
    document.addEventListener('pointerup', onTap, { passive: true });
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('fullscreenchange', onVisible);
      document.removeEventListener('pointerup', onTap);
      const lock = sentinel;
      sentinel = null;
      if (lock) void lock.release().catch(() => {});
    };
  }, [enabled, supported]);

  return status;
}

/**
 * Sets `--fill-h` on the element: the height from its top to the bottom of the window (less
 * `bottomGap`, e.g. the phone tab bar), so a KDS fills the screen and its columns scroll
 * inside instead of the page. Follows resizes, rotation and banners appearing above it.
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, deps: readonly unknown[] = []): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = el.getBoundingClientRect().top + window.scrollY;
        const height = (window.visualViewport?.height ?? window.innerHeight) - top;
        el.style.setProperty('--fill-h', `${Math.max(0, Math.floor(height))}px`);
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    // Banners above (offline, licence, demo) change the top without a window resize.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const shellMain = el.closest('.shell-main');
    const watch = () => {
      if (!observer) return;
      observer.disconnect();
      if (shellMain) for (const child of Array.from(shellMain.children)) if (!child.contains(el)) observer.observe(child);
      if (el.parentElement) observer.observe(el.parentElement);
    };
    watch();
    // A banner added or removed above (offline, demo, licence): watch the new set and measure.
    const added = shellMain && typeof MutationObserver !== 'undefined' ? new MutationObserver(() => (watch(), measure())) : null;
    if (added && shellMain) added.observe(shellMain, { childList: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      observer?.disconnect();
      added?.disconnect();
    };
  }, deps);
}
