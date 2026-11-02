import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadAssetFor,
  downloadPath,
  ANDROID_STEPS,
  assetApp,
  assetFileText,
  assetPlatform,
  buildReleaseCatalog,
  classifyReleaseAssets,
  detectPlatform,
  DOWNLOAD_KINDS,
  DOWNLOAD_TEXT,
  downloadCards,
  formatReleaseDate,
  formatSize,
  latestReleasesByKind,
  MINIPC_COMMAND_STEPS,
  MINIPC_GUIDE_URL,
  MINIPC_IMAGE_STEPS,
  MINIPC_INSTALL_COMMAND,
  MINIPC_SETUP_ADDRESS,
  releaseKind,
  releasesApiUrl,
  releasesPageUrl,
  releaseVersion,
  releaseVersionText,
  TS_RELEASES_REPO,
  WINDOWS_HUB_GUIDE_URL,
} from '../src/index.ts';
import type { DownloadStep, GithubRelease } from '../src/index.ts';

const asset = (name: string, size = 1000) => ({
  name,
  size,
  browser_download_url: `https://github.com/${TS_RELEASES_REPO}/releases/download/v1.2.0/${name}`,
});

test('release URLs point at the list of releases of the repository', () => {
  assert.equal(TS_RELEASES_REPO, 'ansa-music/billS');
  assert.equal(releasesApiUrl(), 'https://api.github.com/repos/ansa-music/billS/releases?per_page=30');
  assert.equal(releasesPageUrl(), 'https://github.com/ansa-music/billS/releases');
  assert.equal(releasesApiUrl('a/b'), 'https://api.github.com/repos/a/b/releases?per_page=30');
  assert.equal(releasesPageUrl('a/b'), 'https://github.com/a/b/releases');
});

test('releaseKind and releaseVersion read the tag prefix', () => {
  assert.equal(releaseKind('mobile-v0.3.1'), 'mobile');
  assert.equal(releaseKind('Mobile-v0.3.1'), 'mobile');
  assert.equal(releaseKind('minipc-v0.1.0'), 'minipc');
  assert.equal(releaseVersion('minipc-v0.1.0'), '0.1.0');
  assert.equal(releaseKind('v1.2.0'), 'general');
  assert.equal(releaseKind('1.2.0'), 'general');
  assert.equal(releaseKind('nightly'), 'general');
  assert.equal(releaseKind('version-2'), 'general');
  assert.equal(releaseVersion('mobile-v0.3.1'), '0.3.1');
  assert.equal(releaseVersion('mobile-0.3.1'), '0.3.1');
  assert.equal(releaseVersion('v1.2.0'), '1.2.0');
  assert.equal(releaseVersion('1.2.0'), '1.2.0');
  assert.equal(releaseVersion('nightly'), 'nightly');
  assert.equal(releaseVersion('version-2'), 'version-2');
});

test('releaseKind: tags of the dropped PC app and of unknown apps are never offered', () => {
  for (const tag of ['desktop-v0.1.1', 'Desktop-v0.2.0', 'desktop-0.2.0', 'desktop-latest', 'hall-v1.0.0', 'kiosk-v2']) {
    assert.equal(releaseKind(tag), null, tag);
  }
});

const rel = (tag: string, published: string | null, names: string[], extra: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  published_at: published,
  html_url: `https://github.com/${TS_RELEASES_REPO}/releases/tag/${tag}`,
  assets: names.map((n) => asset(n)),
  ...extra,
});

test('latestReleasesByKind takes the newest published release of each kind', () => {
  const latest = latestReleasesByKind([
    rel('mobile-v0.4.0-beta', '2026-10-05T00:00:00Z', ['ts-owner.apk'], { prerelease: true }),
    rel('minipc-v0.3.0', null, ['TS-minipc-0.3.0.iso'], { draft: true }),
    rel('mobile-v0.3.0', '2026-10-03T00:00:00Z', ['ts-owner.apk']),
    rel('minipc-v0.2.0', '2026-09-01T00:00:00Z', ['TS-minipc-0.2.0.iso']),
    rel('minipc-v0.2.1', '2026-09-10T00:00:00Z', ['TS-minipc-0.2.1.iso']),
    rel('desktop-v0.2.1', '2026-10-10T00:00:00Z', ['TS_0.2.1_x64_ru-RU.msi']),
    rel('v1.0.0', '2026-08-01T00:00:00Z', []),
  ]);
  assert.equal(latest.mobile?.tag_name, 'mobile-v0.3.0');
  assert.equal(latest.minipc?.tag_name, 'minipc-v0.2.1');
  assert.equal(latest.general?.tag_name, 'v1.0.0');
  assert.deepEqual(Object.keys(latest).sort(), ['general', 'minipc', 'mobile']);
});

