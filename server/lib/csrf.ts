// CSRF defence for cookie-authenticated mutations:
//  1. every non-GET request must carry `X-RG-Client: 1` (a custom header
//     cannot be sent cross-site without a CORS preflight, which we never allow);
//  2. when the browser tells us, the request must be same-origin
//     (Sec-Fetch-Site) and the Origin host must match the Host header.
// Staff cookies are also SameSite=Strict.
import type { MiddlewareHandler } from 'hono';
import { AppError } from './errors.ts';

export const CLIENT_HEADER = 'x-rg-client';

export function csrfGuard(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    if (c.req.header(CLIENT_HEADER) !== '1') throw new AppError('csrf_rejected', 'Missing client header');
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') throw new AppError('csrf_rejected', 'Cross-site request refused');
    const origin = c.req.header('origin');
    if (origin) {
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
      let originHost = '';
      try { originHost = new URL(origin).host; } catch { /* invalid origin */ }
      if (!host || originHost !== host) throw new AppError('csrf_rejected', 'Origin mismatch');
    }
    return next();
  };
}
