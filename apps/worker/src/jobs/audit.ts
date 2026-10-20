import { asc, eq, gt, sql } from 'drizzle-orm';
import { type Database, auditLog, securityAlert, shipCursor } from '@crm/db';
import type { Logger } from '@crm/platform';
import { asSystem } from '../context.js';
import type { ObjectStore } from '../storage.js';

export interface AuditDeps {
  db: Database;
  /** Store backed by the write-once (S3 Object Lock, compliance mode) audit bucket. */
  auditStore: ObjectStore;
  log: Logger;
}

const BATCH = 5000;

/**
 * Ships new audit rows to write-once storage as JSON Lines, one object per batch, keyed by
 * date and sequence range. The cursor only advances after the object is written, so a
 * crash re-ships a batch (identical content, same key) rather than skipping one.
 */
export async function shipAuditLog(
  deps: AuditDeps,
): Promise<{ shipped: number; key: string | null }> {
  return asSystem(deps.db, 'audit-ship', async (tx) => {
    const [cursor] = await tx.select().from(shipCursor).where(eq(shipCursor.id, 1)).for('update');
    const fromSeq = cursor?.lastSeq ?? 0;
    const rows = await tx
      .select()
      .from(auditLog)
      .where(gt(auditLog.seq, fromSeq))
      .orderBy(asc(auditLog.seq))
      .limit(BATCH);
    if (!rows.length) return { shipped: 0, key: null };

    if (cursor?.lastHash && rows[0]!.prevHash !== cursor.lastHash) {
      // The live chain no longer continues from what we shipped: tampering or truncation.
      await tx.insert(securityAlert).values({
        kind: 'AUDIT_CHAIN_BROKEN',
        severity: 'CRITICAL',
        details: {
          atSeq: rows[0]!.seq,
          reason: 'first unshipped row does not chain to the last shipped hash',
        },
      });
      throw new Error('Audit chain discontinuity detected while shipping');
    }

    const first = rows[0]!.seq;
    const last = rows[rows.length - 1]!;
    const day = last.occurredAt.toISOString().slice(0, 10).replace(/-/g, '/');
    const key = `audit/${day}/${String(first).padStart(12, '0')}-${String(last.seq).padStart(12, '0')}.jsonl`;
    const body =
      rows.map((r) => JSON.stringify({ ...r, occurredAt: r.occurredAt.toISOString() })).join('\n') +
      '\n';
    await deps.auditStore.put(key, Buffer.from(body), 'application/x-ndjson');
    await tx
      .update(shipCursor)
      .set({ lastSeq: last.seq, lastHash: last.hash, lastObjectKey: key, updatedAt: new Date() })
      .where(eq(shipCursor.id, 1));
    deps.log.info({ shipped: rows.length, key }, 'audit batch shipped');
    return { shipped: rows.length, key };
  });
}

/** Recomputes the hash chain in the database; raises a CRITICAL alert on any break. */
export async function verifyAuditChain(
  deps: AuditDeps,
): Promise<{ intact: boolean; brokenSeq?: number }> {
  return asSystem(deps.db, 'audit-verify', async (tx) => {
    const res = await tx.execute<{ broken_seq: string; problem: string }>(
      sql`SELECT * FROM audit.verify_chain()`,
    );
    const broken = res.rows[0];
    if (!broken) return { intact: true };
    await tx.insert(securityAlert).values({
      kind: 'AUDIT_CHAIN_BROKEN',
      severity: 'CRITICAL',
      details: { brokenSeq: Number(broken.broken_seq), problem: broken.problem },
    });
    deps.log.error(
      { brokenSeq: broken.broken_seq, problem: broken.problem },
      'audit chain verification failed',
    );
    return { intact: false, brokenSeq: Number(broken.broken_seq) };
  });
}
