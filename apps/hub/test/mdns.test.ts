import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import {
  decodeMessage,
  encodeQuery,
  encodeResponse,
  MdnsResponder,
  planReply,
  TYPE_A,
  TYPE_AAAA,
  TYPE_ANY,
  TYPE_NSEC,
} from '../src/mdns.ts';

const IP = ['192.168.1.10'];

function ip(data: Buffer): string {
  return [...data].join('.');
}

test('query round-trips through encode/decode, QU bit included', () => {
  const msg = decodeMessage(encodeQuery([{ name: 'hub.local', unicast: true }, { name: 'x.local', type: TYPE_AAAA }], 7));
  assert.equal(msg.id, 7);
  assert.equal(msg.flags, 0);
  assert.deepEqual(msg.questions, [
    { name: 'hub.local', type: TYPE_A, class: 1, unicast: true },
    { name: 'x.local', type: TYPE_AAAA, class: 1, unicast: false },
  ]);
});

test('decodes compressed names (0xC0 pointers)', () => {
  // Q1: hub.local A; Q2: "printer" + pointer to "local" at offset 16.
  const buf = Buffer.from([
    0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0,
    3, 0x68, 0x75, 0x62, 5, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0, 0, 1, 0, 1,
    7, ...Buffer.from('printer'), 0xc0, 16, 0, 1, 0x80, 1,
    // nothing after
  ]);
  const msg = decodeMessage(buf);
  assert.equal(msg.questions[0]!.name, 'hub.local');
  assert.deepEqual(msg.questions[1], { name: 'printer.local', type: 1, class: 1, unicast: true });
  // A whole-name pointer to the first question answers for us too.
  const ptrOnly = Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0]),
    buf.subarray(12, 27),
    Buffer.from([0xc0, 12, 0, 255, 0, 1]),
  ]);
  assert.equal(decodeMessage(ptrOnly).questions[1]!.name, 'hub.local');
});

test('rejects malformed packets: truncation and pointer loops', () => {
  assert.throws(() => decodeMessage(Buffer.from([0, 0, 0])));
  assert.throws(() => decodeMessage(Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 3, 0x68])));
  assert.throws(() => decodeMessage(Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 1, 0, 1])));
});

test('response: QR+AA, id 0, cache-flush A records and NSEC', () => {
  const msg = decodeMessage(encodeResponse({ name: 'hub.local', addresses: ['192.168.1.10', '10.0.0.5', 'nonsense'], ttl: 120 }));
  assert.equal(msg.id, 0);
  assert.equal(msg.flags, 0x8400);
  assert.equal(msg.questions.length, 0);
  assert.deepEqual(msg.answers.map((r) => [r.name, r.type, r.class, r.cacheFlush, r.ttl, ip(r.data)]), [
    ['hub.local', TYPE_A, 1, true, 120, '192.168.1.10'],
    ['hub.local', TYPE_A, 1, true, 120, '10.0.0.5'],
  ]);
  assert.equal(msg.additionals[0]!.type, TYPE_NSEC);
});

test('answers A and ANY for our name regardless of case; silent for other names', () => {
  for (const [name, type] of [['hub.local', TYPE_A], ['HUB.Local', TYPE_A], ['hub.local.', TYPE_ANY]] as const) {
    const reply = planReply(decodeMessage(encodeQuery([{ name, type }])), 5353, 'hub', IP, 120);
    assert.ok(reply, name);
    assert.equal(reply.unicast, false);
    const msg = decodeMessage(reply.packet);
    assert.equal(msg.flags, 0x8400);
    assert.equal(ip(msg.answers[0]!.data), '192.168.1.10');
    assert.equal(msg.answers[0]!.cacheFlush, true);
  }
  assert.equal(planReply(decodeMessage(encodeQuery([{ name: 'other.local' }])), 5353, 'hub', IP, 120), null);
  assert.equal(planReply(decodeMessage(encodeQuery([{ name: 'hub.lan' }])), 5353, 'hub', IP, 120), null);
  // 'hub.local' passed as the name works the same.
  assert.ok(planReply(decodeMessage(encodeQuery([{ name: 'hub.local' }])), 5353, 'hub.local', IP, 120));
  // No addresses — nothing to say.
  assert.equal(planReply(decodeMessage(encodeQuery([{ name: 'hub.local' }])), 5353, 'hub', [], 120), null);
});