test('buildReleaseCatalog: a fresh release of one app does not hide the other', () => {
  const c = buildReleaseCatalog([
    rel('mobile-v0.3.0', '2026-10-03T00:00:00Z', ['ts-owner.apk', 'ts-owner.aab']),
    rel('minipc-v0.2.0', '2026-09-01T00:00:00Z', ['TS-minipc-0.2.0.iso', 'TS-minipc-0.2.0.iso.sha256']),
    rel('v1.0.0', '2026-08-01T00:00:00Z', ['old-owner.apk', 'old.iso']),
  ]);
  assert.ok(c);
  assert.deepEqual(c.releases.map((r) => [r.kind, r.version]), [['mobile', '0.3.0'], ['minipc', '0.2.0'], ['general', '1.0.0']]);
  assert.deepEqual(c.android.map((a) => a.name), ['ts-owner.apk']);
  assert.deepEqual(c.minipc.map((a) => a.name), ['TS-minipc-0.2.0.iso']);
  assert.equal(c.androidRelease?.version, '0.3.0');
  assert.equal(c.minipcRelease?.version, '0.2.0');
});

test('buildReleaseCatalog falls back to the general release, then to the other kind', () => {
  const onlyGeneral = buildReleaseCatalog([
    rel('minipc-v0.2.0', '2026-09-01T00:00:00Z', ['TS-minipc-0.2.0.iso']),
    rel('v1.0.0', '2026-08-01T00:00:00Z', ['ts-owner.apk']),
  ]);
  assert.equal(onlyGeneral?.androidRelease?.kind, 'general');
  assert.deepEqual(onlyGeneral?.android.map((a) => a.name), ['ts-owner.apk']);
  assert.equal(onlyGeneral?.minipcRelease?.kind, 'minipc');

  const apkInImage = buildReleaseCatalog([rel('minipc-v0.2.0', null, ['TS-minipc.iso', 'ts-owner.apk'])]);
  assert.equal(apkInImage?.androidRelease?.kind, 'minipc');
  assert.deepEqual(apkInImage?.minipc.map((a) => a.name), ['TS-minipc.iso']);

  const empty = buildReleaseCatalog([rel('mobile-v0.1.0', null, [])]);
  assert.equal(empty?.androidRelease, null);
  assert.equal(empty?.minipcRelease, null);
  assert.deepEqual([empty?.android, empty?.minipc], [[], []]);
});

test('buildReleaseCatalog is null without published releases', () => {
  assert.equal(buildReleaseCatalog([]), null);
  assert.equal(buildReleaseCatalog([rel('mobile-v1', null, ['a.apk'], { draft: true })]), null);
});

test('an old desktop-v release with PC installers is not offered anywhere', () => {
  const desktop = rel('desktop-v1.0.0', '2026-10-30T00:00:00Z', [
    'TS-1.0.0-windows-x64-setup.exe',
    'TS-1.0.0-windows-x64.msi',
    'TS-1.0.0-linux-amd64.deb',
    'ts-owner.apk',
    'latest.json',
  ]);
  // Alone: no catalog at all, so the pages say «скоро» and the short links fall back to the page.
  assert.equal(buildReleaseCatalog([desktop]), null);
  for (const kind of ['windows', 'linux', 'android', 'minipc']) assert.equal(downloadAssetFor(buildReleaseCatalog([desktop]), kind), null, kind);

  // Newest of all, next to the real releases: it neither shows up nor lends its files.
  const c = buildReleaseCatalog([desktop, rel('mobile-v0.1.0', '2026-10-20T00:00:00Z', ['TS-0.1.0.apk']), rel('minipc-v0.1.0', null, ['TS-minipc-0.1.0.iso'])]);
  assert.ok(c);
  assert.deepEqual(c.releases.map((r) => r.kind), ['mobile', 'minipc']);
  assert.deepEqual(c.android.map((a) => a.name), ['TS-0.1.0.apk']);
  assert.deepEqual(c.minipc.map((a) => a.name), ['TS-minipc-0.1.0.iso']);
  assert.equal(downloadAssetFor(c, 'windows'), null);

  // The same installers in a general release are not offered either: the pages hand out only .apk and .iso.
  const general = classifyReleaseAssets(rel('v1.0.0', null, ['TS-1.0.0-windows-x64-setup.exe', 'TS-1.0.0-windows-x64.msi']));
  assert.deepEqual([general.kind, general.android, general.minipc], ['general', [], []]);
});

