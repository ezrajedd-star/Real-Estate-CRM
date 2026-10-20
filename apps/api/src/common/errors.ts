import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Domain-level HTTP errors with a stable machine-readable `code`. Messages are written for
 * end users and must never include PII or internal identifiers beyond the request id.
 */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super({ code, message, details }, status);
  }
}

export const NotFound = (what = 'Resource') =>
  new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);
export const Forbidden = (message = 'You do not have permission to do this') =>
  new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);
export const Unauthorized = (code = 'UNAUTHENTICATED', message = 'Please sign in') =>
  new AppError(HttpStatus.UNAUTHORIZED, code, message);
export const Conflict = (code: string, message: string) =>
  new AppError(HttpStatus.CONFLICT, code, message);
export const BadRequest = (
  code: string,
  message: string,
  details?: Array<{ path: string; message: string }>,
) => new AppError(HttpStatus.BAD_REQUEST, code, message, details);
export const StepUpRequired = () =>
  new AppError(
    HttpStatus.UNAUTHORIZED,
    'STEP_UP_REQUIRED',
    'Please confirm your identity again to continue',
  );
export const TooManyRequests = () =>
  new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many requests, please slow down');

/** Postgres error codes we translate into user-facing errors. */
export function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

export function pgConstraint(err: unknown): string | undefined {
  const e = err as { constraint?: string; cause?: { constraint?: string } };
  return e?.constraint ?? e?.cause?.constraint;
}
