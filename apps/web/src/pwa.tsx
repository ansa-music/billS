import { useCallback, useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

/**
 * PWA helpers for the hall tablets: is the interface running as an installed
 * app, is a new build waiting in the service worker, and can we offer to
 * install. The worker itself is built by vite-plugin-pwa (vite.config.ts) and
 * registered here, only in production builds — in dev there is no worker.
 */

const INSTALL_KEY = 'bills.pwa.install';
const UPDATE_CHECK_MS = 60 * 60 * 1000;
const RELOAD_FALLBACK_MS = 8000;

type InstallMemory = 'dismissed' | 'installed' | null;

function readInstallMemory(): InstallMemory {
  try {
    const v = localStorage.getItem(INSTALL_KEY);
    return v === 'dismissed' || v === 'installed' ? v : null;
  } catch {
    return null;
  }
}

function writeInstallMemory(value: Exclude<InstallMemory, null>): void {
  try {
    localStorage.setItem(INSTALL_KEY, value);
  } catch {
    // Not remembered; the banner just comes back on the next visit.
  }
}

// ---------------------------------------------------------------------------
// Standalone (installed) mode

const STANDALONE_QUERY = '(display-mode: standalone)';

/** True when the page runs as an installed app: no address bar, its own window (Android/desktop/iOS). */
export function isStandalone(): boolean {
  try {
    if (typeof matchMedia === 'function' && matchMedia(STANDALONE_QUERY).matches) return true;
    // iOS Safari has no display-mode media query on older versions; it sets navigator.standalone instead.
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export function useStandalone(): boolean {
  const [standalone, setStandalone] = useState(isStandalone);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(STANDALONE_QUERY);
    const onChange = () => setStandalone(isStandalone());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return standalone;
}

// ---------------------------------------------------------------------------
// Service worker update

/**
 * Registers the service worker and reports when a newer build is installed and
 * waiting. `update()` lets it take over (skipWaiting) and the page reloads;
 * nothing happens until the user asks.
 *
 * Only in production builds: with `devOptions.enabled: false` the plugin serves a
 * no-op stub for `virtual:pwa-register/react` under `vite dev`, so no worker is
 * registered there. The real hook also checks `'serviceWorker' in navigator`
 * itself (plain http on the club LAN has no service workers at all).
 */
export function useUpdatePrompt(): { needRefresh: boolean; update: () => void } {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      // A hall tablet stays open for days: ask the HUB for a newer build now and then
      // (sw.js is served with no-cache), so the banner appears without a reload.
      if (!registration) return;
      setInterval(() => void registration.update().catch(() => {}), UPDATE_CHECK_MS);
    },
    onRegisterError(error) {
      console.warn('[pwa] service worker registration failed', error);
    },
  });
  const update = useCallback(() => {
    // The plugin tells the waiting worker to take over and reloads once it controls the
    // page. If no worker is waiting (it already activated while this page was not yet
    // controlled), nothing would happen — reload anyway so the new build shows up.
    setTimeout(() => location.reload(), RELOAD_FALLBACK_MS);
    void updateServiceWorker(true);
  }, [updateServiceWorker]);
  return { needRefresh, update };
}

// ---------------------------------------------------------------------------
// Install prompt

/** Chrome/Edge/Samsung Internet `beforeinstallprompt` (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export type InstallKind = 'native' | 'ios' | null;

/** iPhone / iPad (iPadOS reports itself as a Mac with touch) running Safari proper, where only "Add to Home Screen" installs. */
function isIosSafari(): boolean {
  try {
    const ua = navigator.userAgent;
    const iPad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    const ios = /iPhone|iPad|iPod/.test(ua) || iPad;
    if (!ios) return false;
    // Other iOS browsers (Chrome, Firefox, Edge, Opera…) cannot add a PWA to the home screen.
    return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua);
  } catch {
    return false;
  }
}

/**
 * Which install hint to show: `native` once the browser offered `beforeinstallprompt`,
 * `ios` for Safari on iPhone/iPad (manual "Add to Home Screen"), `null` otherwise —
 * including when already installed or when the hint was dismissed once on this device.
 */
export function useInstallPrompt(): { kind: InstallKind; install: () => Promise<void>; dismiss: () => void } {
  const standalone = useStandalone();
  const [memory, setMemory] = useState<InstallMemory>(readInstallMemory);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [ios] = useState(isIosSafari);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      writeInstallMemory('installed');
      setMemory('installed');
      setDeferred(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    const e = deferred;
    if (!e) return;
    try {
      await e.prompt();
      const { outcome } = await e.userChoice;
      if (outcome === 'accepted') {
        writeInstallMemory('installed');
        setMemory('installed');
      }
    } catch {
      // The prompt can only be used once; a second call throws. Drop it either way.
    }
    setDeferred(null);
  }, [deferred]);

  const dismiss = useCallback(() => {
    writeInstallMemory('dismissed');
    setMemory('dismissed');
  }, []);

  let kind: InstallKind = null;
  if (!standalone && memory === null) {
    if (deferred) kind = 'native';
    else if (ios) kind = 'ios';
  }
  return { kind, install, dismiss };
}

// ---------------------------------------------------------------------------
// Banners

/** Up to two strips under the top bar: a waiting update and an install hint. */
export function PwaBanners() {
  const updatePrompt = useUpdatePrompt();
  const installPrompt = useInstallPrompt();
  return (
    <>
      {updatePrompt.needRefresh && (
        <div className="pwa-banner" data-kind="update" role="status">
          <p className="pwa-banner-text">Доступна новая версия интерфейса.</p>
          <div className="pwa-banner-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={updatePrompt.update}>
              Обновить
            </button>
          </div>
        </div>
      )}
      {installPrompt.kind === 'native' && (
        <div className="pwa-banner" data-kind="install" role="status">
          <p className="pwa-banner-text">Установите приложение: иконка на экране, работа на весь экран без адресной строки.</p>
          <div className="pwa-banner-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={() => void installPrompt.install()}>
              Установить
            </button>
            <button type="button" className="btn btn-small" onClick={installPrompt.dismiss}>
              Позже
            </button>
          </div>
        </div>
      )}
      {installPrompt.kind === 'ios' && (
        <div className="pwa-banner" data-kind="install" role="status">
          <p className="pwa-banner-text">
            Чтобы поставить на экран «Домой»: нажмите «Поделиться» <span aria-hidden="true">⎙</span> → «На экран „Домой“».
          </p>
          <div className="pwa-banner-actions">
            <button type="button" className="btn btn-small" onClick={installPrompt.dismiss}>
              Понятно
            </button>
          </div>
        </div>
      )}
    </>
  );
}
