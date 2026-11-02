/**
 * «Подключить устройство»: the WebRTC data channel, peer to peer. The device offers, the cash desk answers;
 * both wait for their ICE candidates (TRIAL_LINK.iceGatherMs at most) and send one complete description each
 * over the session — two relayed messages instead of a trickle of candidates. Public STUN servers tell each
 * side its address behind the router (they see only that address, never the data); inside one Wi-Fi the
 * local candidates are enough. When no path is found (AP isolation, a strict 4G NAT) the relay carries on.
 */
import { TRIAL_LINK } from '@bills/domain';
import { LINK_LOOPBACK } from './link-bus.ts';

const ICE_SERVERS: RTCIceServer[] = LINK_LOOPBACK ? [] : [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

export type LinkSdp = { type: 'offer' | 'answer'; sdp: string };

export function rtcAvailable(): boolean {
  // Development only: `localStorage['ts.link.relayOnly'] = '1'` tries the relay path without peer to peer.
  if (LINK_LOOPBACK || import.meta.env.DEV) {
    try {
      if (localStorage.getItem('ts.link.relayOnly') === '1') return false;
    } catch {
      // No storage: peer to peer as usual.
    }
  }
  return typeof RTCPeerConnection === 'function';
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, TRIAL_LINK.iceGatherMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function described(pc: RTCPeerConnection): LinkSdp {
  const d = pc.localDescription;
  if (!d || (d.type !== 'offer' && d.type !== 'answer')) throw new Error('no local description');
  return { type: d.type, sdp: d.sdp };
}

/** The device: a peer connection with its data channel, and the offer to send. */
export async function createOffer(): Promise<{ pc: RTCPeerConnection; dc: RTCDataChannel; offer: LinkSdp }> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const dc = pc.createDataChannel('ts', { ordered: true });
  dc.binaryType = 'arraybuffer';
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return { pc, dc, offer: described(pc) };
}

/** The cash desk: answers an offer; `channel` resolves when the device's data channel arrives. */
export async function acceptOffer(offer: LinkSdp): Promise<{ pc: RTCPeerConnection; answer: LinkSdp; channel: Promise<RTCDataChannel> }> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = new Promise<RTCDataChannel>((resolve) => {
    pc.ondatachannel = (e) => {
      e.channel.binaryType = 'arraybuffer';
      resolve(e.channel);
    };
  });
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { pc, answer: described(pc), channel };
}

/** True when `dc` is (or becomes) open within `ms`. */
export function waitOpen(dc: RTCDataChannel, ms: number): Promise<boolean> {
  if (dc.readyState === 'open') return Promise.resolve(true);
  if (dc.readyState === 'closing' || dc.readyState === 'closed') return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      dc.removeEventListener('open', onOpen);
      dc.removeEventListener('close', onClose);
      resolve(ok);
    };
    const onOpen = () => finish(true);
    const onClose = () => finish(false);
    const timer = setTimeout(() => finish(false), ms);
    dc.addEventListener('open', onOpen);
    dc.addEventListener('close', onClose);
  });
}

/** Resolves with `value`, or with null after `ms`. */
export function withTimeout<T>(value: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    value.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export function closePeer(pc: RTCPeerConnection | null): void {
  if (!pc) return;
  try {
    pc.close();
  } catch {
    // Already closed.
  }
}
