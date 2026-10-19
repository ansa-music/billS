import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PUBLIC_ORIGINS, DEMO_KEYS, isAccessKeyShape, originAllowed, parseOrigins, roleOfKeyPrefix } from '../src/index.ts';

test('originAllowed: exact, wildcard subdomain, star', () => {
  const p = DEFAULT_PUBLIC_ORIGINS;
  assert.equal(originAllowed('https://ts-app.web.app', p), true);
  assert.equal(originAllowed('https://ts-app--pr12-abc123.web.app', p), true);
  assert.equal(originAllowed('https://ts-app-demo.firebaseapp.com', p), true);
  assert.equal(originAllowed('http://ts-app.web.app', p), false);
  assert.equal(originAllowed('https://web.app', p), false);
  assert.equal(originAllowed('https://evil.com/.web.app', p), false);
  assert.equal(originAllowed('https://ts-app.web.app.evil.com', p), false);
  assert.equal(originAllowed(undefined, p), false);
  assert.equal(originAllowed('http://localhost:5173', ['http://localhost:5173']), true);
  assert.equal(originAllowed('https://any.example', ['*']), true);
  assert.equal(originAllowed('https://any.example', []), false);
});

test('parseOrigins trims, drops trailing slashes and empties', () => {
  assert.deepEqual(parseOrigins(' https://a.web.app/ , ,https://b.example'), ['https://a.web.app', 'https://b.example']);
  assert.deepEqual(parseOrigins(undefined), []);
});

test('demo keys are valid access keys of their roles', () => {
  for (const k of DEMO_KEYS) {
    assert.equal(isAccessKeyShape(k.key), true, k.key);
    assert.equal(roleOfKeyPrefix(k.key), k.role);
  }
});
