import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetApp,
  assetPlatform,
  classifyReleaseAssets,
  detectPlatform,
  formatSize,
  releasesApiUrl,
  releasesPageUrl,
  TS_RELEASES_REPO,
} from '../src/index.ts';
import type { GithubRelease } from '../src/index.ts';

const asset = (name: string, size = 1000) => ({
  name,
  size,
  browser_download_url: `https://github.com/${TS_RELEASES_REPO}/releases/download/v1.2.0/${name}`,
});

test('release URLs point at the latest release of the repository', () => {
  assert.equal(TS_RELEASES_REPO, 'ansa-music/billS');
  assert.equal(releasesApiUrl(), 'https://api.github.com/repos/ansa-music/billS/releases/latest');
  assert.equal(releasesPageUrl(), 'https://github.com/ansa-music/billS/releases/latest');
  assert.equal(releasesApiUrl('a/b'), 'https://api.github.com/repos/a/b/releases/latest');
  assert.equal(releasesPageUrl('a/b'), 'https://github.com/a/b/releases/latest');
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
