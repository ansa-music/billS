/**
 * LICENSE_SIGNING_KEY as people paste it: the bare key, PEM, a seed, hex, or the whole notes file
 * with the key (BOM, CRLF, comments, LICENSE_KEY_ID, the public key next to it). The key must be
 * the private half of the public key built into TS for that kid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { LicensePayload } from '@bills/domain';
import { DEV_LICENSE_KEY, PLATFORM_LICENSE_PUBLIC_KEYS, verifyLicense } from '@bills/domain';
import { licenseSignerFromEnv, parseSigningSecret, signChecked } from '../../apps/cloud/src/license.ts';

const DEV = DEV_LICENSE_KEY.privateKey;
const der = Buffer.from(DEV, 'base64url');
const seed = der.subarray(16);
const pem = `-----BEGIN PRIVATE KEY-----\n${der.toString('base64').match(/.{1,40}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;

const payload = (): LicensePayload => ({
  v: 1,
  id: 'lic-1',
  companyId: 'c-1',
  companyName: 'Сеть',
  plan: 'trial',
  issuedAt: 1,
  validFrom: 1,
  validUntil: 2,
  maxClubs: 1,
  maxTables: null,
  maxStaff: null,
  modules: { bar: true, cloud: true, hardware: true },
  hubIds: [],
  blocked: false,
});

test('parseSigningSecret: every way the key gets pasted', () => {
  const notes = [
    '﻿# Ключ подписи лицензий TS — секрет, никому не показывать',
    'Сгенерирован: 2026-10-20',
    `Публичный ключ (packages/domain/src/license.ts): ${DEV_LICENSE_KEY.publicKey}`,
    'LICENSE_KEY_ID=dev',
    `LICENSE_SIGNING_KEY=${der.toString('base64')}`,
    '',
    'Вставьте значение в GitHub → Settings → Secrets → LICENSE_SIGNING_KEY',
  ];
  const cases: Array<[string, string, string | null]> = [
    ['bare base64url', DEV, null],
    ['bare base64 with padding and spaces', `  ${der.toString('base64')}  \n`, null],
    ['PEM', pem, null],
    ['PEM with CRLF', pem.replace(/\n/g, '\r\n'), null],
    ['PEM with escaped newlines', pem.replace(/\n/g, '\n'), null],
    ['hex', der.toString('hex'), null],
    ['raw seed base64url', seed.toString('base64url'), null],
    ['raw seed hex', seed.toString('hex'), null],
    ['notes file', notes.join('\n'), 'dev'],
    ['notes file with CRLF', notes.join('\r\n'), 'dev'],
    ['notes file with PEM inside', `Ключ TS\r\nLICENSE_KEY_ID: "dev"\r\n${pem}\r\nPublic: ${DEV_LICENSE_KEY.publicKey}`, 'dev'],
    ['seed next to the public key', `public ${DEV_LICENSE_KEY.publicKey}\nprivate seed ${seed.toString('base64')}`, null],
  ];
  for (const [name, raw, kid] of cases) assert.deepEqual(parseSigningSecret(raw), { privateKey: DEV, kid }, name);
  for (const junk of ['', 'not a key', `only the public key ${DEV_LICENSE_KEY.publicKey}`, 'x'.repeat(64)]) {
    assert.equal(parseSigningSecret(junk), null, junk);
  }
});

test('licenseSignerFromEnv: kid from the env, else from the file, lower-cased', () => {
  assert.equal(licenseSignerFromEnv({}).dev, true);
  assert.deepEqual(licenseSignerFromEnv({ LICENSE_SIGNING_KEY: `LICENSE_KEY_ID=dev\n${pem}` }), { kid: 'dev', privateKey: DEV, dev: false });
  assert.equal(licenseSignerFromEnv({ LICENSE_SIGNING_KEY: `LICENSE_KEY_ID=dev\n${pem}`, LICENSE_KEY_ID: 'TS-2026' }).kid, 'ts-2026');
  assert.equal(licenseSignerFromEnv({ LICENSE_SIGNING_KEY: pem }).kid, 'ts-2026');
  const logs: string[] = [];
  assert.equal(licenseSignerFromEnv({ LICENSE_SIGNING_KEY: 'garbage' }, (m) => logs.push(m)).privateKey, '');
  assert.match(logs.join(), /не найден/);
});

test('signChecked: the key must belong to the public key built into TS', async () => {
  const signed = await signChecked(licenseSignerFromEnv({ LICENSE_SIGNING_KEY: pem, LICENSE_KEY_ID: 'dev' }), payload());
  assert.equal((await verifyLicense(signed, { dev: DEV_LICENSE_KEY.publicKey })).ok, true);

  // Another Ed25519 key under the platform's kid: "not from this platform".
  const foreign = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  assert.ok(PLATFORM_LICENSE_PUBLIC_KEYS['ts-2026']);
  await assert.rejects(signChecked(licenseSignerFromEnv({ LICENSE_SIGNING_KEY: foreign }), payload()), (e: { code: string; message: string }) => {
    assert.equal(e.code, 'LICENSE_KEY_MISMATCH');
    assert.match(e.message, /не от этой платформы/);
    return true;
  });
  await assert.rejects(signChecked(licenseSignerFromEnv({ LICENSE_SIGNING_KEY: pem, LICENSE_KEY_ID: 'other' }), payload()), {
    code: 'LICENSE_KEY_UNKNOWN',
  });
  await assert.rejects(signChecked(licenseSignerFromEnv({ LICENSE_SIGNING_KEY: 'no key here' }), payload()), { code: 'LICENSE_KEY_MISSING' });
});
