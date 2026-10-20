import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { userSession } from '@crm/db';
import type { Clock } from '@crm/domain';
import { hashSessionId } from '@crm/platform';
import type { Ctx, Session, SessionData } from '../../common/context.js';
import { CLOCK, REDIS } from '../../common/tokens.js';
import { ENV, type Env } from '../../config/env.js';
import { DbService } from '../../infra/db.service.js';

const SESSION_PREFIX = 'sess:';
const USER_SESSIONS_PREFIX = 'user-sess:';
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/**
 * Server-side sessions (BFF pattern, ADR-002). The cookie holds 256 random bits; Redis and
 * the database only ever see its SHA-256. Idle expiry is the Redis TTL (refreshed on use);
 * absolute expiry is enforced on every load. identity.user_session mirrors sessions so users
 * can list/revoke them and the leaver process can revoke everything.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly db: DbService,
  ) {}

  private get idleMs(): number {
    return this.env.SESSION_IDLE_MINUTES * 60_000;
  }

  async create(
    ctx: Ctx,
    userId: string,
    auth: { authTime: Date; amr: string[]; acr: string | null; idToken: string | null },
  ): Promise<{ cookieValue: string; session: Session }> {
    const cookieValue = randomBytes(32).toString('base64url');
    const idHash = hashSessionId(cookieValue);
    const now = this.clock.now();
    const absolute = new Date(now.getTime() + this.env.SESSION_ABSOLUTE_HOURS * 3_600_000);
    const data: SessionData = {
      userId,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      absoluteExpiresAt: absolute.toISOString(),
      authTime: auth.authTime.toISOString(),
      amr: auth.amr,
      acr: auth.acr,
      csrfToken: randomBytes(32).toString('base64url'),
      idToken: auth.idToken,
      userAgent: ctx.userAgent,
    };
    await this.redis
      .multi()
      .set(SESSION_PREFIX + idHash, JSON.stringify(data), 'PX', this.idleMs)
      .sadd(USER_SESSIONS_PREFIX + userId, idHash)
      .pexpire(USER_SESSIONS_PREFIX + userId, this.env.SESSION_ABSOLUTE_HOURS * 3_600_000)
      .exec();

    await this.db.runAs(userId, ctx, (tx) =>
      tx.insert(userSession).values({
        id: idHash,
        userId,
        idleExpiresAt: new Date(now.getTime() + this.idleMs),
        absoluteExpiresAt: absolute,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
        ipHash: ctx.ipHash,
        amr: auth.amr,
      }),
    );
    return {
      cookieValue,
      session: {
        ...data,
        idHash,
        idleExpiresAt: new Date(now.getTime() + this.idleMs).toISOString(),
      },
    };
  }

  /** Loads and touches a session; returns null if missing, idle-expired or past absolute expiry. */
  async load(cookieValue: string): Promise<Session | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(cookieValue)) return null;
    const idHash = hashSessionId(cookieValue);
    const raw = await this.redis.get(SESSION_PREFIX + idHash);
    if (!raw) return null;
    const data = JSON.parse(raw) as SessionData;
    const now = this.clock.now();
    if (now >= new Date(data.absoluteExpiresAt)) {
      await this.destroy(idHash, data.userId, 'ABSOLUTE_TIMEOUT');
      return null;
    }
    const writeLastSeen =
      now.getTime() - new Date(data.lastSeenAt).getTime() > LAST_SEEN_WRITE_INTERVAL_MS;
    data.lastSeenAt = now.toISOString();
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + this.idleMs, new Date(data.absoluteExpiresAt).getTime()),
    );
    await this.redis.set(
      SESSION_PREFIX + idHash,
      JSON.stringify(data),
      'PX',
      idleExpiresAt.getTime() - now.getTime(),
    );
    if (writeLastSeen) {
      await this.db
        .runAs(data.userId, { requestId: 'session-touch', ipHash: '' }, (tx) =>
          tx
            .update(userSession)
            .set({ lastSeenAt: now, idleExpiresAt })
            .where(eq(userSession.id, idHash)),
        )
        .catch(() => undefined); // bookkeeping only; never fail a request on it
    }
    return { ...data, idHash, idleExpiresAt: idleExpiresAt.toISOString() };
  }

  async destroy(idHash: string, userId: string, reason: string, ctx?: Ctx): Promise<void> {
    await this.redis
      .multi()
      .del(SESSION_PREFIX + idHash)
      .srem(USER_SESSIONS_PREFIX + userId, idHash)
      .exec();
    await this.db.runAs(
      ctx?.user?.id ?? userId,
      ctx ?? { requestId: 'session-destroy', ipHash: '' },
      (tx) =>
        tx
          .update(userSession)
          .set({ revokedAt: this.clock.now(), revokedReason: reason })
          .where(and(eq(userSession.id, idHash), isNull(userSession.revokedAt))),
    );
  }

  /** Revokes every session of a user (logout-all, leaver process, suspension). */
  async destroyAllForUser(ctx: Ctx, userId: string, reason: string): Promise<number> {
    const hashes = await this.redis.smembers(USER_SESSIONS_PREFIX + userId);
    const pipeline = this.redis.multi();
    for (const h of hashes) pipeline.del(SESSION_PREFIX + h);
    pipeline.del(USER_SESSIONS_PREFIX + userId);
    await pipeline.exec();
    await this.db.run(ctx, (tx) =>
      tx
        .update(userSession)
        .set({ revokedAt: this.clock.now(), revokedReason: reason })
        .where(and(eq(userSession.userId, userId), isNull(userSession.revokedAt))),
    );
    return hashes.length;
  }

  async listActive(ctx: Ctx, userId: string) {
    const now = this.clock.now();
    return this.db.run(ctx, (tx) =>
      tx
        .select()
        .from(userSession)
        .where(
          and(
            eq(userSession.userId, userId),
            isNull(userSession.revokedAt),
            gt(userSession.absoluteExpiresAt, now),
            gt(userSession.idleExpiresAt, now),
          ),
        ),
    );
  }
}
