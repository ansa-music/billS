import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LinkFailure, LinkMachine, LinkRequestFrame, LinkResponseFrame } from '../src/trial-link.ts';
import {
  base64ToBytes,
  bytesToBase64,
  ChunkAssembler,
  helloRetryMs,
  isLinkSecret,
  LINK_CHUNK_HEADER,
  LINK_START,
  LinkDedupe,
  linkFromHash,
  linkHash,
  linkPathAllowed,
  LinkRequests,
  linkResendable,
  linkStatus,
  linkStep,
  parseLinkControl,
  parseLinkFrame,
  readChunkHeader,
  ReplayWindow,
  splitChunks,
  TRIAL_LINK,
} from '../src/trial-link.ts';

const SECRET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'; // 43 characters, like 32 random bytes in base64url

test('link address: #/link/<secret>[/board] round-trips; anything else is not a link', () => {
  assert.equal(SECRET.length, Math.ceil((TRIAL_LINK.secretBytes * 4) / 3));
  assert.equal(isLinkSecret(SECRET), true);
  assert.equal(linkHash(SECRET), `#/link/${SECRET}`);
  assert.deepEqual(linkFromHash(linkHash(SECRET)), { secret: SECRET, view: 'staff' });
  assert.deepEqual(linkFromHash(linkHash(SECRET, 'board')), { secret: SECRET, view: 'board' });
  assert.deepEqual(linkFromHash(`#/link/${SECRET}/`), { secret: SECRET, view: 'staff' }, 'a trailing slash');
  assert.deepEqual(linkFromHash(`#/link/${SECRET}?from=qr`), { secret: SECRET, view: 'staff' }, 'a query');
  for (const hash of ['', '#/', '#/login', '#/link/', '#/link/short', `#/link/${SECRET}x`, `#/link/${SECRET}/pos`, `#/link/${SECRET}/board/x`, `#/watch/${SECRET}`]) {
    assert.equal(linkFromHash(hash), null, hash);
  }
  assert.equal(isLinkSecret(`${SECRET}=`), false);
});

test('frames: requests, answers and control messages are checked before use', () => {
  assert.deepEqual(parseLinkFrame({ t: 'req', id: 'r1', m: 'post', u: '/api/x', h: { 'Idempotency-Key': 'abcdefgh' }, b: '{}' }), {
    t: 'req',
    id: 'r1',
    m: 'POST',
    u: '/api/x',
    h: { 'idempotency-key': 'abcdefgh' },
    b: '{}',
  });
  assert.equal(parseLinkFrame({ t: 'req', id: 'r1', m: 'GET', u: '/api/x', h: { a: 1 } }), null, 'header values are strings');
  assert.equal(parseLinkFrame({ t: 'res', id: 'r1', s: 200, h: {} }), null, 'an answer has a body');
  assert.deepEqual(parseLinkFrame({ t: 'ev', e: ['{"kind":"counter"}'] }), { t: 'ev', e: ['{"kind":"counter"}'] });
  assert.equal(parseLinkFrame({ t: 'sdp', d: { type: 'pranswer', sdp: '' } }), null);
  assert.equal(parseLinkFrame({ t: 'nope' }), null);
  assert.equal(parseLinkFrame(null), null);

  const hello = parseLinkControl({ t: 'hello', d: 'dev12345abcd', n: 'nonce', at: 1, z: true, info: { name: ' iPad ', who: '', view: 'board' } });
  assert.deepEqual(hello, { t: 'hello', d: 'dev12345abcd', n: 'nonce', at: 1, z: true, info: { name: 'iPad', who: null, view: 'board' } });
  assert.equal(parseLinkControl({ t: 'hello', d: 'x', n: 'n', at: 1, info: {} }), null, 'a device id has a shape');
  assert.equal(parseLinkControl({ t: 'welcome', d: 'dev12345abcd', nd: 'a', n: 'b', s: 'c', at: 1 }), null, 'welcome names the cash desk');
  assert.deepEqual(parseLinkControl({ t: 'revoked', d: 'dev12345abcd' }), { t: 'revoked', d: 'dev12345abcd' });
});

test('only the HUB API goes over the link', () => {
  assert.equal(linkPathAllowed('/api/state'), true);
  assert.equal(linkPathAllowed('/api/counter/orders?x=1'), true);
  for (const url of ['/', '/index.html', 'https://evil.example/api/x', '//evil/api', '/api/../index.html', '/apix']) {
    assert.equal(linkPathAllowed(url), false, url);
  }
});