test('assetPlatform sorts the files by extension and drops the rest', () => {
  assert.deepEqual(assetPlatform('ts-owner.apk'), { platform: 'android', format: 'apk' });
  assert.deepEqual(assetPlatform('TS-0.1.0.APK'), { platform: 'android', format: 'apk' });
  assert.deepEqual(assetPlatform('TS-minipc-0.1.0.iso'), { platform: 'minipc', format: 'iso' });
  for (const junk of [
    'ts-owner.aab',
    'ts-owner.apk.sha256',
    'TS-minipc-0.1.0.iso.sha256',
    'SHA256SUMS',
    'source.zip',
    // The dropped PC app's files.
    'TS_1.2.0_x64_ru-RU.msi',
    'TS_1.2.0_x64-setup.exe',
    'ts_1.2.0_amd64.deb',
    'ts_1.2.0_amd64.AppImage',
    'ts-1.2.0-1.x86_64.rpm',
    'TS_1.2.0_aarch64.dmg',
    'TS_aarch64.app.tar.gz',
    'TS_1.2.0_x64_ru-RU.msi.sig',
    'latest.json',
  ]) {
    assert.equal(assetPlatform(junk), null, junk);
  }
});

test('assetApp reads the app from the file name', () => {
  assert.equal(assetApp('ts-owner-1.2.0.apk'), 'owner');
  assert.equal(assetApp('TS-Mobile.apk'), 'owner');
  assert.equal(assetApp('TS-0.1.0.apk'), null);
});

test('classifyReleaseAssets groups files, keeps metadata and puts the owner app first', () => {
  const release: GithubRelease = {
    tag_name: 'v1.2.0',
    name: 'v1.2.0',
    published_at: '2026-10-01T09:30:00Z',
    html_url: 'https://github.com/ansa-music/billS/releases/tag/v1.2.0',
    assets: [
      asset('ts-hall-1.2.0.apk'),
      asset('ts-owner-1.2.0.apk', 30_000_000),
      asset('ts-owner-1.2.0.aab'),
      asset('ts-owner-1.2.0.apk.sha256'),
      asset('TS-minipc-1.2.0.iso'),
      asset('TS-minipc-1.2.0.iso.sha256'),
      asset('TS_1.2.0_x64-setup.exe'),
      asset('latest.json'),
    ],
  };
  const r = classifyReleaseAssets(release);
  assert.equal(r.version, '1.2.0');
  assert.equal(r.kind, 'general');
  assert.equal(r.title, null);
  assert.equal(r.publishedAt, Date.UTC(2026, 9, 1, 9, 30));
  assert.equal(r.pageUrl, release.html_url);
  assert.deepEqual(
    r.android.map((a) => a.name),
    ['ts-owner-1.2.0.apk', 'ts-hall-1.2.0.apk'],
  );
  assert.equal(r.android[0]?.app, 'owner');
  assert.equal(r.android[0]?.size, 30_000_000);
  assert.match(r.android[0]?.url ?? '', /ts-owner-1\.2\.0\.apk$/);
  assert.match(r.android[0]?.checksumUrl ?? '', /ts-owner-1\.2\.0\.apk\.sha256$/);
  assert.deepEqual(
    r.minipc.map((a) => a.name),
    ['TS-minipc-1.2.0.iso'],
  );
});

test('classifyReleaseAssets copes with an empty or sparse release', () => {
  const r = classifyReleaseAssets({ tag_name: 'nightly', name: 'Ночная сборка', html_url: 'https://x', assets: [] });
  assert.equal(r.version, 'nightly');
  assert.equal(r.title, 'Ночная сборка');
  assert.equal(r.publishedAt, null);
  assert.deepEqual([r.android, r.minipc], [[], []]);
  assert.equal(classifyReleaseAssets({ tag_name: 'v2', html_url: 'x', assets: [], published_at: 'garbage' }).publishedAt, null);
});

