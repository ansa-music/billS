import { useSyncExternalStore } from 'react';
import { registerDevice } from './api.ts';
import { nativeBridge } from './platform.ts';

/** Push state of this phone, as the «Телефон и уведомления» page shows it. */
export type PhonePushStatus =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'on'; deviceId: string }
  | { state: 'denied' }
  | { state: 'unavailable'; message: string }
  | { state: 'error'; message: string };

let status: PhonePushStatus = { state: 'idle' };
let running: Promise<PhonePushStatus> | null = null;
const listeners = new Set<() => void>();

function set(next: PhonePushStatus): PhonePushStatus {
  status = next;
  for (const l of listeners) l();
  return next;
}

/**
 * Asks the phone for the notification permission and the FCM token and registers this
 * phone in the cloud (idempotent by token, so it is safe on every start: the token may
 * have changed). Never throws — the cabinet works without pushes.
 */
export function enablePhonePush(): Promise<PhonePushStatus> {
  const bridge = nativeBridge();
  if (!bridge) return Promise.resolve(status);
  if (running) return running;
  set({ state: 'pending' });
  running = (async () => {
    try {
      const result = await bridge.pushToken();
      if (!result.ok) {
        return set(result.reason === 'denied' ? { state: 'denied' } : { state: 'unavailable', message: result.message });
      }
      const device = await registerDevice({
        token: result.token,
        platform: bridge.platform,
        name: bridge.deviceName(),
      });
      await bridge.setDeviceId(device.id);
      return set({ state: 'on', deviceId: device.id });
    } catch (e) {
      return set({ state: 'error', message: (e as Error).message || 'Не удалось зарегистрировать телефон' });
    } finally {
      running = null;
    }
  })();
  return running;
}

/** After sign-out the phone is no longer in the device list. */
export function resetPhonePush(): void {
  set({ state: 'idle' });
}

export function usePhonePushStatus(): PhonePushStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => status,
  );
}
