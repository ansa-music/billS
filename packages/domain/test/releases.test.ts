import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetApp,
  assetPlatform,
  buildReleaseCatalog,
  classifyReleaseAssets,
  detectPlatform,
  formatSize,
  latestReleasesByKind,
  releaseKind,
  releasesApiUrl,
  releasesPageUrl,
  releaseVersion,
  TS_RELEASES_REPO,
} from '../src/index.ts';
import type { GithubRelease } from '../src/index.ts';

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
  assert.equal(releaseKind('desktop-v0.2.0'), 'desktop');
  assert.equal(releaseKind('Desktop-v0.2.0'), 'desktop');
  assert.equal(releaseKind('mobile-v0.3.1'), 'mobile');
  assert.equal(releaseKind('v1.2.0'), 'general');
  assert.equal(releaseKind('1.2.0'), 'general');
  assert.equal(releaseKind('nightly'), 'general');
  assert.equal(releaseVersion('desktop-v0.2.0'), '0.2.0');
  assert.equal(releaseVersion('mobile-v0.3.1'), '0.3.1');
  assert.equal(releaseVersion('mobile-0.3.1'), '0.3.1');
  assert.equal(releaseVersion('v1.2.0'), '1.2.0');
  assert.equal(releaseVersion('1.2.0'), '1.2.0');
  assert.equal(releaseVersion('nightly'), 'nightly');
  assert.equal(releaseVersion('version-2'), 'version-2');
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
    rel('desktop-v0.3.0', null, ['TS_0.3.0_x64_ru-RU.msi'], { draft: true }),
    rel('mobile-v0.3.0', '2026-10-03T00:00:00Z', ['ts-owner.apk']),
    rel('desktop-v0.2.0', '2026-09-01T00:00:00Z', ['TS_0.2.0_x64_ru-RU.msi']),
    rel('desktop-v0.2.1', '2026-09-10T00:00:00Z', ['TS_0.2.1_x64_ru-RU.msi']),
    rel('v1.0.0', '2026-08-01T00:00:00Z', []),
  ]);
  assert.equal(latest.mobile?.tag_name, 'mobile-v0.3.0');
  assert.equal(latest.desktop?.tag_name, 'desktop-v0.2.1');
  assert.equal(latest.general?.tag_name, 'v1.0.0');
});

test('buildReleaseCatalog: a fresh release of one app does not hide the other', () => {
  const c = buildReleaseCatalog([
    rel('mobile-v0.3.0', '2026-10-03T00:00:00Z', ['ts-owner.apk', 'ts-owner.aab']),
    rel('desktop-v0.2.0', '2026-09-01T00:00:00Z', ['TS_0.2.0_x64_ru-RU.msi', 'TS_0.2.0_x64_ru-RU.msi.sig', 'TS_0.2.0_amd64.deb', 'latest.json']),
    rel('v1.0.0', '2026-08-01T00:00:00Z', ['old-owner.apk', 'old.msi']),
  ]);
  assert.ok(c);
  assert.deepEqual(c.releases.map((r) => [r.kind, r.version]), [['mobile', '0.3.0'], ['desktop', '0.2.0'], ['general', '1.0.0']]);
  assert.deepEqual(c.android.map((a) => a.name), ['ts-owner.apk']);
  assert.deepEqual(c.windows.map((a) => a.name), ['TS_0.2.0_x64_ru-RU.msi']);
  assert.deepEqual(c.linux.map((a) => a.name), ['TS_0.2.0_amd64.deb']);
  assert.equal(c.androidRelease?.version, '0.3.0');
  assert.equal(c.desktopRelease?.version, '0.2.0');
});

test('buildReleaseCatalog falls back to the general release, then to the other kind', () => {
  const onlyGeneral = buildReleaseCatalog([
    rel('desktop-v0.2.0', '2026-09-01T00:00:00Z', ['TS_0.2.0_x64_ru-RU.msi']),
    rel('v1.0.0', '2026-08-01T00:00:00Z', ['ts-owner.apk']),
  ]);
  assert.equal(onlyGeneral?.androidRelease?.kind, 'general');
  assert.deepEqual(onlyGeneral?.android.map((a) => a.name), ['ts-owner.apk']);
  assert.equal(onlyGeneral?.desktopRelease?.kind, 'desktop');

  const apkInDesktop = buildReleaseCatalog([rel('desktop-v0.2.0', null, ['TS.msi', 'ts-owner.apk'])]);
  assert.equal(apkInDesktop?.androidRelease?.kind, 'desktop');
  assert.deepEqual(apkInDesktop?.windows.map((a) => a.name), ['TS.msi']);

  const empty = buildReleaseCatalog([rel('mobile-v0.1.0', null, [])]);
  assert.equal(empty?.androidRelease, null);
  assert.equal(empty?.desktopRelease, null);
  assert.deepEqual([empty?.android, empty?.windows], [[], []]);
});

