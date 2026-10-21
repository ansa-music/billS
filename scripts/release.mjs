// Publishes a new version of one TS app: puts the tag the release workflow listens to on the
// current main and pushes it. The workflow builds the files and creates the public GitHub Release
// that the «Скачать приложение» page offers.
//
//   node scripts/release.mjs desktop          ПК кассы (.msi, .deb)      → тег desktop-v<версия>
//   node scripts/release.mjs mobile           телефон владельца (APK)    → тег mobile-v<версия>
//   node scripts/release.mjs minipc           образ для мини-ПК (.iso)   → тег minipc-v<версия>
//   node scripts/release.mjs desktop 0.2.0    своя версия вместо «следующей»
//   флаги: --yes (не спрашивать), --dry-run (только показать, что будет сделано)
//
// The version comes from the tag: the workflows patch it into the app at build time, so nothing
// has to be edited or committed before a release.
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const KINDS = {
  desktop: { label: 'TS для ПК кассы (.msi и .deb)', workflow: 'desktop.yml' },
  mobile: { label: 'TS для Android (APK)', workflow: 'mobile.yml' },
  minipc: { label: 'TS для мини-ПК (образ для флешки)', workflow: 'minipc.yml' },
};
const REPO = 'ansa-music/billS';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [kind, wanted] = args.filter((a) => !a.startsWith('--'));

function fail(message) {
  console.error(`Ошибка: ${message}`);
  process.exit(1);
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

if (!KINDS[kind]) {
  fail(`укажите, что выпускать: ${Object.keys(KINDS).join(', ')}. Например: node scripts/release.mjs desktop`);
}
if (wanted !== undefined && !parse(wanted)) fail(`версия должна быть вида 1.2.3, а не «${wanted}»`);

try {
  git('fetch', '--quiet', 'origin', 'main', '--tags');
} catch (e) {
  fail(`не удалось связаться с GitHub: ${e.stderr || e.message}`);
}
if (git('status', '--porcelain')) fail('есть незакоммиченные изменения — сначала закоммитьте или отмените их');
const head = git('rev-parse', 'HEAD');
const main = git('rev-parse', 'origin/main');
if (head !== main) {
  fail('выпускать можно только то, что уже в main на GitHub: перейдите на main и сделайте git pull');
}

// Tags of this kind, newest version first.
const prefix = `${kind}-v`;
const versions = git('tag', '--list', `${prefix}*`)
  .split('\n')
  .map((t) => t.slice(prefix.length))
  .map(parse)
  .filter(Boolean)
  .sort((a, b) => compare(b, a));
const last = versions[0] ?? null;

let next;
if (wanted) {
  next = parse(wanted);
  if (last && compare(next, last) <= 0) fail(`версия ${wanted} не новее уже выпущенной ${last.join('.')}`);
} else {
  next = last ? [last[0], last[1], last[2] + 1] : [0, 1, 0];
}
const version = next.join('.');
const tag = `${prefix}${version}`;

console.log(`Что выпускаем: ${KINDS[kind].label}`);
console.log(`Версия:        ${version}${last ? ` (была ${last.join('.')})` : ' (первая)'}`);
console.log(`Коммит:        ${git('log', '-1', '--format=%h %s')}`);
console.log(`Тег:           ${tag}`);
console.log('');
console.log('После этого GitHub соберёт файлы (10–40 минут) и опубликует их для всех на странице скачивания.');

if (flags.has('--dry-run')) {
  console.log('--dry-run: ничего не сделано.');
  process.exit(0);
}
if (!flags.has('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Опубликовать? Введите «да»: ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'да' && answer !== 'yes') {
    console.log('Отменено, ничего не сделано.');
    process.exit(0);
  }
}

git('tag', '-a', tag, '-m', `${KINDS[kind].label} ${version}`);
try {
  git('push', 'origin', tag);
} catch (e) {
  git('tag', '-d', tag);
  fail(`не удалось отправить тег на GitHub: ${e.stderr || e.message}`);
}
console.log('');
console.log(`Готово. Сборка: https://github.com/${REPO}/actions/workflows/${KINDS[kind].workflow}`);
console.log(`Выпуск появится здесь: https://github.com/${REPO}/releases/tag/${tag}`);
