import { type ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Permission, RoleGrant } from '@crm/domain';
import type { RequestContext } from '@crm/db';

export interface Grant extends RoleGrant {
  id: string;
  grantedAt: Date;
}

export interface AuthenticatedUser {
  id: string;
  displayName: string;
  email: string;
  grants: Grant[];
  permissions: ReadonlySet<Permission>;
  breakGlassUntil: Date | null;
}

/** Server-side session (stored in Redis, keyed by the SHA-256 of the cookie value). */
export interface SessionData {
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  authTime: string;
  amr: string[];
  acr: string | null;
  csrfToken: string;
  idToken: string | null;
  userAgent: string | null;
}

export interface Session extends SessionData {
  idHash: string;
  idleExpiresAt: string;
}

/** Everything known about the caller of the current request. */
export interface Ctx {
  requestId: string;
  ipHash: string;
  userAgent: string | null;
  user: AuthenticatedUser | null;
  session: Session | null;
}

export interface AuthedCtx extends Ctx {
  user: AuthenticatedUser;
  session: Session;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: Ctx;
  }
}

export function dbContext(ctx: Ctx): RequestContext {
  return { userId: ctx.user?.id ?? null, requestId: ctx.requestId, ipHash: ctx.ipHash };
}

/** Injects the request context. Only use on routes behind the auth guard. */
export const CurrentCtx = createParamDecorator(
  (_data: unknown, exec: ExecutionContext): AuthedCtx => {
    const req = exec.switchToHttp().getRequest<FastifyRequest>();
    if (!req.ctx?.user || !req.ctx.session)
      throw new Error('CurrentCtx used on an unauthenticated route');
    return req.ctx as AuthedCtx;
  },
);
