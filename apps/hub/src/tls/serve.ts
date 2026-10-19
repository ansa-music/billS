/**
 * HTTPS at runtime: loads the certificates named by HUB_TLS_*, serves the root
 * certificate with install instructions (/ca, /ca.crt, /ca.pem — public, also
 * over plain HTTP, because a tablet has to fetch the root before it trusts the
 * HUB) and redirects every other plain-HTTP request to HTTPS.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { CA_INSTALL_GUIDES, originUrl } from '@bills/domain';
import type { TlsStatus } from '@bills/domain';
import { guard } from '../http/command.ts';
import { caDer, describe, RENEW_BEFORE_DAYS } from './ca.ts';
import type { CertInfo } from './ca.ts';

const DAY = 24 * 60 * 60 * 1000;
const CA_FILE_NAME = 'TS-root.crt';

export interface TlsRuntime {
  key: Buffer;
  cert: Buffer;
  caPem: Buffer;
  info: CertInfo;
}

export interface TlsSettings {
  certPath?: string;
  keyPath?: string;
  /** Root certificate to hand out; default `ca.crt` next to the server certificate. */
  caPath?: string;
}

/** null when HTTPS is not configured; throws when it is configured but broken (HUB must not start on HTTP silently). */
export function loadTls(s: TlsSettings): TlsRuntime | null {
  if (!s.certPath && !s.keyPath) return null;
  if (!s.certPath || !s.keyPath) throw new Error('Для HTTPS нужны обе переменные: HUB_TLS_CERT и HUB_TLS_KEY');
  const caPath = s.caPath ?? join(dirname(s.certPath), 'ca.crt');
  for (const [name, path] of [
    ['HUB_TLS_CERT', s.certPath],
    ['HUB_TLS_KEY', s.keyPath],
    ['HUB_TLS_CA', caPath],
  ] as const) {
    if (!existsSync(path)) throw new Error(`${name}: файл ${path} не найден — выполните \`bills ca init\``);
  }
  const cert = readFileSync(s.certPath);
  const caPem = readFileSync(caPath);
  return { key: readFileSync(s.keyPath), cert, caPem, info: describe(caPem, cert) };
}

export interface TlsStatusContext {
  tls: TlsRuntime | null;
  httpsPort: number | null;
  httpPort: number | null;
  mdnsName: string | null;
  now: number;
}

