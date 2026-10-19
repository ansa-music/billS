/** Shared by both backends (api-http.ts, api-supabase.ts): the error type and the shell signals. */
import type { DevicePlatform } from '@bills/domain';

/**
 * Platforms a device row can have. 'webpush' (the installed cabinet PWA) and 'ntfy' (the Android
 * app via the ntfy app) exist only with the Supabase backend; the union stays valid whether or not
 * the domain's DevicePlatform already lists them.
 */
export type AnyDevicePlatform = DevicePlatform | 'webpush' | 'ntfy';

/** POST /owner/devices: idempotent by token (FCM token, PushSubscription JSON or ntfy topic URL). */
export interface RegisterDeviceBody {
  token: string;
  platform: AnyDevicePlatform;
  name?: string;
}

export class CloudRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Connectivity and auth signals from every request, so the shell can show a banner or the login form. */
export type ApiSignal = { type: 'online'; online: boolean } | { type: 'unauthorized' };

const listeners = new Set<(signal: ApiSignal) => void>();

export function subscribeApi(listener: (signal: ApiSignal) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emit(signal: ApiSignal): void {
  for (const l of listeners) l(signal);
}
