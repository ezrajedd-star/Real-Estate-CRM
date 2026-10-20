import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import sharp from 'sharp';
import { type Database, auditLog, document, securityAlert } from '@crm/db';
import type { Logger } from '@crm/platform';
import { asSystem } from '../context.js';
import type { MalwareScanner } from '../scanning/clamd.js';
import type { ObjectStore } from '../storage.js';

export interface ScanDeps {
  db: Database;
  store: ObjectStore;
  scanner: MalwareScanner;
  log: Logger;
}

const quarantineKey = (id: string) => `quarantine/${id}`;
const cleanKey = (id: string) => `clean/${id}`;

/** Declared type → MIME types the file's magic bytes may legitimately report. */
const MAGIC_MATCH: Record<string, string[]> = {
  'application/pdf': ['application/pdf'],
  'image/jpeg': ['image/jpeg'],
  'image/png': ['image/png'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
};

export type ScanOutcome = 'CLEAN' | 'INFECTED' | 'REJECTED' | 'SKIPPED';

/**
 * Promotes a quarantined upload to clean storage, or rejects it (ADR-006):
 *   1. magic bytes must match the declared, allow-listed type;
 *   2. ClamAV must report it clean (scanner errors are retried, never treated as clean);
 *   3. images are re-encoded, which strips EXIF/GPS and other metadata;
 *   4. the result is stored under clean/ with SSE, and the quarantine copy is deleted.
 * Idempotent: a document that is no longer QUARANTINED is skipped.
 */
export async function scanDocument(deps: ScanDeps, documentId: string): Promise<ScanOutcome> {
  const doc = await asSystem(deps.db, 'scan', async (tx) => {
    const [row] = await tx.select().from(document).where(eq(document.id, documentId));
    return row;
  });
  if (!doc || doc.status !== 'QUARANTINED') return 'SKIPPED';

  const bytes = await deps.store.get(quarantineKey(documentId));
  const finish = async (
    status: 'CLEAN' | 'INFECTED' | 'REJECTED',
    detail: string | null,
    sha256: string | null,
  ) => {
    await asSystem(deps.db, 'scan', async (tx) => {
      await tx
        .update(document)
        .set({ status, scanDetail: detail, scannedAt: new Date(), sha256 })
        .where(and(eq(document.id, documentId), eq(document.status, 'QUARANTINED')));
      await tx.insert(auditLog).values({
        action: 'document.scanned',
        subjectType: 'document',
        subjectId: documentId,
        outcome: status === 'CLEAN' ? 'SUCCESS' : 'FAILURE',
        details: { status },
      });
      if (status === 'INFECTED') {
        await tx.insert(securityAlert).values({
          kind: 'MALWARE_UPLOAD',
          severity: 'HIGH',
          subjectUserId: doc.uploadedBy,
          details: { documentId, signature: detail },
        });
      }
    });
  };

  if (bytes.length !== doc.sizeBytes) {
    await deps.store.delete(quarantineKey(documentId));
    await finish('REJECTED', 'Size does not match the declared size', null);
    return 'REJECTED';
  }

  const detected = await fileTypeFromBuffer(bytes);
  const allowed = MAGIC_MATCH[doc.contentType] ?? [];
  if (!detected || !allowed.includes(detected.mime)) {
    await deps.store.delete(quarantineKey(documentId));
    await finish(
      'REJECTED',
      `Content does not match declared type (${detected?.mime ?? 'unknown'})`,
      null,
    );
    return 'REJECTED';
  }

  const result = await deps.scanner.scan(bytes); // throws → BullMQ retries with backoff
  if (!result.clean) {
    await deps.store.delete(quarantineKey(documentId));
    await finish('INFECTED', result.signature, null);
    deps.log.warn({ documentId, signature: result.signature }, 'malware detected in upload');
    return 'INFECTED';
  }

  const output = await stripMetadata(bytes, detected.mime);
  const sha256 = createHash('sha256').update(output).digest('hex');
  await deps.store.put(cleanKey(documentId), output, doc.contentType);
  await deps.store.delete(quarantineKey(documentId));
  await finish('CLEAN', null, sha256);
  return 'CLEAN';
}

/** Re-encodes images without metadata (EXIF, GPS, XMP, ICC beyond sRGB). */
export async function stripMetadata(bytes: Buffer, mime: string): Promise<Buffer> {
  if (mime === 'image/jpeg') return sharp(bytes).rotate().jpeg({ quality: 90 }).toBuffer();
  if (mime === 'image/png') return sharp(bytes).png().toBuffer();
  return bytes;
}
