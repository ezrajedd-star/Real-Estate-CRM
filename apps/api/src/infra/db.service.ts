import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { type Database, type DbHandle, type Tx, withContext } from '@crm/db';
import { type Ctx, dbContext } from '../common/context.js';
import { DB } from '../common/tokens.js';

/**
 * The only way the API touches the database. Every call runs in a transaction bound to the
 * caller via `app.*` settings, so Postgres RLS sees exactly who is asking (ADR-003).
 */
@Injectable()
export class DbService implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly handle: DbHandle) {}

  /** Unscoped access — only for tables readable without a user (e.g. crypto.data_key). */
  get raw(): Database {
    return this.handle.db;
  }

  run<T>(ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withContext(this.handle.db, dbContext(ctx), fn);
  }

  /**
   * Runs as a specific user id before the request context has a loaded user (login,
   * session bookkeeping). RLS still applies to that user.
   */
  runAs<T>(
    userId: string | null,
    base: Pick<Ctx, 'requestId' | 'ipHash'>,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return withContext(
      this.handle.db,
      { userId, requestId: base.requestId, ipHash: base.ipHash },
      fn,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}
