import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { TooManyRequests } from '../common/errors.js';
import { REDIS } from '../common/tokens.js';

export interface RateLimitRule {
  /** Bucket name, e.g. `auth`, `search`, `reveal`, `export`, `file`. */
  bucket: string;
  /** Max requests per window, applied separately per IP and per account. */
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT = 'rateLimit';
export const RateLimit = (rule: RateLimitRule) => SetMetadata(RATE_LIMIT, rule);

/** Default for every route without an explicit rule. */
const DEFAULT_RULE: RateLimitRule = { bucket: 'default', limit: 300, windowSeconds: 60 };

/**
 * Fixed-window rate limiting in Redis, keyed by IP hash and by user (brief §8.2). Shared
 * across API instances. Runs after authentication so account limits apply.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule =
      this.reflector.getAllAndOverride<RateLimitRule>(RATE_LIMIT, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_RULE;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const window = Math.floor(Date.now() / 1000 / rule.windowSeconds);
    const keys = [`rl:${rule.bucket}:ip:${req.ctx.ipHash}:${window}`];
    if (req.ctx.user) keys.push(`rl:${rule.bucket}:user:${req.ctx.user.id}:${window}`);

    const pipeline = this.redis.multi();
    for (const k of keys) pipeline.incr(k).expire(k, rule.windowSeconds + 1);
    const results = (await pipeline.exec()) ?? [];
    const counts = results.filter((_, i) => i % 2 === 0).map(([, v]) => Number(v));
    if (counts.some((c) => c > rule.limit)) throw TooManyRequests();
    return true;
  }
}
