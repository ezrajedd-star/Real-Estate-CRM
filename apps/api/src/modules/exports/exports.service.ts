import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, sql } from 'drizzle-orm';
import { approvalRequest, company, companyProperty, exportJob } from '@crm/db';
import { type Clock, maskTin } from '@crm/domain';
import type { AuthedCtx } from '../../common/context.js';
import { Conflict, NotFound } from '../../common/errors.js';
import { CLOCK } from '../../common/tokens.js';
import { ENV, type Env } from '../../config/env.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';
import { ApprovalsService } from '../approvals/index.js';

export type ExportFilters = {
  propertyId?: string;
  status?: string;
};

/**
 * Bulk export controls (brief §8.2): permission-gated, approval-gated (maker–checker),
 * single-use, expiring, size-capped, watermarked with requester + time, masked PII, and an
 * alert when volume is unusual.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    @Inject(ENV) private readonly env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async request(ctx: AuthedCtx, kind: 'companies', filters: ExportFilters, justification: string) {
    return this.db.run(ctx, async (tx) => {
      const approval = await this.approvals.create(tx, ctx, {
        type: 'BULK_EXPORT',
        summary: `Export ${kind} (${Object.keys(filters).length ? JSON.stringify(filters) : 'all in scope'}) — ${justification}`,
        payload: { kind, filters, justification },
        subjectType: 'export',
      });
      const [job] = await tx
        .insert(exportJob)
        .values({
          kind,
          filters: { ...filters },
          approvalRequestId: approval.id,
          requestedBy: ctx.user.id,
        })
        .returning();
      return { id: job!.id, approvalId: approval.id, status: 'PENDING_APPROVAL' };
    });
  }

  async list(ctx: AuthedCtx) {
    return this.db.run(ctx, async (tx) => {
      const rows = await tx
        .select({ job: exportJob, status: approvalRequest.status })
        .from(exportJob)
        .innerJoin(approvalRequest, eq(approvalRequest.id, exportJob.approvalRequestId))
        .where(eq(exportJob.requestedBy, ctx.user.id))
        .orderBy(desc(exportJob.createdAt));
      return rows.map(({ job, status }) => ({
        id: job.id,
        kind: job.kind,
        approvalStatus: status,
        createdAt: job.createdAt.toISOString(),
        expiresAt: job.expiresAt.toISOString(),
        downloadedAt: job.downloadedAt?.toISOString() ?? null,
        rowCount: job.rowCount,
      }));
    });
  }

  /** Generates the file once. Only the requester, only after approval, only before expiry. */
  async download(ctx: AuthedCtx, id: string): Promise<{ filename: string; csv: string }> {
    return this.db.run(ctx, async (tx) => {
      // Lock the job row so two concurrent downloads cannot both succeed.
      const [job] = await tx
        .select()
        .from(exportJob)
        .where(and(eq(exportJob.id, id), eq(exportJob.requestedBy, ctx.user.id)))
        .for('update');
      if (!job) throw NotFound('Export');
      const [approval] = await tx
        .select({ status: approvalRequest.status })
        .from(approvalRequest)
        .where(eq(approvalRequest.id, job.approvalRequestId));
      const status = approval?.status;
      if (status !== 'APPROVED')
        throw Conflict('NOT_APPROVED', 'This export has not been approved');
      if (job.downloadedAt)
        throw Conflict(
          'ALREADY_DOWNLOADED',
          'This export was already downloaded; request a new one',
        );
      if (job.expiresAt <= this.clock.now())
        throw Conflict('EXPIRED', 'This export has expired; request a new one');

      const filters = job.filters as ExportFilters;
      const conds = [];
      if (filters.status)
        conds.push(eq(company.status, filters.status as typeof company.$inferSelect.status));
      if (filters.propertyId) {
        conds.push(
          exists(
            tx
              .select({ x: sql`1` })
              .from(companyProperty)
              .where(
                and(
                  eq(companyProperty.companyId, company.id),
                  eq(companyProperty.propertyId, filters.propertyId),
                ),
              ),
          ),
        );
      }
      // RLS restricts rows to the requester's own scope.
      const rows = await tx
        .select()
        .from(company)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(company.legalName))
        .limit(this.env.EXPORT_MAX_ROWS + 1);
      const truncated = rows.length > this.env.EXPORT_MAX_ROWS;
      const data = rows.slice(0, this.env.EXPORT_MAX_ROWS);

      const now = this.clock.now();
      const watermark = `CONFIDENTIAL — exported by ${ctx.user.displayName} (${ctx.user.id}) at ${now.toISOString()} — export ${id}`;
      const lines = [
        `# ${watermark}`,
        ...(truncated ? [`# Truncated to ${this.env.EXPORT_MAX_ROWS} rows`] : []),
        [
          'id',
          'legal_name',
          'trade_name',
          'registration_type',
          'registration_no',
          'tin_masked',
          'vat_status',
          'status',
          'industry',
        ].join(','),
        ...data.map((c) =>
          [
            c.id,
            c.legalName,
            c.tradeName,
            c.registrationType,
            c.registrationNo,
            c.tinLast3 ? maskTin(`000-000-000-${c.tinLast3}`) : '',
            c.vatStatus,
            c.status,
            c.industry,
          ]
            .map(csvCell)
            .join(','),
        ),
      ];
      await tx
        .update(exportJob)
        .set({ downloadedAt: now, rowCount: data.length, watermark })
        .where(eq(exportJob.id, id));
      await this.audit.record(tx, {
        action: 'export.downloaded',
        subjectType: 'export',
        subjectId: id,
        details: { kind: job.kind, rows: data.length, truncated },
      });
      if (data.length >= this.env.EXPORT_ALERT_ROWS) {
        await this.audit.alert(tx, {
          kind: 'LARGE_EXPORT',
          severity: 'MEDIUM',
          subjectUserId: ctx.user.id,
          details: { exportId: id, rows: data.length },
        });
      }
      return {
        filename: `${job.kind}-${now.toISOString().slice(0, 10)}-${id.slice(-8)}.csv`,
        csv: lines.join('\r\n') + '\r\n',
      };
    });
  }
}

/** RFC 4180 quoting plus formula-injection guard for spreadsheet apps. */
export function csvCell(v: string | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
