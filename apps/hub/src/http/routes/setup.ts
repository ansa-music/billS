/**
 * First-boot wizard routes: GET /setup (page), GET /api/setup/status, POST /api/setup.
 * The logic and the file live in src/setup.ts (main.ts only); this module stays free of Node
 * built-ins because the in-browser demo HUB (apps/web, VITE_DEMO_LOCAL) bundles http/app.ts.
 *
 * Who may use it. The wizard has no login: on first boot nobody has a key yet, so — like a home
 * router's setup page — the HUB trusts its own LAN while it is not connected to a cloud. The
 * trade-off: any device in the club network can connect the HUB to a cloud first; the window is
 * short (it closes for good after the first save) and the manager sees the result right away.
 * To keep that trust to the LAN only, every request must
 *  - come from a private address (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7,
 *    fe80::/10; `req.ip` is the socket address — the HUB does not trust proxy headers);
 *  - carry no proxy headers (X-Forwarded-For, Forwarded, CF-Connecting-IP…): a tunnel or reverse
 *    proxy on the mini-PC connects from 127.0.0.1 on behalf of someone on the internet;
 *  - name the HUB by a LAN host (an IP, hub.local, a one-word name…), which defeats DNS rebinding;
 *  - for POST, be same-origin JSON: a foreign page can neither send it without a CORS preflight
 *    nor pass the Origin check.
 * A demo HUB answers «disabled», a configured one «already set up». The window stays open as long as
 * the HUB runs without a cloud: a club that does so on purpose closes it with HUB_SETUP=off, and a
 * guest Wi-Fi should be a separate network from the one the HUB and the tablets are on.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { HubSetupRequest, HubSetupResponse, HubSetupStatus } from '@bills/domain';
import { HubError } from '../../errors.ts';
import { setupBlockedPageHtml, setupClosedPageHtml, setupPageHtml } from '../setup-page.ts';

export interface SetupController {
  status(): HubSetupStatus;
  save(req: HubSetupRequest, meta: { ip?: string }): Promise<HubSetupResponse>;
}

/** Private, loopback and link-local addresses — the club LAN; IPv4-mapped IPv6 and zone ids are understood. */
export function isPrivateAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  let a = ip.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) a = mapped[1]!;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [o1, o2, o3, o4] = v4.slice(1).map(Number) as [number, number, number, number];
    if ([o1, o2, o3, o4].some((o) => o > 255)) return false;
    return o1 === 127 || o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
  }
  if (!a.includes(':') || !/^[0-9a-f:.]+$/.test(a)) return false;
  if (a === '::1') return true;
  const first = a.startsWith('::') ? 0 : parseInt(a.split(':', 1)[0]!, 16);
  if (!Number.isFinite(first)) return false;
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.localhost'];

/** A Host header naming the HUB the LAN way: an address, localhost, a one-word name or a local suffix. */
export function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (/^\[[0-9a-f:.]+(?:%[0-9a-z._-]+)?\](?::\d{1,5})?$/.test(h)) return true;
  const name = h.replace(/:\d{1,5}$/, '').replace(/\.$/, '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)) return true;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(name)) return false;
  return !name.includes('.') || LOCAL_SUFFIXES.some((s) => name.endsWith(s));
}

const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip'];

function sameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const o = new URL(origin);
    return o.host === new URL(`${o.protocol}//${host}`).host;
  } catch {
    return false;
  }
}

/** Why this request may not use the wizard; null when it comes from the club LAN. */
export function setupAccessProblem(req: FastifyRequest): string | null {
  if (!isPrivateAddress(req.ip)) return 'address';
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return 'proxy';
  if (!isLocalHostHeader(req.headers.host)) return 'host';
  const origin = req.headers.origin;
  if (origin !== undefined && !sameOrigin(origin, req.headers.host)) return 'origin';
  return null;
}

const LAN_ONLY = 'Мастер настройки открывается только из сети клуба: подключитесь к Wi-Fi клуба и откройте адрес, показанный на экране мини-ПК';

async function lanOnly(req: FastifyRequest): Promise<void> {
  if (setupAccessProblem(req)) throw new HubError(403, 'SETUP_LAN_ONLY', LAN_ONLY);
}

const PAGE_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function sendPage(reply: FastifyReply, status: number, html: string) {
  return reply.status(status).headers(PAGE_HEADERS).type('text/html; charset=utf-8').send(html);
}

const setupBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', maxLength: 4000 },
    hubId: { type: 'string', maxLength: 200 },
    apiKey: { type: 'string', maxLength: 600 },
    cloudUrl: { type: 'string', maxLength: 500 },
    lamps: {
      type: 'object',
      additionalProperties: false,
      required: ['driver'],
      properties: {
        driver: { type: 'string', enum: ['simulator', 'esp32-http', 'modbus-tcp'] },
        esp32Host: { type: 'string', maxLength: 300 },
        esp32Token: { type: 'string', maxLength: 300 },
        modbusHost: { type: 'string', maxLength: 300 },
      },
    },
    skipCheck: { type: 'boolean' },
  },
} as const;

export function registerSetupRoutes(app: FastifyInstance, setup: SetupController): void {
  const page = async (req: FastifyRequest, reply: FastifyReply) => {
    if (setupAccessProblem(req)) return sendPage(reply, 403, setupBlockedPageHtml(LAN_ONLY));
    const st = setup.status();
    return sendPage(reply, 200, st.open ? setupPageHtml(st) : setupClosedPageHtml(st));
  };
  app.get('/setup', page);
  app.get('/setup/', page);

  app.get('/api/setup/status', { onRequest: lanOnly }, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return setup.status();
  });

  app.post<{ Body: HubSetupRequest }>(
    '/api/setup',
    {
      onRequest: lanOnly,
      preValidation: async (req) => {
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
          throw new HubError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Нужен JSON (Content-Type: application/json)');
        }
      },
      schema: { body: setupBody },
    },
    async (req, reply) => {
      const result = await setup.save(req.body ?? {}, { ip: req.ip });
      return reply.header('cache-control', 'no-store').send(result);
    },
  );
}
