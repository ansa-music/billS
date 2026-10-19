import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The cloud's 404, unchanged since before the cabinet was served from here. */
const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Такого адреса нет' } } as const;

/** Vite hashes everything under assets/: safe to cache for a year. */
const ASSETS_CACHE = 'public, max-age=31536000, immutable';
/** index.html, a service worker, the manifest and other unhashed files are revalidated on every load. */
const NO_CACHE = 'no-cache';
const MANIFEST_TYPE = 'application/manifest+json; charset=utf-8';

function sendNotFound(reply: FastifyReply) {
  return reply.status(404).send(NOT_FOUND);
}

/** API and HUB sync URLs never fall back to the cabinet's index.html. */
function isMachineUrl(url: string): boolean {
  return /^\/(api|sync)(\/|\?|$)/.test(url);
}

function wantsCabinet(req: FastifyRequest): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && !isMachineUrl(req.url);
}

/**
 * Serves the built owner cabinet (apps/cloud-web/dist) on `/` with an SPA fallback,
 * the same way the HUB serves the hall screen (apps/hub/src/http/static.ts).
 *
 * - `assets/*` (hashed by Vite) is cached for a year, everything else is `no-cache`.
 * - GET/HEAD for an unknown URL outside `/api` and `/sync` answers with `index.html`.
 * - Everything else unknown gets the cloud's JSON 404.
 * - Without `dir` (or when it does not exist) only the JSON 404 is installed: the API works as before.
 */
export function registerStatic(app: FastifyInstance, dir: string | undefined): void {
  if (!dir || !existsSync(dir)) {
    app.setNotFoundHandler((_req, reply) => sendNotFound(reply));
    return;
  }

  app.register(fastifyStatic, {
    root: dir,
    prefix: '/',
    // Cache-Control is decided per file in setHeaders instead of one value for everything.
    cacheControl: false,
    setHeaders(reply, filePath) {
      const rel = relative(dir, filePath).split(sep).join('/');
      reply.header('cache-control', rel.startsWith('assets/') ? ASSETS_CACHE : NO_CACHE);
      if (rel.endsWith('.webmanifest')) reply.header('content-type', MANIFEST_TYPE);
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (wantsCabinet(req) && existsSync(`${dir}/index.html`)) {
      return reply.type('text/html; charset=utf-8').header('cache-control', NO_CACHE).sendFile('index.html');
    }
    return sendNotFound(reply);
  });
}
