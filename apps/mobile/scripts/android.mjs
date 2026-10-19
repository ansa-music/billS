// Сборка Android: собрать кабинет в www/, cap sync, затем gradle-задача.
//   node scripts/android.mjs assembleDebug   → android/app/build/outputs/apk/debug/app-debug.apk
//   node scripts/android.mjs bundleRelease   → android/app/build/outputs/bundle/release/app-release.aab
// JDK 21 и Android SDK ищутся сами (JAVA_HOME / ANDROID_HOME или стандартные пути Windows).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = join(APP, 'android');
const task = process.argv[2] ?? 'assembleDebug';
const win = process.platform === 'win32';

function findJdk() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  for (const root of ['C:/Program Files/Microsoft', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Java']) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root).sort().reverse()) if (/jdk-?2[1-9]/.test(d)) candidates.push(join(root, d));
  }
  return candidates.find((p) => existsSync(join(p, 'bin', win ? 'java.exe' : 'java')) && /2[1-9]/.test(p)) ?? process.env.JAVA_HOME;
}

function findSdk() {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  if (process.env.HOME) candidates.push(join(process.env.HOME, 'Android', 'Sdk'), join(process.env.HOME, 'Library', 'Android', 'sdk'));
  return candidates.find((p) => p && existsSync(join(p, 'platforms')));
}

const jdk = findJdk();
const sdk = findSdk();
if (!sdk) {
  console.error('Не найден Android SDK: задайте ANDROID_HOME (см. apps/mobile/README.md)');
  process.exit(1);
}
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ...(jdk ? { JAVA_HOME: jdk } : {}) };
writeFileSync(join(ANDROID, 'local.properties'), `sdk.dir=${sdk.replaceAll('\\', '/')}\n`);
console.log(`JDK: ${jdk ?? '(из PATH)'}\nSDK: ${sdk}\nЗадача: ${task}`);

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, env, stdio: 'inherit', shell: win });
run('npx', ['vite', 'build'], APP);
run('npx', ['cap', 'sync', 'android'], APP);
run(join(ANDROID, win ? 'gradlew.bat' : 'gradlew'), [task, '--no-daemon'], ANDROID);
