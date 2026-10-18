import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAccessKey,
  isAccessKeyShape,
  KEY_ALPHABET,
  keyPrefixOf,
  normalizeAccessKey,
  roleOfKeyPrefix,
} from '../src/auth.ts';

const indices = Array.from({ length: 16 }, (_, i) => i * 7);

test('a formatted key has the role prefix and four groups of four safe characters', () => {
  const key = formatAccessKey('owner', indices);
  assert.match(key, /^OWNER-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(isAccessKeyShape(key));
  assert.equal(roleOfKeyPrefix(key), 'owner');
  assert.equal(keyPrefixOf(key), key.slice(0, 10));
  assert.equal(roleOfKeyPrefix(formatAccessKey('superadmin', indices)), 'superadmin');
});

test('the alphabet never contains look-alike characters', () => {
  for (const c of '0O1IL') assert.ok(!KEY_ALPHABET.includes(c), c);
});

test('typed keys are normalized: case, spaces, odd dashes', () => {
  assert.equal(normalizeAccessKey('  wtr 7k3q m2px 9hwd 4rtb '), 'WTR-7K3Q-M2PX-9HWD-4RTB');
  assert.equal(normalizeAccessKey('WTR—7K3Q--M2PX_9HWD-4RTB-'), 'WTR-7K3Q-M2PX-9HWD-4RTB');
  assert.ok(isAccessKeyShape(normalizeAccessKey('cash-abcd-efgh-jkmn-pqrs')));
  assert.ok(!isAccessKeyShape('WTR-7K3Q-M2PX-9HWD'));
  assert.ok(!isAccessKeyShape('WTR-7K3Q-M2PX-9HWD-4RT0'));
  assert.equal(roleOfKeyPrefix('NOPE-AAAA-AAAA-AAAA-AAAA'), null);
});
