// LICENSE_SIGNING_KEY as people paste it: the key alone, PEM, CRLF, or the whole generated key file.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { DEV_LICENSE_KEY } from '@bills/domain';
import { licenseSignerFromEnv, parseSigningKey, signerProblem } from '../src/license.ts';

const DEV = DEV_LICENSE_KEY.privateKey;
const toB64 = (b64url: string) => Buffer.from(b64url, 'base64url').toString('base64');

/** The layout of LICENSE_SIGNING_KEY.secret.txt as the key generator wrote it. */
function keyFile(kid: string, pub: string, priv: string): string {
  return [
    'TS — боевой ключ подписи лицензий (Ed25519, PKCS#8 DER в base64url). СЕКРЕТ: не коммитить.',
    `Публичная половина зашита в packages/domain/src/license.ts (PLATFORM_LICENSE_PUBLIC_KEYS, kid "${kid}").`,
    '',
    `Supabase:   supabase secrets set LICENSE_SIGNING_KEY=${priv}`,
    'Облако на мини-ПК (apps/cloud): LICENSE_SIGNING_KEY=… в .env облака.',
    '',
    `kid: ${kid}`,
    `public (raw, base64url): ${pub}`,
    `private (pkcs8, base64url): ${priv}`,
    '',
    'Перенесите ключ в менеджер паролей / секреты Supabase и удалите этот файл.',
    '',
  ].join('\n');
}

test('signing key: the whole generated key file → the private key and its kid', async () => {
  const file = keyFile('dev', DEV_LICENSE_KEY.publicKey, DEV);
  assert.deepEqual(parseSigningKey(file), { privateKey: DEV, kid: 'dev' });
  const signer = licenseSignerFromEnv({ LICENSE_SIGNING_KEY: file });
  assert.equal(signer.kid, 'dev');
  assert.equal(await signerProblem(signer), null);
  // With a BOM and Windows line ends (Notepad).
  assert.equal(parseSigningKey(`﻿${file.replace(/\n/g, '\r\n')}`).privateKey, DEV);
  // LICENSE_KEY_ID from the environment wins over the `kid:` line.
  assert.equal(licenseSignerFromEnv({ LICENSE_SIGNING_KEY: file, LICENSE_KEY_ID: 'ts-2026' }).kid, 'ts-2026');
});

test('signing key: the key alone — base64url, base64 with padding, CRLF, NAME=value, raw seed', () => {
  assert.equal(parseSigningKey(DEV).privateKey, DEV);
  assert.equal(parseSigningKey(`  ${toB64(DEV)}\r\n`).privateKey, DEV);
  assert.equal(parseSigningKey(`LICENSE_SIGNING_KEY=${DEV}`).privateKey, DEV);
  assert.equal(parseSigningKey(`LICENSE_SIGNING_KEY: "${toB64(DEV)}"\r\nLICENSE_KEY_ID=dev\r\n`).kid, 'dev');
  assert.equal(parseSigningKey(DEV).kid, null);
  const seed = Buffer.from(DEV, 'base64url').subarray(16).toString('base64url');
  assert.equal(parseSigningKey(seed).privateKey, DEV);
  // Wrapped over several lines without armor.
  assert.equal(parseSigningKey(toB64(DEV).match(/.{1,20}/g)!.join('\n')).privateKey, DEV);
});

test('signing key: PEM, with LF, CRLF or literal \\n', () => {
  const lines = ['-----BEGIN PRIVATE KEY-----', ...toB64(DEV).match(/.{1,40}/g)!, '-----END PRIVATE KEY-----', ''];
  assert.equal(parseSigningKey(lines.join('\n')).privateKey, DEV);
  assert.equal(parseSigningKey(lines.join('\r\n')).privateKey, DEV);
  assert.equal(parseSigningKey(lines.join('\\n')).privateKey, DEV);
  const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  assert.match(parseSigningKey(`комментарий\n${pem}`).privateKey, /^MC4CAQAwBQYDK2VwBCIEI/);
  assert.throws(() => parseSigningKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'), /PEM/);
});

test('signing key: junk, a public key alone or two different keys → a plain error', () => {
  assert.throws(() => parseSigningKey('not a key'), /не найден закрытый ключ Ed25519/);
  assert.throws(() => parseSigningKey(`public (raw, base64url): ${DEV_LICENSE_KEY.publicKey}`), /не найден закрытый ключ/);
  const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  assert.throws(() => parseSigningKey(`${DEV}\n${other}`), /несколько разных/);

  const signer = licenseSignerFromEnv({ LICENSE_SIGNING_KEY: 'kid: ts-2026\nкакой-то текст' });
  assert.equal(signer.dev, false);
  assert.match(signer.problem!, /не найден закрытый ключ/);
});

test('signing key: a key that is not the platform key of its kid is named plainly', async () => {
  const pair = generateKeyPairSync('ed25519');
  const priv = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url');
  const pub = (pair.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const signer = licenseSignerFromEnv({ LICENSE_SIGNING_KEY: keyFile('ts-2026', pub, priv) });
  assert.equal(signer.kid, 'ts-2026');
  assert.match((await signerProblem(signer))!, /ключ подписи не соответствует публичному ключу платформы/);
  // The dev key under the platform kid: wrong LICENSE_KEY_ID, said so.
  const devAsPlatform = licenseSignerFromEnv({ LICENSE_SIGNING_KEY: DEV, LICENSE_KEY_ID: 'ts-2026' });
  assert.match((await signerProblem(devAsPlatform))!, /относится к kid «dev»/);
});
