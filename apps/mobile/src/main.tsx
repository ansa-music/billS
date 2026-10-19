import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as CapApp } from '@capacitor/app';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Preferences } from '@capacitor/preferences';
import { SplashScreen } from '@capacitor/splash-screen';
import { FirebaseMessaging, Importance } from '@capacitor-firebase/messaging';
import { App } from '../../cloud-web/src/App.tsx';
import type { NativeBridge, PushTokenResult } from '../../cloud-web/src/platform.ts';
import { setNativeBridge } from '../../cloud-web/src/platform.ts';
import '../../cloud-web/src/styles.css';

/**
 * The owner's phone app: the cabinet from apps/cloud-web plus this native shell.
 * Stored values (cloud address, session token, device id) are read before the first
 * render so the bridge getters stay synchronous.
 */

const KEYS = { cloudUrl: 'ts.cloudUrl', token: 'ts.token', deviceId: 'ts.deviceId' } as const;

async function read(key: string): Promise<string | null> {
  return (await Preferences.get({ key })).value;
}

async function write(key: string, value: string | null): Promise<void> {
  if (value === null) await Preferences.remove({ key });
  else await Preferences.set({ key, value });
}

/** A push tap carries `data.clubId` (see PushData): open that club. */
function openFromPush(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const clubId = (data as Record<string, unknown>).clubId;
  if (typeof clubId === 'string' && clubId) location.hash = `#/clubs/${encodeURIComponent(clubId)}`;
}

async function setUpPush(): Promise<void> {
  // Registered before anything else, so a tap that launched the app is not lost.
  await FirebaseMessaging.addListener('notificationActionPerformed', (e) => openFromPush(e.notification.data));
  if (Capacitor.getPlatform() === 'android') {
    // Same id the cloud sends in android.notification.channel_id.
    await FirebaseMessaging.createChannel({
      id: 'alerts',
      name: 'Тревоги клуба',
      description: 'Свет без игры, нет электричества, HUB не на связи, смена не закрыта',
      importance: Importance.High,
      vibration: true,
    }).catch(() => {});
  }
}

async function pushToken(): Promise<PushTokenResult> {
  try {
    let perm = await FirebaseMessaging.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await FirebaseMessaging.requestPermissions();
    if (perm.receive !== 'granted') return { ok: false, reason: 'denied' };
    const { token } = await FirebaseMessaging.getToken();
    return { ok: true, token };
  } catch (e) {
    // Typically a build without google-services.json / GoogleService-Info.plist: Firebase is not configured.
    return { ok: false, reason: 'unavailable', message: (e as Error).message || 'Firebase не настроен в этой сборке' };
  }
}

async function scanQr(): Promise<string | null> {
  try {
    const res = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: 'Наведите камеру на QR в кабинете TS',
      scanButton: false,
    });
    return res.ScanResult || null;
  } catch {
    return null; // cancelled or no camera permission
  }
}

async function main(): Promise<void> {
  const [cloudUrl, token, deviceId, device, info] = await Promise.all([
    read(KEYS.cloudUrl),
    read(KEYS.token),
    read(KEYS.deviceId),
    Device.getInfo(),
    CapApp.getInfo().catch(() => ({ version: '0.1.0', build: '1' })),
  ]);
  const state = { cloudUrl, token, deviceId };
  const platform = Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
  const name = [device.manufacturer, device.model].filter(Boolean).join(' ').trim() || (platform === 'ios' ? 'iPhone' : 'Android');

  const bridge: NativeBridge = {
    platform,
    cloudUrl: () => state.cloudUrl,
    async setCloudUrl(url) {
      state.cloudUrl = url;
      await write(KEYS.cloudUrl, url);
    },
    token: () => state.token,
    async setToken(t) {
      state.token = t;
      await write(KEYS.token, t);
    },
    deviceId: () => state.deviceId,
    async setDeviceId(id) {
      state.deviceId = id;
      await write(KEYS.deviceId, id);
    },
    scanQr,
    pushToken,
    deviceName: () => name,
    appVersion: () => `${info.version} (${info.build})`,
  };
  setNativeBridge(bridge);
  await setUpPush().catch(() => {});

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await SplashScreen.hide().catch(() => {});
}

void main();
