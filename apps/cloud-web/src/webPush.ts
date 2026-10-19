import { registerDevice } from './api.ts';
import { vapidPublicKey } from './config.ts';
import { readLocalDevice, writeLocalDevice } from './localDevices.ts';
import { base64UrlToBytes, isIos, isVapidPublicKey } from './supabase-util.ts';

/** Web Push of this browser (Supabase mode): the installed PWA on Android/desktop, iOS 16.4+ from the home screen. */
export type WebPushSupport =
  | { ok: true }
  | { ok: false; reason: 'no-key' | 'unsupported' | 'ios-not-installed' | 'insecure' };

function standalone(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function webPushSupport(): WebPushSupport {
  if (!isVapidPublicKey(vapidPublicKey())) return { ok: false, reason: 'no-key' };
  if (!isSecureContext) return { ok: false, reason: 'insecure' };
  const ios = isIos(navigator.userAgent, navigator.maxTouchPoints);
  if (ios && !standalone()) return { ok: false, reason: 'ios-not-installed' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, reason: ios ? 'ios-not-installed' : 'unsupported' };
  }
  return { ok: true };
}

export type WebPushResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: 'denied' | 'unsupported' | 'error'; message: string };

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua)
    ? 'Android'
    : isIos(ua, navigator.maxTouchPoints)
      ? 'iPhone/iPad'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Браузер';
  return [browser, os].filter(Boolean).join(', ') + (standalone() ? ' (приложение)' : '');
}

/** Permission → push subscription (VAPID) → device row 'webpush' with the subscription JSON as the token. */
export async function enableWebPush(): Promise<WebPushResult> {
  const support = webPushSupport();
  if (!support.ok) return { ok: false, reason: 'unsupported', message: support.reason };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return { ok: false, reason: 'denied', message: 'Уведомления запрещены в настройках браузера' };
    }
    const reg = await navigator.serviceWorker.ready;
    const key = base64UrlToBytes(vapidPublicKey());
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with another VAPID key cannot be used: replace it.
    if (sub && sub.options.applicationServerKey) {
      const old = new Uint8Array(sub.options.applicationServerKey);
      if (old.length !== key.length || old.some((b, i) => b !== key[i])) {
        await sub.unsubscribe().catch(() => false);
        sub = null;
      }
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const device = await registerDevice({ platform: 'webpush', token: JSON.stringify(sub), name: deviceName() });
    writeLocalDevice('webpush', { deviceId: device.id, token: sub.endpoint });
    return { ok: true, deviceId: device.id };
  } catch (e) {
    return { ok: false, reason: 'error', message: (e as Error).message || 'Не удалось включить уведомления' };
  }
}

/** Id of this browser's device row, if it registered one. */
export function webPushDeviceId(): string | null {
  return readLocalDevice('webpush')?.deviceId ?? null;
}

/** After the row was deleted in the list: stop the browser subscription too. */
export async function disableWebPush(): Promise<void> {
  writeLocalDevice('webpush', null);
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // nothing to undo
  }
}