test('buildReleaseCatalog is null without published releases', () => {
  assert.equal(buildReleaseCatalog([]), null);
  assert.equal(buildReleaseCatalog([rel('desktop-v1', null, ['a.msi'], { draft: true })]), null);
});

test('assetPlatform sorts installers by extension and drops the rest', () => {
  assert.deepEqual(assetPlatform('ts-owner.apk'), { platform: 'android', format: 'apk' });
  assert.deepEqual(assetPlatform('TS_1.2.0_x64_ru-RU.msi'), { platform: 'windows', format: 'msi' });
  assert.deepEqual(assetPlatform('TS_1.2.0_x64-setup.EXE'), { platform: 'windows', format: 'exe' });
  assert.deepEqual(assetPlatform('ts_1.2.0_amd64.deb'), { platform: 'linux', format: 'deb' });
  assert.deepEqual(assetPlatform('ts_1.2.0_amd64.AppImage'), { platform: 'linux', format: 'AppImage' });
  assert.deepEqual(assetPlatform('ts-1.2.0-1.x86_64.rpm'), { platform: 'linux', format: 'rpm' });
  assert.deepEqual(assetPlatform('TS_1.2.0_aarch64.dmg'), { platform: 'mac', format: 'dmg' });
  assert.deepEqual(assetPlatform('TS_aarch64.app.tar.gz'), { platform: 'mac', format: 'app.tar.gz' });
  for (const junk of [
    'ts-owner.aab',
    'ts-owner.apk.sha256',
    'TS_1.2.0_x64_ru-RU.msi.sig',
    'TS_aarch64.app.tar.gz.sig',
    'TS_1.2.0_x64-setup.nsis.zip',
    'ts_1.2.0_amd64.AppImage.tar.gz',
    'latest.json',
    'SHA256SUMS',
    'source.zip',
  ]) {
    assert.equal(assetPlatform(junk), null, junk);
  }
});

test('assetApp reads the app from the file name', () => {
  assert.equal(assetApp('ts-owner-1.2.0.apk'), 'owner');
  assert.equal(assetApp('TS-Mobile.apk'), 'owner');
  assert.equal(assetApp('ts-desktop_1.2.0_amd64.deb'), 'desktop');
  assert.equal(assetApp('TS_1.2.0_x64.msi'), null);
});

test('classifyReleaseAssets groups files, keeps metadata and puts the expected app first', () => {
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
      asset('TS_1.2.0_x64-setup.exe'),
      asset('TS-desktop_1.2.0_x64_ru-RU.msi'),
      asset('TS-desktop_1.2.0_x64_ru-RU.msi.sig'),
      asset('ts-desktop_1.2.0_amd64.deb'),
      asset('ts-desktop_1.2.0_amd64.AppImage'),
      asset('TS_1.2.0_aarch64.dmg'),
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
  assert.deepEqual(
    r.windows.map((a) => a.name),
    ['TS-desktop_1.2.0_x64_ru-RU.msi', 'TS_1.2.0_x64-setup.exe'],
  );
  assert.deepEqual(
    r.linux.map((a) => a.format),
    ['deb', 'AppImage'],
  );
  assert.deepEqual(
    r.mac.map((a) => a.name),
    ['TS_1.2.0_aarch64.dmg'],
  );
});

test('classifyReleaseAssets copes with an empty or sparse release', () => {
  const r = classifyReleaseAssets({ tag_name: 'nightly', name: 'Ночная сборка', html_url: 'https://x', assets: [] });
  assert.equal(r.version, 'nightly');
  assert.equal(r.title, 'Ночная сборка');
  assert.equal(r.publishedAt, null);
  assert.deepEqual([r.android, r.windows, r.linux, r.mac], [[], [], [], []]);
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
