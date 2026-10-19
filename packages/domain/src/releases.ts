/**
 * App installers outside the app stores: the Android APK of the owner app and
 * the desktop cash-desk installers are published as GitHub Releases of a public
 * repository. Each app is released on its own, told apart by the tag prefix
 * (see ReleaseKind). The pages «Скачать приложение» (owner cabinet, hall
 * screens) read the list of releases from the GitHub API, take the latest one
 * of each kind and sort their files by platform here.
 */

/** Public repository whose releases carry the installers. */
export const TS_RELEASES_REPO = 'ansa-music/billS';

/**
 * GitHub REST endpoint of the recent releases, newest first. The list, not
 * `/releases/latest`: that is a single release, and a fresh APK release would
 * hide the desktop installers of an older one.
 */
export function releasesApiUrl(repo: string = TS_RELEASES_REPO): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=30`;
}

/** Human page of all releases; also the fallback when the API is unreachable. */
export function releasesPageUrl(repo: string = TS_RELEASES_REPO): string {
  return `https://github.com/${repo}/releases`;
}

/**
 * What a release ships, from its tag: «desktop-v0.2.0» — the cash-desk app for
 * computers (.msi, .deb), «mobile-v0.3.0» — the owner app (APK), anything else
 * («v1.0.0», «1.0.0», «nightly») — a general release that may carry both.
 */
export type ReleaseKind = 'desktop' | 'mobile' | 'general';

const KIND_PREFIXES: Array<{ prefix: string; kind: ReleaseKind }> = [
  { prefix: 'desktop-', kind: 'desktop' },
  { prefix: 'mobile-', kind: 'mobile' },
];

export function releaseKind(tag: string): ReleaseKind {
  const lower = tag.toLowerCase();
  return KIND_PREFIXES.find((p) => lower.startsWith(p.prefix))?.kind ?? 'general';
}

/** The version for people: «desktop-v0.2.0» → «0.2.0», «v1.2.0» → «1.2.0», «nightly» stays. */
export function releaseVersion(tag: string): string {
  const lower = tag.toLowerCase();
  const prefix = KIND_PREFIXES.find((p) => lower.startsWith(p.prefix))?.prefix ?? '';
  const rest = tag.slice(prefix.length);
  return /^v\d/i.test(rest) ? rest.slice(1) : rest;
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
  /** Drafts and prereleases are not offered for download. */
  draft?: boolean;
  prerelease?: boolean;
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
  kind: ReleaseKind;
  /** Tag without the kind prefix and the «v»: «desktop-v1.2.0» → «1.2.0». */
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

/**
 * Sorts the files of a release by platform. Within a platform the files named
 * after the expected app come first (owner app on Android, cash desk on
 * computers), then the rest in the order GitHub listed them.
 */
export function classifyReleaseAssets(release: GithubRelease): ClassifiedRelease {
  const out: ClassifiedRelease = {
    kind: releaseKind(release.tag_name ?? ''),
    version: releaseVersion(release.tag_name ?? ''),
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

/** What the download pages offer: the latest release of each kind, its files merged by platform. */
export interface ReleaseCatalog {
  /** The latest release of each kind there is, newest first. */
  releases: ClassifiedRelease[];
  android: ReleaseAsset[];
  windows: ReleaseAsset[];
  linux: ReleaseAsset[];
  mac: ReleaseAsset[];
  /** The release the Android files come from; null when no release has any. */
  androidRelease: ClassifiedRelease | null;
  /** The release the computer installers (Windows, Linux, macOS) come from. */
  desktopRelease: ClassifiedRelease | null;
}

function publishedMs(release: GithubRelease): number {
  const t = release.published_at ? Date.parse(release.published_at) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * The latest published release of each kind (drafts and prereleases skipped).
 * Newest by publish date; on a tie or without dates the one GitHub listed first.
 */
export function latestReleasesByKind(list: readonly GithubRelease[]): Partial<Record<ReleaseKind, GithubRelease>> {
  const latest: Partial<Record<ReleaseKind, GithubRelease>> = {};
  for (const release of list) {
    if (release.draft || release.prerelease) continue;
    const kind = releaseKind(release.tag_name ?? '');
    const seen = latest[kind];
    if (!seen || publishedMs(release) > publishedMs(seen)) latest[kind] = release;
  }
  return latest;
}

/**
 * Sorts the latest release of each kind into one catalog. The phone files come
 * from the latest mobile release, the computer files from the latest desktop
 * release; a kind without such files falls back to the general release and then
 * to the other kind, so a fresh release of one app never hides the other's files.
 * Null when there is no published release at all.
 */
export function buildReleaseCatalog(list: readonly GithubRelease[]): ReleaseCatalog | null {
  const latest = latestReleasesByKind(list);
  const byKind: Partial<Record<ReleaseKind, ClassifiedRelease>> = {};
  for (const kind of Object.keys(latest) as ReleaseKind[]) byKind[kind] = classifyReleaseAssets(latest[kind]!);
  const releases = Object.values(byKind).sort((a, b) => (b.publishedAt ?? -Infinity) - (a.publishedAt ?? -Infinity));
  if (releases.length === 0) return null;

  const pick = (order: ReleaseKind[], has: (r: ClassifiedRelease) => boolean): ClassifiedRelease | null =>
    order.map((k) => byKind[k]).find((r): r is ClassifiedRelease => r !== undefined && has(r)) ?? null;
  const androidRelease = pick(['mobile', 'general', 'desktop'], (r) => r.android.length > 0);
  const desktopRelease = pick(
    ['desktop', 'general', 'mobile'],
    (r) => r.windows.length + r.linux.length + r.mac.length > 0,
  );
  return {
    releases,
    android: androidRelease?.android ?? [],
    windows: desktopRelease?.windows ?? [],
    linux: desktopRelease?.linux ?? [],
    mac: desktopRelease?.mac ?? [],
    androidRelease,
    desktopRelease,
  };
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
export type VisitorPlatform = 'android' | 'ios' | 'windows' | 'linux' | 'mac' | 'other';

/**
 * Guesses the device from `navigator.userAgent` (and `maxTouchPoints`, because
 * iPadOS Safari reports itself as a Mac). Android goes before Linux: its user
 * agent contains both.
 */
export function detectPlatform(userAgent: string, maxTouchPoints = 0): VisitorPlatform {
  const ua = userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Macintosh|Mac OS X/i.test(ua)) return maxTouchPoints > 1 ? 'ios' : 'mac';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'other';
}
