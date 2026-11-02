/**
 * App files outside the app stores: the Android APK of the owner app and the
 * mini-PC USB image are published as GitHub Releases of a public repository.
 * Each is released on its own, told apart by the tag prefix (see ReleaseKind).
 * The cash desk has no installer: it runs in the browser. The pages «Скачать
 * приложение» (owner cabinet, hall screens) read the list of releases from the
 * GitHub API, take the latest one of each kind and sort their files by platform here.
 */

/** Public repository whose releases carry the files. */
export const TS_RELEASES_REPO = 'ansa-music/billS';

/**
 * GitHub REST endpoint of the recent releases, newest first. The list, not
 * `/releases/latest`: that is a single release, and a fresh APK release would
 * hide the mini-PC image of an older one.
 */
export function releasesApiUrl(repo: string = TS_RELEASES_REPO): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=30`;
}

/** Human page of all releases; also the fallback when the API is unreachable. */
export function releasesPageUrl(repo: string = TS_RELEASES_REPO): string {
  return `https://github.com/${repo}/releases`;
}

/**
 * What a release ships, from its tag: «mobile-v0.3.0» — the owner app (APK),
 * «minipc-v0.1.0» — the USB image of the club's mini-PC (.iso), a plain version
 * or name («v1.0.0», «1.0.0», «nightly») — a general release that may carry either.
 */
export type ReleaseKind = 'mobile' | 'minipc' | 'general';

const KIND_PREFIXES: Array<{ prefix: string; kind: ReleaseKind }> = [
  { prefix: 'mobile-', kind: 'mobile' },
  { prefix: 'minipc-', kind: 'minipc' },
];

/**
 * Tags of apps the pages do not offer: the dropped TS app for PC (its releases «desktop-v0.1.1» and
 * the updater channel «desktop-latest» stay on GitHub) and any other «<app>-v1.2.0». Without this
 * they would count as general releases and their files would come back on the download pages.
 */
const OTHER_APP_TAG = /^(desktop-|[a-z][a-z0-9]*-v\d)/;

/** The kind of a release, or null when the pages never offer it (see OTHER_APP_TAG). */
export function releaseKind(tag: string): ReleaseKind | null {
  const lower = tag.toLowerCase();
  const known = KIND_PREFIXES.find((p) => lower.startsWith(p.prefix))?.kind;
  if (known) return known;
  return OTHER_APP_TAG.test(lower) ? null : 'general';
}

/** The version for people: «mobile-v0.3.0» → «0.3.0», «v1.2.0» → «1.2.0», «nightly» stays. */
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

/** Where a file goes; «minipc» is the USB image that installs the whole mini-PC (HUB on Debian). */
export type ReleasePlatform = 'android' | 'minipc';

/** Which app a file installs, guessed from its name; null when the name does not say. */
export type ReleaseApp = 'owner';

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  platform: ReleasePlatform;
  /** File format: apk or iso. */
  format: string;
  app: ReleaseApp | null;
  /** The «<file>.sha256» published next to it, when there is one (the mini-PC image has it). */
  checksumUrl?: string;
}

export interface ClassifiedRelease {
  /** Null for a tag the pages never offer (see releaseKind); the catalog skips such releases. */
  kind: ReleaseKind | null;
  /** Tag without the kind prefix and the «v»: «mobile-v1.2.0» → «1.2.0». */
  version: string;
  /** Display name of the release when it differs from the tag, else null. */
  title: string | null;
  /** Epoch ms, null when GitHub did not say. */
  publishedAt: number | null;
  pageUrl: string;
  android: ReleaseAsset[];
  minipc: ReleaseAsset[];
}

/** Matching is case-insensitive. */
const FORMATS: Array<{ suffix: string; platform: ReleasePlatform; format: string }> = [
  { suffix: '.apk', platform: 'android', format: 'apk' },
  { suffix: '.iso', platform: 'minipc', format: 'iso' },
];

