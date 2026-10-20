import { sql } from 'drizzle-orm';
import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Who is acting, for RLS and the audit trigger. `userId: null` means unauthenticated
 * (login flow) — RLS then hides every protected row.
 */
export interface RequestContext {
  userId: string | null;
  requestId: string;
  ipHash?: string | null;
}

export interface DbHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    // A runaway query must not hold a pooled connection (and its transaction) forever.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/**
 * Runs `fn` inside a transaction whose first statement binds the request context with
 * `set_config(..., is_local => true)`. The settings vanish at COMMIT/ROLLBACK, so a pooled
 * connection can never carry one user's identity into another request. Every data access
 * in the API goes through here (ADR-003).
 */
export async function withContext<T>(
  db: Database,
  ctx: RequestContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.user_id', ${ctx.userId ?? ''}, true),
                 set_config('app.request_id', ${ctx.requestId}, true),
                 set_config('app.ip_hash', ${ctx.ipHash ?? ''}, true)`,
    );
    return fn(tx);
  });
}

/** The worker's well-known system user (see migration 0002). */
export const SYSTEM_USER_ID = '00000000-0000-7000-8000-000000000001';
