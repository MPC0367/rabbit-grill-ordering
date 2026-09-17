// HTTP application: middleware, error mapping, route modules, static client.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { AppError } from './lib/errors.ts';
import { csrfGuard } from './lib/csrf.ts';
import type { GuestContext, StaffContext } from './lib/auth.ts';
import { authRoutes, streamsGuest, streamsStaff } from './routes/auth.ts';
import { catalogPublic, catalogStaff } from './routes/catalog.ts';
import { tablesPublic, tablesGuest, tablesStaff } from './routes/tables.ts';
import { ordersGuest, ordersStaff } from './routes/orders.ts';
import { serviceGuest, serviceStaff } from './routes/service.ts';
import { billingGuest, billingStaff } from './routes/billing.ts';
import { analyticsRoutes, insightsStaff } from './routes/insights.ts';
import { adminStaff } from './routes/admin.ts';

export type AppEnv = {
  Variables: { staff: StaffContext; guest: GuestContext };
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** Request body caps (bytes). The analytics batch route applies its own. */
export const BODY_LIMITS = {
  /** QR resolve and join: a token and a PIN. */
  public: 16 * 1024,
  /** Every other JSON body (60 cart lines with 500-character Thai notes fit easily). */
  default: 256 * 1024,
  /** Menu CSV preview: up to 2,000,000 characters, Thai text is 3 bytes each in UTF-8. */
  import: 8 * 1024 * 1024,
} as const;

function requestSizeLimit(): MiddlewareHandler {
  // The unread body stays on the socket, so the connection is not reused: without
  // `Connection: close` a keep-alive client sends its next request into a socket
  // the server is about to drop.
  const tooLarge = (c: Context) => c.json({
    error: { code: 'payload_too_large', message: 'This request is too large.' },
  }, 413, { Connection: 'close' });
  const limits = {
    public: bodyLimit({ maxSize: BODY_LIMITS.public, onError: tooLarge }),
    default: bodyLimit({ maxSize: BODY_LIMITS.default, onError: tooLarge }),
    import: bodyLimit({ maxSize: BODY_LIMITS.import, onError: tooLarge }),
  };
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const path = c.req.path;
    if (path === '/api/analytics/batch') return next();
    if (path === '/api/staff/menu/import/preview') return limits.import(c, next);
    if (path.startsWith('/api/public/')) return limits.public(c, next);
    return limits.default(c, next);
  };
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    c.header('X-Frame-Options', 'SAMEORIGIN');
    if (!c.req.path.startsWith('/api/')) c.header('Content-Security-Policy', CSP);
    if (c.req.path.startsWith('/admin') || c.req.path.startsWith('/q/') || c.req.path.startsWith('/api/')) {
      c.header('X-Robots-Tag', 'noindex, nofollow');
    }
    if (config.logRequests && c.req.path.startsWith('/api/')) {
      // Never log query strings or bodies: they can carry tokens and PINs.
      console.log(`${c.req.method} ${c.req.routePath} ${c.res.status} ${Date.now() - started}ms`);
    }
  });

  // gzip for API JSON and CSV (their length is not known up front, so the 1 KB
  // threshold applies to static files only) and for HTML, CSS and JS. Never the
  // event streams: text/event-stream is not compressible and they send no-transform.
  app.use('*', compress({ threshold: 1024 }));

  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store');
  });
  // Bodies are capped BEFORE anything reads them: an unauthenticated 100 MB
  // JSON post must not be buffered and parsed by the only process.
  app.use('/api/*', requestSizeLimit());
  app.use('/api/*', csrfGuard());

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    }
    console.error('[error]', c.req.method, c.req.routePath, err);
    return c.json({ error: { code: 'internal', message: 'Something went wrong on the server.' } }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

  // Route modules. Several modules may share a base path; Hono merges them.
  app.route('/api/staff/auth', authRoutes);
  app.route('/api/public', catalogPublic);
  app.route('/api/public', tablesPublic);
  app.route('/api/analytics', analyticsRoutes);
  app.route('/api/guest', streamsGuest);
  app.route('/api/staff', streamsStaff);
  app.route('/api/guest', tablesGuest);
  app.route('/api/guest', ordersGuest);
  app.route('/api/guest', serviceGuest);
  app.route('/api/guest', billingGuest);
  app.route('/api/staff', tablesStaff);
  app.route('/api/staff', ordersStaff);
  app.route('/api/staff', serviceStaff);
  app.route('/api/staff', billingStaff);
  app.route('/api/staff', catalogStaff);
  app.route('/api/staff', insightsStaff);
  app.route('/api/staff', adminStaff);

  app.all('/api/*', (c) => c.json({ error: { code: 'not_found', message: 'Unknown API route' } }, 404));

  // Built client (production). In development Vite serves the client.
  if (config.serveClient && existsSync(join(config.distDir, 'index.html'))) {
    const indexHtml = readFileSync(join(config.distDir, 'index.html'), 'utf8');
    const notFoundText = (c: Context) => c.text('Not found', 404, { 'Cache-Control': 'no-store' });
    const missing: MiddlewareHandler = async (c) => notFoundText(c);
    const spa = (c: Context) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    };
    // Hashed bundles: served precompressed when a .br/.gz sibling exists (compress() covers the rest),
    // cached for a year, and a missing file is a 404 - never index.html, which a browser would
    // then cache as "JavaScript" for a year. Source maps stay private unless SERVE_SOURCEMAPS=1.
    app.use('/assets/*',
      async (c, next) => (c.req.path.endsWith('.map') && !config.serveSourceMaps ? missing(c, next) : next()),
      staticCache('public, max-age=31536000, immutable'),
      serveStatic({ root: config.distDir, precompressed: true }),
      missing);
    // Dish photos and other public files: revalidated weekly, answered 304 when unchanged.
    app.use('/media/*', staticCache('public, max-age=604800'), serveStatic({ root: config.distDir }), missing);
    app.use('/*', async (c, next) => {
      // index.html is the one file that must never be served stale after a deploy.
      if (c.req.path === '/' || c.req.path === '/index.html') return spa(c);
      return next();
    }, staticCache('public, max-age=3600'), serveStatic({ root: config.distDir }));
    // A path with a file extension that no file matched is a 404; everything else is an app route.
    app.get('*', (c) => (/\.[A-Za-z0-9]{1,8}$/.test(c.req.path) ? notFoundText(c) : spa(c)));
  }

  return app;
}

