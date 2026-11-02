/**
 * «Подключить устройство», the device's side: the normal TS web app runs here, but there is no HUB and no
 * venue database on this phone or tablet. `fetch('/api/…')` and `new EventSource('/api/events')` are carried
 * to the cash desk (link-host.ts), which answers from its in-page HUB exactly as for its own screens.
 *
 * - Connection: hello on the lobby → welcome on this device's pair topic → a session (relay), then peer to
 *   peer when possible. The pure state machine (packages/domain trial-link.ts linkStep) decides when to say
 *   hello again; the cash desk's «up» brings the device back at once after the cash desk reopens.
 * - Requests: queued while the cash desk is being reached (TRIAL_LINK.queueWaitMs), failed at once while it is
 *   known to be away (the page then shows its usual «нет связи» and the status line says why). A request lost
 *   with a broken session is resent with the same id only when that is safe (reads, writes with their
 *   Idempotency-Key — LinkRequests / linkResendable); a keyless write that may have arrived fails instead.
 * - Liveness: a request unanswered for TRIAL_LINK.pingAfterMs, or a long silence, sends a ping; no answer
 *   within TRIAL_LINK.pingTimeoutMs means the session is gone.
 */
import type { LinkControl, LinkDeviceInfo, LinkFailure, LinkFrame, LinkInput, LinkKeys, LinkMachine } from '@bills/domain';
import {
  controlAad,
  deriveLinkKeys,
  deriveSessionKey,
  deviceNameFromUserAgent,
  isLinkDeviceId,
  LINK_START,
  linkCompression,
  LinkRequests,
  linkStatus,
  linkStep,
  openControl,
  parseLinkControl,
  randomLinkId,
  sealControl,
  TRIAL_LINK,
} from '@bills/domain';
import { AUTH_CHANGED_EVENT, readAuth, readDevice } from '../auth.ts';
import type { LinkBus } from './link-bus.ts';
import { createLinkBus } from './link-bus.ts';
import type { LinkTarget } from './link-mode.ts';
import { clearLinkStorage, LINK_DEVICE_KEY, setLinkRetry, updateLinkView } from './link-mode.ts';
import type { LinkSdp } from './link-peer.ts';
import { closePeer, createOffer, rtcAvailable, waitOpen, withTimeout } from './link-peer.ts';
import { LinkSession } from './link-session.ts';
import type { Injector } from './page-api.ts';
import { installFetch, isHubPath } from './page-api.ts';

const HOST = 'h';

function deviceId(): string {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const v = storage.getItem(LINK_DEVICE_KEY);
      if (isLinkDeviceId(v)) return v;
    } catch {
      // Blocked storage: try the next one.
    }
  }
  const id = randomLinkId(TRIAL_LINK.deviceIdBytes);
  for (const storage of [localStorage, sessionStorage]) {
    try {
      storage.setItem(LINK_DEVICE_KEY, id);
    } catch {
      // Not remembered: a reload shows up as a new device in the cash desk's list.
    }
  }
  return id;
}

const FAILURE_TEXT: Record<LinkFailure, string> = {
  offline: 'Касса не отвечает',
  lost: 'Связь с кассой прервалась',
  timeout: 'Касса не ответила вовремя',
};

let started = false;

/** Puts the page's fetch / EventSource stand-ins in place (synchronously) and starts connecting. Once per page. */
export function startLinkDevice(target: LinkTarget): void {
  if (started) return;
  started = true;
  const device = new Device(target);
  installFetch(device, () => {});
  installLinkEventSource(device);
  setLinkRetry(() => device.retry());
  void device.start();
}

class Device implements Injector {
  readonly #target: LinkTarget;
  readonly #id = deviceId();
  readonly #book = new LinkRequests();
  #machine: LinkMachine = LINK_START;
  #keys: LinkKeys | null = null;
  #bus: LinkBus | null = null;
  #lobbyName = '';
  #pairName = '';
  #lobby: ReturnType<LinkBus['join']> | null = null;
  #pair: ReturnType<LinkBus['join']> | null = null;
  #nonce: string | null = null;
  #session: LinkSession | null = null;
  /** The cash-desk instance of the session (its «up» with another one means the session is gone). */
  #hostInstance: string | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ping: { at: number } | null = null;
  #pc: RTCPeerConnection | null = null;
  #answer: ((sdp: LinkSdp) => void) | null = null;
  #directTimer: ReturnType<typeof setTimeout> | undefined;
  #directAttempt = 0;
  #cloud = false;
  readonly #changeListeners = new Set<(data: string) => void>();
  readonly #upListeners = new Set<() => void>();

  constructor(target: LinkTarget) {
    this.#target = target;
  }

  get up(): boolean {
    return this.#machine.phase === 'up' && this.#session !== null;
  }