test('ignores responses (QR=1), including our own announcements', () => {
  const own = decodeMessage(encodeResponse({ name: 'hub.local', addresses: IP, ttl: 120 }));
  own.questions.push({ name: 'hub.local', type: TYPE_A, class: 1, unicast: false });
  assert.equal(planReply(own, 5353, 'hub', IP, 120), null);
});

test('AAAA for our name gets a negative NSEC only', () => {
  const reply = planReply(decodeMessage(encodeQuery([{ name: 'hub.local', type: TYPE_AAAA }])), 5353, 'hub', IP, 120);
  assert.ok(reply);
  const msg = decodeMessage(reply.packet);
  assert.deepEqual(msg.answers.map((r) => r.type), [TYPE_NSEC]);
  // Bitmap: window 0, length 1, only A.
  assert.deepEqual([...msg.answers[0]!.data.subarray(-3)], [0, 1, 0x40]);
});

test('QU bit → unicast; non-5353 source port → legacy unicast with id and question', () => {
  const qu = planReply(decodeMessage(encodeQuery([{ name: 'hub.local', unicast: true }])), 5353, 'hub', IP, 120);
  assert.equal(qu?.unicast, true);
  assert.equal(decodeMessage(qu.packet).id, 0);

  const legacy = planReply(decodeMessage(encodeQuery([{ name: 'Hub.local' }], 0x1234)), 51000, 'hub', IP, 120);
  assert.equal(legacy?.unicast, true);
  const msg = decodeMessage(legacy.packet);
  assert.equal(msg.id, 0x1234);
  assert.deepEqual(msg.questions, [{ name: 'Hub.local', type: TYPE_A, class: 1, unicast: false }]);
  assert.equal(msg.answers[0]!.ttl, 10);
  assert.equal(msg.answers[0]!.cacheFlush, false);
});

async function freeUdpPort(): Promise<number> {
  const s = createSocket('udp4');
  await new Promise<void>((resolve) => s.bind(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

function receiveOne(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mDNS-ответ не пришёл')), timeoutMs);
    socket.once('message', (buf) => {
      clearTimeout(timer);
      resolve(buf);
    });
  });
}

test('responder answers a legacy unicast query on loopback', async () => {
  const port = await freeUdpPort();
  const warnings: string[] = [];
  const responder = new MdnsResponder({
    name: 'hub',
    port,
    addresses: () => ['192.168.1.10'],
    logger: { info() {}, warn: (m) => warnings.push(m) },
  });
  await responder.start();
  const client = createSocket('udp4');
  try {
    await new Promise<void>((resolve) => client.bind(0, '127.0.0.1', resolve));
    const reply = receiveOne(client, 3000);
    client.send(encodeQuery([{ name: 'HUB.local' }], 0xbeef), port, '127.0.0.1');
    const msg = decodeMessage(await reply);
    assert.equal(msg.id, 0xbeef);
    assert.equal(msg.flags & 0x8400, 0x8400);
    assert.equal(msg.questions[0]!.name, 'HUB.local');
    assert.deepEqual(msg.answers.filter((r) => r.type === TYPE_A).map((r) => ip(r.data)), ['192.168.1.10']);

    // A foreign name gets no answer at all.
    const silence = receiveOne(client, 300).then(() => 'answered', () => 'silent');
    client.send(encodeQuery([{ name: 'printer.local' }], 1), port, '127.0.0.1');
    assert.equal(await silence, 'silent');
  } finally {
    await new Promise<void>((resolve) => client.close(() => resolve()));
    await responder.close();
  }
  await responder.close(); // idempotent
});

test('start() never throws when the port is unusable', async () => {
  const warnings: string[] = [];
  const responder = new MdnsResponder({ name: 'hub', port: 70000, logger: { info() {}, warn: (m) => warnings.push(m) } });
  await responder.start();
  await responder.close();
  assert.ok(warnings.some((w) => w.includes('70000')), warnings.join('\n'));
});
