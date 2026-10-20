import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Clock } from '@crm/domain';
import type { Logger } from '@crm/platform';
import { type AuthedCtx, CurrentCtx } from '../../common/context.js';
import { NotFound } from '../../common/errors.js';
import { CLOCK, LOGGER, REDIS } from '../../common/tokens.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { ENV, type Env } from '../../config/env.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';
import { RateLimit } from '../../infra/rate-limit.js';
import { Public, SkipCsrf } from './decorators.js';
import { sessionCookieName } from './guards.js';
import { OidcProvider, isMultiFactor } from './oidc.provider.js';
import { SessionService } from './session.service.js';

const LOGIN_STATE_COOKIE = 'login_state';
const LOGIN_TTL_SECONDS = 600;
const FAILED_LOGIN_ALERT_THRESHOLD = 5;

const LoginQuery = z.object({
  // Only same-origin relative paths: blocks open redirects (`//evil`, `/\evil`, absolute URLs).
  returnTo: z
    .string()
    .max(500)
    .regex(/^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@/%?]*$/)
    .optional()
    .catch(undefined),
  stepUp: z.enum(['1', '0']).optional(),
});

interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  stepUp: boolean;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly oidc: OidcProvider,
    private readonly sessions: SessionService,
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /** Starts the OIDC code+PKCE flow. */
  @Public()
  @Get('login')
  @RateLimit({ bucket: 'auth', limit: 20, windowSeconds: 60 })
  async login(
    @Query(new ZodPipe(LoginQuery)) q: z.infer<typeof LoginQuery>,
    @Res() reply: FastifyReply,
  ) {
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const pending: PendingLogin = {
      codeVerifier,
      nonce,
      returnTo: q.returnTo ?? '/',
      stepUp: q.stepUp === '1',
    };
    await this.redis.set(`login:${state}`, JSON.stringify(pending), 'EX', LOGIN_TTL_SECONDS);
    const url = await this.oidc.authorizationUrl({
      state,
      nonce,
      codeChallenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      stepUp: pending.stepUp,
    });
    // Binds the flow to this browser (login CSRF). Lax: the IdP redirect back is a top-level navigation.
    void reply
      .setCookie(LOGIN_STATE_COOKIE, state, {
        httpOnly: true,
        secure: this.env.COOKIE_SECURE,
        sameSite: 'lax',
        path: '/api/v1/auth/callback',
        maxAge: LOGIN_TTL_SECONDS,
      })
      .redirect(url.toString(), 302);
  }

  /** IdP redirect target: verifies state/PKCE/nonce, enforces MFA, creates the session. */
  @Public()
  @SkipCsrf()
  @Get('callback')
  @RateLimit({ bucket: 'auth', limit: 20, windowSeconds: 60 })
  async callback(@Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const query = req.query as Record<string, string | undefined>;
    const cookieState = req.cookies?.[LOGIN_STATE_COOKIE];
    void reply.clearCookie(LOGIN_STATE_COOKIE, { path: '/api/v1/auth/callback' });

    const fail = async (reason: string, status = 400) => {
      await this.audit.recordStandalone(req.ctx, {
        action: 'auth.login',
        outcome: 'FAILURE',
        details: { reason },
      });
      await this.countFailure(req);
      return reply
        .status(status)
        .type('text/html; charset=utf-8')
        .send(redirectPage(`/login?error=${encodeURIComponent(reason)}`));
    };

    if (query.error) return fail('IDP_ERROR');
    if (!query.state || !cookieState || query.state !== cookieState) return fail('STATE_MISMATCH');
    const raw = await this.redis.getdel(`login:${query.state}`);
    if (!raw) return fail('LOGIN_EXPIRED');
    const pending = JSON.parse(raw) as PendingLogin;

    let identity;
    try {
      const callbackUrl = new URL(`${this.env.API_BASE_URL}/auth/callback`);
      for (const [k, v] of Object.entries(query))
        if (v !== undefined) callbackUrl.searchParams.set(k, v);
      identity = await this.oidc.exchange(callbackUrl, {
        state: query.state,
        nonce: pending.nonce,
        codeVerifier: pending.codeVerifier,
        maxAge: pending.stepUp ? this.env.STEP_UP_MAX_AGE_SECONDS : undefined,
      });
    } catch (err) {
      this.log.warn({ err }, 'oidc code exchange failed');
      return fail('EXCHANGE_FAILED');
    }

    if (!isMultiFactor(identity, this.env.OIDC_MFA_ACR_VALUES)) return fail('MFA_REQUIRED', 403);
    if (!identity.email) return fail('NO_EMAIL');

    const upsert = await this.db.runAs(null, req.ctx, (tx) =>
      tx.execute<{ user_id: string; status: string }>(
        sql`SELECT user_id, status FROM identity.upsert_login(${identity.sub}, ${identity.email}, ${identity.name})`,
      ),
    );
    const row = upsert.rows[0];
    if (!row) return fail('PROVISIONING_FAILED', 500);
    if (row.status !== 'ACTIVE') return fail('ACCOUNT_INACTIVE', 403);

    // Rotate: any session this browser already had is replaced (session fixation defence).
    const previous = req.ctx.session;
    if (previous)
      await this.sessions.destroy(previous.idHash, previous.userId, 'REPLACED_BY_LOGIN');

    const { cookieValue } = await this.sessions.create(req.ctx, row.user_id, identity);
    await this.db.runAs(row.user_id, req.ctx, (tx) =>
      this.audit.record(tx, {
        action: pending.stepUp ? 'auth.step_up' : 'auth.login',
        details: { amr: identity.amr, acr: identity.acr },
      }),
    );

    void reply.setCookie(sessionCookieName(this.env), cookieValue, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/',
    });
    // An HTML hop (not a 302) so the next request is a same-site navigation and the
    // SameSite=Strict session cookie is sent.
    return reply.type('text/html; charset=utf-8').send(redirectPage(pending.returnTo));
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentCtx() ctx: AuthedCtx, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.sessions.destroy(ctx.session.idHash, ctx.user.id, 'LOGOUT', ctx);
    await this.audit.recordStandalone(ctx, { action: 'auth.logout' });
    void reply.clearCookie(sessionCookieName(this.env), { path: '/' });
    const endSession = await this.oidc
      .endSessionUrl(ctx.session.idToken, `${this.env.PUBLIC_WEB_ORIGIN}/login?signedOut=1`)
      .catch(() => null);
    return { endSessionUrl: endSession?.toString() ?? null };
  }

  @Get('me')
  me(@CurrentCtx() ctx: AuthedCtx) {
    return {
      id: ctx.user.id,
      displayName: ctx.user.displayName,
      email: ctx.user.email,
      grants: ctx.user.grants.map((g) => ({ ...g, grantedAt: g.grantedAt.toISOString() })),
      permissions: [...ctx.user.permissions].sort(),
      csrfToken: ctx.session.csrfToken,
      session: {
        idleExpiresAt: ctx.session.idleExpiresAt,
        absoluteExpiresAt: ctx.session.absoluteExpiresAt,
        authTime: ctx.session.authTime,
        amr: ctx.session.amr,
      },
      breakGlassUntil: ctx.user.breakGlassUntil?.toISOString() ?? null,
    };
  }

  @Get('sessions')
  async listSessions(@CurrentCtx() ctx: AuthedCtx) {
    const rows = await this.sessions.listActive(ctx, ctx.user.id);
    return rows.map((r) => ({
      id: r.id.slice(0, 16),
      current: r.id === ctx.session.idHash,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      userAgent: r.userAgent,
      absoluteExpiresAt: r.absoluteExpiresAt.toISOString(),
    }));
  }

  /** Revoke one of my sessions (by the 16-char prefix shown in the list). */
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeSession(@CurrentCtx() ctx: AuthedCtx, @Param('id') id: string) {
    if (!/^[0-9a-f]{16}$/.test(id)) throw NotFound('Session');
    const rows = await this.sessions.listActive(ctx, ctx.user.id);
    const target = rows.find((r) => r.id.startsWith(id));
    if (!target) throw NotFound('Session');
    await this.sessions.destroy(target.id, ctx.user.id, 'USER_REVOKED', ctx);
    await this.audit.recordStandalone(ctx, {
      action: 'auth.session_revoked',
      subjectType: 'session',
      subjectId: id,
    });
  }

  /** Counts failures per IP hash; a burst raises a security alert (brief §8.7). */
  private async countFailure(req: FastifyRequest): Promise<void> {
    const key = `auth-fail:${req.ctx.ipHash}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 600);
    if (n === FAILED_LOGIN_ALERT_THRESHOLD) {
      await this.audit.alertStandalone(req.ctx, {
        kind: 'FAILED_LOGIN_BURST',
        severity: 'HIGH',
        details: { ipHash: req.ctx.ipHash, failuresIn10Min: n, at: this.clock.now().toISOString() },
      });
    }
  }
}

/** Minimal same-origin redirect page. `target` is validated relative path or a fixed route. */
function redirectPage(target: string): string {
  const safe = target.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/%?]/g, '');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>Signing in…</title><p>Continue to <a href="${safe}">the application</a>.</p>`;
}
