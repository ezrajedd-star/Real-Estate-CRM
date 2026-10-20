import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '@crm/platform';
import { LOGGER } from './tokens.js';
import { pgCode } from './errors.js';

/**
 * Uniform error envelope. Unexpected errors become a generic 500 — no stack traces, SQL,
 * or values ever reach the client; the redacted detail goes to the log with the request id.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = req.ctx?.requestId ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: { code: string; message: string; details?: unknown } = {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Quote the request id if you contact support.',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null && 'code' in res) {
        body = res as typeof body;
      } else {
        body = {
          code: statusCode(status),
          message: status >= 500 ? body.message : exception.message,
        };
      }
    } else if (pgCode(exception) === '42501') {
      // insufficient_privilege / RLS violation: the policy layer should have caught this first.
      status = HttpStatus.FORBIDDEN;
      body = { code: 'FORBIDDEN', message: 'You do not have permission to do this' };
    } else if (pgCode(exception) === '40001' || pgCode(exception) === '40P01') {
      status = HttpStatus.CONFLICT;
      body = { code: 'RETRY', message: 'The record was changed concurrently, please retry' };
    } else if ((exception as { statusCode?: number })?.statusCode === 413) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;
      body = { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
    }

    if (status >= 500) {
      this.log.error({ err: exception, requestId }, 'unhandled error');
    } else if (status === 403 || pgCode(exception)) {
      this.log.warn({ requestId, code: body.code, pg: pgCode(exception) }, 'request denied');
    }

    void reply.status(status).send({ error: { ...body, requestId } });
  }
}

function statusCode(status: number): string {
  return (
    {
      400: 'BAD_REQUEST',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      405: 'METHOD_NOT_ALLOWED',
      409: 'CONFLICT',
      413: 'PAYLOAD_TOO_LARGE',
      415: 'UNSUPPORTED_MEDIA_TYPE',
      429: 'RATE_LIMITED',
    }[status] ?? 'ERROR'
  );
}
