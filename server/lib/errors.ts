import { ERROR_CODES, type ErrorCode } from '../../shared/errors.ts';

/** Throw anywhere in a handler or domain function; the app turns it into JSON. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }
}

export const fail = (code: ErrorCode, message?: string, details?: unknown): never => {
  throw new AppError(code, message, details);
};

export function assertFound<T>(value: T | undefined | null, what = 'record'): T {
  if (value === undefined || value === null) throw new AppError('not_found', `${what} not found`);
  return value;
}

/** Throw stale_version with the current state so the client can refresh and explain. */
export function staleVersion(current?: unknown): never {
  throw new AppError('stale_version', 'This was changed on another device. Showing the latest version.', { current });
}
