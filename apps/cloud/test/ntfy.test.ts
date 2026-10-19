import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PushKind } from '@bills/domain';
import type { PushFetch } from '../src/push.ts';
import { headerText, NtfySender } from '../src/push.ts';

const TOPIC = 'https://ntfy.sh/ts-k3J9xQ2mZp7Lw4Rt8Vb6Yc1N';

/** Decodes an RFC 2047 encoded-word the way ntfy does. */
function decodeHeader(value: string): string {
  const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(value);
  if (!m) return value;
  return new TextDecoder().decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)));
}

test('ntfy: POST to the topic with Title/Tags/Priority/Click and the text as body', async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];
  const fetch: PushFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: new TextDecoder().decode(init.body as Uint8Array) });
    return { status: 200, text: async () => '{}' };
  };
  const sender = new NtfySender({ fetch, token: 'tk_secret', cabinetUrl: 'https://ts.example.pages.dev' });
  const res = await sender.send({
    token: TOPIC,
    platform: 'ntfy',
    title: 'Клуб «Демо»: Батарея ИБП почти разряжена',
    body: 'Осталось 5 минут',
    data: { kind: 'POWER_CRITICAL', clubId: 'club 1' },
  });
  assert.deepEqual(res, { ok: true });
  const c = calls[0]!;
  assert.equal(c.url, TOPIC);
  assert.equal(c.method, 'POST');
  assert.equal(c.body, 'Осталось 5 минут');
  assert.match(c.headers.title!, /^=\?UTF-8\?B\?/);
  assert.equal(decodeHeader(c.headers.title!), 'Клуб «Демо»: Батарея ИБП почти разряжена');
  assert.equal(c.headers.priority, '5');
  assert.equal(c.headers.tags, 'rotating_light');
  assert.equal(c.headers.click, 'https://ts.example.pages.dev/#/clubs/club%201');
  assert.equal(c.headers.authorization, 'Bearer tk_secret');
  // Every header value must be sendable by fetch (Latin-1).
  for (const v of Object.values(c.headers)) assert.match(v, /^[\x20-\x7e]*$/);
});

test('ntfy: without token/cabinet no auth and no click; errors are not "unregistered"', async () => {
  const seen: Record<string, string>[] = [];
  let status = 200;
  const fetch: PushFetch = async (_url, init) => {
    seen.push(init.headers);
    return { status, text: async () => 'limit' };
  };
  const sender = new NtfySender({ fetch });
  const msg = { token: TOPIC, title: 'TS: test', body: 'b', data: { kind: 'OTHER' as PushKind, clubId: 'c' } };
  assert.deepEqual(await sender.send(msg), { ok: true });
  assert.equal(seen[0]!.title, 'TS: test');
  assert.equal(seen[0]!.priority, '3');
  assert.equal(seen[0]!.authorization, undefined);
  assert.equal(seen[0]!.click, undefined);
  status = 429;
  assert.deepEqual(await sender.send(msg), { ok: false, error: 'ntfy 429: limit', unregistered: false });

  const bad = await sender.send({ ...msg, token: 'http://ntfy.sh/short' });
  assert.equal(!bad.ok && bad.unregistered, true);
  assert.equal(seen.length, 2);
});

test('headerText keeps ASCII as is', () => {
  assert.equal(headerText('Hello'), 'Hello');
  assert.equal(decodeHeader(headerText('Привет')), 'Привет');
});
