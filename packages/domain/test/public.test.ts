import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PUBLIC_ORIGINS, DEMO_KEYS, isAccessKeyShape, isDemoKeyShape, isShortKeyShape, originAllowed, parseOrigins, roleOfKeyPrefix } from '../src/index.ts';

test('originAllowed: exact, wildcard subdomain, star', () => {
  const p = DEFAULT_PUBLIC_ORIGINS;
  assert.equal(originAllowed('https://ts-demo.pages.dev', p), true);
  assert.equal(originAllowed('https://a1b2c3d4.ts-demo.pages.dev', p), true);
  assert.equal(originAllowed('https://ansa-music.github.io', p), true);
  assert.equal(originAllowed('http://ts-demo.pages.dev', p), false);
  assert.equal(originAllowed('https://pages.dev', p), false);
  assert.equal(originAllowed('https://evil.com/.pages.dev', p), false);
  assert.equal(originAllowed('https://ts-demo.pages.dev.evil.com', p), false);
  assert.equal(originAllowed(undefined, p), false);
  assert.equal(originAllowed('http://localhost:5173', ['http://localhost:5173']), true);
  assert.equal(originAllowed('https://any.example', ['*']), true);
  assert.equal(originAllowed('https://any.example', []), false);
});

test('parseOrigins trims, drops trailing slashes and empties', () => {
  assert.deepEqual(parseOrigins(' https://a.pages.dev/ , ,https://b.example'), ['https://a.pages.dev', 'https://b.example']);
  assert.deepEqual(parseOrigins(undefined), []);
});

test('demo keys: four digits, never the shape of a real key', () => {
  for (const k of DEMO_KEYS) {
    assert.equal(isDemoKeyShape(k.key), true, k.key);
    assert.equal(isAccessKeyShape(k.key), false, k.key);
    assert.equal(isShortKeyShape(k.key), false, k.key);
  }
  assert.equal(roleOfKeyPrefix('OWNER-2222-2222-2222-2222'), 'owner');
  assert.ok(DEMO_KEYS.some((k) => k.roles.length > 1), 'a demo person with several roles');
  assert.equal(new Set(DEMO_KEYS.map((k) => k.key)).size, DEMO_KEYS.length);
});
