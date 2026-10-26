#!/usr/bin/env node
// Release steps of TS for PC in GitHub Actions (.github/workflows/desktop.yml).
//
//   node apps/desktop/scripts/ci.mjs prepare
//     Writes src-tauri/tauri.ci.conf.json for `tauri build --config`: the version from the
//     desktop-v<version> tag (so a tag alone is enough for a release), the updater public key from
//     the TAURI_UPDATER_PUBKEY repository variable, updater files only when there is a signing key.
//     With a key, checks that it matches that public key and stops the build if it does not.
//     Adds the built-in HUB (apps/desktop/hub-bundle from `node scripts/bundle-hub.mjs --node …`) to
//     the installer resources and stops the build when it is missing: an installer without it could
//     not start the HUB on the club PC.
//   node apps/desktop/scripts/ci.mjs signatures <dir>…
//     Every installer (.msi, .deb) in the folders gets a .sig that the public key verifies.
//   node apps/desktop/scripts/ci.mjs release <in-dir> <out-dir>
//     Files of the GitHub release: installers under readable names, .sha256 next to each and
//     latest.json for the updater (when the installers are signed).
//
// Environment: GITHUB_REF_TYPE, GITHUB_REF_NAME, GITHUB_REPOSITORY, GITHUB_OUTPUT,
// TAURI_UPDATER_PUBKEY, TAURI_SIGNING_PRIVATE_KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
// Empty values count as missing (GitHub gives "" for a secret that does not exist).
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkKeyPair,
  configPublicKey,
  DESKTOP_DIR,
  parsePublicKey,
  signFile,
  TAURI_CONF,
  verifySignature,
} from './updater-key.mjs';

export const CI_CONF = join(DESKTOP_DIR, 'src-tauri', 'tauri.ci.conf.json');
/** Built-in HUB made by scripts/bundle-hub.mjs; installed as <resources>/hub-bundle (local_hub.rs). */
export const HUB_BUNDLE = join(DESKTOP_DIR, 'hub-bundle');
/** `bundle.resources` entry: the source is relative to src-tauri. */
export const HUB_RESOURCES = { '../hub-bundle/': 'hub-bundle/' };
/** Prerelease that always holds the newest latest.json: the endpoint in tauri.conf.json points here. */
export const UPDATER_CHANNEL_TAG = 'desktop-latest';
const TAG_PREFIX = 'desktop-v';

const MESSAGES = {
  mismatch:
    'Ключ подписи обновлений не подходит к открытому ключу. Секрет TAURI_SIGNING_PRIVATE_KEY и переменная ' +
    'TAURI_UPDATER_PUBKEY должны быть из одной пары: создайте пару заново (npm run desktop:signing-key) и ' +
    'вставьте оба значения ещё раз (apps/desktop/README.md, раздел «Ключ автообновления»).',
  password:
    'Пароль ключа подписи обновлений не подходит: проверьте секрет TAURI_SIGNING_PRIVATE_KEY_PASSWORD ' +
    '(содержимое файла password.txt рядом с ключом).',
  broken:
    'Ключ подписи обновлений повреждён: вставьте в секрет TAURI_SIGNING_PRIVATE_KEY всё содержимое файла ' +
    'updater.key целиком, без пробелов и переносов в начале и в конце.',
};

const env = (name) => (process.env[name] ?? '').trim();

function annotate(level, message) {
  console.log(`::${level}::${message.replace(/\r?\n/g, ' ')}`);
}

function fail(message) {
  annotate('error', message);
  process.exit(1);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/**
 * Version from the tag of a release build: "desktop-v0.1.2" → "0.1.2"; null for other builds.
 * MSI accepts only numbers: major and minor up to 255, patch up to 65535.
 */
export function tagVersion(refType, refName) {
  if (refType !== 'tag' || !refName?.startsWith(TAG_PREFIX)) return null;
  const version = refName.slice(TAG_PREFIX.length);
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || Number(m[1]) > 255 || Number(m[2]) > 255 || Number(m[3]) > 65535) {
    throw new Error(
      `Метка ${refName}: после «${TAG_PREFIX}» нужна версия из трёх чисел, например ${TAG_PREFIX}0.1.2 ` +
        '(первые два числа не больше 255).',
    );
  }
  return version;
}

