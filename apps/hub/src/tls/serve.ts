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
import { originUrl } from '@bills/domain';
import type { TlsStatus } from '@bills/domain';
import { caDer, describe } from './ca.ts';
import { caPageHtml, sendCa } from './routes.ts';
import type { TlsRuntime } from './routes.ts';

export { caPageHtml, registerTlsRoutes, tlsStatus } from './routes.ts';
export type { TlsRuntime, TlsStatusContext } from './routes.ts';

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
  return { key: readFileSync(s.keyPath), cert, caPem, caDer: caDer(caPem), info: describe(caPem, cert) };
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
