import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as CapApp } from '@capacitor/app';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import { Preferences } from '@capacitor/preferences';
import { SplashScreen } from '@capacitor/splash-screen';
import { App } from '../../cloud-web/src/App.tsx';
import { SUPABASE_MODE } from '../../cloud-web/src/config.ts';
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

/**
 * No push service of our own (no Firebase/Google account needed): alerts come through the free
 * ntfy app, connected on the cabinet page «Телефон и уведомления». A tap on an ntfy notification
 * opens the cabinet link the cloud put in it. The self-hosted cloud has no ntfy channel yet.
 */
async function pushToken(): Promise<PushTokenResult> {
  return {
    ok: false,
    reason: 'unavailable',
    message: SUPABASE_MODE
      ? 'тревоги приходят через бесплатное приложение ntfy — включите его в разделе «Уведомления через ntfy»'
      : 'в сборке для своего облака уведомлений на телефон нет, тревоги видны в кабинете',
  };
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

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await SplashScreen.hide().catch(() => {});
}

void main();
