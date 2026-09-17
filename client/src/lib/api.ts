// JSON API client. Every mutation carries X-RG-Client (CSRF guard) and is
// same-origin with cookies. Errors surface as ApiError with a stable code.
import type { ErrorCode } from '../../../shared/errors.ts';

export type ClientErrorCode = ErrorCode | 'network_error' | 'timeout' | 'aborted';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly details: unknown;
  constructor(code: ClientErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
  /** The request may or may not have reached the server. */
  get ambiguous(): boolean {
    return this.code === 'network_error' || this.code === 'timeout' || this.status >= 502;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('timeout'), opts.timeoutMs ?? 15_000);
  const onAbort = () => controller.abort('aborted');
  opts.signal?.addEventListener('abort', onAbort);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-RG-Client': '1' } : {}),
        ...opts.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch {
    const reason = controller.signal.reason;
    if (reason === 'timeout') throw new ApiError('timeout', 0, 'The request timed out.');
    if (reason === 'aborted') throw new ApiError('aborted', 0, 'The request was cancelled.');
    throw new ApiError('network_error', 0, 'Could not reach the restaurant server.');
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: ClientErrorCode; message?: string; details?: unknown } } | null)?.error;
    if (!err && res.status >= 502) throw new ApiError('network_error', res.status, 'The restaurant server is not reachable.');
    throw new ApiError(err?.code ?? 'internal', res.status, err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body: unknown = {}, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  patch: <T>(path: string, body: unknown = {}, opts?: RequestOptions) => request<T>('PATCH', path, body, opts),
  put: <T>(path: string, body: unknown = {}, opts?: RequestOptions) => request<T>('PUT', path, body, opts),
  del: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('DELETE', path, body, opts),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    q.set(k, String(typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
