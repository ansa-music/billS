import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  b64urlDecodeBytes,
  b64urlEncode,
  DEV_LICENSE_KEY,
  licenseGateOf,
  licenseStatus,
  licenseTermEnd,
  peekLicense,
  PLATFORM_LICENSE_PUBLIC_KEYS,
  signLicense,
  verifyLicense,
} from '../src/license.ts';
import type { LicensePayload } from '../src/license.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 19, 9, 0, 0);
const DEV_KEYS = { [DEV_LICENSE_KEY.kid]: DEV_LICENSE_KEY.publicKey };

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    id: 'lic-1',
    companyId: 'co-1',
    companyName: 'Сеть «Шар»',
    plan: 'trial',
    issuedAt: NOW,
    validFrom: NOW,
    validUntil: NOW + 7 * DAY,
    maxClubs: 1,
    maxTables: null,
    maxStaff: 10,
    modules: { bar: true, cloud: true, hardware: false },
    hubIds: ['hub-a'],
    blocked: false,
    ...over,
  };
}

test('base64url round-trips any bytes', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) % 256);
    assert.deepEqual(b64urlDecodeBytes(b64urlEncode(bytes)), bytes);
    assert.equal(b64urlEncode(bytes), Buffer.from(bytes).toString('base64url'));
  }
});

test('a signed license verifies and reads back the same terms', async () => {
  const text = await signLicense(payload(), DEV_LICENSE_KEY.privateKey, DEV_LICENSE_KEY.kid);
  assert.match(text, /^TS1\.dev\./);
  const res = await verifyLicense(text, DEV_KEYS);
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.license, payload());
  assert.deepEqual(peekLicense(text), payload());
});

test('a forged license is refused: edited payload, another key, unknown kid, garbage', async () => {
  const text = await signLicense(payload(), DEV_LICENSE_KEY.privateKey, DEV_LICENSE_KEY.kid);
  const [p, kid, body, sig] = text.split('.') as [string, string, string, string];

  // The manager widens their own license: 1 branch → 10, a year longer.
  const widened = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload({ maxClubs: 10, validUntil: NOW + 365 * DAY }))));
  const forged = await verifyLicense(`${p}.${kid}.${widened}.${sig}`, DEV_KEYS);
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.reason, 'signature');

  // Signed with a key of their own.
  const { privateKey } = generateKeyPairSync('ed25519');
  const own = await signLicense(payload(), privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'), 'dev');
  assert.equal((await verifyLicense(own, DEV_KEYS)).ok, false);

  // The dev key is not a platform key: production HUBs refuse dev-signed licenses.
  const prod = await verifyLicense(text, PLATFORM_LICENSE_PUBLIC_KEYS);
  assert.equal(prod.ok, false);
  if (!prod.ok) assert.equal(prod.reason, 'unknown_key');

  assert.equal((await verifyLicense('hello', DEV_KEYS)).ok, false);
  assert.equal((await verifyLicense(`${p}.${kid}.${body}.AAAA`, DEV_KEYS)).ok, false);
});

test('status: active, warning 3 days before, last day, expired → read-only', () => {
  const lic = payload();
  assert.equal(licenseStatus(lic, NOW, { hubId: 'hub-a' }).state, 'active');
  const warn = licenseStatus(lic, NOW + 4 * DAY + 1, { hubId: 'hub-a' });
  assert.equal(warn.state, 'expiring');
  assert.equal(warn.daysLeft, 3);
  assert.equal(warn.readOnly, false);
  assert.match(warn.message!, /через 3 дн/);
  const last = licenseStatus(lic, NOW + 7 * DAY - 3_600_000, { hubId: 'hub-a' });
  assert.equal(last.state, 'last_day');
  assert.equal(last.readOnly, false);
  const over = licenseStatus(lic, NOW + 7 * DAY, { hubId: 'hub-a' });
  assert.equal(over.state, 'expired');
  assert.equal(over.readOnly, true);
  assert.equal(over.daysLeft, 0);
  assert.deepEqual(licenseGateOf(over), { readOnly: true, modules: lic.modules });
});

test('status: winding the clock back does not revive an expired license', () => {
  const lic = payload();
  const st = licenseStatus(lic, NOW + DAY, { hubId: 'hub-a', highWater: NOW + 8 * DAY });
  assert.equal(st.state, 'expired');
});

test('status: other HUB, blocked, missing, invalid, not yet valid', () => {
  const lic = payload();
  assert.equal(licenseStatus(lic, NOW, { hubId: 'hub-b' }).state, 'wrong_hub');
  assert.equal(licenseStatus(lic, NOW, { hubId: 'hub-b' }).readOnly, true);
  assert.equal(licenseStatus(payload({ blocked: true }), NOW, { hubId: 'hub-a' }).state, 'blocked');
  assert.equal(licenseStatus(null, NOW).state, 'missing');
  assert.equal(licenseStatus(null, NOW).readOnly, true);
  assert.equal(licenseStatus(lic, NOW, { invalid: true }).state, 'invalid');
  // A few minutes of clock difference is fine…
  assert.equal(licenseStatus(payload({ validFrom: NOW + 5 * 60_000 }), NOW, { hubId: 'hub-a' }).state, 'active');
  // …a day is not.
  assert.equal(licenseStatus(payload({ validFrom: NOW + DAY }), NOW, { hubId: 'hub-a' }).state, 'not_yet');
});

test('terms: 3 or 7 day trial, months, until a date (through the end of that day in Kazakhstan)', () => {
  assert.equal(licenseTermEnd({ kind: 'trial', days: 7 }, NOW), NOW + 7 * DAY);
  assert.equal(licenseTermEnd({ kind: 'trial', days: 3 }, NOW), NOW + 3 * DAY);
  assert.throws(() => licenseTermEnd({ kind: 'trial', days: 5 as 3 }, NOW));
  assert.equal(licenseTermEnd({ kind: 'months', months: 1 }, NOW), Date.UTC(2026, 10, 19, 9, 0, 0));
  assert.equal(licenseTermEnd({ kind: 'until', date: '2026-12-31' }, NOW), Date.UTC(2027, 0, 1) - 5 * 3_600_000);
  assert.throws(() => licenseTermEnd({ kind: 'until', date: '2020-01-01' }, NOW));
  assert.throws(() => licenseTermEnd({ kind: 'until', date: '31.12.2026' }, NOW));
});
