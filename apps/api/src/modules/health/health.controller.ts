import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { REDIS } from '../../common/tokens.js';
import { DbService } from '../../infra/db.service.js';
import { Public } from '../auth/index.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is up. */
  @Public()
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. Reveals nothing beyond up/down. */
  @Public()
  @Get('ready')
  async ready() {
    try {
      await this.db.raw.execute(sql`SELECT 1`);
      await this.redis.ping();
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