export function tlsStatus(ctx: TlsStatusContext): TlsStatus {
  const { tls } = ctx;
  if (!tls) {
    return {
      enabled: false,
      mdnsName: ctx.mdnsName,
      httpsPort: null,
      httpPort: null,
      caSubject: null,
      caFingerprint: null,
      caValidTo: null,
      serverValidTo: null,
      renewSoon: false,
      dnsNames: [],
      ips: [],
      caPageUrls: [],
      appUrls: [],
    };
  }
  // LAN addresses first: every tablet can reach an IP, not every one resolves .local.
  const lan = tls.info.ips.filter((ip) => ip !== '127.0.0.1' && ip !== '::1');
  const names = tls.info.dnsNames.filter((n) => n !== 'localhost');
  const hosts = [...lan, ...names];
  const caOrigin = (h: string) =>
    ctx.httpPort !== null ? originUrl('http', h, ctx.httpPort) : originUrl('https', h, ctx.httpsPort);
  return {
    enabled: true,
    mdnsName: ctx.mdnsName,
    httpsPort: ctx.httpsPort,
    httpPort: ctx.httpPort,
    caSubject: tls.info.caSubject,
    caFingerprint: tls.info.caFingerprint,
    caValidTo: tls.info.caValidTo,
    serverValidTo: tls.info.serverValidTo,
    renewSoon: tls.info.serverValidTo - ctx.now < RENEW_BEFORE_DAYS * DAY,
    dnsNames: tls.info.dnsNames,
    ips: tls.info.ips,
    caPageUrls: hosts.map((h) => `${caOrigin(h)}/ca`),
    appUrls: hosts.map((h) => `${originUrl('https', h, ctx.httpsPort)}/`),
  };
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Stand-alone page: the tablet opens it before the app works, so no SPA, no scripts. */
export function caPageHtml(status: TlsStatus, host: string | undefined): string {
  const hostName = (host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const app = hostName ? `${originUrl('https', hostName, status.httpsPort)}/` : (status.appUrls[0] ?? '/');
  const guides = CA_INSTALL_GUIDES.map(
    (g) => `<section><h2>${esc(g.device)}</h2><ol>${g.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>`,
  ).join('');
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TS — сертификат клуба</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
body{max-width:720px;margin:0 auto;padding:24px 16px;background:Canvas;color:CanvasText}
h1{font-size:1.5rem;margin:0 0 8px}h2{font-size:1.1rem;margin:24px 0 4px}
.btn{display:inline-block;padding:12px 20px;border-radius:10px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;margin:8px 8px 0 0}
.btn.alt{background:transparent;color:inherit;border:1px solid currentColor}
code{word-break:break-all;font-size:.85rem}.muted{opacity:.7}li{margin:4px 0}
</style></head><body>
<h1>Сертификат клуба TS</h1>
<p>Установите этот сертификат один раз на каждый планшет и ПК — после этого приложение TS открывается по защищённому адресу без предупреждений и ставится на экран как приложение.</p>
<p><a class="btn" href="/ca.crt" download="${CA_FILE_NAME}">Скачать сертификат</a><a class="btn alt" href="${esc(app)}">Открыть TS</a></p>
<p class="muted">Сертификат: ${esc(status.caSubject ?? '')}<br>Отпечаток SHA-256: <code>${esc(status.caFingerprint ?? '')}</code><br>Сверьте его с отпечатком на странице «Оборудование».</p>
${guides}
</body></html>`;
}

function sendCa(kind: 'der' | 'pem', tls: TlsRuntime): { type: string; body: Buffer; disposition: string } {
  return kind === 'der'
    ? { type: 'application/x-x509-ca-cert', body: caDer(tls.caPem), disposition: `attachment; filename="${CA_FILE_NAME}"` }
    : { type: 'application/x-pem-file', body: tls.caPem, disposition: 'attachment; filename="TS-root.pem"' };
}

/** /ca, /ca.crt, /ca.pem (public) and GET /api/tls (equipment.view) on the main app. */
export function registerTlsRoutes(app: FastifyInstance, status: () => TlsStatus, tls: TlsRuntime | null): void {
  app.get('/api/tls', { preHandler: guard('equipment.view') }, async () => status());
  if (!tls) return;
  for (const [path, kind] of [
    ['/ca.crt', 'der'],
    ['/ca.pem', 'pem'],
  ] as const) {
    app.get(path, async (_req, reply) => {
      const f = sendCa(kind, tls);
      return reply.header('content-type', f.type).header('content-disposition', f.disposition).header('cache-control', 'no-cache').send(f.body);
    });
  }
  app.get('/ca', async (req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(caPageHtml(status(), req.headers.host)),
  );
}

export interface RedirectServerOptions {
  tls: TlsRuntime;
  status: () => TlsStatus;
  httpsPort: number;
}

/** Plain-HTTP handler: the certificate pages as-is, everything else → 308 to the same path over HTTPS. */
export function redirectHandler(opts: RedirectServerOptions) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const path = url.split('?', 1)[0];
    if (path === '/ca.crt' || path === '/ca.pem') {
      const f = sendCa(path === '/ca.crt' ? 'der' : 'pem', opts.tls);
      res.writeHead(200, { 'content-type': f.type, 'content-disposition': f.disposition, 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : f.body);
      return;
    }
    if (path === '/ca' || path === '/ca/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : caPageHtml(opts.status(), req.headers.host));
      return;
    }
    const hostHeader = req.headers.host ?? '';
    // Strip the port (IPv6 literals keep their brackets).
    let host = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    // Only a plain host name or address goes into Location — anything else falls back to the certificate's first name.
    if (!/^[a-z0-9.\-:]+$/i.test(host)) host = opts.tls.info.ips.find((ip) => ip !== '127.0.0.1') ?? opts.tls.info.dnsNames[0] ?? 'localhost';
    res.writeHead(308, { location: `${originUrl('https', host, opts.httpsPort)}${url}` });
    res.end();
  };
}

export function startRedirectServer(
  opts: RedirectServerOptions & { host: string; port: number },
): Promise<Server> {
  const server = createServer(redirectHandler(opts));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