/**
 * Platform and format of a release file, or null for anything the pages do not
 * hand out: checksums (.sha256), signatures (.sig, .asc), Android App Bundles
 * (.aab — Play Store only, cannot be installed from a file) and the installers
 * of the dropped PC app (.msi, .exe, .deb, .AppImage, .dmg, its latest.json).
 */
export function assetPlatform(name: string): { platform: ReleasePlatform; format: string } | null {
  const lower = name.toLowerCase();
  for (const f of FORMATS) {
    if (lower.endsWith(f.suffix)) return { platform: f.platform, format: f.format };
  }
  return null;
}

/** «owner» / «mobile» in the name → the owner app. */
export function assetApp(name: string): ReleaseApp | null {
  return /owner|mobile/.test(name.toLowerCase()) ? 'owner' : null;
}

/**
 * Sorts the files of a release by platform. On Android the files named after
 * the owner app come first, then the rest in the order GitHub listed them.
 */
export function classifyReleaseAssets(release: GithubRelease): ClassifiedRelease {
  const out: ClassifiedRelease = {
    kind: releaseKind(release.tag_name ?? ''),
    version: releaseVersion(release.tag_name ?? ''),
    title: release.name && release.name !== release.tag_name ? release.name : null,
    publishedAt: null,
    pageUrl: release.html_url,
    android: [],
    minipc: [],
  };
  if (release.published_at) {
    const t = Date.parse(release.published_at);
    if (Number.isFinite(t)) out.publishedAt = t;
  }
  const checksums = new Map<string, string>();
  for (const a of release.assets ?? []) {
    const lower = a.name.toLowerCase();
    if (lower.endsWith('.sha256')) checksums.set(lower.slice(0, -'.sha256'.length), a.browser_download_url);
  }
  for (const a of release.assets ?? []) {
    const kind = assetPlatform(a.name);
    if (!kind) continue;
    const item: ReleaseAsset = {
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
      platform: kind.platform,
      format: kind.format,
      app: assetApp(a.name),
    };
    const checksum = checksums.get(a.name.toLowerCase());
    if (checksum) item.checksumUrl = checksum;
    out[kind.platform].push(item);
  }
  // Array.prototype.sort is stable, so ties keep GitHub's order. The mini-PC image is one file per
  // release: nothing to put first.
  out.android.sort((x, y) => Number(y.app === 'owner') - Number(x.app === 'owner'));
  return out;
}

/** What the download pages offer: the latest release of each kind, its files merged by platform. */
export interface ReleaseCatalog {
  /** The latest release of each kind there is, newest first. */
  releases: ClassifiedRelease[];
  android: ReleaseAsset[];
  /** USB images of the club's mini-PC. */
  minipc: ReleaseAsset[];
  /** The release the Android files come from; null when no release has any. */
  androidRelease: ClassifiedRelease | null;
  /** The release the mini-PC image comes from. */
  minipcRelease: ClassifiedRelease | null;
}

