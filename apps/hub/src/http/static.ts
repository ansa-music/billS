import { existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Не найдено' } } as const;

/** Vite hashes everything under assets/: safe to cache for a year. */
const ASSETS_CACHE = 'public, max-age=31536000, immutable';
/**
 * index.html, the service worker (sw.js, workbox-*.js), the manifest and anything
 * else unhashed are revalidated on every load, so an installed app picks up a new
 * build on its next start instead of a year later.
 */
const NO_CACHE = 'no-cache';
/** The web app manifest has its own media type; `send` guesses it too, but nothing should depend on that. */
const MANIFEST_TYPE = 'application/manifest+json; charset=utf-8';

function sendNotFound(reply: FastifyReply) {
  return reply.status(404).send(NOT_FOUND);
}

/**
 * Serves the built hall screen (apps/web/dist) on `/` with an SPA fallback.
 *
 * - Files under `dir` are served as-is; `/` resolves to `index.html`.
 * - Only `assets/*` (hashed by Vite) is cached for long; `index.html`, `sw.js`,
 *   `manifest.webmanifest` and the icons are `no-cache` (PWA, see docs/PWA_PLAN_RU.md).
 * - GET/HEAD for an unknown non-`/api` URL answers with `index.html` (client-side routing).
 * - Everything else unknown (including `/api/*`) gets the HUB's JSON 404.
 * - When `dir` is missing nothing is served, but the JSON 404 is still installed
 *   so the error format stays the same with or without a built screen.
 */
export function registerStatic(app: FastifyInstance, dir: string): void {
  if (!existsSync(dir)) {
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
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isRead && !req.url.startsWith('/api')) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return sendNotFound(reply);
  });
}
