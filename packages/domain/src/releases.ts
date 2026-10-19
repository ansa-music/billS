/**
 * App installers outside the app stores: the Android APK of the owner app and
 * the desktop cash-desk installers are published as GitHub Releases of a public
 * repository. The pages «Скачать приложение» (owner cabinet, hall screens) read
 * the latest release from the GitHub API and sort its files by platform here.
 */

/** Public repository whose releases carry the installers. */
export const TS_RELEASES_REPO = 'ansa-music/billS';

/** GitHub REST endpoint of the latest (non-draft, non-prerelease) release. */
export function releasesApiUrl(repo: string = TS_RELEASES_REPO): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/** Human page of the latest release; also the fallback when the API is unreachable. */
export function releasesPageUrl(repo: string = TS_RELEASES_REPO): string {
  return `https://github.com/${repo}/releases/latest`;
}

/** The part of a GitHub release asset the pages use. */
export interface GithubReleaseAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

/** The part of a GitHub release the pages use. */
export interface GithubRelease {
  tag_name: string;
  name?: string | null;
  published_at?: string | null;
  html_url: string;
  assets: GithubReleaseAsset[];
}

export type ReleasePlatform = 'android' | 'windows' | 'linux' | 'mac';

/** Which app a file installs, guessed from its name; null when the name does not say. */
export type ReleaseApp = 'owner' | 'desktop';

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  platform: ReleasePlatform;
  /** Installer format: apk, msi, exe, deb, AppImage, rpm, dmg, app.tar.gz. */
  format: string;
  app: ReleaseApp | null;
}

export interface ClassifiedRelease {
  /** Tag without the leading «v»: «v1.2.0» → «1.2.0». */
  version: string;
  /** Display name of the release when it differs from the tag, else null. */
  title: string | null;
  /** Epoch ms, null when GitHub did not say. */
  publishedAt: number | null;
  pageUrl: string;
  android: ReleaseAsset[];
  windows: ReleaseAsset[];
  linux: ReleaseAsset[];
  mac: ReleaseAsset[];
}

/** Longest suffixes first, so «.app.tar.gz» wins over a bare «.gz». Matching is case-insensitive. */
const FORMATS: Array<{ suffix: string; platform: ReleasePlatform; format: string }> = [
  { suffix: '.app.tar.gz', platform: 'mac', format: 'app.tar.gz' },
  { suffix: '.appimage', platform: 'linux', format: 'AppImage' },
  { suffix: '.apk', platform: 'android', format: 'apk' },
  { suffix: '.msi', platform: 'windows', format: 'msi' },
  { suffix: '.exe', platform: 'windows', format: 'exe' },
  { suffix: '.deb', platform: 'linux', format: 'deb' },
  { suffix: '.rpm', platform: 'linux', format: 'rpm' },
  { suffix: '.dmg', platform: 'mac', format: 'dmg' },
];

/**
 * Platform and format of a release file, or null for anything that is not an
 * installer: signatures (.sig, .asc), checksums (.sha256), the updater manifest
 * (latest.json), updater bundles (.nsis.zip, .msi.zip, .AppImage.tar.gz) and
 * Android App Bundles (.aab — Play Store only, cannot be installed from a file).
 */
export function assetPlatform(name: string): { platform: ReleasePlatform; format: string } | null {
  const lower = name.toLowerCase();
  for (const f of FORMATS) {
    if (lower.endsWith(f.suffix)) return { platform: f.platform, format: f.format };
  }
  return null;
}

/** «owner» / «mobile» in the name → the owner app; «desktop» / «cash» / «kassa» → the cash-desk app. */
export function assetApp(name: string): ReleaseApp | null {
  const lower = name.toLowerCase();
  if (/owner|mobile/.test(lower)) return 'owner';
  if (/desktop|cash|kassa/.test(lower)) return 'desktop';
  return null;
}

function stripV(tag: string): string {
  return /^v\d/i.test(tag) ? tag.slice(1) : tag;
}

/**
 * Sorts the files of a release by platform. Within a platform the files named
 * after the expected app come first (owner app on Android, cash desk on
 * computers), then the rest in the order GitHub listed them.
 */
export function classifyReleaseAssets(release: GithubRelease): ClassifiedRelease {
  const out: ClassifiedRelease = {
    version: stripV(release.tag_name ?? ''),
    title: release.name && release.name !== release.tag_name ? release.name : null,
    publishedAt: null,
    pageUrl: release.html_url,
    android: [],
    windows: [],
    linux: [],
    mac: [],
  };
  if (release.published_at) {
    const t = Date.parse(release.published_at);
    if (Number.isFinite(t)) out.publishedAt = t;
  }
  for (const a of release.assets ?? []) {
    const kind = assetPlatform(a.name);
    if (!kind) continue;
    out[kind.platform].push({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
      platform: kind.platform,
      format: kind.format,
      app: assetApp(a.name),
    });
  }
  const preferred: Record<ReleasePlatform, ReleaseApp> = {
    android: 'owner',
    windows: 'desktop',
    linux: 'desktop',
    mac: 'desktop',
  };
  for (const platform of Object.keys(preferred) as ReleasePlatform[]) {
    const want = preferred[platform];
    // Array.prototype.sort is stable, so ties keep GitHub's order.
    out[platform].sort((x, y) => Number(y.app === want) - Number(x.app === want));
  }
  return out;
}

/** 734 → «734 Б», 52_428_800 → «50 МБ», 1_288_490_189 → «1,2 ГБ». */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return `${text} ${units[unit]}`;
}

/** The platform of the device the page is open on, for putting its section first. */
export type DevicePlatform = 'android' | 'ios' | 'windows' | 'linux' | 'mac' | 'other';

/**
 * Guesses the device from `navigator.userAgent` (and `maxTouchPoints`, because
 * iPadOS Safari reports itself as a Mac). Android goes before Linux: its user
 * agent contains both.
 */
export function detectPlatform(userAgent: string, maxTouchPoints = 0): DevicePlatform {
  const ua = userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Macintosh|Mac OS X/i.test(ua)) return maxTouchPoints > 1 ? 'ios' : 'mac';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'other';
}