  onChange(listener: (data: string) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  onUpChange(listener: () => void): () => void {
    this.#upListeners.add(listener);
    return () => this.#upListeners.delete(listener);
  }

  async start(): Promise<void> {
    try {
      this.#keys = await deriveLinkKeys(this.#target.secret);
    } catch {
      updateLinkView({ status: 'offline', problem: 'Этот браузер не умеет шифровать связь. Откройте ссылку с кассы в Chrome, Safari или Edge.' });
      this.#book.failAll('offline');
      return;
    }
    this.#lobbyName = `tsl-${this.#keys.room}`;
    this.#pairName = `tsl-${this.#keys.room}-${this.#id}`;
    this.#bus = createLinkBus((up) => {
      this.#cloud = up;
      this.#publish();
      if (up && this.#machine.phase !== 'up') this.#dispatch('retry');
    });
    this.#pair = this.#bus.join(this.#pairName, (event, payload) => void this.#onPair(event, payload));
    this.#lobby = this.#bus.join(this.#lobbyName, (event, payload) => void this.#onLobby(event, payload));
    this.#bus.connect();
    this.#dispatch('start');

    setInterval(() => this.#tick(), 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this.#bus?.nudge();
      this.#wake();
    });
    window.addEventListener('online', () => {
      this.#bus?.nudge();
      this.#wake();
    });
    window.addEventListener(AUTH_CHANGED_EVENT, () => {
      if (this.up) void this.#session!.send({ t: 'info', info: this.#info() });
    });
    window.addEventListener('pagehide', () => {
      if (this.up) void this.#session!.send({ t: 'bye' });
    });
  }

  /** «Повторить» on the status line. */
  retry(): void {
    this.#bus?.nudge();
    this.#dispatch('retry');
  }

  #wake(): void {
    if (this.#machine.phase !== 'up') {
      this.#dispatch('retry');
      return;
    }
    const silent = this.#session ? Date.now() - this.#session.lastHeard : Infinity;
    // Asleep longer than the cash desk keeps a quiet session: it is gone, start a new one at once.
    if (silent > TRIAL_LINK.sessionIdleMs - 15_000) this.#dispatch('lost');
    else if (silent > TRIAL_LINK.idlePingMs) this.#sendPing();
  }

  // -- the state machine -----------------------------------------------------

  #dispatch(input: LinkInput): void {
    const wasUp = this.up;
    const wasRevoked = this.#machine.phase === 'revoked';
    const now = Date.now();
    const { m, fx } = linkStep(this.#machine, input, now);
    this.#machine = m;
    if (fx.lost) {
      this.#endSession();
      this.#book.sessionLost(now);
    }
    if (fx.failQueued) this.#book.expire(now, 0);
    if (fx.timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer =
        fx.timer === null
          ? undefined
          : setTimeout(() => {
              // A phone in a pocket does not keep calling an absent cash desk: it tries again when it is on screen.
              if (document.visibilityState === 'hidden' && this.#machine.phase === 'down' && !this.#machine.waiting) return;
              this.#dispatch('timer');
            }, fx.timer);
    }
    if (fx.hello) void this.#sendHello();
    if (fx.flush) {
      this.#flush();
      this.#directAttempt = 0;
      this.#scheduleDirect(300);
    }
    if (m.phase === 'revoked' && !wasRevoked) this.#revoked();
    this.#publish();
    if (wasUp !== this.up) for (const l of this.#upListeners) l();
  }

  #publish(): void {
    updateLinkView({ status: linkStatus(this.#machine), direct: this.#machine.direct, cloud: this.#cloud });
  }

  #info(): LinkDeviceInfo {
    const name = readDevice().trim() || deviceNameFromUserAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0);
    return { name: name.slice(0, 120), who: readAuth()?.staff.name ?? null, view: this.#target.view };
  }

  async #sendHello(): Promise<void> {
    if (!this.#keys || !this.#lobby || !this.#pair) return;
    const nonce = randomLinkId(TRIAL_LINK.nonceBytes);
    this.#nonce = nonce;
    // The welcome comes on the pair topic: be there before asking (else it is lost and the hello times out).
    await this.#pair.ready();
    if (this.#nonce !== nonce) return;
    const hello: LinkControl = { t: 'hello', d: this.#id, n: nonce, at: Date.now(), z: linkCompression(), info: this.#info() };
    this.#lobby.send('c', { f: this.#id, x: await sealControl(this.#keys.control, hello, controlAad(this.#lobbyName, this.#id)) });
  }

  async #onLobby(event: string, payload: unknown): Promise<void> {
    const p = payload as { f?: unknown; x?: unknown } | null;
    // Other devices' hellos are not for us.
    if (event !== 'c' || !p || p.f !== HOST || !this.#keys) return;
    const ctl = parseLinkControl(await openControl(this.#keys.control, p.x, controlAad(this.#lobbyName, HOST)));
    if (!ctl) return;
    if (ctl.t === 'up') {
      if (this.up && ctl.hi === this.#hostInstance) return;
      this.#dispatch('host-up');
    } else if (ctl.t === 'bye') {
      if (ctl.hi === this.#hostInstance) this.#dispatch('host-bye');
    }
  }

  async #onPair(event: string, payload: unknown): Promise<void> {
    const p = payload as { f?: unknown; s?: unknown; x?: unknown } | null;
    if (!p || p.f !== HOST || !this.#keys) return;
    if (event === 'd') {
      if (this.#session && p.s === this.#session.id) this.#session.receiveRelay(p.x);
      return;
    }
    if (event !== 'c') return;
    const ctl = parseLinkControl(await openControl(this.#keys.control, p.x, controlAad(this.#pairName, HOST)));
    if (!ctl) return;
    if (ctl.t === 'revoked' && ctl.d === this.#id) {
      this.#dispatch('revoked');
      return;
    }
    if (ctl.t !== 'welcome' || ctl.d !== this.#id || ctl.nd !== this.#nonce) return;
    this.#nonce = null;
    const key = await deriveSessionKey(this.#keys.base, ctl.nd, ctl.n);
    this.#endSession();
    const pair = this.#pair!;
    const sid = ctl.s;
    const session: LinkSession = new LinkSession({
      id: sid,
      key,
      out: 'd2h',
      compress: ctl.z && linkCompression(),
      relay: (chunks) => pair.send('d', { f: this.#id, s: sid, x: chunks }),
      onFrame: (frame) => this.#onFrame(session, frame),
    });
    this.#session = session;
    this.#hostInstance = ctl.hi;
    this.#ping = null;
    this.#dispatch('welcome');
  }

  #onFrame(session: LinkSession, frame: LinkFrame): void {
    if (session !== this.#session) return;
    switch (frame.t) {
      case 'res':
        this.#book.settle(frame);
        return;
      case 'ev':
        for (const data of frame.e) for (const l of this.#changeListeners) l(data);
        return;
      case 'pong':
        this.#ping = null;
        return;
      case 'sdp':
        if (frame.d.type === 'answer') this.#answer?.(frame.d);
        return;
      case 'bye':
        this.#dispatch('host-bye');
        return;
      default:
        return;
    }
  }

  #endSession(): void {
    clearTimeout(this.#directTimer);
    this.#session?.close();
    this.#session = null;
    closePeer(this.#pc);
    this.#pc = null;
    this.#answer = null;
    this.#ping = null;
  }

  #revoked(): void {
    clearTimeout(this.#timer);
    this.#endSession();
    this.#book.failAll('offline');
    clearLinkStorage();
    this.#bus?.close();
  }

  // -- requests --------------------------------------------------------------

  inject(options: Parameters<Injector['inject']>[0]): ReturnType<Injector['inject']> {
    const frame = {
      t: 'req' as const,
      id: randomLinkId(9),
      m: (options.method ?? 'GET').toUpperCase(),
      u: options.url,
      h: options.headers ?? {},
      ...(typeof options.payload === 'string' ? { b: options.payload } : options.payload !== undefined ? { b: JSON.stringify(options.payload) } : {}),
    };
    return new Promise((resolve, reject) => {
      this.#book.add(
        frame,
        Date.now(),
        (res) => resolve({ statusCode: res.s, headers: res.h, body: res.b }),
        // Rejects like a lost network: the screens show «нет связи» and api.ts retries keyed commands with the same key.
        (why) => reject(new TypeError(FAILURE_TEXT[why])),
      );
      options.signal?.addEventListener('abort', () => this.#book.drop(frame.id), { once: true });
      const phase = this.#machine.phase;
      if (this.up) this.#flush();
      else if (phase === 'revoked' || (phase === 'down' && !this.#machine.waiting)) this.#book.expire(Date.now(), 0);
    });
  }

  #flush(): void {
    const session = this.#session;
    if (!session || !this.up) return;
    const now = Date.now();
    const queued = this.#book.queued();
    if (queued.length > 0 && now - session.lastHeard > TRIAL_LINK.idlePingMs) this.#sendPing();
    for (const frame of queued) {
      this.#book.markSent(frame.id, now);
      void session.send(frame);
    }
  }

  #sendPing(): void {
    if (!this.#session || this.#ping) return;
    const at = Date.now();
    this.#ping = { at };
    void this.#session.send({ t: 'ping', at });
  }

  #tick(): void {
    const now = Date.now();
    const away = this.#machine.phase === 'revoked' || (this.#machine.phase === 'down' && !this.#machine.waiting);
    this.#book.expire(now, away ? 0 : TRIAL_LINK.queueWaitMs);
    const session = this.#session;
    if (!this.up || !session) return;
    if (this.#ping) {
      if (now - this.#ping.at >= TRIAL_LINK.pingTimeoutMs && session.lastHeard < this.#ping.at) {
        this.#ping = null;
        this.#dispatch('lost');
      }
      return;
    }
    const silent = now - session.lastHeard;
    if (this.#book.oldestWaitMs(now) >= TRIAL_LINK.pingAfterMs && silent >= TRIAL_LINK.pingAfterMs) this.#sendPing();
    else if (document.visibilityState === 'visible' && silent >= TRIAL_LINK.idlePingMs) this.#sendPing();
  }

  // -- peer to peer ----------------------------------------------------------

  #scheduleDirect(ms: number): void {
    clearTimeout(this.#directTimer);
    if (!rtcAvailable()) return;
    this.#directTimer = setTimeout(() => void this.#tryDirect(), ms);
  }

  async #tryDirect(): Promise<void> {
    const session = this.#session;
    if (!session || !this.up || session.direct) return;
    closePeer(this.#pc);
    this.#pc = null;
    const fail = () => {
      if (this.#session !== session) return;
      closePeer(this.#pc);
      this.#pc = null;
      this.#directAttempt++;
      this.#scheduleDirect(Math.min(TRIAL_LINK.directRetryMaxMs, TRIAL_LINK.directRetryMs * 2 ** (this.#directAttempt - 1)));
    };
    let made: Awaited<ReturnType<typeof createOffer>>;
    try {
      made = await createOffer();
    } catch {
      fail();
      return;
    }
    if (this.#session !== session) {
      closePeer(made.pc);
      return;
    }
    this.#pc = made.pc;
    const answer = new Promise<LinkSdp>((resolve) => (this.#answer = resolve));
    await session.send({ t: 'sdp', d: made.offer });
    const sdp = await withTimeout(answer, TRIAL_LINK.directTimeoutMs);
    this.#answer = null;
    if (!sdp || this.#session !== session || this.#pc !== made.pc) return fail();
    try {
      await made.pc.setRemoteDescription(sdp);
    } catch {
      return fail();
    }
    if (!(await waitOpen(made.dc, TRIAL_LINK.directTimeoutMs)) || this.#session !== session) return fail();
    this.#directAttempt = 0;
    session.setChannel(made.dc);
    const dc = made.dc;
    const back = () => {
      if (this.#session !== session || session.channel !== dc) return;
      session.setChannel(null);
      this.#dispatch('direct-down');
      // Answers in flight over the closed channel may be lost: resend what is safe over the relay.
      this.#book.resendSent(Date.now());
      this.#flush();
      this.#scheduleDirect(3000);
    };
    dc.addEventListener('close', back);
    made.pc.addEventListener('connectionstatechange', () => {
      if (made.pc.connectionState === 'failed' || made.pc.connectionState === 'closed') back();
    });
    this.#dispatch('direct-up');
  }
}

/**
 * `new EventSource('/api/events')` on the device: open while the session with the cash desk works, «error»
 * (and trying again, as a real stream does) while it does not — the app shows itself offline and refetches on
 * the next «open». The cash desk's change events arrive as `changed`; pings are made here every 15 s while up.
 */
function installLinkEventSource(device: Device): void {
  const NetworkEventSource = window.EventSource;

  class LinkEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly url: string;
    readonly withCredentials = false;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    #offChange: () => void = () => {};
    #offUp: () => void = () => {};
    #ping: ReturnType<typeof setInterval> | undefined;

    constructor(url: string | URL, init?: EventSourceInit) {
      super();
      this.url = new URL(String(url), window.location.href).href;
      if (!isHubPath(new URL(this.url))) return new NetworkEventSource(url, init) as unknown as LinkEventSource;
      this.#offChange = device.onChange((data) => this.#emit('changed', data));
      this.#offUp = device.onUpChange(() => this.#sync());
      this.#ping = setInterval(() => this.#emit('ping', '{}'), 15_000);
      setTimeout(() => this.#sync(), 0);
    }

    #sync(): void {
      if (this.readyState === 2) return;
      if (device.up && this.readyState !== 1) {
        this.readyState = 1;
        const open = new Event('open');
        this.onopen?.(open);
        this.dispatchEvent(open);
      } else if (!device.up && this.readyState === 1) {
        this.readyState = 0;
        const error = new Event('error');
        this.onerror?.(error);
        this.dispatchEvent(error);
      }
    }

    #emit(type: string, data: string): void {
      if (this.readyState !== 1) return;
      const event = new MessageEvent(type, { data });
      if (type === 'message') this.onmessage?.(event);
      this.dispatchEvent(event);
    }

    close(): void {
      this.readyState = 2;
      this.#offChange();
      this.#offUp();
      clearInterval(this.#ping);
    }
  }

  window.EventSource = LinkEventSource as unknown as typeof EventSource;
}
