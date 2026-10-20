import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Clock, Permission } from '@crm/domain';
import { safeEqual } from '@crm/platform';
import { Forbidden, StepUpRequired, Unauthorized } from '../../common/errors.js';
import { CLOCK } from '../../common/tokens.js';
import { ENV, type Env } from '../../config/env.js';
import { AuditService } from '../../infra/audit.service.js';
import { PERMISSIONS_KEY, PUBLIC, SKIP_CSRF, STEP_UP } from './decorators.js';
import { PrincipalService } from './principal.service.js';
import { SessionService } from './session.service.js';

export const SESSION_COOKIE = '__Host-sid';
export const DEV_SESSION_COOKIE = 'sid';

export function sessionCookieName(env: Env): string {
  // The __Host- prefix requires Secure; plain-HTTP dev (non-localhost) falls back.
  return env.COOKIE_SECURE ? SESSION_COOKIE : DEV_SESSION_COOKIE;
}

/** Global guard 1: resolves the session and principal. Everything is private by default. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly principals: PrincipalService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const cookie = req.cookies?.[sessionCookieName(this.env)];

    if (cookie) {
      const session = await this.sessions.load(cookie);
      if (session) {
        const user = await this.principals.load(session.userId, req.ctx);
        if (user) {
          req.ctx.session = session;
          req.ctx.user = user;
        } else {
          // Suspended / left / unknown: kill the session at once.
          await this.sessions.destroy(session.idHash, session.userId, 'USER_INACTIVE');
        }
      }
    }
    if (isPublic) return true;
    if (!req.ctx.user) throw Unauthorized();
    if (
      this.env.ADMIN_IP_ALLOWLIST.length > 0 &&
      req.ctx.user.grants.some((g) => IP_RESTRICTED_ROLES.has(g.role))
    ) {
      if (!this.env.ADMIN_IP_ALLOWLIST.includes(req.ip))
        throw Forbidden('Access from this network is not allowed for your role');
    }
    return true;
  }
}

/** Roles that may be restricted to an IP allowlist (brief §7.4). */
const IP_RESTRICTED_ROLES = new Set(['SUPER_ADMIN', 'FINANCE']);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard 2: CSRF protection for state-changing requests (synchronizer token in the
 * `x-csrf-token` header + Origin check), on top of SameSite=Strict cookies.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(req.method)) return true;
    if (
      this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;

    const origin = req.headers.origin;
    if (origin && origin !== this.env.PUBLIC_WEB_ORIGIN)
      throw Forbidden('Cross-origin request rejected');
    if (!req.ctx.session) return true; // unauthenticated state-changing routes are guarded by AuthGuard
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || !safeEqual(token, req.ctx.session.csrfToken)) {
      throw Forbidden('Missing or invalid CSRF token');
    }
    return true;
  }
}

/** Global guard 3: coarse RBAC from @Can(); object-level scope is enforced in services and RLS. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const user = req.ctx.user;
    if (!user) throw Unauthorized();
    const missing = required.filter((p) => !user.permissions.has(p));
    if (missing.length) {
      await this.audit.recordStandalone(req.ctx, {
        action: 'authz.denied',
        outcome: 'DENIED',
        details: { route: `${req.method} ${req.routeOptions.url}`, missing },
      });
      throw Forbidden();
    }
    return true;
  }
}

/** Global guard 4: re-authentication for sensitive actions. */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (
      !this.reflector.getAllAndOverride<boolean>(STEP_UP, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const session = context.switchToHttp().getRequest<FastifyRequest>().ctx.session;
    if (!session) throw Unauthorized();
    const age = (this.clock.now().getTime() - new Date(session.authTime).getTime()) / 1000;
    if (age > this.env.STEP_UP_MAX_AGE_SECONDS) throw StepUpRequired();
    return true;
  }
}
