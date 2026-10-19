import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAccessKey,
  formatShortKey,
  isAccessKeyShape,
  isShortKeyShape,
  isWeakShortKey,
  KEY_ALPHABET,
  keyKindOf,
  keyPrefixOf,
  LOGIN_THROTTLE,
  loginLockMs,
  normalizeAccessKey,
  roleOfKeyPrefix,
  shortKeyHashInput,
} from '../src/auth.ts';

const indices = Array.from({ length: 16 }, (_, i) => i * 7);

test('a long key has the role prefix and four groups of four safe characters', () => {
  const key = formatAccessKey('owner', indices);
  assert.match(key, /^OWNER-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(isAccessKeyShape(key));
  assert.equal(roleOfKeyPrefix(key), 'owner');
  assert.equal(keyPrefixOf(key), key.slice(0, 10));
  assert.equal(roleOfKeyPrefix(formatAccessKey('tech', indices)), 'tech');
  assert.equal(roleOfKeyPrefix(formatAccessKey('manager', indices)), 'manager');
  assert.throws(() => formatAccessKey('waiter', indices), /no long keys/);
});

test('the alphabet never contains look-alike characters', () => {
  for (const c of '0O1IL') assert.ok(!KEY_ALPHABET.includes(c), c);
});

test('typed keys are normalized: case, spaces, odd dashes; digits stay digits', () => {
  assert.equal(normalizeAccessKey('  mgr 7k3q m2px 9hwd 4rtb '), 'MGR-7K3Q-M2PX-9HWD-4RTB');
  assert.equal(normalizeAccessKey('MGR—7K3Q--M2PX_9HWD-4RTB-'), 'MGR-7K3Q-M2PX-9HWD-4RTB');
  assert.ok(!isAccessKeyShape('MGR-7K3Q-M2PX-9HWD'));
  assert.ok(!isAccessKeyShape('MGR-7K3Q-M2PX-9HWD-4RT0'));
  assert.equal(roleOfKeyPrefix('NOPE-AAAA-AAAA-AAAA-AAAA'), null);
  assert.equal(normalizeAccessKey(' 318 540 '), '318540');
  assert.equal(normalizeAccessKey('318-540'), '318540');
});

test('short keys: six digits, kind detection, a prefix that does not reveal them', () => {
  assert.ok(isShortKeyShape('318540'));
  assert.ok(!isShortKeyShape('31854'));
  assert.ok(!isShortKeyShape('3185401'));
  assert.equal(keyKindOf('318540'), 'short');
  assert.equal(keyKindOf('MGR-7K3Q-M2PX-9HWD-4RTB'), 'long');
  assert.equal(keyKindOf('hello'), null);
  assert.equal(keyPrefixOf('318540'), '••••40');
});

test('weak short keys are refused and never generated', () => {
  for (const k of ['000000', '111111', '123456', '654321', '890123', '121212', '123123']) assert.ok(isWeakShortKey(k), k);
  for (const k of ['318540', '527193', '640285']) assert.ok(!isWeakShortKey(k), k);
  assert.equal(formatShortKey([1, 1, 1, 1, 1, 1, 3, 1, 8, 5, 4, 0]), '318540');
  assert.equal(formatShortKey([1, 1, 1, 1, 1, 1]), null);
});

test('a short key hashes differently in every branch', () => {
  assert.notEqual(shortKeyHashInput('club-a', '318540'), shortKeyHashInput('club-b', '318540'));
  assert.ok(shortKeyHashInput('club-a', '318540').includes('club-a'));
});

test('login throttle: five free failures, then a growing pause with a ceiling', () => {
  assert.equal(loginLockMs(0), 0);
  assert.equal(loginLockMs(LOGIN_THROTTLE.freeFailures - 1), 0);
  assert.equal(loginLockMs(LOGIN_THROTTLE.freeFailures), LOGIN_THROTTLE.baseLockMs);
  assert.equal(loginLockMs(LOGIN_THROTTLE.freeFailures + 1), LOGIN_THROTTLE.baseLockMs * 2);
  assert.equal(loginLockMs(100), LOGIN_THROTTLE.maxLockMs);
});
