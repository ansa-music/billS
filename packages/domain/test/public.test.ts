import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PUBLIC_ORIGINS, DEMO_KEYS, isAccessKeyShape, isShortKeyShape, originAllowed, parseOrigins, roleOfKeyPrefix } from '../src/index.ts';

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

test('demo keys: long keys for the platform and the manager, six digits for staff', () => {
  for (const k of DEMO_KEYS) {
    if (k.roles.length === 1 && ['owner', 'tech', 'manager'].includes(k.roles[0]!)) {
      assert.equal(isAccessKeyShape(k.key), true, k.key);
      assert.equal(roleOfKeyPrefix(k.key), k.roles[0]);
    } else {
      assert.equal(isShortKeyShape(k.key), true, k.key);
    }
  }
  assert.ok(DEMO_KEYS.some((k) => k.roles.length > 1), 'a demo person with several roles');
  assert.equal(new Set(DEMO_KEYS.map((k) => k.key)).size, DEMO_KEYS.length);
});
