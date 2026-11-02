import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlAad,
  dataAad,
  deriveLinkKeys,
  deriveSessionKey,
  newLinkSecret,
  openControl,
  packFrame,
  randomLinkId,
  seal,
  sealControl,
  unpackFrame,
  unseal,
} from '../src/trial-link-crypto.ts';
import { ChunkAssembler, isLinkSecret, parseLinkFrame, splitChunks, TRIAL_LINK } from '../src/trial-link.ts';

test('a new link secret is 256 random bits in base64url', () => {
  const a = newLinkSecret();
  const b = newLinkSecret();
  assert.equal(isLinkSecret(a), true);
  assert.notEqual(a, b);
  assert.match(randomLinkId(TRIAL_LINK.deviceIdBytes), /^[A-Za-z0-9_-]{12}$/);
});

test('the room comes from the secret (same secret → same room), and does not contain it', async () => {
  const secret = newLinkSecret();
  const k1 = await deriveLinkKeys(secret);
  const k2 = await deriveLinkKeys(secret);
  const other = await deriveLinkKeys(newLinkSecret());
  assert.equal(k1.room, k2.room);
  assert.notEqual(k1.room, other.room);
  assert.match(k1.room, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(secret.includes(k1.room), false);
});

test('control messages open only with the same link, topic and sender', async () => {
  const secret = newLinkSecret();
  const a = await deriveLinkKeys(secret);
  const b = await deriveLinkKeys(secret);
  const stranger = await deriveLinkKeys(newLinkSecret());
  const aad = controlAad('tsl-room', 'dev1');
  const text = await sealControl(a.control, { t: 'up', hi: 'x', at: 1 }, aad);
  assert.equal(text.includes('"up"'), false, 'not readable on the wire');
  assert.deepEqual(await openControl(b.control, text, aad), { t: 'up', hi: 'x', at: 1 });
  assert.equal(await openControl(stranger.control, text, aad), null, 'another café');
  assert.equal(await openControl(b.control, text, controlAad('tsl-room', 'dev2')), null, 'another sender');
  assert.equal(await openControl(b.control, text, controlAad('tsl-other', 'dev1')), null, 'another topic');
  const flipped = (text[5] === 'A' ? 'B' : 'A') + '';
  assert.equal(await openControl(b.control, text.slice(0, 5) + flipped + text.slice(6), aad), null, 'one character changed');
  assert.equal(await openControl(b.control, 42, aad), null);
});

test('both sides derive the same session key; another session cannot open it', async () => {
  const secret = newLinkSecret();
  const device = await deriveLinkKeys(secret);
  const host = await deriveLinkKeys(secret);
  const kd = await deriveSessionKey(device.base, 'nonceD', 'nonceH');
  const kh = await deriveSessionKey(host.base, 'nonceD', 'nonceH');
  const other = await deriveSessionKey(host.base, 'nonceD', 'nonceH2');
  const plain = new TextEncoder().encode('секрет');
  const sealed = await seal(kd, plain, dataAad('s1', 'd2h', 1));
  assert.deepEqual(await unseal(kh, sealed, dataAad('s1', 'd2h', 1)), plain);
  await assert.rejects(unseal(other, sealed, dataAad('s1', 'd2h', 1)), 'a replay into another session');
  await assert.rejects(unseal(kh, sealed, dataAad('s1', 'd2h', 2)), 'moved to another sequence number');
  await assert.rejects(unseal(kh, sealed, dataAad('s1', 'h2d', 1)), 'reflected back to its sender');
  // A fresh IV each time: the same message never looks the same twice.
  const again = await seal(kd, plain, dataAad('s1', 'd2h', 1));
  assert.notDeepEqual(again, sealed);
});

test('packing: big messages are compressed when allowed, small ones are not; both unpack', async () => {
  const big = { t: 'res', id: 'r1', s: 200, h: {}, b: JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ name: `Латте ${i}`, price: 1200 })) }) };
  const packed = await packFrame(big, true);
  const plain = await packFrame(big, false);
  assert.equal(packed[0], 1, 'deflate');
  assert.equal(plain[0], 0, 'raw');
  assert.ok(packed.length < plain.length / 4);
  assert.deepEqual(await unpackFrame(packed), big);
  assert.deepEqual(await unpackFrame(plain), big);
  const small = await packFrame({ t: 'ping', at: 1 }, true);
  assert.equal(small[0], 0);
  await assert.rejects(unpackFrame(new Uint8Array([7, 1, 2])));
});

test('end to end: pack → seal → chunks (shuffled, duplicated) → assemble → open → the same request', async () => {
  const secret = newLinkSecret();
  const key = await deriveSessionKey((await deriveLinkKeys(secret)).base, 'a', 'b');
  const photo = 'data:image/jpeg;base64,' + Buffer.from(new Uint8Array(300_000).map(() => Math.floor(Math.random() * 256))).toString('base64');
  const frame = { t: 'req', id: 'r9', m: 'POST', u: '/api/bar/products', h: { 'idempotency-key': 'k-123456789' }, b: JSON.stringify({ photo }) };
  const sealed = await seal(key, await packFrame(frame, true), dataAad('s', 'd2h', 5));
  const chunks = splitChunks(5, sealed, TRIAL_LINK.directChunkBytes);
  assert.ok(chunks.length > 10);
  const asm = new ChunkAssembler();
  const order = chunks.map((_, i) => i).reverse();
  order.splice(3, 0, 7, 7);
  let whole: Uint8Array | null = null;
  for (const i of order) whole = asm.push(chunks[i]!, 0)?.data ?? whole;
  assert.ok(whole);
  const back = parseLinkFrame(await unpackFrame(await unseal(key, whole, dataAad('s', 'd2h', 5))));
  assert.deepEqual(back, frame);
});
