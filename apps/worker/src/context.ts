import { randomUUID } from 'node:crypto';
import { type Database, SYSTEM_USER_ID, type Tx, withContext } from '@crm/db';

/**
 * Worker jobs act as the well-known system user over the `app_worker` DB role. The audit
 * trigger records them as actor_type SYSTEM (derived from the DB role, not a setting).
 */
export function asSystem<T>(db: Database, job: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withContext(
    db,
    { userId: SYSTEM_USER_ID, requestId: `job:${job}:${randomUUID()}`, ipHash: null },
    fn,
  );
}
