import { Global, Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createDb } from '@crm/db';
import { type Clock, systemClock } from '@crm/domain';
import { DbKeyStore, FieldCipher, createLogger, keyProviderFromEnv } from '@crm/platform';
import { CIPHER, CLOCK, DB, LOGGER, REDIS } from '../common/tokens.js';
import { ENV, type Env, loadEnv } from '../config/env.js';
import { AuditService } from './audit.service.js';
import { DbService } from './db.service.js';
import { RateLimitGuard } from './rate-limit.js';
import { StorageService } from './storage.service.js';

export const SCAN_QUEUE = Symbol('SCAN_QUEUE');
export const SCAN_QUEUE_NAME = 'document-scan';

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    { provide: LOGGER, useFactory: () => createLogger({ name: 'api' }) },
    { provide: CLOCK, useValue: systemClock satisfies Clock },
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) =>
        new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: false }),
    },
    {
      provide: DB,
      inject: [ENV],
      useFactory: (env: Env) => createDb(env.DATABASE_URL_APP, { max: 20 }),
    },
    {
      provide: CIPHER,
      inject: [DbService, ENV],
      useFactory: (db: DbService, env: Env) =>
        new FieldCipher(
          keyProviderFromEnv({ ...process.env, NODE_ENV: env.NODE_ENV }),
          new DbKeyStore(db.raw),
        ),
    },
    {
      provide: SCAN_QUEUE,
      inject: [ENV],
      useFactory: (env: Env) =>
        new Queue(SCAN_QUEUE_NAME, {
          connection: { url: env.REDIS_URL },
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 1000,
          },
        }),
    },
    DbService,
    AuditService,
    StorageService,
    RateLimitGuard,
  ],
  exports: [
    ENV,
    LOGGER,
    CLOCK,
    REDIS,
    DB,
    CIPHER,
    SCAN_QUEUE,
    DbService,
    AuditService,
    StorageService,
    RateLimitGuard,
  ],
})
export class InfraModule {}