/**
 * Cache headers and conditional GET for static files. serveStatic sets
 * Last-Modified but ignores If-Modified-Since; this adds a weak ETag (size and
 * mtime, so each encoding has its own) and answers 304 when the copy the
 * browser holds is still current.
 */
function staticCache(cacheControl: string): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res.status !== 200) return;
    const modified = res.headers.get('Last-Modified');
    if (!modified) return;
    const etag = `W/"${res.headers.get('Content-Length') ?? '0'}-${Date.parse(modified).toString(36)}"`;
    res.headers.set('Cache-Control', cacheControl);
    res.headers.set('ETag', etag);
    const ifNoneMatch = c.req.header('if-none-match');
    const ifModifiedSince = c.req.header('if-modified-since');
    const fresh = ifNoneMatch !== undefined
      ? ifNoneMatch.split(',').map((t) => t.trim()).some((t) => t === etag || t === '*')
      : ifModifiedSince !== undefined && Date.parse(modified) <= Date.parse(ifModifiedSince);
    if (!fresh) return;
    await res.body?.cancel().catch(() => undefined);
    const headers = new Headers({ 'Cache-Control': cacheControl, ETag: etag, 'Last-Modified': modified });
    const vary = res.headers.get('Vary');
    if (vary) headers.set('Vary', vary);
    c.res = new Response(null, { status: 304, headers });
  };
}