test('formatSize uses Russian units', () => {
  assert.equal(formatSize(734), '734 Б');
  assert.equal(formatSize(1536), '1,5 КБ');
  assert.equal(formatSize(50 * 1024 * 1024), '50 МБ');
  assert.equal(formatSize(1.2 * 1024 * 1024 * 1024), '1,2 ГБ');
  assert.equal(formatSize(2 * 1024 * 1024), '2 МБ');
  assert.equal(formatSize(-1), '—');
});

test('detectPlatform reads the user agent', () => {
  const android = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';
  assert.equal(detectPlatform(android), 'android');
  assert.equal(detectPlatform(iphone), 'ios');
  assert.equal(detectPlatform(mac), 'mac');
  assert.equal(detectPlatform(mac, 5), 'ios'); // iPadOS Safari
  assert.equal(detectPlatform(win), 'windows');
  assert.equal(detectPlatform(linux), 'linux');
  assert.equal(detectPlatform(''), 'other');
});

const GB = 1024 * 1024 * 1024;

/** The full set the release workflows publish (mobile, mini-PC) next to an old release of the PC app. */
const fullSet = (): GithubRelease[] => [
  rel('minipc-v0.1.0', '2026-10-21T08:00:00Z', ['TS-minipc-0.1.0.iso', 'TS-minipc-0.1.0.iso.sha256']),
  rel('desktop-v0.1.1', '2026-10-21T06:00:00Z', [
    'TS_0.1.1_x64_ru-RU.msi',
    'TS_0.1.1_x64_ru-RU.msi.sig',
    'ts_0.1.1_amd64.deb',
    'ts_0.1.1_amd64.deb.sig',
    'latest.json',
  ]),
  rel('mobile-v0.1.0', '2026-10-20T12:00:00Z', ['TS-0.1.0.apk']),
];

test('buildReleaseCatalog exposes the mini-PC image with its checksum', () => {
  const c = buildReleaseCatalog(fullSet());
  assert.ok(c);
  assert.deepEqual(c.releases.map((r) => [r.kind, r.version]), [['minipc', '0.1.0'], ['mobile', '0.1.0']]);
  assert.deepEqual(c.minipc.map((a) => [a.name, a.platform, a.format]), [['TS-minipc-0.1.0.iso', 'minipc', 'iso']]);
  assert.match(c.minipc[0]?.checksumUrl ?? '', /TS-minipc-0\.1\.0\.iso\.sha256$/);
  assert.equal(c.minipcRelease?.kind, 'minipc');
  assert.equal(c.minipcRelease?.version, '0.1.0');
  assert.deepEqual(c.android.map((a) => a.name), ['TS-0.1.0.apk']);
  assert.equal(c.android[0]?.checksumUrl, undefined);
  assert.equal(c.androidRelease?.version, '0.1.0');

  // A mini-PC release alone does not pretend to carry the phone app, and an image in a general release is found.
  const onlyImage = buildReleaseCatalog([rel('minipc-v0.1.0', null, ['TS-minipc-0.1.0.iso'])]);
  assert.equal(onlyImage?.androidRelease, null);
  assert.equal(buildReleaseCatalog([rel('v1.0.0', null, ['TS-minipc-1.0.0.iso'])])?.minipcRelease?.kind, 'general');
  assert.equal(buildReleaseCatalog([rel('mobile-v0.1.1', null, ['TS.apk'])])?.minipcRelease, null);
});

test('downloadCards puts the visitor phone first and marks it; a computer has no card', () => {
  assert.deepEqual(downloadCards('android'), { order: ['android', 'minipc', 'ios'], current: 'android' });
  assert.deepEqual(downloadCards('ios'), { order: ['ios', 'android', 'minipc'], current: 'ios' });
  for (const platform of ['windows', 'linux', 'mac', 'other'] as const) {
    assert.deepEqual(downloadCards(platform), { order: ['android', 'minipc', 'ios'], current: null }, platform);
  }
});

test('download labels: file, version and date in plain words', () => {
  const c = buildReleaseCatalog(fullSet());
  assert.equal(assetFileText({ format: 'apk', size: 30 * 1024 * 1024 }), 'файл .apk · 30 МБ');
  assert.equal(assetFileText({ format: 'iso', size: 1.5 * GB }), 'файл .iso · 1,5 ГБ');
  assert.equal(formatReleaseDate(Date.UTC(2026, 9, 21, 6), 'UTC'), '21 октября 2026');
  assert.equal(formatReleaseDate(Date.UTC(2026, 0, 1, 20), 'Asia/Almaty'), '2 января 2026');
  assert.equal(releaseVersionText(c!.minipcRelease!, 'UTC'), 'Версия 0.1.0 от 21 октября 2026');
  assert.equal(releaseVersionText({ version: '0.2.0', publishedAt: null }), 'Версия 0.2.0');
});

