// Request helpers for Hono handlers.
import type { Context } from 'hono';
import type { z } from 'zod';
import { createHash } from 'node:crypto';
import { AppError } from './errors.ts';
import { config } from '../config.ts';

/** Parse and validate a JSON body with a shared zod schema. */
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError('bad_request', 'Expected a JSON body');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('validation_failed', 'Some fields are not valid', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    });
  }
  return parsed.data;
}

/** Validate query-string parameters. */
export function query<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AppError('validation_failed', 'Some query parameters are not valid', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

let warnedProxy = false;

/** Client IP honouring TRUST_PROXY_HOPS (Nth address from the right of X-Forwarded-For). */
export function clientIp(c: Context): string {
  const hops = config.trustProxyHops;
  if (hops === 0 && !warnedProxy && c.req.header('x-forwarded-for')) {
    // Behind a proxy with TRUST_PROXY_HOPS=0 every client shares the proxy's address,
    // so one busy table or one guesser can use up everybody's rate limits.
    warnedProxy = true;
    console.warn('[server] WARNING: requests arrive through a proxy (X-Forwarded-For) but TRUST_PROXY_HOPS=0: rate limits treat every client as one address. Set TRUST_PROXY_HOPS to the number of proxies.');
  }
  if (hops > 0) {
    const xff = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const candidate = xff[xff.length - hops];
    if (candidate) return candidate;
  }
  // @hono/node-server exposes the raw Node request on c.env.incoming
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable hash of a JSON-able payload (key order independent). */
export function payloadHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export const noStore = { 'Cache-Control': 'no-store' } as const;
