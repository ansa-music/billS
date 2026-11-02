import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudError } from '../src/errors.ts';
import { allowedOrigins, cafeRoute, corsHeaders, deviceIdOf, isBrowserRequest, loginSource, readBody, tokenMatches } from '../src/http.ts';

test('a café URL names the café by its normalised code and the HUB path', () => {
  assert.deepEqual(cafeRoute('/c/K7F392QXM4P8/api/state'), { code: 'K7F392QXM4P8', path: '/api/state' });
  // Typed with dashes, lower case, look-alikes (O → 0, I/L → 1).
  assert.deepEqual(cafeRoute('/c/k7f3-92qx-m4p8/api/events'), { code: 'K7F392QXM4P8', path: '/api/events' });
  assert.deepEqual(cafeRoute('/c/K7F3-92QX-M4PO/metrics'), { code: 'K7F392QXM4P0', path: '/metrics' });
  assert.equal(cafeRoute('/assets/index.js'), null);
  assert.equal(cafeRoute('/'), null);
});

test('a malformed code or a non-API path is 404 before any Durable Object is touched', () => {
  const notFound = (p: string, code: string) => assert.throws(() => cafeRoute(p), (e: unknown) => e instanceof CloudError && e.status === 404 && e.code === code);
  notFound('/c/SHORT/api/state', 'CAFE_NOT_FOUND');
  notFound('/c/K7F392QXM4PU/api/state', 'CAFE_NOT_FOUND'); // U is not in the alphabet
  notFound('/c/%E0%A4%A/api/state', 'CAFE_NOT_FOUND');
  notFound('/c/K7F392QXM4P8/admin', 'NOT_FOUND');
  notFound('/c/K7F392QXM4P8', 'NOT_FOUND');
});

test('the body guard refuses a big body by its length and a chunked one while reading', async () => {
  const tooBig = (e: unknown) => e instanceof CloudError && e.status === 413 && e.code === 'BODY_TOO_LARGE' && /КБ/.test(e.message);
  const declared = new Request('https://x/', { method: 'POST', body: 'x'.repeat(10), headers: { 'content-length': '5000' } });
  await assert.rejects(readBody(declared, 1024), tooBig);
  const chunks = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(400));
      c.close();
    },
  });
  const chunked = new Request('https://x/', { method: 'POST', body: chunks, duplex: 'half' } as RequestInit);
  await assert.rejects(readBody(chunked, 1024), tooBig);
  const fine = await readBody(new Request('https://x/', { method: 'POST', body: '{"a":1}' }), 1024);
  assert.equal(new TextDecoder().decode(fine!), '{"a":1}');
  assert.equal(await readBody(new Request('https://x/'), 1024), null);
});

test('CORS only for the allowed origins', () => {
  const patterns = allowedOrigins(' https://*.pages.dev , http://localhost:5173,');
  assert.deepEqual(patterns, ['https://*.pages.dev', 'http://localhost:5173']);
  assert.equal(corsHeaders('https://ts-cafe.pages.dev', patterns)['access-control-allow-origin'], 'https://ts-cafe.pages.dev');
  assert.deepEqual(corsHeaders('https://evil.example', patterns), {});
  assert.deepEqual(corsHeaders(null, patterns), {});
});

test('the admin token: equal only to itself, never when unset or empty', async () => {
  assert.equal(await tokenMatches('s3cret-token', 's3cret-token'), true);
  assert.equal(await tokenMatches('s3cret-tokeN', 's3cret-token'), false);
  assert.equal(await tokenMatches('s3cret', 's3cret-token'), false);
  assert.equal(await tokenMatches('', ''), false);
  assert.equal(await tokenMatches('anything', undefined), false);
  assert.equal(await tokenMatches(null, 'x'), false);
});

test('a browser request is told apart from the platform server (admin API)', () => {
  assert.equal(isBrowserRequest(new Headers({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' })), true);
  assert.equal(isBrowserRequest(new Headers({ origin: 'https://evil.example' })), true);
  assert.equal(isBrowserRequest(new Headers({ 'sec-fetch-dest': 'document' })), true);
  // Deno (a Supabase function) and Node's fetch send none of these (Node adds only sec-fetch-mode).
  assert.equal(isBrowserRequest(new Headers({ authorization: 'Bearer x', 'sec-fetch-mode': 'cors', 'user-agent': 'Deno/2' })), false);
});

test('the login throttle counts a device behind the café IP on its own', () => {
  assert.equal(deviceIdOf(new Headers({ 'x-ts-device': 'd_8f3K2pQx9Lm4Zt7w' })), 'd_8f3K2pQx9Lm4Zt7w');
  assert.equal(deviceIdOf(new Headers({ 'x-ts-device': 'short' })), null);
  assert.equal(deviceIdOf(new Headers({ 'x-ts-device': 'bad id with spaces' })), null);
  assert.equal(deviceIdOf(new Headers()), null);
  assert.equal(loginSource('203.0.113.7', 'd_8f3K2pQx9Lm4Zt7w'), '203.0.113.7#d_8f3K2pQx9Lm4Zt7w');
  assert.equal(loginSource('203.0.113.7', null), '203.0.113.7');
  assert.ok(loginSource('2001:0db8:85a3:0000:0000:8a2e:0370:7334', 'd_8f3K2pQx9Lm4Zt7w').length <= 64);
});
