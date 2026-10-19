import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PUBLIC_ORIGINS, DEMO_KEYS, isAccessKeyShape, originAllowed, parseOrigins, roleOfKeyPrefix } from '../src/index.ts';

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

test('demo keys are valid access keys of their roles', () => {
  for (const k of DEMO_KEYS) {
    assert.equal(isAccessKeyShape(k.key), true, k.key);
    assert.equal(roleOfKeyPrefix(k.key), k.role);
  }
});
