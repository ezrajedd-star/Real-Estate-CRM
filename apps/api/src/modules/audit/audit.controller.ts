import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog, securityAlert } from '@crm/db';
import { type AuthedCtx, CurrentCtx } from '../../common/context.js';
import { NotFound } from '../../common/errors.js';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';
import { Can } from '../auth/index.js';

const AuditQuery = z.object({
  subjectType: z
    .string()
    .regex(/^[a-z_.]{2,60}$/)
    .optional(),
  subjectId: z.string().max(64).optional(),
  action: z
    .string()
    .regex(/^[a-z0-9_.]{2,80}$/)
    .optional(),
  actorId: z.string().uuid().optional(),
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Read side of the audit trail and security monitoring (Compliance/DPO, Internal Auditor). */
@Controller()
export class AuditController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get('audit')
  @Can('audit.read')
  async list(
    @CurrentCtx() ctx: AuthedCtx,
    @Query(new ZodPipe(AuditQuery)) q: z.infer<typeof AuditQuery>,
  ) {
    return this.db.run(ctx, async (tx) => {
      const conds = [];
      if (q.subjectType) conds.push(eq(auditLog.subjectType, q.subjectType));
      if (q.subjectId) conds.push(eq(auditLog.subjectId, q.subjectId));
      if (q.action) conds.push(eq(auditLog.action, q.action));
      if (q.actorId) conds.push(eq(auditLog.actorId, q.actorId));
      if (q.beforeSeq) conds.push(lt(auditLog.seq, q.beforeSeq));
      const rows = await tx
        .select()
        .from(auditLog)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(auditLog.seq))
        .limit(q.limit);
      // Reading the audit log is itself audited.
      await this.audit.record(tx, {
        action: 'audit.viewed',
        details: { filters: { ...q, limit: undefined } },
      });
      return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
    });
  }

  @Get('security/alerts')
  @Can('security.dashboard')
  async alerts(@CurrentCtx() ctx: AuthedCtx) {
    const rows = await this.db.run(ctx, (tx) =>
      tx.select().from(securityAlert).orderBy(desc(securityAlert.createdAt)).limit(200),
    );
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
    }));
  }

  @Post('security/alerts/:id/ack')
  @HttpCode(204)
  @Can('security.dashboard')
  async ack(@CurrentCtx() ctx: AuthedCtx, @Param('id', UuidPipe) id: string) {
    await this.db.run(ctx, async (tx) => {
      const res = await tx
        .update(securityAlert)
        .set({ acknowledgedAt: new Date(), acknowledgedBy: ctx.user.id })
        .where(and(eq(securityAlert.id, id), isNull(securityAlert.acknowledgedAt)))
        .returning({ id: securityAlert.id });
      if (!res.length) throw NotFound('Alert');
      await this.audit.record(tx, {
        action: 'security.alert_acknowledged',
        subjectType: 'security_alert',
        subjectId: id,
      });
    });
  }
}
