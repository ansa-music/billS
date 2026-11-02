/**
 * «Подключить устройство», the cash desk's side: its in-page HUB answers the devices. It listens on the
 * lobby for hellos, keeps one session per device (pair topic, then peer to peer when possible), runs each
 * request through the same injector as its own screens (`app.inject` + the save trigger, so the HUB sees
 * an ordinary request with the device's own Bearer token and Idempotency-Key), remembers recent answers
 * per request id (a resent request is answered again, never run twice), and forwards the HUB's change
 * events to every device within TRIAL_LINK.eventBatchMs. The cash desk stays the single source of truth;
 * when its tab closes it says «bye», when it opens again it says «up» and the devices come back on their own.
 */
import type { LinkControl, LinkFrame, LinkKeys } from '@bills/domain';
import {
  controlAad,
  deriveLinkKeys,
  deriveSessionKey,
  isLinkDeviceId,
  linkCompression,
  LinkDedupe,
  linkPathAllowed,
  newLinkSecret,
  openControl,
  parseLinkControl,
  randomLinkId,
  sealControl,
  TRIAL_LINK,
} from '@bills/domain';
import type { BusTopic, LinkBus } from './link-bus.ts';
import { createLinkBus, linkBusConfigured } from './link-bus.ts';
import type { LinkDeviceView, StoredLinkDevice } from './link-control.ts';
import { setLinkHostApi, updateLinkHostState } from './link-control.ts';
import type { LinkSdp } from './link-peer.ts';
import { acceptOffer, closePeer, rtcAvailable, waitOpen, withTimeout } from './link-peer.ts';
import { LinkSession } from './link-session.ts';

export interface LinkHostRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  payload?: string;
  remoteAddress: string;
}

export interface LinkHostResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface Device {
  stored: StoredLinkDevice;
  topic: BusTopic | null;
  session: LinkSession | null;
  pc: RTCPeerConnection | null;
  /** Hellos of one device are handled one after another. */
  chain: Promise<void>;
}

const HOST = 'h';
const SEEN_NONCES = 5000;
const lobbyOf = (room: string) => `tsl-${room}`;
const pairOf = (room: string, device: string) => `tsl-${room}-${device}`;
const json = (status: number, code: string, message: string): LinkHostResponse => ({
  statusCode: status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ error: { code, message } }),
});

interface HostDeps {
  handle(req: LinkHostRequest): Promise<LinkHostResponse>;
  subscribe(listener: (e: object) => void): () => void;
  known: StoredLinkDevice[];
  remember(list: StoredLinkDevice[]): void;
}

class LinkHost {
  readonly #deps: HostDeps;
  readonly #secret: string;
  readonly #hi = randomLinkId(9);
  #keys!: LinkKeys;
  #bus: LinkBus | null = null;
  #lobby: BusTopic | null = null;
  #lobbyName = '';
  #bye: string | null = null;
  readonly #devices = new Map<string, Device>();
  readonly #seen: string[] = [];
  readonly #seenSet = new Set<string>();
  readonly #dedupe = new LinkDedupe<Promise<LinkHostResponse>>(TRIAL_LINK.dedupeEntries * 4);
  #events: string[] = [];
  #eventTimer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | null = null;
  #sweep: ReturnType<typeof setInterval> | undefined;
  #connected = false;
  #stopped = false;
  readonly #onPageHide = () => this.#sayBye();

  constructor(secret: string, deps: HostDeps) {
    this.#secret = secret;
    this.#deps = deps;
    for (const s of deps.known) this.#devices.set(s.id, { stored: { ...s }, topic: null, session: null, pc: null, chain: Promise.resolve() });
  }

