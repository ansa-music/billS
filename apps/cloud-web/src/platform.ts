/**
 * Where the cabinet runs. In the browser it is served by the cloud itself: same-origin
 * requests, HttpOnly cookie. Inside the phone app (apps/mobile, Capacitor) the shell
 * registers a NativeBridge before the first render: requests go to the cloud address
 * from the app settings with `Authorization: Bearer <token>` and `x-ts-app: 1`, and the
 * shell adds what a browser cannot do — QR scanner and the FCM token for pushes.
 * Notification taps are handled by the shell itself (it sets `location.hash`).
 *
 * The cabinet never imports Capacitor: everything native is behind this interface.
 * Getters are synchronous: the shell loads the stored values before the first render.
 */
export interface NativeBridge {
  platform: 'android' | 'ios';
  /** Cloud address from the app settings ("https://cloud.example.kz"), null until set. */
  cloudUrl(): string | null;
  setCloudUrl(url: string | null): Promise<void>;
  /** Owner session token, null when signed out. */
  token(): string | null;
  setToken(token: string | null): Promise<void>;
  /** Id of this phone in the cloud's device list (from POST /api/owner/devices), null when not registered. */
  deviceId(): string | null;
  setDeviceId(id: string | null): Promise<void>;
  /** Opens the camera; resolves with the scanned text, null when cancelled. */
  scanQr(): Promise<string | null>;
  /** Asks for the notification permission and returns the FCM registration token. */
  pushToken(): Promise<PushTokenResult>;
  /** "Pixel 8" — shown in the device list. */
  deviceName(): string;
  /** App version for the settings screen ("0.1.0 (1)"). */
  appVersion(): string;
}

export type PushTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'denied' }
  | { ok: false; reason: 'unavailable'; message: string };

let bridge: NativeBridge | null = null;

export function setNativeBridge(b: NativeBridge): void {
  bridge = b;
}

export function nativeBridge(): NativeBridge | null {
  return bridge;
}
