// Ключ подписи APK приложения TS для Android — создаётся один раз на всё время жизни приложения.
//
//   npm run android:keystore              → ~/.ts-keys/android/
//   npm run android:keystore -- <папка>   → в свою папку (только вне репозитория)
//
// Создаёт ts-release.jks (keytool из JDK: JAVA_HOME, PATH или стандартные папки Windows) и рядом
// github-secrets.txt — значения для четырёх секретов GitHub. В терминал пароли и base64 не
// печатаются: вывод можно спокойно показывать другим. Секреты в GitHub пользователь вставляет сам.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALIAS = 'ts';
// ~27 years: Android never lets an app change its signing key, so the key must outlive the app.
const VALIDITY_DAYS = 10000;
const SECRETS = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
const win = process.platform === 'win32';

function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

/** keytool of JDK 17+: JAVA_HOME, then PATH, then the usual Windows install folders. */
function findKeytool() {
  const exe = win ? 'keytool.exe' : 'keytool';
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', exe));
  candidates.push('keytool');
  if (win) {
    const roots = ['C:/Program Files/Microsoft', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Java'];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const d of readdirSync(root).sort().reverse()) if (/jdk/i.test(d)) candidates.push(join(root, d, 'bin', exe));
    }
    candidates.push('C:/Program Files/Android/Android Studio/jbr/bin/keytool.exe');
  }
  return candidates.find((c) => {
    if (c !== 'keytool' && !existsSync(c)) return false;
    return spawnSync(c, ['-help'], { stdio: 'ignore' }).error === undefined;
  });
}

const target = resolve(process.argv[2] ?? join(homedir(), '.ts-keys', 'android'));
const inRepo = relative(REPO, target);
if (!inRepo || (!inRepo.startsWith('..') && !isAbsolute(inRepo))) {
  fail(`папка ${target} внутри репозитория. Ключ подписи нельзя хранить в git — укажите папку вне репозитория.`);
}
const keystore = join(target, 'ts-release.jks');
const valuesFile = join(target, 'github-secrets.txt');
for (const f of [keystore, valuesFile]) {
  if (existsSync(f)) {
    fail(`${f} уже есть — не перезаписываю. Ключ подписи создаётся один раз: новый ключ сломает обновления приложения. Если нужен ещё один — укажите другую папку.`);
  }
}

const keytool = findKeytool();
if (!keytool) fail('не найден keytool. Установите JDK 21 (например: winget install --id Microsoft.OpenJDK.21 -e) или задайте JAVA_HOME.');

mkdirSync(target, { recursive: true, mode: 0o700 });

// PKCS12 (keytool's default) has one password for the store and the key, so both secrets get the
// same value. URL-safe characters only: nothing to escape in GitHub, Gradle or a shell.
const password = randomBytes(24).toString('base64url');
// Passed through the environment (-storepass:env), so the password is not visible in the process list.
const env = { ...process.env, TS_KEYSTORE_PASSWORD: password };
const gen = spawnSync(
  keytool,
  [
    '-genkeypair',
    '-keystore', keystore,
    '-storetype', 'PKCS12',
    '-alias', ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', String(VALIDITY_DAYS),
    '-dname', 'CN=TS, O=TS, C=KZ',
    '-storepass:env', 'TS_KEYSTORE_PASSWORD',
    '-keypass:env', 'TS_KEYSTORE_PASSWORD',
  ],
  { env, encoding: 'utf8' },
);
if (gen.status !== 0 || !existsSync(keystore)) fail(`keytool не создал ключ:\n${gen.stderr || gen.stdout || gen.error}`);

// The certificate fingerprint is public (it is in every signed APK): handy to compare with the CI log.
const list = spawnSync(keytool, ['-list', '-v', '-keystore', keystore, '-alias', ALIAS, '-storepass:env', 'TS_KEYSTORE_PASSWORD'], {
  env,
  encoding: 'utf8',
});
const sha256 = /SHA256:\s*([0-9A-F:]+)/i.exec(list.stdout ?? '')?.[1] ?? null;

const base64 = readFileSync(keystore).toString('base64');
const values = { ANDROID_KEYSTORE_BASE64: base64, ANDROID_KEYSTORE_PASSWORD: password, ANDROID_KEY_ALIAS: ALIAS, ANDROID_KEY_PASSWORD: password };
const text = [
  'Секреты GitHub для подписи приложения TS для Android.',
  'Где создать: репозиторий на GitHub → Settings → Secrets and variables → Actions → New repository secret.',
  'Name — имя секрета ниже, Secret — строка под ним целиком (без пробелов в начале и в конце).',
  '',
  ...SECRETS.flatMap((name) => [name, values[name], '']),
  'Этот файл и ts-release.jks храните вместе в надёжном месте (менеджер паролей + копия на флешке).',
  'Не кладите их в git и не пересылайте в мессенджерах: с ними кто угодно выпустит «обновление» TS.',
  'Потеряете ключ — новые версии не встанут поверх старой, всем придётся удалить приложение и поставить заново.',
  sha256 ? `Отпечаток сертификата (SHA-256, не секрет): ${sha256}` : '',
  '',
].join('\n');
writeFileSync(valuesFile, text, { mode: 0o600 });
try {
  chmodSync(keystore, 0o600);
} catch {
  // Windows: permissions come from the user folder
}

console.log(`Готово: ключ подписи приложения TS для Android создан.

  Ключ:      ${keystore}
  Значения:  ${valuesFile}

Что сделать в GitHub (репозиторий → Settings → Secrets and variables → Actions → New repository secret):
создайте четыре секрета, имена и значения — в файле «Значения» выше:
${SECRETS.map((n, i) => `  ${i + 1}. ${n}`).join('\n')}

После этого каждая новая версия (метка mobile-v…, см. docs/MOBILE_RELEASE_RU.md) будет подписана этим ключом.
${sha256 ? `\nОтпечаток сертификата (не секрет, для сверки с журналом сборки): ${sha256}\n` : ''}
ВАЖНО: сохраните оба файла в надёжном месте (менеджер паролей + копия на флешке), не кладите их в git
и не пересылайте в мессенджерах. Если ключ потеряется, новые версии не встанут поверх старой —
всем придётся удалить приложение и установить заново.`);
