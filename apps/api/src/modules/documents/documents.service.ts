import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, desc, eq } from 'drizzle-orm';
import { document, uuidv7 } from '@crm/db';
import { SENSITIVE_CATEGORIES } from '@crm/contracts';
import type { InitiateUploadRequest } from '@crm/contracts';
import { type Clock, canAccess } from '@crm/domain';
import type { z } from 'zod';
import type { AuthedCtx } from '../../common/context.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../common/errors.js';
import { CLOCK } from '../../common/tokens.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';
import { SCAN_QUEUE } from '../../infra/infra.module.js';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  StorageService,
  UPLOAD_URL_TTL_SECONDS,
} from '../../infra/storage.service.js';
import { assertCompanyAccess } from '../contacts/index.js';

type DocumentRow = typeof document.$inferSelect;

/**
 * Document lifecycle (ADR-006): PENDING_UPLOAD → (client PUTs to quarantine) → QUARANTINED
 * → worker scans, checks magic bytes, strips metadata → CLEAN (or INFECTED/REJECTED).
 * Only CLEAN documents can be downloaded, via a ≤5-minute presigned URL, and every URL
 * issued is audited.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    @Inject(SCAN_QUEUE) private readonly scanQueue: Queue,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async initiateUpload(ctx: AuthedCtx, input: z.infer<typeof InitiateUploadRequest>) {
    const classification = SENSITIVE_CATEGORIES.includes(input.category)
      ? 'SENSITIVE'
      : input.classification;
    const id = uuidv7();
    const key = StorageService.quarantineKey(id);
    await this.db.run(ctx, async (tx) => {
      if (input.companyId) await assertCompanyAccess(tx, ctx, input.companyId, 'document.upload');
      await tx.insert(document).values({
        id,
        companyId: input.companyId ?? null,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        category: input.category,
        classification,
        originalName: input.originalName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        storageKey: key,
        uploadedBy: ctx.user.id,
      });
      await this.audit.record(tx, {
        action: 'document.upload_started',
        subjectType: 'document',
        subjectId: id,
        details: { category: input.category },
      });
    });
    const url = await this.storage.presignUpload(key, input.contentType, input.sizeBytes);
    return {
      documentId: id,
      uploadUrl: url,
      method: 'PUT' as const,
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(this.clock.now().getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** Client confirms the PUT finished; we verify the object and queue the malware scan. */
  async completeUpload(ctx: AuthedCtx, id: string) {
    const doc = await this.db.run(ctx, async (tx) => {
      const [row] = await tx.select().from(document).where(eq(document.id, id));
      if (!row || row.uploadedBy !== ctx.user.id) throw NotFound('Document');
      if (row.status !== 'PENDING_UPLOAD')
        throw Conflict('ALREADY_COMPLETED', 'This upload was already completed');
      return row;
    });
    const head = await this.storage.head(doc.storageKey);
    const status = head && head.size === doc.sizeBytes ? 'QUARANTINED' : 'REJECTED';
    await this.db.run(ctx, async (tx) => {
      await tx
        .update(document)
        .set({
          status,
          scanDetail: status === 'REJECTED' ? 'Uploaded object missing or size mismatch' : null,
        })
        .where(and(eq(document.id, id), eq(document.status, 'PENDING_UPLOAD')));
      await this.audit.record(tx, {
        action: 'document.uploaded',
        subjectType: 'document',
        subjectId: id,
        outcome: status === 'QUARANTINED' ? 'SUCCESS' : 'FAILURE',
      });
    });
    if (status === 'REJECTED')
      throw BadRequest(
        'UPLOAD_INCOMPLETE',
        'The file did not arrive intact. Please upload it again.',
      );
    // jobId = document id → enqueueing twice is a no-op (idempotent).
    await this.scanQueue.add('scan', { documentId: id }, { jobId: id });
    return this.get(ctx, id);
  }

  async get(ctx: AuthedCtx, id: string) {
    return this.db.run(ctx, async (tx) => {
      const [row] = await tx.select().from(document).where(eq(document.id, id));
      if (!row) throw NotFound('Document');
      return this.dto(row);
    });
  }

  async listFor(ctx: AuthedCtx, ownerType: string, ownerId: string) {
    return this.db.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(document)
        .where(and(eq(document.ownerType, ownerType), eq(document.ownerId, ownerId)))
        .orderBy(desc(document.createdAt));
      return rows.map((r) => this.dto(r));
    });
  }

  async downloadUrl(ctx: AuthedCtx, id: string) {
    return this.db.run(ctx, async (tx) => {
      const [row] = await tx.select().from(document).where(eq(document.id, id));
      if (!row) throw NotFound('Document');
      // App-layer check mirrors RLS (sensitive documents need document.read_sensitive in scope).
      if (row.companyId) {
        const { propertyIds } = await assertCompanyAccess(tx, ctx, row.companyId, 'document.read');
        if (
          row.classification === 'SENSITIVE' &&
          !canAccess(ctx.user.grants, 'document.read_sensitive', {
            companyId: row.companyId,
            propertyIds,
          })
        ) {
          throw NotFound('Document');
        }
      } else if (row.uploadedBy !== ctx.user.id && !ctx.user.permissions.has('document.read')) {
        throw NotFound('Document');
      }
      if (row.status !== 'CLEAN')
        throw Conflict(
          'NOT_AVAILABLE',
          'This document is not available (still being scanned or rejected)',
        );
      if (!ctx.user.permissions.has('document.read') && row.uploadedBy !== ctx.user.id)
        throw Forbidden();

      const url = await this.storage.presignDownload(
        StorageService.cleanKey(id),
        row.originalName,
        row.contentType,
      );
      await this.audit.record(tx, {
        action: 'document.download_url',
        subjectType: 'document',
        subjectId: id,
        details: { classification: row.classification, ttlSeconds: DOWNLOAD_URL_TTL_SECONDS },
      });
      return {
        url,
        expiresAt: new Date(
          this.clock.now().getTime() + DOWNLOAD_URL_TTL_SECONDS * 1000,
        ).toISOString(),
      };
    });
  }

  /** Reads a CLEAN document's bytes server-side (imports). Audited like a download. */
  async readClean(ctx: AuthedCtx, id: string): Promise<{ row: DocumentRow; bytes: Buffer }> {
    const row = await this.db.run(ctx, async (tx) => {
      const [r] = await tx.select().from(document).where(eq(document.id, id));
      if (!r) throw NotFound('Document');
      if (r.status !== 'CLEAN')
        throw Conflict(
          'NOT_AVAILABLE',
          'This document is not available (still being scanned or rejected)',
        );
      await this.audit.record(tx, {
        action: 'document.read_server_side',
        subjectType: 'document',
        subjectId: id,
      });
      return r;
    });
    return { row, bytes: await this.storage.getBuffer(StorageService.cleanKey(id)) };
  }

  private dto(r: DocumentRow) {
    return {
      id: r.id,
      ownerType: r.ownerType,
      ownerId: r.ownerId,
      companyId: r.companyId,
      category: r.category,
      classification: r.classification,
      originalName: r.originalName,
      contentType: r.contentType,
      sizeBytes: r.sizeBytes,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