function publishedMs(release: GithubRelease): number {
  const t = release.published_at ? Date.parse(release.published_at) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * The latest published release of each kind (drafts, prereleases and tags the
 * pages never offer skipped). Newest by publish date; on a tie or without dates
 * the one GitHub listed first.
 */
export function latestReleasesByKind(list: readonly GithubRelease[]): Partial<Record<ReleaseKind, GithubRelease>> {
  const latest: Partial<Record<ReleaseKind, GithubRelease>> = {};
  for (const release of list) {
    if (release.draft || release.prerelease) continue;
    const kind = releaseKind(release.tag_name ?? '');
    if (!kind) continue;
    const seen = latest[kind];
    if (!seen || publishedMs(release) > publishedMs(seen)) latest[kind] = release;
  }
  return latest;
}

/**
 * Sorts the latest release of each kind into one catalog. The phone files come
 * from the latest mobile release, the mini-PC image from the latest minipc
 * release; a kind without such files falls back to the general release and then
 * to the other kind, so a fresh release of one never hides the other's files.
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
  const androidRelease = pick(['mobile', 'general', 'minipc'], (r) => r.android.length > 0);
  const minipcRelease = pick(['minipc', 'general', 'mobile'], (r) => r.minipc.length > 0);
  return {
    releases,
    android: androidRelease?.android ?? [],
    minipc: minipcRelease?.minipc ?? [],
    androidRelease,
    minipcRelease,
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

// ---- The «Скачать приложение» page, shared by the cabinet and the hall screens ----

/**
 * The cards of the download page: the owner's Android phone, the club's mini-PC, iPhone. There is
 * no card for the cash-desk computer: the cash desk opens in its browser.
 */
export type DownloadCard = 'android' | 'minipc' | 'ios';

const CARD_ORDER: readonly DownloadCard[] = ['android', 'minipc', 'ios'];

/**
 * The card of the visitor's phone goes first and is marked «это устройство»;
 * the rest keep the order Android → mini-PC → iPhone. A computer gets no mark,
 * and neither does the mini-PC card: the mini-PC is set up from another device.
 */
export function downloadCards(platform: VisitorPlatform): { order: DownloadCard[]; current: DownloadCard | null } {
  const first: DownloadCard | null = platform === 'android' || platform === 'ios' ? platform : null;
  const order = first ? [first, ...CARD_ORDER.filter((c) => c !== first)] : [...CARD_ORDER];
  return { order, current: first };
}

/** Small print under a download button: «файл .apk · 30 МБ». */
export function assetFileText(asset: Pick<ReleaseAsset, 'format' | 'size'>): string {
  return `файл .${asset.format} · ${formatSize(asset.size)}`;
}

/** «21 октября 2026» (no «г.»), in the visitor's time zone unless one is given. */
export function formatReleaseDate(ms: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('year')}`;
}

/** «Версия 0.1.1 от 21 октября 2026»; without a date just «Версия 0.1.1». */
export function releaseVersionText(release: Pick<ClassifiedRelease, 'version' | 'publishedAt'>, timeZone?: string): string {
  const date = release.publishedAt === null ? '' : ` от ${formatReleaseDate(release.publishedAt, timeZone)}`;
  return `Версия ${release.version}${date}`;
}

/** The one command that turns an Ubuntu or Debian machine into the club's mini-PC (deploy/linux/install.sh). */
export const MINIPC_INSTALL_COMMAND = `curl -fsSL https://raw.githubusercontent.com/${TS_RELEASES_REPO}/main/deploy/linux/install.sh | sudo bash`;
/** Where the manager finishes the setup after the install: the HUB's setup page. */
export const MINIPC_SETUP_ADDRESS = 'http://<адрес мини-ПК>:4310/setup';
/** The full mini-PC guide for people. */
export const MINIPC_GUIDE_URL = `https://github.com/${TS_RELEASES_REPO}/blob/main/docs/MINIPC_RU.md`;
/** HUB as a Windows service on a computer the venue already has (deploy/windows, set up by support). */
export const WINDOWS_HUB_GUIDE_URL = `https://github.com/${TS_RELEASES_REPO}/blob/main/deploy/windows/README.md`;

/**
 * A piece of an instruction step: plain text, a bold name of what to press, a
 * link, or a command to copy (shown as a block with a «Скопировать» button).
 */
export type StepPart = string | { strong: string } | { text: string; href: string } | { command: string };
export type DownloadStep = StepPart[];

const CONNECTION_CODE: StepPart[] = [
  'Вставьте код подключения из кабинета управляющего: ',
  { strong: 'Компания → Филиалы → новый филиал' },
  '.',
];

/** Plain texts of the download page (both apps). */
export const DOWNLOAD_TEXT = {
  loading: 'Проверяем новую версию…',
  error: 'Не удалось проверить новые версии, попробуйте позже.',
  allVersions: 'все версии',
  current: 'это устройство',
  android: {
    kicker: 'Телефон владельца',
    title: 'Android',
    button: 'Скачать для Android',
    lead: 'Выручка, столы и уведомления клуба в телефоне. Ставится файлом, без Google Play.',
    soon: 'Скоро здесь появится версия для Android',
    hint: 'Новая версия ставится так же — поверх старой, данные и вход сохранятся.',
    qr: 'Наведите камеру телефона, чтобы скачать на телефон',
  },
  minipc: {
    kicker: 'Главный компьютер клуба',
    title: 'Мини-ПК клуба',
    button: 'Скачать образ для флешки',
    lead: 'Маленький компьютер в клубе, который хранит данные, включает лампы и работает даже без интернета.',
    soon: 'Скоро здесь появится готовый образ для флешки',
    warning: 'Установка с флешки полностью стирает диск мини-ПК — всё, что на нём было, пропадёт.',
    commandTitle: 'Уже стоит Ubuntu или Debian? Хватит одной команды',
    commandTitleNoImage: 'Пока образа нет, мини-ПК с Ubuntu или Debian настраивается одной командой',
    windows:
      'Отдельного мини-ПК нет, а компьютер кассы на Windows работает весь день? HUB можно поставить на него службой Windows — с этим поможет техподдержка.',
    windowsGuide: 'HUB на Windows',
    guide: 'Подробная инструкция',
  },
} as const;

export const ANDROID_STEPS: readonly DownloadStep[] = [
  ['Нажмите ', { strong: '«Скачать для Android»' }, ' на телефоне и дождитесь загрузки.'],
  ['Откройте скачанный файл — из уведомления или из папки «Загрузки».'],
  [
    'Телефон попросит разрешить установку из неизвестных источников — включите ',
    { strong: '«Разрешить из этого источника»' },
    ' и вернитесь назад.',
  ],
  [
    'Нажмите ',
    { strong: '«Установить»' },
    '. Если Play Защита предупредит о неизвестном приложении — «Подробнее» → ',
    { strong: '«Всё равно установить»' },
    '.',
  ],
];

export const MINIPC_IMAGE_STEPS: readonly DownloadStep[] = [
  [
    'Скачайте образ и запишите его на флешку программой ',
    { text: 'balenaEtcher', href: 'https://etcher.balena.io/' },
    ' или ',
    { text: 'Rufus', href: 'https://rufus.ie/ru/' },
    '.',
  ],
  [
    'Вставьте флешку в мини-ПК и включите его. Если он не загрузился с флешки — при включении нажимайте ',
    { strong: 'F12' },
    ', ',
    { strong: 'F11' },
    ' или ',
    { strong: 'Esc' },
    ' и выберите флешку.',
  ],
  ['Установка пройдёт сама. Когда она закончится, на экране мини-ПК появится адрес — откройте его на телефоне или компьютере в сети клуба.'],
  CONNECTION_CODE,
];

export const MINIPC_COMMAND_STEPS: readonly DownloadStep[] = [
  ['Откройте терминал мини-ПК и вставьте команду:', { command: MINIPC_INSTALL_COMMAND }],
  ['Когда установка закончится, откройте на телефоне или компьютере в сети клуба адрес ', { strong: MINIPC_SETUP_ADDRESS }, '.'],
  CONNECTION_CODE,
];

/**
 * Short download links of the cabinet site: /download/<kind> redirects to the latest file. The PC
 * app's /download/windows and /download/linux are gone: such links land on the download page.
 */
export type DownloadKind = 'android' | 'minipc';
export const DOWNLOAD_KINDS: readonly DownloadKind[] = ['android', 'minipc'];

/** Path of the short link on the cabinet site, e.g. «/download/android». */
export function downloadPath(kind: DownloadKind): string {
  return `/download/${kind}`;
}

/**
 * The one file a short link hands out: Android — the APK, mini-PC — the USB image. Null for any
 * other kind (the old «windows» and «linux» too) and when there is no file yet.
 */
export function downloadAssetFor(catalog: ReleaseCatalog | null, kind: string): ReleaseAsset | null {
  if (!catalog) return null;
  const byFormat = (list: ReleaseAsset[], formats: string[]): ReleaseAsset | null =>
    formats.map((f) => list.find((a) => a.format === f)).find((a) => a !== undefined) ?? list[0] ?? null;
  switch (kind) {
    case 'android':
      return byFormat(catalog.android, ['apk']);
    case 'minipc':
      return byFormat(catalog.minipc, ['iso']);
    default:
      return null;
  }
}
