// Updater keys of TS for PC (Tauri updater = minisign, Ed25519): reading the public key, checking
// signatures and signing with the Tauri CLI. CI uses it to make sure, before building, that the
// private key in the repository secrets belongs to the public key built into the app — otherwise
// every installed copy would reject the update.
//
// Formats (Tauri stores each minisign "box" base64-encoded, minisign itself as plain text):
//   public key  untrusted comment: minisign public key: <id>\n base64("Ed" + keyId[8] + key[32])
//   signature   untrusted comment: …\n base64(alg[2] + keyId[8] + sig[64])\n trusted comment: …\n
//               base64(global sig[64] over sig + trusted comment)
//   alg "ED" signs BLAKE2b-512 of the file (what Tauri writes), "Ed" — the file itself.
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** apps/desktop: the Tauri CLI runs from here. */
export const DESKTOP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TAURI_CONF = join(DESKTOP_DIR, 'src-tauri', 'tauri.conf.json');

/** Lines of a minisign box given as plain text or base64 (the way Tauri keeps keys and signatures). */
function boxLines(value) {
  let text = String(value ?? '').trim();
  if (!text.startsWith('untrusted comment:')) text = Buffer.from(text, 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment:')) throw new Error('это не ключ и не подпись Tauri');
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
}

export function parsePublicKey(value) {
  const raw = Buffer.from(boxLines(value)[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.toString('latin1', 0, 2) !== 'Ed') throw new Error('открытый ключ повреждён');
  return { keyId: raw.subarray(2, 10), key: raw.subarray(10) };
}

export function parseSignature(value) {
  const lines = boxLines(value);
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  const alg = raw.toString('latin1', 0, 2);
  if (raw.length !== 74 || (alg !== 'Ed' && alg !== 'ED')) throw new Error('подпись повреждена');
  const prefix = 'trusted comment: ';
  return {
    prehashed: alg === 'ED',
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: lines[2]?.startsWith(prefix) ? lines[2].slice(prefix.length) : null,
    globalSignature: lines[3] ? Buffer.from(lines[3], 'base64') : null,
  };
}

/** Key id as minisign prints it ("untrusted comment: minisign public key: 3ADF8930F744303C"). */
export function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString('hex').toUpperCase();
}

/** True when `signature` (a Tauri .sig) was made over `data` by the private half of `publicKey`. */
export function verifySignature(publicKey, data, signature) {
  const pub = parsePublicKey(publicKey);
  const sig = parseSignature(signature);
  if (!pub.keyId.equals(sig.keyId)) return false;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.key.toString('base64url') }, format: 'jwk' });
  const message = sig.prehashed ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, key, sig.signature)) return false;
  if (sig.trustedComment === null || sig.globalSignature === null) return true;
  return verify(null, Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]), key, sig.globalSignature);
}

/** Path of the Tauri CLI entry (node_modules/@tauri-apps/cli/tauri.js), or null before `npm ci`. */
export function tauriCli() {
  try {
    return createRequire(join(DESKTOP_DIR, 'package.json')).resolve('@tauri-apps/cli/tauri.js');
  } catch {
    return null;
  }
}

/** Runs the Tauri CLI with node directly: no npx, no shell, the same on Windows and Linux. */
export function runTauri(args, { env = process.env } = {}) {
  const cli = tauriCli();
  if (!cli) throw new Error('нет @tauri-apps/cli — выполните npm ci в корне репозитория');
  return spawnSync(process.execPath, [cli, ...args], { cwd: DESKTOP_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Tool output without anything that looks like a key or a signature. */
export function redact(text) {
  return String(text ?? '').replace(/[A-Za-z0-9+/=_-]{40,}/g, '…');
}

/**
 * Signs `file` with the Tauri CLI (writes `<file>.sig`) and returns the signature. The key and the
 * password travel through the environment only, never on a command line.
 */
export function signFile(file, { privateKey, password, appVersion } = {}) {
  const env = { ...process.env, CI: 'true', TAURI_SIGNING_PRIVATE_KEY: privateKey };
  delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  if (password) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password;
  else delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  const args = ['signer', 'sign'];
  if (appVersion) args.push('--app-version', appVersion);
  const result = runTauri([...args, file], { env });
  const sigPath = `${file}.sig`;
  if (result.status !== 0 || !existsSync(sigPath)) {
    const output = redact(`${result.stderr}\n${result.stdout}`);
    const lines = output.split('\n').map((l) => l.trim());
    const reason = lines.find((l) => /error/i.test(l) && !/^Error\s/.test(l)) ?? lines.find((l) => /error/i.test(l));
    const error = new Error(reason || `tauri signer sign завершился с кодом ${result.status}`);
    error.wrongPassword = /wrong password/i.test(output);
    throw error;
  }
  return readFileSync(sigPath, 'utf8').trim();
}

/**
 * Checks that the private key signs what `publicKey` verifies. Returns { ok: true } or
 * { ok: false, reason: 'mismatch' | 'password' | 'broken', message }.
 */
export function checkKeyPair({ publicKey, privateKey, password }) {
  try {
    parsePublicKey(publicKey);
  } catch (e) {
    return { ok: false, reason: 'broken', message: `открытый ключ: ${e.message}` };
  }
  const dir = mkdtempSync(join(tmpdir(), 'ts-updater-key-'));
  try {
    const file = join(dir, 'probe.txt');
    const data = Buffer.from(`TS updater key check ${new Date().toISOString()}\n`);
    writeFileSync(file, data);
    let signature;
    try {
      signature = signFile(file, { privateKey, password });
    } catch (e) {
      return { ok: false, reason: e.wrongPassword ? 'password' : 'broken', message: e.message };
    }
    return verifySignature(publicKey, data, signature)
      ? { ok: true }
      : { ok: false, reason: 'mismatch', message: 'подпись не проверяется открытым ключом' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** plugins.updater.pubkey of tauri.conf.json. */
export function configPublicKey() {
  return JSON.parse(readFileSync(TAURI_CONF, 'utf8')).plugins?.updater?.pubkey ?? '';
}