/** Config merged over tauri.conf.json by `tauri build --config` (JSON merge patch). */
export function ciConfig({ version, publicKey, updaterArtifacts, hubBundle = false }) {
  const config = { bundle: { createUpdaterArtifacts: updaterArtifacts } };
  // JSON merge patch: adds to the deploy/ resources of tauri.conf.json.
  if (hubBundle) config.bundle.resources = HUB_RESOURCES;
  if (version) config.version = version;
  if (publicKey) config.plugins = { updater: { pubkey: publicKey } };
  return config;
}

/** What is missing in the built-in HUB folder for this OS ([] — complete). */
export function hubBundleProblems(dir, platform = process.platform) {
  const node = platform === 'win32' ? 'node.exe' : 'node';
  return [node, join('src', 'main.mjs'), join('src', 'migrations'), join('web', 'index.html'), 'package.json'].filter(
    (f) => !existsSync(join(dir, f)),
  );
}

function prepare() {
  const missing = hubBundleProblems(HUB_BUNDLE);
  if (missing.length) {
    fail(
      `Нет встроенного HUB для установщика (${HUB_BUNDLE}: не хватает ${missing.join(', ')}). ` +
        'Сначала выполните: node scripts/bundle-hub.mjs --node host',
    );
  }
  let version;
  try {
    version = tagVersion(env('GITHUB_REF_TYPE'), env('GITHUB_REF_NAME'));
  } catch (e) {
    fail(e.message);
  }
  const variable = env('TAURI_UPDATER_PUBKEY');
  const publicKey = variable || configPublicKey();
  if (variable) {
    try {
      parsePublicKey(variable);
    } catch {
      fail(
        'Переменная TAURI_UPDATER_PUBKEY не похожа на открытый ключ: вставьте в неё всё содержимое файла ' +
          'updater.key.pub целиком.',
      );
    }
  }
  const privateKey = env('TAURI_SIGNING_PRIVATE_KEY');
  const signing = Boolean(privateKey);

  if (signing) {
    const check = checkKeyPair({ publicKey, privateKey, password: env('TAURI_SIGNING_PRIVATE_KEY_PASSWORD') });
    if (!check.ok) {
      console.log(`Проверка ключа: ${check.message}`);
      if (check.reason === 'mismatch' && !variable) {
        fail(
          `${MESSAGES.mismatch} Сейчас переменной TAURI_UPDATER_PUBKEY нет, и сборка взяла старый ключ из ` +
            'tauri.conf.json.',
        );
      }
      fail(MESSAGES[check.reason] ?? MESSAGES.broken);
    }
    console.log('Ключ подписи обновлений подходит к открытому ключу — установщики будут подписаны для автообновления.');
  } else {
    const message =
      'Нет секрета TAURI_SIGNING_PRIVATE_KEY: установщики соберутся, но без файлов автообновления. ' +
      'Программы этой версии не смогут обновиться сами — понадобится установить новую версию вручную. ' +
      'Как добавить ключ: apps/desktop/README.md, раздел «Ключ автообновления».';
    annotate(version ? 'warning' : 'notice', message);
  }

  const config = ciConfig({ version, publicKey: variable || null, updaterArtifacts: signing, hubBundle: true });
  writeFileSync(CI_CONF, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`${CI_CONF}: ${JSON.stringify(config)}`);
  setOutput('signing', String(signing));
  setOutput('version', version ?? baseVersion());
}

function baseVersion() {
  return JSON.parse(readFileSync(TAURI_CONF, 'utf8')).version;
}

const INSTALLER = /\.(exe|msi|deb)$/i;

/** Installers in a folder and its subfolders (merged artifacts keep bundle/nsis, bundle/msi…). */
function installersIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? installersIn(join(dir, e.name)) : INSTALLER.test(e.name) ? [join(dir, e.name)] : [],
  );
}

