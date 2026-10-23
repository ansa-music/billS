// Cloudflare Pages Function: short download links of the cabinet site,
// https://ts-cabinet.pages.dev/download/windows | linux | android | minipc.
// Each redirects to the latest file in GitHub Releases, so one link stays valid across versions and
// can be sent in a chat or put on a QR code. No file yet or GitHub unreachable → the download page.
import { buildReleaseCatalog, downloadAssetFor, releasesApiUrl } from '../../../../packages/domain/src/releases.ts';
import type { GithubRelease } from '../../../../packages/domain/src/releases.ts';

interface Context {
  request: Request;
  params: { kind?: string | string[] };
}

export async function onRequestGet({ request, params }: Context): Promise<Response> {
  const kind = String(params.kind ?? '').toLowerCase();
  const fallback = new URL('/#/apps', request.url).href;
  try {
    const res = await fetch(releasesApiUrl(), {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ts-cabinet-download' },
      // GitHub allows 60 anonymous API calls an hour per IP: the edge keeps the list for 5 minutes.
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
    if (res.ok) {
      const asset = downloadAssetFor(buildReleaseCatalog((await res.json()) as GithubRelease[]), kind);
      if (asset) return new Response(null, { status: 302, headers: { location: asset.url, 'cache-control': 'no-store' } });
    }
  } catch {
    // fall through to the download page
  }
  return new Response(null, { status: 302, headers: { location: fallback, 'cache-control': 'no-store' } });
}