test('chunks: a message split for the transport comes back whole, in any order, once', () => {
  const data = new Uint8Array(50_000).map((_, i) => (i * 7) % 251);
  const chunks = splitChunks(42, data, 16 * 1024);
  assert.equal(chunks.length, 4);
  assert.ok(chunks.every((c) => c.length <= 16 * 1024));
  assert.deepEqual(readChunkHeader(chunks[2]!), { seq: 42, index: 2, count: 4 });

  const asm = new ChunkAssembler();
  const order = [3, 1, 1, 0, 2];
  let out: { seq: number; data: Uint8Array } | null = null;
  for (const i of order) {
    const got = asm.push(chunks[i]!, 0);
    if (got) {
      assert.equal(out, null, 'returned once');
      out = got;
    }
  }
  assert.ok(out);
  assert.equal(out.seq, 42);
  assert.deepEqual(out.data, data);
  assert.equal(asm.pending, 0);
  assert.equal(asm.push(chunks[0]!, 0), null, 'a late duplicate piece starts nothing complete');

  // One-piece messages and empty ones.
  const one = splitChunks(7, new Uint8Array([1, 2, 3]), 1000);
  assert.equal(one.length, 1);
  assert.deepEqual(asm.push(one[0]!, 0), { seq: 7, data: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(asm.push(splitChunks(8, new Uint8Array(0), 100)[0]!, 0)?.data, new Uint8Array(0));
  assert.equal(asm.push(new Uint8Array([9, 9]), 0), null, 'garbage');
  assert.throws(() => splitChunks(1, data, LINK_CHUNK_HEADER));
});

test('chunks: oversized and stale messages are dropped', () => {
  const asm = new ChunkAssembler({ maxBytes: 1000, ttlMs: 1000 });
  const big = splitChunks(1, new Uint8Array(3000), 509);
  for (const c of big) assert.equal(asm.push(c, 0), null);
  assert.equal(asm.pending, 0);

  const msg = splitChunks(2, new Uint8Array(900), 309);
  assert.equal(asm.push(msg[0]!, 0), null);
  assert.equal(asm.pending, 1);
  // Long after: the half message is forgotten, the rest cannot complete it.
  assert.equal(asm.push(splitChunks(3, new Uint8Array(400), 209)[0]!, 5000), null);
  assert.equal(asm.push(msg[1]!, 5000), null);
  assert.equal(asm.push(msg[2]!, 5000), null);
});

test('replay window: each sequence number once; very old ones never', () => {
  const w = new ReplayWindow(8);
  assert.equal(w.accept(1), true);
  assert.equal(w.accept(1), false);
  assert.equal(w.accept(3), true);
  assert.equal(w.accept(2), true, 'out of order is fine');
  assert.equal(w.accept(20), true);
  assert.equal(w.accept(12), false, 'older than the window');
  assert.equal(w.accept(13), true);
  assert.equal(w.accept(13), false);
  assert.equal(w.accept(0), false);
  assert.equal(w.accept(1.5), false);
  for (let s = 21; s < 100; s++) assert.equal(w.accept(s), true);
  assert.equal(w.accept(95), false);
});

test('resend: reads and keyed writes may go again; a write without a key that went out may not', () => {
  assert.equal(linkResendable('GET', {}, true), true);
  assert.equal(linkResendable('POST', { 'idempotency-key': 'k-12345678' }, true), true);
  assert.equal(linkResendable('POST', {}, true), false);
  assert.equal(linkResendable('POST', { 'idempotency-key': 'short' }, true), false);
  assert.equal(linkResendable('POST', {}, false), true, 'never sent: nothing can have happened');
});

function book() {
  const requests = new LinkRequests();
  const settled = new Map<string, LinkResponseFrame | LinkFailure>();
  const add = (frame: LinkRequestFrame, now: number) =>
    requests.add(
      frame,
      now,
      (res) => settled.set(frame.id, res),
      (why) => settled.set(frame.id, why),
    );
  return { requests, settled, add };
}

const req = (id: string, m = 'GET', h: Record<string, string> = {}): LinkRequestFrame => ({ t: 'req', id, m, u: '/api/state', h });
const res = (id: string): LinkResponseFrame => ({ t: 'res', id, s: 200, h: {}, b: '{}' });

test('requests: queued until sent, answered once, the late answer ignored', () => {
  const { requests, settled, add } = book();
  add(req('a'), 0);
  add(req('b'), 1);
  assert.deepEqual(
    requests.queued().map((f) => f.id),
    ['a', 'b'],
  );
  requests.markSent('a', 10);
  assert.deepEqual(
    requests.queued().map((f) => f.id),
    ['b'],
  );
  assert.equal(requests.oldestWaitMs(110), 100);
  assert.equal(requests.settle(res('a')), true);
  assert.equal(requests.settle(res('a')), false, 'a repeated answer');
  assert.equal(requests.settle(res('zzz')), false, 'an unknown answer');
  assert.deepEqual(settled.get('a'), res('a'));
  assert.equal(requests.size, 1);
});

test('requests: a broken session resends what is safe and fails a keyless write that may have run', () => {
  const { requests, settled, add } = book();
  add(req('read'), 0);
  add(req('keyed', 'POST', { 'idempotency-key': 'k-12345678' }), 0);
  add(req('keyless', 'POST'), 0);
  add(req('queued', 'POST'), 0);
  for (const id of ['read', 'keyed', 'keyless']) requests.markSent(id, 5);
  assert.equal(requests.sessionLost(100), 1);
  assert.equal(settled.get('keyless'), 'lost');
  assert.deepEqual(requests.queued().map((f) => f.id).sort(), ['keyed', 'queued', 'read']);

  // Waiting for the cash desk: requeued ones count from the loss.
  assert.equal(requests.expire(100 + TRIAL_LINK.queueWaitMs - 1, TRIAL_LINK.queueWaitMs), 1, 'the never-sent one queued since 0');
  assert.equal(settled.get('queued'), 'offline');
  assert.equal(requests.expire(100 + TRIAL_LINK.queueWaitMs, TRIAL_LINK.queueWaitMs), 2);
  assert.equal(settled.get('read'), 'offline');
  assert.equal(requests.size, 0);
});

test('requests: when the data channel closes, resendable requests go again over the relay; a keyless write waits', () => {
  const { requests, settled, add } = book();
  add(req('read'), 0);
  add(req('keyless', 'POST'), 0);
  requests.markSent('read', 1);
  requests.markSent('keyless', 1);
  assert.equal(requests.resendSent(50), 1);
  assert.deepEqual(requests.queued().map((f) => f.id), ['read']);
  assert.equal(settled.size, 0, 'nothing failed');
  assert.equal(requests.settle(res('keyless')), true, 'its answer may still come over the relay');
});

test('chunks: a message resent with another chunk size replaces the half-received one', () => {
  const asm = new ChunkAssembler();
  const data = new Uint8Array(40_000).map((_, i) => i % 13);
  const direct = splitChunks(9, data, 16 * 1024);
  const relay = splitChunks(9, data, 96 * 1024);
  assert.equal(asm.push(direct[0]!, 0), null);
  assert.deepEqual(asm.push(relay[0]!, 0)?.data, data);
});

test('requests: the overall deadline applies to sent requests too; failAll empties the book', () => {
  const { requests, settled, add } = book();
  add(req('slow'), 0);
  requests.markSent('slow', 0);
  assert.equal(requests.expire(TRIAL_LINK.requestDeadlineMs - 1, TRIAL_LINK.queueWaitMs), 0);
  assert.equal(requests.expire(TRIAL_LINK.requestDeadlineMs, TRIAL_LINK.queueWaitMs), 1);
  assert.equal(settled.get('slow'), 'timeout');
  add(req('x'), 0);
  requests.failAll('offline');
  assert.equal(settled.get('x'), 'offline');
  assert.equal(requests.size, 0);
});

test('dedupe: the cash desk remembers recent answers, least recently used out, old ones forgotten', () => {
  const d = new LinkDedupe<string>(2, 1000);
  d.set('a', 'A', 0);
  d.set('b', 'B', 0);
  assert.equal(d.get('a', 10), 'A');
  d.set('c', 'C', 10);
  assert.equal(d.get('a', 10), undefined, 'the oldest insert went first');
  assert.equal(d.get('b', 10), 'B');
  assert.equal(d.get('c', 2000), undefined, 'expired');
  assert.equal(d.size, 1);
});

test('state machine: hello → welcome is «на связи»; no welcome is «не отвечает» with growing pauses', () => {
  let m: LinkMachine = LINK_START;
  let r = linkStep(m, 'start', 0, 0.5);
  assert.deepEqual(r.fx, { hello: true, timer: TRIAL_LINK.helloTimeoutMs });
  assert.equal(linkStatus(r.m), 'connecting');
  m = r.m;

  // The cash desk does not answer.
  r = linkStep(m, 'timer', 6000, 0.5);
  assert.equal(linkStatus(r.m), 'offline');
  assert.equal(r.fx.failQueued, true);
  assert.equal(r.fx.timer, helloRetryMs(1, 0.5));
  m = r.m;
  r = linkStep(m, 'timer', 8000, 0.5);
  assert.deepEqual(r.fx, { hello: true, timer: TRIAL_LINK.helloTimeoutMs }, 'the pause is over: hello again');
  assert.equal(linkStatus(r.m), 'offline', 'still «не отвечает» while it tries');
  m = r.m;
  r = linkStep(m, 'timer', 14_000, 0.5);
  assert.equal(r.fx.timer, helloRetryMs(2, 0.5));
  assert.ok(helloRetryMs(2, 0.5) > helloRetryMs(1, 0.5));
  m = r.m;

  // «Повторить» while waiting out the pause: hello now.
  r = linkStep(m, 'retry', 15_000, 0.5);
  assert.equal(r.fx.hello, true);
  m = r.m;
  assert.deepEqual(linkStep(m, 'retry', 15_001, 0.5).fx, {}, 'a hello is already out');

  r = linkStep(m, 'welcome', 15_500, 0.5);
  assert.equal(linkStatus(r.m), 'online');
  assert.deepEqual(r.fx, { flush: true, timer: null });
  m = r.m;
  m = linkStep(m, 'direct-up', 16_000).m;
  assert.equal(m.direct, true);
  m = linkStep(m, 'direct-down', 17_000).m;
  assert.equal(m.direct, false);
  assert.equal(linkStatus(m), 'online', 'the relay carries on');
});

test('state machine: a broken session reconnects at once; «bye» waits for «up»; revoked is final', () => {
  let m = linkStep(linkStep(LINK_START, 'start', 0).m, 'welcome', 100).m;
  let r = linkStep(m, 'lost', 1000);
  assert.equal(r.fx.lost, true);
  assert.equal(r.fx.hello, true);
  assert.equal(linkStatus(r.m), 'connecting');
  m = linkStep(r.m, 'welcome', 1200).m;

  r = linkStep(m, 'host-bye', 2000, 0.5);
  assert.equal(linkStatus(r.m), 'offline');
  assert.equal(r.fx.lost, true);
  assert.equal(r.fx.failQueued, true);
  assert.ok((r.fx.timer ?? 0) >= TRIAL_LINK.helloRetryMinMs * 4);
  m = r.m;
  r = linkStep(m, 'host-up', 60_000);
  assert.equal(r.fx.hello, true, 'the cash desk is back: hello at once');
  assert.equal(r.fx.lost, undefined, 'nothing was in flight');
  m = linkStep(r.m, 'welcome', 60_200).m;
  assert.equal(linkStatus(m), 'online');

  // A new cash-desk instance while the device thinks it is up: its session is gone.
  r = linkStep(m, 'host-up', 70_000);
  assert.equal(r.fx.hello, true);
  assert.equal(r.fx.lost, true, 'what was sent to the old instance goes again');
  assert.equal(linkStatus(r.m), 'connecting');

  r = linkStep(r.m, 'revoked', 71_000);
  assert.equal(linkStatus(r.m), 'revoked');
  for (const input of ['start', 'welcome', 'timer', 'retry', 'host-up'] as const) {
    assert.equal(linkStatus(linkStep(r.m, input, 72_000).m), 'revoked', input);
  }
});

test('hello pauses: 2 s doubling, capped at 2 minutes, jittered ±20 %', () => {
  assert.equal(helloRetryMs(1, 0.5), 2000);
  assert.equal(helloRetryMs(2, 0.5), 4000);
  assert.equal(helloRetryMs(30, 0.5), TRIAL_LINK.helloRetryMaxMs);
  assert.equal(helloRetryMs(1, 0), 1600);
  assert.equal(helloRetryMs(1, 0.999999), 2400);
});

test('base64 for relayed chunks round-trips big pieces', () => {
  const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});
