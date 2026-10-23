// Tests of the release scripts of TS for PC: node --test "apps/desktop/scripts/*.test.mjs"
// The key pair tests run the real Tauri CLI (after npm ci) and are skipped without it.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ciConfig, latestJson, releaseAsset, tagVersion } from './ci.mjs';
import { checkKeyPair, keyIdHex, parsePublicKey, runTauri, signFile, tauriCli, verifySignature } from './updater-key.mjs';

describe('tagVersion', () => {
  test('takes the version from a desktop-v tag', () => {
    assert.equal(tagVersion('tag', 'desktop-v0.1.2'), '0.1.2');
    assert.equal(tagVersion('tag', 'desktop-v1.255.65535'), '1.255.65535');
  });
  test('null outside release tags', () => {
    assert.equal(tagVersion('branch', 'main'), null);
    assert.equal(tagVersion('tag', 'mobile-v0.1.0'), null);
    assert.equal(tagVersion('tag', 'desktop-latest'), null);
  });
  test('rejects versions an MSI cannot carry', () => {
    assert.throws(() => tagVersion('tag', 'desktop-v0.2'), /трёх чисел/);
    assert.throws(() => tagVersion('tag', 'desktop-v0.2.0-beta'), /трёх чисел/);
    assert.throws(() => tagVersion('tag', 'desktop-v256.0.0'), /255/);
  });
});

test('ciConfig: version and public key only when given', () => {
  assert.deepEqual(ciConfig({ version: null, publicKey: null, updaterArtifacts: false }), {
    bundle: { createUpdaterArtifacts: false },
  });
  assert.deepEqual(ciConfig({ version: '0.1.2', publicKey: 'PUB', updaterArtifacts: true }), {
    bundle: { createUpdaterArtifacts: true },
    version: '0.1.2',
    plugins: { updater: { pubkey: 'PUB' } },
  });
});

test('release assets and latest.json', () => {
  const msi = releaseAsset('TS_0.1.2_x64_ru-RU.msi', '0.1.2');
  const deb = releaseAsset('TS_0.1.2_amd64.deb', '0.1.2');
  assert.equal(msi.name, 'TS-0.1.2-windows-x64.msi');
  assert.equal(deb.name, 'TS-0.1.2-linux-amd64.deb');
  assert.equal(releaseAsset('latest.json', '0.1.2'), null);
  const json = latestJson({
    version: '0.1.2',
    notes: 'n',
    pubDate: '2026-10-21T00:00:00Z',
    entries: [
      { url: 'https://x/msi', signature: 'S1', platforms: msi.platforms },
      { url: 'https://x/deb', signature: 'S2', platforms: deb.platforms },
    ],
  });
  assert.deepEqual(Object.keys(json.platforms).sort(), ['linux-x86_64', 'linux-x86_64-deb', 'windows-x86_64-msi']);
  assert.deepEqual(json.platforms['windows-x86_64-msi'], { signature: 'S1', url: 'https://x/msi' });
  const exe = releaseAsset('TS_0.1.2_x64-setup.exe', '0.1.2');
  assert.equal(exe.name, 'TS-0.1.2-windows-x64-setup.exe');
  assert.deepEqual(exe.platforms, ['windows-x86_64', 'windows-x86_64-nsis']);
  assert.equal(json.pub_date, '2026-10-21T00:00:00Z');
});

test('the public key in tauri.conf.json parses', () => {
  const conf = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const { keyId, key } = parsePublicKey(conf.plugins.updater.pubkey);
  assert.equal(key.length, 32);
  assert.match(keyIdHex(keyId), /^[0-9A-F]{16}$/);
});

describe('key pairs (Tauri CLI)', { skip: tauriCli() ? false : 'нет @tauri-apps/cli' }, () => {
  let dir;
  const pair = (name, password) => {
    const key = join(dir, `${name}.key`);
    const args = ['signer', 'generate', '--ci', '--write-keys', key];
    if (password) args.push('--password', password);
    const r = runTauri(args);
    assert.equal(r.status, 0, r.stderr);
    return { privateKey: readFileSync(key, 'utf8').trim(), publicKey: readFileSync(`${key}.pub`, 'utf8').trim(), password };
  };
  let a;
  let b;
  let open;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ts-key-test-'));
    a = pair('a', 'secret-a');
    b = pair('b', 'secret-b');
    open = pair('open', undefined);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('a key matches its own public key', () => {
    assert.deepEqual(checkKeyPair(a), { ok: true });
    assert.deepEqual(checkKeyPair(open), { ok: true });
  });
  test('a key from another pair does not match', () => {
    assert.equal(checkKeyPair({ ...a, publicKey: b.publicKey }).reason, 'mismatch');
  });
  test('a wrong password is told apart', () => {
    assert.equal(checkKeyPair({ ...a, password: 'nope' }).reason, 'password');
    assert.equal(checkKeyPair({ ...a, password: '' }).reason, 'password');
  });
  test('a damaged key is told apart', () => {
    assert.equal(checkKeyPair({ ...a, privateKey: 'garbage' }).reason, 'broken');
  });
  test('signatures cover the file and the trusted comment', () => {
    const file = join(dir, 'setup.msi');
    writeFileSync(file, 'installer bytes');
    const sig = signFile(file, { ...a, appVersion: '0.1.2' });
    assert.ok(verifySignature(a.publicKey, Buffer.from('installer bytes'), sig));
    assert.ok(!verifySignature(a.publicKey, Buffer.from('installer bytes!'), sig));
    assert.ok(!verifySignature(b.publicKey, Buffer.from('installer bytes'), sig));
    // A forged trusted comment (e.g. another version) breaks the global signature.
    const text = Buffer.from(sig, 'base64').toString('utf8').replace('0.1.2', '9.9.9');
    assert.ok(text.includes('9.9.9'));
    assert.ok(!verifySignature(a.publicKey, Buffer.from('installer bytes'), Buffer.from(text).toString('base64')));
  });
});