const stepText = (steps: readonly DownloadStep[]) =>
  steps
    .map((step) =>
      step.map((p) => (typeof p === 'string' ? p : 'strong' in p ? p.strong : 'command' in p ? p.command : p.text)).join(''),
    )
    .join('\n');

test('download steps cover what the owner has to press on each device', () => {
  assert.equal(
    MINIPC_INSTALL_COMMAND,
    'curl -fsSL https://raw.githubusercontent.com/ansa-music/billS/main/deploy/linux/install.sh | sudo bash',
  );
  assert.equal(MINIPC_SETUP_ADDRESS, 'http://<адрес мини-ПК>:4310/setup');
  assert.equal(MINIPC_GUIDE_URL, 'https://github.com/ansa-music/billS/blob/main/docs/MINIPC_RU.md');
  assert.equal(WINDOWS_HUB_GUIDE_URL, 'https://github.com/ansa-music/billS/blob/main/deploy/windows/README.md');

  assert.match(stepText(ANDROID_STEPS), /неизвестных источников/);
  const image = stepText(MINIPC_IMAGE_STEPS);
  assert.match(image, /balenaEtcher/);
  assert.match(image, /Rufus/);
  assert.match(image, /Компания → Филиалы → новый филиал/);
  assert.match(DOWNLOAD_TEXT.minipc.warning, /стирает диск/);
  // Without a mini-PC the HUB goes on the Windows computer as a service, not through a PC program.
  assert.match(DOWNLOAD_TEXT.minipc.windows, /службой Windows/);
  assert.doesNotMatch(DOWNLOAD_TEXT.minipc.windows, /[Пп]рограмм/);
  const command = stepText(MINIPC_COMMAND_STEPS);
  assert.ok(command.includes(MINIPC_INSTALL_COMMAND));
  assert.ok(command.includes(MINIPC_SETUP_ADDRESS));
  // Every step has some text and every step list stays short.
  for (const steps of [ANDROID_STEPS, MINIPC_IMAGE_STEPS, MINIPC_COMMAND_STEPS]) {
    assert.ok(steps.length >= 3 && steps.length <= 4);
    for (const step of steps) assert.ok(step.length > 0);
  }
  // Nothing technical in what a visitor reads when there is no release yet.
  for (const text of [DOWNLOAD_TEXT.android.soon, DOWNLOAD_TEXT.minipc.soon, DOWNLOAD_TEXT.error]) {
    assert.doesNotMatch(text, /GitHub|релиз|API|APK/i);
  }
});

test('downloadAssetFor: one file per short link; the old PC links give nothing', () => {
  const asset = (name: string) => ({ name, size: 1, browser_download_url: `https://x/${name}` });
  const catalog = buildReleaseCatalog([
    { tag_name: 'mobile-v0.2.0', html_url: 'https://x/m2', published_at: '2026-10-23T10:00:00Z', assets: [asset('TS-0.2.0.apk'), asset('TS-0.2.0.apk.sha256')] },
    { tag_name: 'mobile-v0.1.0', html_url: 'https://x/m', published_at: '2026-10-22T10:00:00Z', assets: [asset('TS-0.1.0.apk')] },
    { tag_name: 'minipc-v0.1.0', html_url: 'https://x/i', published_at: '2026-10-22T10:00:00Z', assets: [asset('TS-minipc-0.1.0.iso')] },
  ]);
  assert.equal(downloadAssetFor(catalog, 'android')?.name, 'TS-0.2.0.apk');
  assert.equal(downloadAssetFor(catalog, 'minipc')?.name, 'TS-minipc-0.1.0.iso');
  assert.equal(downloadAssetFor(catalog, 'windows'), null);
  assert.equal(downloadAssetFor(catalog, 'linux'), null);
  assert.equal(downloadAssetFor(catalog, 'mac'), null);
  assert.equal(downloadAssetFor(null, 'android'), null);
  assert.equal(downloadAssetFor(buildReleaseCatalog([]), 'android'), null);
  assert.deepEqual(DOWNLOAD_KINDS, ['android', 'minipc']);
  assert.equal(downloadPath('android'), '/download/android');
});