function signatures(dirs) {
  const publicKey = env('TAURI_UPDATER_PUBKEY') || configPublicKey();
  const privateKey = env('TAURI_SIGNING_PRIVATE_KEY');
  const password = env('TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  const version = JSON.parse(readFileSync(CI_CONF, 'utf8')).version ?? baseVersion();
  const files = dirs.flatMap(installersIn);
  if (files.length === 0) fail(`Нет установщиков в ${dirs.join(', ')}`);
  for (const file of files) {
    if (!existsSync(`${file}.sig`)) {
      console.log(`${basename(file)}: подписываю для автообновления`);
      try {
        signFile(file, { privateKey, password, appVersion: version });
      } catch (e) {
        fail(`${basename(file)}: не удалось подписать (${e.message})`);
      }
    }
    if (!verifySignature(publicKey, readFileSync(file), readFileSync(`${file}.sig`, 'utf8'))) {
      fail(`${basename(file)}: ${MESSAGES.mismatch}`);
    }
    console.log(`${basename(file)}: подпись проверена`);
  }
}

/** Readable file name of an installer in the release and the updater platforms it serves. */
export function releaseAsset(file, version) {
  // The setup .exe (NSIS, per-user: no admin rights, no UAC) is the main Windows installer and
  // the default the updater takes; the .msi stays for IT departments that deploy MSI packages.
  if (/\.exe$/i.test(file)) {
    return { name: `TS-${version}-windows-x64-setup.exe`, platforms: ['windows-x86_64', 'windows-x86_64-nsis'] };
  }
  if (/\.msi$/i.test(file)) {
    return { name: `TS-${version}-windows-x64.msi`, platforms: ['windows-x86_64-msi'] };
  }
  if (/\.deb$/i.test(file)) {
    return { name: `TS-${version}-linux-amd64.deb`, platforms: ['linux-x86_64', 'linux-x86_64-deb'] };
  }
  return null;
}

/** latest.json in the format of tauri-plugin-updater (static JSON). */
export function latestJson({ version, notes, pubDate, entries }) {
  const platforms = {};
  for (const { url, signature, platforms: keys } of entries) {
    for (const key of keys) platforms[key] = { signature, url };
  }
  return { version, notes, pub_date: pubDate, platforms };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function release(inDir, outDir) {
  const tag = env('GITHUB_REF_NAME');
  const repo = env('GITHUB_REPOSITORY') || 'ansa-music/billS';
  let version;
  try {
    version = tagVersion('tag', tag);
  } catch (e) {
    fail(e.message);
  }
  if (!version) fail(`Выпуск делается только по метке ${TAG_PREFIX}<версия>, а сборка запущена для «${tag}».`);
  mkdirSync(outDir, { recursive: true });
  const files = installersIn(inDir);
  const kinds = new Set(files.map((f) => f.slice(-3).toLowerCase()));
  if (!kinds.has('exe') || !kinds.has('deb')) fail(`Нужны установщики для Windows (.exe) и Linux (.deb), найдено: ${files.map((f) => basename(f)).join(', ') || 'ничего'}`);

  const entries = [];
  for (const file of files) {
    const asset = releaseAsset(file, version);
    const target = join(outDir, asset.name);
    copyFileSync(file, target);
    writeFileSync(`${target}.sha256`, `${sha256(target)}  ${asset.name}\n`);
    console.log(`${basename(file)} → ${asset.name}`);
    if (existsSync(`${file}.sig`)) {
      const url = `https://github.com/${repo}/releases/download/${tag}/${asset.name}`;
      entries.push({ url, signature: readFileSync(`${file}.sig`, 'utf8').trim(), platforms: asset.platforms });
    }
  }
  if (entries.length === files.length) {
    const json = latestJson({ version, notes: `TS для ПК ${version}`, pubDate: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), entries });
    writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(json, null, 2)}\n`);
    console.log(`latest.json: ${Object.keys(json.platforms).join(', ')}`);
  } else {
    annotate('warning', 'Установщики без подписи обновлений: latest.json не создан, автообновление на эту версию не придёт.');
  }
  setOutput('version', version);
  setOutput('channel', UPDATER_CHANNEL_TAG);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') prepare();
  else if (command === 'signatures' && args.length > 0) signatures(args);
  else if (command === 'release' && args.length === 2) release(args[0], args[1]);
  else fail('Использование: ci.mjs prepare | signatures <папка>… | release <откуда> <куда>');
}
