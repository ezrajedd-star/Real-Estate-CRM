import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { type Tx, approvalDecision, approvalRequest } from '@crm/db';
import {
  type ApprovalStatus,
  type ApprovalType,
  APPROVAL_TYPES,
  type Clock,
  checkDecision,
} from '@crm/domain';
import type { AuthedCtx } from '../../common/context.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../../common/errors.js';
import { CLOCK } from '../../common/tokens.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';

type ApprovalRow = typeof approvalRequest.$inferSelect;

/** Applies an approved request's payload, inside the checker's transaction. */
export interface ApprovalHandler {
  apply(tx: Tx, ctx: AuthedCtx, request: ApprovalRow): Promise<void>;
}

/**
 * Generic maker–checker engine (brief §7.3). Makers create requests; a different person with
 * the step's permission decides; on final approval the registered handler applies the
 * change in the same transaction, so "approved" and "applied" can never diverge.
 * The DB independently rejects maker == checker (trigger) and enforces visibility (RLS).
 */
@Injectable()
export class ApprovalsService {
  private readonly handlers = new Map<ApprovalType, ApprovalHandler>();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  register(type: ApprovalType, handler: ApprovalHandler): void {
    this.handlers.set(type, handler);
  }

  async create(
    tx: Tx,
    ctx: AuthedCtx,
    input: {
      type: ApprovalType;
      summary: string;
      payload: Record<string, unknown>;
      subjectType?: string;
      subjectId?: string;
    },
  ): Promise<ApprovalRow> {
    const [row] = await tx
      .insert(approvalRequest)
      .values({
        type: input.type,
        summary: input.summary,
        payload: input.payload,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        makerId: ctx.user.id,
      })
      .returning();
    await this.audit.record(tx, {
      action: 'approval.requested',
      subjectType: 'approval',
      subjectId: row!.id,
      details: { type: input.type },
    });
    return row!;
  }

  async list(ctx: AuthedCtx, filter: { status?: ApprovalStatus; type?: ApprovalType }) {
    return this.db.run(ctx, async (tx) => {
      const conds = [];
      if (filter.status) conds.push(eq(approvalRequest.status, filter.status));
      if (filter.type) conds.push(eq(approvalRequest.type, filter.type));
      const rows = await tx
        .select()
        .from(approvalRequest)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(approvalRequest.createdAt))
        .limit(200);
      const decisions = rows.length
        ? await tx
            .select()
            .from(approvalDecision)
            .where(
              inArray(
                approvalDecision.requestId,
                rows.map((r) => r.id),
              ),
            )
        : [];
      return rows.map((r) =>
        this.toDto(
          ctx,
          r,
          decisions.filter((d) => d.requestId === r.id),
        ),
      );
    });
  }

  async get(ctx: AuthedCtx, id: string) {
    return this.db.run(ctx, async (tx) => {
      const [row] = await tx.select().from(approvalRequest).where(eq(approvalRequest.id, id));
      if (!row) throw NotFound('Approval request');
      const decisions = await tx
        .select()
        .from(approvalDecision)
        .where(eq(approvalDecision.requestId, id));
      return this.toDto(ctx, row, decisions);
    });
  }

  async decide(ctx: AuthedCtx, id: string, decision: 'APPROVE' | 'REJECT', comment?: string) {
    return this.db.run(ctx, async (tx) => {
      const [row] = await tx
        .select()
        .from(approvalRequest)
        .where(eq(approvalRequest.id, id))
        .for('update');
      if (!row) throw NotFound('Approval request');
      if (!(row.type in APPROVAL_TYPES)) throw BadRequest('UNKNOWN_TYPE', 'Unknown approval type');
      const type = row.type as ApprovalType;
      const decisions = await tx
        .select()
        .from(approvalDecision)
        .where(eq(approvalDecision.requestId, id));

      const check = checkDecision(
        { type, makerId: row.makerId, status: row.status, decisions },
        ctx.user.id,
        ctx.user.permissions,
        decision,
      );
      if (!check.ok) {
        await this.audit.recordStandalone(ctx, {
          action: 'approval.decision_denied',
          outcome: 'DENIED',
          subjectType: 'approval',
          subjectId: id,
          details: { reason: check.reason },
        });
        if (check.reason === 'NOT_PENDING')
          throw Conflict('NOT_PENDING', 'This request has already been decided');
        if (check.reason === 'SELF_APPROVAL')
          throw Forbidden('You cannot approve a request you made');
        throw Forbidden();
      }

      await tx.insert(approvalDecision).values({
        requestId: id,
        stepIndex: check.stepIndex,
        deciderId: ctx.user.id,
        decision,
        comment: comment ?? null,
      });
      const now = this.clock.now();
      const terminal = check.resultingStatus !== 'PENDING';
      await tx
        .update(approvalRequest)
        .set({ status: check.resultingStatus, decidedAt: terminal ? now : null })
        .where(eq(approvalRequest.id, id));

      if (check.resultingStatus === 'APPROVED') {
        const handler = this.handlers.get(type);
        if (handler) {
          await handler.apply(tx, ctx, row);
          await tx
            .update(approvalRequest)
            .set({ appliedAt: now })
            .where(eq(approvalRequest.id, id));
        }
      }
      await this.audit.record(tx, {
        action: `approval.${decision === 'APPROVE' ? 'approved' : 'rejected'}`,
        subjectType: 'approval',
        subjectId: id,
        details: { type, step: check.stepIndex, status: check.resultingStatus },
      });
      const [updated] = await tx.select().from(approvalRequest).where(eq(approvalRequest.id, id));
      const allDecisions = await tx
        .select()
        .from(approvalDecision)
        .where(eq(approvalDecision.requestId, id));
      return this.toDto(ctx, updated!, allDecisions);
    });
  }

  async cancel(ctx: AuthedCtx, id: string) {
    return this.db.run(ctx, async (tx) => {
      const [row] = await tx
        .select()
        .from(approvalRequest)
        .where(eq(approvalRequest.id, id))
        .for('update');
      if (!row) throw NotFound('Approval request');
      if (row.makerId !== ctx.user.id) throw Forbidden('Only the requester can cancel');
      if (row.status !== 'PENDING')
        throw Conflict('NOT_PENDING', 'This request has already been decided');
      await tx
        .update(approvalRequest)
        .set({ status: 'CANCELLED', decidedAt: this.clock.now() })
        .where(eq(approvalRequest.id, id));
      await this.audit.record(tx, {
        action: 'approval.cancelled',
        subjectType: 'approval',
        subjectId: id,
      });
    });
  }

  private toDto(
    ctx: AuthedCtx,
    r: ApprovalRow,
    decisions: Array<typeof approvalDecision.$inferSelect>,
  ) {
    const type = r.type as ApprovalType;
    const nextStep = APPROVAL_TYPES[type]?.steps[decisions.length];
    return {
      id: r.id,
      type,
      summary: r.summary,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      makerId: r.makerId,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      appliedAt: r.appliedAt?.toISOString() ?? null,
      canDecide:
        r.status === 'PENDING' &&
        r.makerId !== ctx.user.id &&
        !!nextStep &&
        ctx.user.permissions.has(nextStep) &&
        !decisions.some((d) => d.deciderId === ctx.user.id),
      decisions: decisions
        .sort((a, b) => a.stepIndex - b.stepIndex)
        .map((d) => ({
          stepIndex: d.stepIndex,
          deciderId: d.deciderId,
          decision: d.decision,
          comment: d.comment,
          decidedAt: d.decidedAt.toISOString(),
        })),
    };
  }
}
