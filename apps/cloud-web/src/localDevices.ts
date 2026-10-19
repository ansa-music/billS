/**
 * Device rows this browser/app registered itself (Supabase mode): Web Push of this browser and the
 * ntfy topic of this phone. Kept in localStorage so the page shows «это устройство» and sign-out
 * removes them from the cloud.
 */

export interface LocalDevice {
  deviceId: string;
  /** Web Push: the subscription endpoint; ntfy: the topic URL. */
  token: string;
}

type Kind = 'webpush' | 'ntfy';

const KEY: Record<Kind, string> = { webpush: 'ts.device.webpush', ntfy: 'ts.device.ntfy' };

export function readLocalDevice(kind: Kind): LocalDevice | null {
  try {
    const raw = localStorage.getItem(KEY[kind]);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LocalDevice>;
    return typeof v.deviceId === 'string' && typeof v.token === 'string' ? { deviceId: v.deviceId, token: v.token } : null;
  } catch {
    return null;
  }
}

export function writeLocalDevice(kind: Kind, device: LocalDevice | null): void {
  try {
    if (device) localStorage.setItem(KEY[kind], JSON.stringify(device));
    else localStorage.removeItem(KEY[kind]);
  } catch {
    // storage blocked — the device still works, only the «это устройство» mark is lost
  }
}

export function localDeviceIds(): string[] {
  return (['webpush', 'ntfy'] as const).flatMap((k) => {
    const d = readLocalDevice(k);
    return d ? [d.deviceId] : [];
  });
}

export function forgetLocalDevices(): void {
  writeLocalDevice('webpush', null);
  writeLocalDevice('ntfy', null);
}
