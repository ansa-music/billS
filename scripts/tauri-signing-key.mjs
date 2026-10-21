#!/usr/bin/env node
// Creates the key pair that signs updates of TS for PC (Tauri updater) and tells what to paste into
// the GitHub settings. The keys go to a folder outside the repository (default ~/.ts-keys/desktop);
// the script prints only file names and instructions, never the keys themselves.
//
//   npm run desktop:signing-key                       создать ключи и показать, что куда вставить
//   npm run desktop:signing-key -- --copy key         скопировать закрытый ключ в буфер обмена
//   npm run desktop:signing-key -- --copy password    скопировать пароль
//   npm run desktop:signing-key -- --copy pub         скопировать открытый ключ
//   npm run desktop:signing-key -- --write-config     записать открытый ключ в tauri.conf.json
//   флаг --dir <папка>: другая папка для ключей (не внутри репозитория)
//
// The private key gets a random password (password.txt next to it): GitHub does not allow empty
// secrets, and a password keeps a copied key file useless on its own.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkKeyPair, keyIdHex, parsePublicKey, redact, runTauri, TAURI_CONF } from '../apps/desktop/scripts/updater-key.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = { key: 'updater.key', password: 'password.txt', pub: 'updater.key.pub' };

function fail(message) {
  console.error(`\nОшибка: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { dir: join(homedir(), '.ts-keys', 'desktop'), writeConfig: false, copy: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = resolve(argv[++i] ?? fail('после --dir укажите папку'));
    else if (arg === '--write-config') opts.writeConfig = true;
    else if (arg === '--copy') opts.copy = argv[++i] ?? fail('после --copy укажите: key, password или pub');
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else fail(`непонятный параметр «${arg}». Подсказка: npm run desktop:signing-key -- --help`);
  }
  if (opts.copy && !FILES[opts.copy]) fail('после --copy укажите: key, password или pub');
  return opts;
}

function insideRepo(dir) {
  const rel = relative(REPO_ROOT, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Copies text to the clipboard with the system tool; false when there is none. */
function copyToClipboard(text) {
  const tools =
    process.platform === 'win32'
      ? [['clip', []]]
      : process.platform === 'darwin'
        ? [['pbcopy', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  for (const [cmd, args] of tools) {
    const r = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

/** Puts the public key into plugins.updater.pubkey, keeping the rest of the file as it is. */
function writeConfig(publicKey) {
  const text = readFileSync(TAURI_CONF, 'utf8');
  const pattern = /("pubkey"\s*:\s*")[^"]*(")/;
  if (!pattern.test(text)) fail(`в ${TAURI_CONF} нет поля plugins.updater.pubkey`);
  writeFileSync(TAURI_CONF, text.replace(pattern, `$1${publicKey}$2`));
}

const opts = parseArgs(process.argv.slice(2));
const paths = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, join(opts.dir, f)]));

if (opts.help) {
  console.log(`
Ключи автообновления TS для ПК.
  npm run desktop:signing-key                       создать ключи и показать, что куда вставить на GitHub
  npm run desktop:signing-key -- --copy key         скопировать закрытый ключ в буфер обмена
  npm run desktop:signing-key -- --copy password    скопировать пароль
  npm run desktop:signing-key -- --copy pub         скопировать открытый ключ
  npm run desktop:signing-key -- --write-config     записать открытый ключ в tauri.conf.json (вместо переменной)
  --dir <папка>                                     другая папка для ключей (по умолчанию ${join(homedir(), '.ts-keys', 'desktop')})
`);
  process.exit(0);
}

if (opts.copy) {
  const file = paths[opts.copy];
  if (!existsSync(file)) fail(`нет файла ${file}. Сначала создайте ключи: npm run desktop:signing-key`);
  const text = readFileSync(file, 'utf8').trim();
  if (copyToClipboard(text)) console.log(`\nСкопировано в буфер обмена: ${FILES[opts.copy]}. Вставьте его на GitHub (Ctrl+V).\n`);
  else fail(`не получилось скопировать. Откройте файл ${file} в блокноте, выделите всё (Ctrl+A) и скопируйте (Ctrl+C).`);
  process.exit(0);
}

if (insideRepo(opts.dir)) fail(`папка ${opts.dir} внутри репозитория — ключ может случайно попасть в git. Выберите другую: --dir <папка>`);

const existing = Object.values(paths).filter((p) => existsSync(p));
if (existing.length > 0 && !opts.writeConfig) {
  fail(
    `ключи уже есть: ${existing.join(', ')}.\n` +
      'Новую пару создавать не нужно, если эти ключи уже вставлены на GitHub. Если всё же нужна новая пара ' +
      '(например, старую вставили неверно) — переименуйте эту папку и запустите команду снова. ' +
      'Удалять старые ключи нельзя, пока программы в клубах не обновятся на версию с новым ключом.',
  );
}

if (existing.length === 0) {
  mkdirSync(opts.dir, { recursive: true });
  const password = randomBytes(24).toString('base64url');
  const result = runTauri(['signer', 'generate', '--ci', '--password', password, '--write-keys', paths.key]);
  if (result.status !== 0 || !existsSync(paths.key) || !existsSync(paths.pub)) {
    fail(`не удалось создать ключи: ${redact(result.stderr || result.stdout).trim() || `код ${result.status}`}`);
  }
  writeFileSync(paths.password, password, { mode: 0o600 });
  try {
    chmodSync(paths.key, 0o600);
  } catch {
    // Windows: file modes do not apply; the folder is in the user's profile.
  }
  const check = checkKeyPair({
    publicKey: readFileSync(paths.pub, 'utf8'),
    privateKey: readFileSync(paths.key, 'utf8').trim(),
    password,
  });
  if (!check.ok) fail(`созданные ключи не прошли проверку (${check.message}). Удалите папку ${opts.dir} и запустите снова.`);
}

const publicKey = readFileSync(paths.pub, 'utf8').trim();
const id = keyIdHex(parsePublicKey(publicKey).keyId);

if (opts.writeConfig) {
  writeConfig(publicKey);
  console.log(`\nОткрытый ключ ${id} записан в ${relative(REPO_ROOT, TAURI_CONF)}.`);
  console.log('Закоммитьте этот файл. Переменная TAURI_UPDATER_PUBKEY на GitHub тогда не обязательна');
  console.log('(если она есть, сборка возьмёт ключ из неё — значения должны совпадать).\n');
  if (existing.length > 0) process.exit(0);
}

const defaultDir = opts.dir === join(homedir(), '.ts-keys', 'desktop');
const npmCopy = (what) => `npm run desktop:signing-key -- --copy ${what}${defaultDir ? '' : ` --dir "${opts.dir}"`}`;
console.log(`
Готово. Ключи автообновления TS для ПК (ключ ${id}) лежат в папке:
  ${opts.dir}
    ${FILES.key}      — закрытый ключ (секрет, никому не показывать)
    ${FILES.password}     — пароль к нему (секрет)
    ${FILES.pub}  — открытый ключ (не секрет)

Сразу сохраните копию этой папки (флешка, менеджер паролей). Без неё новые версии нельзя
будет подписать, и TS на компьютерах клубов перестанет обновляться сам.

Что вставить на GitHub: github.com/ansa-music/billS → Settings → Secrets and variables → Actions.

  1. Вкладка «Secrets» → «New repository secret»:
       Name:   TAURI_SIGNING_PRIVATE_KEY
       Secret: всё содержимое файла ${FILES.key}       (скопировать: ${npmCopy('key')})
  2. Ещё один «New repository secret»:
       Name:   TAURI_SIGNING_PRIVATE_KEY_PASSWORD
       Secret: всё содержимое файла ${FILES.password}      (скопировать: ${npmCopy('password')})
  3. Вкладка «Variables» → «New repository variable»:
       Name:   TAURI_UPDATER_PUBKEY
       Value:  всё содержимое файла ${FILES.pub}   (скопировать: ${npmCopy('pub')})

Без буфера обмена: откройте файл в блокноте, выделите всё (Ctrl+A) и скопируйте (Ctrl+C).
Код менять и коммитить не нужно: следующая сборка сама проверит, что ключи подходят друг к другу.
`);
