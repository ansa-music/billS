import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SocketLike } from '../src/trial-link-realtime.ts';
import { RealtimeLink, realtimeSocketUrl } from '../src/trial-link-realtime.ts';

/** An in-memory stand-in for the browser WebSocket: the test plays the Supabase Realtime server. */
class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  // The server's side:
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  push(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  last(event: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.event === event);
  }
  replyJoin(topic: string, status = 'ok'): void {
    const join = [...this.sent].reverse().find((m) => m.event === 'phx_join' && m.topic === `realtime:${topic}`);
    assert.ok(join, `a join for ${topic}`);
    this.push({ topic: `realtime:${topic}`, event: 'phx_reply', payload: { status, response: {} }, ref: join.ref });
  }
}

function setup(perSecond = 1000) {
  const sockets: FakeSocket[] = [];
  const statuses: boolean[] = [];
  const link = new RealtimeLink({
    url: 'https://abc.supabase.co',
    apikey: 'anon-key',
    perSecond,
    socket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onStatus: (up) => statuses.push(up),
  });
  return { link, sockets, statuses };
}

test('the socket address carries the public key and protocol 1.0.0', () => {
  assert.equal(realtimeSocketUrl('https://abc.supabase.co/', 'k=1'), 'wss://abc.supabase.co/realtime/v1/websocket?apikey=k%3D1&vsn=1.0.0');
  assert.equal(realtimeSocketUrl('http://127.0.0.1:54321', 'k'), 'ws://127.0.0.1:54321/realtime/v1/websocket?apikey=k&vsn=1.0.0');
});

test('join → reply → broadcasts both ways, in Supabase Realtime frames', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { link, sockets, statuses } = setup();
    const got: Array<[string, unknown]> = [];
    const topic = link.join('tsl-room', (event, payload) => got.push([event, payload]));
    link.connect();
    const ws = sockets[0]!;
    assert.equal(ws.url, 'wss://abc.supabase.co/realtime/v1/websocket?apikey=anon-key&vsn=1.0.0');
    topic.send('c', { early: true });
    ws.open();
    assert.deepEqual(statuses, [true]);
    const join = ws.last('phx_join')!;
    assert.equal(join.topic, 'realtime:tsl-room');
    assert.equal(join.join_ref, join.ref);
    assert.deepEqual(join.payload, {
      config: { broadcast: { self: false, ack: false }, presence: { key: '', enabled: false }, postgres_changes: [], private: false },
      access_token: 'anon-key',
    });
    assert.equal(ws.last('broadcast'), undefined, 'nothing is sent before the join is confirmed');
    let ready = false;
    void topic.ready().then(() => (ready = true));
    ws.replyJoin('tsl-room');
    await Promise.resolve();
    assert.equal(ready, true);
    assert.equal(topic.joined, true);
    const early = ws.last('broadcast')!;
    assert.deepEqual(early.payload, { type: 'broadcast', event: 'c', payload: { early: true } });
    assert.equal(early.join_ref, join.ref);

    ws.push({ topic: 'realtime:tsl-room', event: 'broadcast', payload: { type: 'broadcast', event: 'd', payload: { x: 1 } }, ref: null });
    ws.push({ topic: 'realtime:other', event: 'broadcast', payload: { type: 'broadcast', event: 'd', payload: { x: 2 } }, ref: null });
    ws.push({ topic: 'realtime:tsl-room', event: 'presence_state', payload: {}, ref: null });
    assert.deepEqual(got, [['d', { x: 1 }]]);

    topic.leave();
    assert.equal(ws.last('phx_leave')?.topic, 'realtime:tsl-room');
    link.close();
    assert.equal(ws.closed, true);
    assert.deepEqual(statuses, [true, false]);
  } finally {
    mock.timers.reset();
  }
});

test('an unanswered heartbeat drops the socket; it reconnects and joins again', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { link, sockets, statuses } = setup();
    const joined: boolean[] = [];
    link.join('tsl-a', () => {}, (j) => joined.push(j));
    link.connect();
    const ws = sockets[0]!;
    ws.open();
    ws.replyJoin('tsl-a');
    mock.timers.tick(25_000);
    const hb = ws.last('heartbeat')!;
    assert.equal(hb.topic, 'phoenix');
    ws.push({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: hb.ref });
    mock.timers.tick(25_000);
    assert.equal(ws.closed, false, 'answered: still up');
    mock.timers.tick(25_000); // the second heartbeat was never answered
    assert.equal(ws.closed, true);
    assert.deepEqual(statuses, [true, false]);
    assert.deepEqual(joined, [true, false]);
    mock.timers.tick(1000);
    const ws2 = sockets[1]!;
    assert.ok(ws2, 'a new socket after the first pause');
    ws2.open();
    ws2.replyJoin('tsl-a');
    assert.deepEqual(joined, [true, false, true]);
    link.close();
  } finally {
    mock.timers.reset();
  }
});

test('a refused or closed channel is joined again; a lost socket is retried with growing pauses', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { link, sockets } = setup();
    link.join('tsl-b', () => {});
    link.connect();
    const ws = sockets[0]!;
    ws.open();
    ws.replyJoin('tsl-b', 'error');
    const joins = () => ws.sent.filter((m) => m.event === 'phx_join').length;
    assert.equal(joins(), 1);
    mock.timers.tick(3000);
    assert.equal(joins(), 2, 'tried again');
    ws.replyJoin('tsl-b');
    const ref = ws.last('phx_join')!.ref;
    ws.push({ topic: 'realtime:tsl-b', event: 'phx_error', payload: {}, ref, join_ref: ref });
    mock.timers.tick(3000);
    assert.equal(joins(), 3);

    ws.drop();
    mock.timers.tick(999);
    assert.equal(sockets.length, 1);
    mock.timers.tick(1);
    assert.equal(sockets.length, 2);
    sockets[1]!.drop();
    mock.timers.tick(1999);
    assert.equal(sockets.length, 2);
    mock.timers.tick(1);
    assert.equal(sockets.length, 3, 'the second pause is longer');
    link.close();
  } finally {
    mock.timers.reset();
  }
});

test('broadcasts are paced to the configured rate', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { link, sockets } = setup(10);
    const topic = link.join('tsl-c', () => {});
    link.connect();
    const ws = sockets[0]!;
    ws.open();
    ws.replyJoin('tsl-c');
    for (let i = 0; i < 5; i++) topic.send('d', { i });
    const sent = () => ws.sent.filter((m) => m.event === 'broadcast').length;
    assert.equal(sent(), 1);
    assert.equal(link.backlog, 4);
    mock.timers.tick(100);
    assert.equal(sent(), 2);
    for (let i = 0; i < 3; i++) mock.timers.tick(100);
    assert.equal(sent(), 5);
    assert.deepEqual(
      ws.sent.filter((m) => m.event === 'broadcast').map((m) => (m.payload as { payload: { i: number } }).payload.i),
      [0, 1, 2, 3, 4],
      'in order',
    );
    topic.send('d', { i: 5 });
    assert.equal(sent(), 5, 'waits for its turn');
    topic.send('c', { bye: true }, true);
    assert.equal(sent(), 6, 'an urgent one skips the queue');
    assert.deepEqual((ws.sent.filter((m) => m.event === 'broadcast').at(-1)!.payload as { payload: unknown }).payload, { bye: true });
    mock.timers.tick(100);
    assert.equal(sent(), 7);
    link.close();
  } finally {
    mock.timers.reset();
  }
});
