import type { DeviceView } from '@bills/domain';
import { registerDevice } from './api.ts';
import { readLocalDevice, writeLocalDevice } from './localDevices.ts';
import { nativeBridge } from './platform.ts';
import { ntfyTopicName, ntfyTopicUrl } from './supabase-util.ts';

/**
 * Push through ntfy (Supabase mode, mainly the Android app: its WebView has no Web Push).
 * The cloud posts alerts to a secret topic; the free ntfy app on the phone is subscribed to it.
 */

export function newNtfyTopicUrl(server: string): string {
  const random = new Uint8Array(24);
  crypto.getRandomValues(random);
  return ntfyTopicUrl(server, ntfyTopicName(random));
}

/** The topic this device uses (null before the first «Получать уведомления через ntfy»). */
export function currentNtfyTopic(): { deviceId: string; topicUrl: string } | null {
  const d = readLocalDevice('ntfy');
  return d ? { deviceId: d.deviceId, topicUrl: d.token } : null;
}

/** Registers the topic URL as a device 'ntfy'; the same topic keeps its device id. */
export async function enableNtfy(topicUrl: string): Promise<DeviceView> {
  const bridge = nativeBridge();
  const device = await registerDevice({
    platform: 'ntfy',
    token: topicUrl,
    name: bridge ? `${bridge.deviceName()} (ntfy)` : 'ntfy',
  });
  writeLocalDevice('ntfy', { deviceId: device.id, token: topicUrl });
  if (bridge) await bridge.setDeviceId(device.id).catch(() => undefined);
  return device;
}

export function forgetNtfy(): void {
  writeLocalDevice('ntfy', null);
}