  async start(): Promise<void> {
    this.#keys = await deriveLinkKeys(this.#secret);
    if (this.#stopped) return;
    this.#lobbyName = lobbyOf(this.#keys.room);
    // Sealed now: on pagehide there is no time for WebCrypto.
    this.#bye = await sealControl(this.#keys.control, { t: 'bye', hi: this.#hi } satisfies LinkControl, controlAad(this.#lobbyName, HOST));
    this.#bus = createLinkBus((up) => {
      this.#connected = up;
      this.#publish();
    });
    this.#lobby = this.#bus.join(
      this.#lobbyName,
      (event, payload) => void this.#onLobby(event, payload),
      (joined) => {
        if (joined) void this.#announce();
      },
    );
    this.#bus.connect();
    this.#unsubscribe = this.#deps.subscribe((e) => this.#queueEvent(JSON.stringify(e)));
    this.#sweep = setInterval(() => this.#sweepIdle(), 15_000);
    window.addEventListener('pagehide', this.#onPageHide);
    this.#publish();
  }

  /** The lobby was (re)joined: devices waiting for the cash desk say hello at once. */
  async #announce(): Promise<void> {
    const x = await sealControl(this.#keys.control, { t: 'up', hi: this.#hi, at: Date.now() } satisfies LinkControl, controlAad(this.#lobbyName, HOST));
    this.#lobby?.send('c', { f: HOST, x });
  }

  #sayBye(): void {
    if (this.#bye) this.#lobby?.send('c', { f: HOST, x: this.#bye }, true);
  }

  async #onLobby(event: string, payload: unknown): Promise<void> {
    if (event !== 'c' || this.#stopped) return;
    const p = payload as { f?: unknown; x?: unknown } | null;
    if (!p || !isLinkDeviceId(p.f)) return;
    const from = p.f;
    const ctl = parseLinkControl(await openControl(this.#keys.control, p.x, controlAad(this.#lobbyName, from)));
    if (ctl?.t !== 'hello' || ctl.d !== from) return;
    const dev = this.#device(from);
    dev.chain = dev.chain.then(() => this.#onHello(dev, ctl)).catch((err: unknown) => console.warn('[link] a device could not connect', err));
  }

  #device(id: string): Device {
    let dev = this.#devices.get(id);
    if (dev) return dev;
    const now = Date.now();
    dev = { stored: { id, name: 'Устройство', who: null, view: 'staff', firstSeen: now, lastSeen: now }, topic: null, session: null, pc: null, chain: Promise.resolve() };
    this.#devices.set(id, dev);
    // The list keeps the most recent devices.
    if (this.#devices.size > TRIAL_LINK.maxDevices) {
      const oldest = [...this.#devices.values()].filter((d) => !d.session).sort((a, b) => a.stored.lastSeen - b.stored.lastSeen)[0];
      if (oldest) this.#devices.delete(oldest.stored.id);
    }
    return dev;
  }

  async #onHello(dev: Device, hello: Extract<LinkControl, { t: 'hello' }>): Promise<void> {
    const now = Date.now();
    if (this.#stopped || Math.abs(now - hello.at) > TRIAL_LINK.helloMaxSkewMs) return;
    // A hello recorded on the wire and played again opens nothing new.
    if (this.#seenSet.has(hello.n)) return;
    this.#seen.push(hello.n);
    this.#seenSet.add(hello.n);
    if (this.#seen.length > SEEN_NONCES) this.#seenSet.delete(this.#seen.shift()!);

    dev.stored = { ...dev.stored, name: hello.info.name, who: hello.info.who, view: hello.info.view, lastSeen: now };
    this.#remember();
    const topicName = pairOf(this.#keys.room, dev.stored.id);
    if (!dev.topic) dev.topic = this.#bus!.join(topicName, (event, payload) => this.#onPair(dev, event, payload));
    const topic = dev.topic;
    if ((await withTimeout(topic.ready(), 10_000)) === null || this.#stopped) return;

    const hostNonce = randomLinkId(TRIAL_LINK.nonceBytes);
    const sid = randomLinkId(9);
    const key = await deriveSessionKey(this.#keys.base, hello.n, hostNonce);
    this.#endSession(dev);
    const session: LinkSession = new LinkSession({
      id: sid,
      key,
      out: 'h2d',
      compress: hello.z && linkCompression(),
      relay: (chunks) => topic.send('d', { f: HOST, s: sid, x: chunks }),
      onFrame: (frame) => this.#onFrame(dev, session, frame),
    });
    dev.session = session;
    const welcome: LinkControl = { t: 'welcome', d: dev.stored.id, nd: hello.n, n: hostNonce, s: sid, hi: this.#hi, at: Date.now(), z: linkCompression() };
    topic.send('c', { f: HOST, x: await sealControl(this.#keys.control, welcome, controlAad(topicName, HOST)) });
    this.#publish();
  }

  #onPair(dev: Device, event: string, payload: unknown): void {
    const p = payload as { f?: unknown; s?: unknown; x?: unknown } | null;
    if (!p || p.f !== dev.stored.id || event !== 'd') return;
    const session = dev.session;
    if (session && p.s === session.id) session.receiveRelay(p.x);
  }

  #onFrame(dev: Device, session: LinkSession, frame: LinkFrame): void {
    dev.stored.lastSeen = Date.now();
    switch (frame.t) {
      case 'req':
        void this.#serve(dev, session, frame);
        return;
      case 'ping':
        void session.send({ t: 'pong', at: frame.at });
        return;
      case 'sdp':
        if (frame.d.type === 'offer') void this.#acceptDirect(dev, session, frame.d);
        return;
      case 'info':
        dev.stored = { ...dev.stored, name: frame.info.name, who: frame.info.who, view: frame.info.view };
        this.#remember();
        this.#publish();
        return;
      case 'bye':
        if (dev.session === session) this.#endSession(dev);
        this.#publish();
        return;
      default:
        return;
    }
  }

  async #serve(dev: Device, session: LinkSession, req: Extract<LinkFrame, { t: 'req' }>): Promise<void> {
    const key = `${dev.stored.id}:${req.id}`;
    const now = Date.now();
    let answer = this.#dedupe.get(key, now);
    if (!answer) {
      answer = this.#run(dev, req);
      this.#dedupe.set(key, answer, now);
    }
    const res = await answer;
    // A session replaced meanwhile: the device resends on its new one and gets this same answer from memory.
    if (session.closed) return;
    await session.send({ t: 'res', id: req.id, s: res.statusCode, h: res.headers, b: res.body });
  }

  async #run(dev: Device, req: Extract<LinkFrame, { t: 'req' }>): Promise<LinkHostResponse> {
    if (!linkPathAllowed(req.u)) return json(404, 'NOT_FOUND', 'Такого адреса нет');
    try {
      const res = await this.#deps.handle({
        method: req.m,
        url: req.u,
        headers: req.h,
        ...(req.b !== undefined ? { payload: req.b } : {}),
        remoteAddress: `link:${dev.stored.id}`,
      });
      const { 'content-length': _length, ...headers } = res.headers;
      return { statusCode: res.statusCode, headers, body: res.body };
    } catch (err) {
      console.error('[link] a device request failed at the cash desk', err);
      return json(500, 'INTERNAL', 'Внутренняя ошибка кассы');
    }
  }

  async #acceptDirect(dev: Device, session: LinkSession, offer: LinkSdp): Promise<void> {
    if (!rtcAvailable() || session.closed) return;
    closePeer(dev.pc);
    dev.pc = null;
    let made: Awaited<ReturnType<typeof acceptOffer>>;
    try {
      made = await acceptOffer(offer);
    } catch {
      return;
    }
    if (dev.session !== session) {
      closePeer(made.pc);
      return;
    }
    dev.pc = made.pc;
    const pc = made.pc;
    await session.send({ t: 'sdp', d: made.answer });
    const dc = await withTimeout(made.channel, TRIAL_LINK.directTimeoutMs + 5000);
    if (!dc || dev.session !== session || dev.pc !== pc || !(await waitOpen(dc, TRIAL_LINK.directTimeoutMs))) {
      if (dev.pc === pc) {
        closePeer(pc);
        dev.pc = null;
      }
      return;
    }
    session.setChannel(dc);
    const back = () => {
      if (session.channel === dc) {
        session.setChannel(null);
        this.#publish();
      }
    };
    dc.addEventListener('close', back);
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') back();
    });
    this.#publish();
  }

  #queueEvent(data: string): void {
    this.#events.push(data);
    if (this.#eventTimer !== undefined) return;
    this.#eventTimer = setTimeout(() => {
      this.#eventTimer = undefined;
      const e = this.#events.splice(0);
      for (const dev of this.#devices.values()) if (dev.session && !dev.session.closed) void dev.session.send({ t: 'ev', e });
    }, TRIAL_LINK.eventBatchMs);
  }

  #endSession(dev: Device): void {
    dev.session?.close();
    dev.session = null;
    closePeer(dev.pc);
    dev.pc = null;
  }

  /** Sessions nobody used for a while are closed (the device says hello again when it needs one). */
  #sweepIdle(): void {
    const now = Date.now();
    let changed = false;
    for (const dev of this.#devices.values()) {
      if (dev.session && now - dev.session.lastHeard > TRIAL_LINK.sessionIdleMs) {
        this.#endSession(dev);
        dev.topic?.leave();
        dev.topic = null;
        changed = true;
      }
    }
    this.#remember();
    if (changed) this.#publish();
    else this.#publish(); // «на связи» / «был в …» follows the clock too
  }

  #remember(): void {
    const list = [...this.#devices.values()].map((d) => ({ ...d.stored })).sort((a, b) => b.lastSeen - a.lastSeen);
    this.#deps.remember(list.slice(0, TRIAL_LINK.maxDevices));
  }

  views(): LinkDeviceView[] {
    const now = Date.now();
    return [...this.#devices.values()]
      .map((d) => {
        const online = d.session !== null && !d.session.closed && now - d.session.lastHeard < 60_000;
        return { ...d.stored, online, direct: online && d.session!.direct };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
  }

  #publish(): void {
    if (this.#stopped) return;
    updateLinkHostState({ connected: this.#connected, devices: this.views() });
  }

  /** «Отключить все устройства»: devices on line hear «revoked» first, then everything stops. */
  async revokeAll(): Promise<void> {
    const sends: Array<Promise<void>> = [];
    for (const dev of this.#devices.values()) {
      if (!dev.topic) continue;
      const topic = dev.topic;
      const name = pairOf(this.#keys.room, dev.stored.id);
      sends.push(
        sealControl(this.#keys.control, { t: 'revoked', d: dev.stored.id } satisfies LinkControl, controlAad(name, HOST)).then((x) => topic.send('c', { f: HOST, x })),
      );
    }
    await Promise.all(sends);
    // Paced sends go out at TRIAL_LINK.relayPerSecond: give them time before the socket closes.
    await new Promise((r) => setTimeout(r, Math.min(5000, 300 + (sends.length * 1000) / TRIAL_LINK.relayPerSecond)));
    this.stop(false);
  }

  stop(bye: boolean): void {
    if (bye) this.#sayBye();
    this.#stopped = true;
    window.removeEventListener('pagehide', this.#onPageHide);
    clearInterval(this.#sweep);
    clearTimeout(this.#eventTimer);
    this.#unsubscribe?.();
    for (const dev of this.#devices.values()) this.#endSession(dev);
    const bus = this.#bus;
    // A moment for the last messages to leave.
    setTimeout(() => bus?.close(), bye ? 500 : 0);
  }
}

// ---------------------------------------------------------------------------
// Wiring into the trial cash desk (boot.ts)

export interface TrialLinkHostDeps {
  /** The in-page HUB's injector: the same one the cash desk's own fetch uses. */
  inject(req: LinkHostRequest): Promise<LinkHostResponse>;
  /** The save trigger after a write (keepTrialSaved). */
  changed(): void;
  /** Subscribe to the HUB's change events; returns the unsubscribe. */
  onChange(listener: (e: object) => void): () => void;
  /** The stored secret and devices, and how to keep new ones (with the trial in IndexedDB). */
  secret(): string | null;
  devices(): StoredLinkDevice[];
  saveSecret(secret: string): void;
  rememberDevices(list: StoredLinkDevice[]): void;
}

/**
 * Makes this cash desk ready for devices: the dialog's API is registered; the host starts now when a link
 * was made before (devices come back by themselves after the cash desk reopens), else on the dialog's first use.
 * Nothing at all happens in a build without the relay.
 */
export function installTrialLinkHost(deps: TrialLinkHostDeps): void {
  if (!linkBusConfigured()) return;
  let host: LinkHost | null = null;
  let lastRemembered = '';
  const make = (secret: string): LinkHost =>
    new LinkHost(secret, {
      handle: async (req) => {
        const res = await deps.inject(req);
        if (req.method !== 'GET' && req.method !== 'HEAD') deps.changed();
        return res;
      },
      subscribe: deps.onChange,
      known: deps.devices(),
      remember: (list) => {
        // Kept in memory with the trial; it reaches IndexedDB with the next save.
        const text = JSON.stringify(list);
        if (text === lastRemembered) return;
        lastRemembered = text;
        deps.rememberDevices(list);
      },
    });
  const run = (secret: string) => {
    host = make(secret);
    updateLinkHostState({ secret, devices: host.views() });
    const started = host;
    void started.start().catch((err: unknown) => {
      console.warn('[link] devices cannot connect to this cash desk', err);
    });
  };
  setLinkHostApi({
    async enable() {
      const existing = deps.secret();
      if (existing && host) return existing;
      const secret = existing ?? newLinkSecret();
      if (!existing) deps.saveSecret(secret);
      if (!host) run(secret);
      return secret;
    },
    async rotate() {
      const old = host;
      host = null;
      if (old) await old.revokeAll();
      deps.rememberDevices([]);
      lastRemembered = '[]';
      const secret = newLinkSecret();
      deps.saveSecret(secret);
      updateLinkHostState({ devices: [] });
      run(secret);
      return secret;
    },
  });
  const saved = deps.secret();
  if (saved) run(saved);
}
