import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { type Tx, configValue, featureFlag, taxRate } from '@crm/db';
import type { ConfigChangeRequest } from '@crm/contracts';
import {
  type Clock,
  type LocalDate,
  manilaToday,
  parseLocalDate,
  resolveEffective,
} from '@crm/domain';
import type { AuthedCtx, Ctx } from '../../common/context.js';
import { Conflict, pgConstraint } from '../../common/errors.js';
import { CLOCK } from '../../common/tokens.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';
import { ApprovalsService } from '../approvals/index.js';

/**
 * Effective-dated configuration and tax-rate tables (brief: "all tax rates, thresholds and
 * legal periods live in configuration tables with effective dates, never in code").
 * Changes are proposals; they apply only when another authorised person approves them.
 * Applying a change closes the open period at the new row's start date — history is kept.
 */
@Injectable()
export class ConfigService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.approvals.register('CONFIG_CHANGE', {
      apply: (tx, ctx, req) => this.apply(tx, ctx, req.payload as ConfigChangeRequest, req.id),
    });
  }

  listValues(ctx: Ctx) {
    return this.db.run(ctx, (tx) =>
      tx.select().from(configValue).orderBy(asc(configValue.key), asc(configValue.effectiveFrom)),
    );
  }

  listTaxRates(ctx: Ctx) {
    return this.db.run(ctx, (tx) =>
      tx.select().from(taxRate).orderBy(asc(taxRate.taxType), asc(taxRate.effectiveFrom)),
    );
  }

  listFlags(ctx: Ctx) {
    return this.db.run(ctx, (tx) => tx.select().from(featureFlag).orderBy(asc(featureFlag.key)));
  }

  async isEnabled(ctx: Ctx, key: string): Promise<boolean> {
    const rows = await this.db.run(ctx, (tx) =>
      tx.select().from(featureFlag).where(eq(featureFlag.key, key)),
    );
    return rows[0]?.enabled ?? false;
  }

  /** The tax rate in force on a business date (Asia/Manila). */
  async taxRateOn(ctx: Ctx, taxType: string, asOf: LocalDate = manilaToday(this.clock)) {
    const rows = await this.db.run(ctx, (tx) =>
      tx.select().from(taxRate).where(eq(taxRate.taxType, taxType)),
    );
    return resolveEffective(
      rows.map((r) => ({
        ...r,
        effectiveFrom: parseLocalDate(r.effectiveFrom),
        effectiveTo: r.effectiveTo ? parseLocalDate(r.effectiveTo) : null,
      })),
      asOf,
    );
  }

  async propose(ctx: AuthedCtx, change: ConfigChangeRequest) {
    const summary =
      change.kind === 'tax_rate'
        ? `Set ${change.taxType} ${change.rate ?? 'brackets'} from ${change.effectiveFrom}`
        : change.kind === 'config_value'
          ? `Set ${change.key} from ${change.effectiveFrom}`
          : `${change.enabled ? 'Enable' : 'Disable'} feature ${change.key}`;
    return this.db.run(ctx, (tx) =>
      this.approvals.create(tx, ctx, {
        type: 'CONFIG_CHANGE',
        summary,
        payload: change as unknown as Record<string, unknown>,
        subjectType: change.kind,
        subjectId: change.kind === 'tax_rate' ? change.taxType : change.key,
      }),
    );
  }

  private async apply(
    tx: Tx,
    ctx: AuthedCtx,
    change: ConfigChangeRequest,
    approvalId: string,
  ): Promise<void> {
    try {
      if (change.kind === 'feature_flag') {
        await tx
          .update(featureFlag)
          .set({ enabled: change.enabled, updatedAt: this.clock.now(), updatedBy: ctx.user.id })
          .where(eq(featureFlag.key, change.key));
      } else if (change.kind === 'tax_rate') {
        // Close the period that is open at (or spans) the new start date.
        await tx
          .update(taxRate)
          .set({ effectiveTo: change.effectiveFrom })
          .where(
            and(
              eq(taxRate.taxType, change.taxType),
              lt(taxRate.effectiveFrom, change.effectiveFrom),
              or(
                isNull(taxRate.effectiveTo),
                sql`${taxRate.effectiveTo} > ${change.effectiveFrom}`,
              ),
            ),
          );
        await tx.insert(taxRate).values({
          taxType: change.taxType,
          rate: change.rate,
          brackets: change.brackets ?? null,
          basis: change.basis,
          sourceReference: change.sourceReference ?? null,
          effectiveFrom: change.effectiveFrom,
          effectiveTo: change.effectiveTo,
          needsConfirmation: !change.confirmed,
          approvalRequestId: approvalId,
          createdBy: ctx.user.id,
        });
      } else {
        const scopeCond =
          change.scopeId === null
            ? isNull(configValue.scopeId)
            : eq(configValue.scopeId, change.scopeId);
        await tx
          .update(configValue)
          .set({ effectiveTo: change.effectiveFrom })
          .where(
            and(
              eq(configValue.key, change.key),
              eq(configValue.scopeType, change.scopeType),
              scopeCond,
              lt(configValue.effectiveFrom, change.effectiveFrom),
              or(
                isNull(configValue.effectiveTo),
                sql`${configValue.effectiveTo} > ${change.effectiveFrom}`,
              ),
            ),
          );
        await tx.insert(configValue).values({
          key: change.key,
          scopeType: change.scopeType,
          scopeId: change.scopeId,
          value: change.value ?? null,
          effectiveFrom: change.effectiveFrom,
          effectiveTo: change.effectiveTo,
          needsConfirmation: !change.confirmed,
          notes: change.notes ?? null,
          approvalRequestId: approvalId,
          createdBy: ctx.user.id,
        });
      }
    } catch (err) {
      if (pgConstraint(err)?.includes('excl')) {
        throw Conflict(
          'OVERLAPPING_PERIOD',
          'This change overlaps an existing effective period that starts on or after it',
        );
      }
      throw err;
    }
    await this.audit.record(tx, {
      action: 'config.changed',
      subjectType: change.kind,
      details: { approvalId },
    });
  }
}
