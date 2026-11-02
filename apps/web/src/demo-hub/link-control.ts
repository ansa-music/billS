/**
 * «Подключить устройство» at the cash desk, the light half: what the dialog shows (the link, the devices,
 * whether the cash desk reaches the TS cloud) and the two things it can ask for — make the link, and
 * «Отключить все устройства». The in-page HUB's side (link-host.ts, started from boot.ts) fills this in;
 * the dialog (trial/TrialLink.tsx) imports only this module, so it never pulls in the HUB.
 */
import type { LinkView } from '@bills/domain';

/** A device as the cash desk remembers it (kept with the trial in IndexedDB, never sent anywhere). */
export interface StoredLinkDevice {
  id: string;
  name: string;
  /** Who was signed in there last. */
  who: string | null;
  view: LinkView;
  firstSeen: number;
  lastSeen: number;
}

export interface LinkDeviceView extends StoredLinkDevice {
  /** A session is alive right now. */
  online: boolean;
  /** …and runs peer to peer (inside the Wi-Fi) rather than through the TS cloud. */
  direct: boolean;
}

export interface LinkHostState {
  /** The link secret, null until the director first opens the dialog. */
  secret: string | null;
  /** The cash desk reaches the relay (Supabase Realtime). */
  connected: boolean;
  devices: LinkDeviceView[];
}

export interface LinkHostApi {
  /** The link secret, made (and the cash desk opened to devices) on first use. */
  enable(): Promise<string>;
  /** «Отключить все устройства»: devices on line are told, the secret changes; resolves with the new one. */
  rotate(): Promise<string>;
}

let api: LinkHostApi | null = null;
let state: LinkHostState = { secret: null, connected: false, devices: [] };
let version = 0;
const listeners = new Set<() => void>();

export function setLinkHostApi(next: LinkHostApi | null): void {
  api = next;
  version++;
  for (const l of listeners) l();
}

/** null when this page is not a cash desk that can take devices (another build, a viewing copy). */
export function linkHostApi(): LinkHostApi | null {
  return api;
}

export function linkHostState(): LinkHostState {
  return state;
}

export function updateLinkHostState(patch: Partial<LinkHostState>): void {
  state = { ...state, ...patch };
  version++;
  for (const l of listeners) l();
}

export function subscribeLinkHost(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function linkHostVersion(): number {
  return version;
}
