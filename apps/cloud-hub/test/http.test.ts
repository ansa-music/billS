import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudError } from '../src/errors.ts';
import { allowedOrigins, cafeRoute, corsHeaders, readBody } from '../src/http.ts';
import { VirtualTimers } from '../src/timers.ts';

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

test('captured HUB intervals never arm a real timer and run as catch-up work', () => {
  const timers = new VirtualTimers(10_000);
  let ticks = 0;
  let once = 0;
  const realSetInterval = globalThis.setInterval;
  timers.capture(1_000, () => {
    const id = setInterval(() => ticks++, 1000);
    setTimeout(() => once++, 50_000);
    // The HUB calls .unref?.() on its timers.
    (id as unknown as { unref?: () => void }).unref?.();
  });
  assert.equal(globalThis.setInterval, realSetInterval);
  assert.equal(timers.size, 2);
  assert.equal(timers.runDue(5_000), 0); // floored to 10 s
  assert.equal(timers.runDue(11_000), 1);
  assert.equal(timers.runDue(500_000), 2); // slept long: each job once, not 49 times
  assert.equal(ticks, 2);
  assert.equal(once, 1);
  assert.equal(timers.size, 1);
});
