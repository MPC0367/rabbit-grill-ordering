// HTTP application: middleware, error mapping, route modules, static client.
import { Hono } from 'hono';
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

  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store');
  });
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
    app.use('/assets/*', async (c, next) => {
      await next();
      if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    app.use('/*', serveStatic({ root: config.distDir }));
    app.get('*', (c) => {
      c.header('Cache-Control', 'no-cache');
      return c.html(indexHtml);
    });
  }

  return app;
}
