import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { bankAccount, consent, kycProfile, person, privacyNotice, uuidv7 } from '@crm/db';
import type { z } from 'zod';
import type {
  CaptureConsentRequest,
  CreateBankAccountRequest,
  PublishNoticeRequest,
  UpsertKycRequest,
} from '@crm/contracts';
import { canAccess, maskBankAccount } from '@crm/domain';
import type { FieldCipher } from '@crm/platform';
import type { AuthedCtx } from '../../common/context.js';
import { Conflict, Forbidden, NotFound, pgCode } from '../../common/errors.js';
import { CIPHER } from '../../common/tokens.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';
import { assertCompanyAccess } from './scope.js';

const FIN_AAD = (id: string) => ({
  table: 'contacts.kyc_profile',
  column: 'financials_enc',
  rowId: id,
});
const BANK_AAD = (id: string) => ({
  table: 'contacts.bank_account',
  column: 'account_no_enc',
  rowId: id,
});

/** KYC (AMLA basics), tenant bank accounts, privacy notices and consent records. */
@Injectable()
export class KycService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CIPHER) private readonly cipher: FieldCipher,
  ) {}

  async getKyc(ctx: AuthedCtx, companyId: string) {
    return this.db.run(ctx, async (tx) => {
      await assertCompanyAccess(tx, ctx, companyId, 'kyc.read');
      const [row] = await tx.select().from(kycProfile).where(eq(kycProfile.companyId, companyId));
      if (!row) return null;
      return this.kycDto(row);
    });
  }

  async upsertKyc(ctx: AuthedCtx, companyId: string, input: z.infer<typeof UpsertKycRequest>) {
    return this.db.run(ctx, async (tx) => {
      await assertCompanyAccess(tx, ctx, companyId, 'kyc.write');
      const [existing] = await tx
        .select()
        .from(kycProfile)
        .where(eq(kycProfile.companyId, companyId));
      const id = existing?.id ?? uuidv7();
      const financialsEnc = input.financialsSummary
        ? await this.cipher.encrypt('financials', input.financialsSummary, FIN_AAD(id))
        : undefined;
      const reviewed = input.status === 'VERIFIED' || input.status === 'REJECTED';
      const values = {
        status: input.status,
        riskRating: input.riskRating ?? null,
        notes: input.notes ?? null,
        nextReviewOn: input.nextReviewOn ?? null,
        ...(financialsEnc && { financialsEnc }),
        ...(reviewed && { reviewedBy: ctx.user.id, reviewedAt: new Date() }),
      };
      if (existing) {
        if (input.version !== undefined && input.version !== existing.version) {
          throw Conflict('STALE_VERSION', 'KYC was changed by someone else. Reload and try again.');
        }
        await tx.update(kycProfile).set(values).where(eq(kycProfile.id, id));
      } else {
        await tx.insert(kycProfile).values({ id, companyId, createdBy: ctx.user.id, ...values });
      }
      await this.audit.record(tx, {
        action: 'kyc.updated',
        subjectType: 'company',
        subjectId: companyId,
        details: { status: input.status },
      });
      const [row] = await tx.select().from(kycProfile).where(eq(kycProfile.id, id));
      return this.kycDto(row!);
    });
  }

  async listBankAccounts(ctx: AuthedCtx, companyId: string) {
    return this.db.run(ctx, async (tx) => {
      await assertCompanyAccess(tx, ctx, companyId, 'kyc.read');
      const rows = await tx
        .select()
        .from(bankAccount)
        .where(eq(bankAccount.companyId, companyId))
        .orderBy(desc(bankAccount.createdAt));
      return rows.map((r) => this.bankDto(r));
    });
  }

  async addBankAccount(
    ctx: AuthedCtx,
    companyId: string,
    input: z.infer<typeof CreateBankAccountRequest>,
  ) {
    const id = uuidv7();
    const digits = input.accountNo.replace(/\D/g, '');
    const enc = await this.cipher.encrypt('bank', digits, BANK_AAD(id));
    const bidx = await this.cipher.blindIndex('bank_account.account_no', digits);
    return this.db.run(ctx, async (tx) => {
      await assertCompanyAccess(tx, ctx, companyId, 'kyc.write');
      await tx.insert(bankAccount).values({
        id,
        companyId,
        bankName: input.bankName,
        accountName: input.accountName,
        accountNoEnc: enc,
        accountNoBidx: bidx,
        accountNoLast4: digits.slice(-4),
        purpose: input.purpose,
        createdBy: ctx.user.id,
      });
      await this.audit.record(tx, {
        action: 'bank_account.added',
        subjectType: 'company',
        subjectId: companyId,
        details: { bankAccountId: id },
      });
      const [row] = await tx.select().from(bankAccount).where(eq(bankAccount.id, id));
      return this.bankDto(row!);
    });
  }

  async revealBankAccount(ctx: AuthedCtx, companyId: string, accountId: string, reason: string) {
    return this.db.run(ctx, async (tx) => {
      const { propertyIds } = await assertCompanyAccess(tx, ctx, companyId, 'kyc.read');
      if (!canAccess(ctx.user.grants, 'pii.reveal.bank', { companyId, propertyIds })) {
        await this.audit.recordStandalone(ctx, {
          action: 'pii.reveal',
          outcome: 'DENIED',
          subjectType: 'bank_account',
          subjectId: accountId,
          details: { field: 'bank_account' },
        });
        throw Forbidden('You are not allowed to reveal bank details');
      }
      const [row] = await tx
        .select()
        .from(bankAccount)
        .where(and(eq(bankAccount.id, accountId), eq(bankAccount.companyId, companyId)));
      if (!row) throw NotFound('Bank account');
      const value = await this.cipher.decrypt(row.accountNoEnc, BANK_AAD(accountId));
      await this.audit.record(tx, {
        action: 'pii.reveal',
        subjectType: 'bank_account',
        subjectId: accountId,
        details: { field: 'bank_account', reason },
      });
      return { field: 'bank_account', value, revealedAt: new Date().toISOString() };
    });
  }

  // ------------------------------------------------------------ privacy notices & consent

  listNotices(ctx: AuthedCtx) {
    return this.db.run(ctx, (tx) =>
      tx
        .select()
        .from(privacyNotice)
        .orderBy(asc(privacyNotice.audience), desc(privacyNotice.effectiveFrom)),
    );
  }

  async publishNotice(ctx: AuthedCtx, input: z.infer<typeof PublishNoticeRequest>) {
    return this.db.run(ctx, async (tx) => {
      try {
        const [row] = await tx
          .insert(privacyNotice)
          .values({
            ...input,
            bodySha256: createHash('sha256').update(input.bodyMarkdown).digest('hex'),
            publishedBy: ctx.user.id,
          })
          .returning();
        await this.audit.record(tx, {
          action: 'privacy.notice_published',
          subjectType: 'privacy_notice',
          subjectId: row!.id,
          details: { version: input.versionLabel },
        });
        return row!;
      } catch (err) {
        if (pgCode(err) === '23505')
          throw Conflict('DUPLICATE_VERSION', 'A notice with this version label already exists');
        throw err;
      }
    });
  }

  async captureConsent(
    ctx: AuthedCtx,
    personId: string,
    input: z.infer<typeof CaptureConsentRequest>,
  ) {
    return this.db.run(ctx, async (tx) => {
      const [p] = await tx.select({ id: person.id }).from(person).where(eq(person.id, personId));
      if (!p) throw NotFound('Person');
      const [n] = await tx
        .select({ id: privacyNotice.id })
        .from(privacyNotice)
        .where(eq(privacyNotice.id, input.noticeId));
      if (!n) throw NotFound('Privacy notice');
      const [row] = await tx
        .insert(consent)
        .values({
          ...input,
          evidenceDocumentId: input.evidenceDocumentId ?? null,
          personId,
          capturedBy: ctx.user.id,
        })
        .returning();
      return row!;
    });
  }

  async listConsents(ctx: AuthedCtx, personId: string) {
    return this.db.run(ctx, (tx) =>
      tx
        .select()
        .from(consent)
        .where(eq(consent.personId, personId))
        .orderBy(desc(consent.capturedAt)),
    );
  }

  private kycDto(r: typeof kycProfile.$inferSelect) {
    return {
      companyId: r.companyId,
      status: r.status,
      riskRating: r.riskRating,
      hasFinancials: !!r.financialsEnc,
      notes: r.notes,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      nextReviewOn: r.nextReviewOn,
      version: r.version,
    };
  }

  private bankDto(r: typeof bankAccount.$inferSelect) {
    return {
      id: r.id,
      bankName: r.bankName,
      accountName: r.accountName,
      accountNoMasked: maskBankAccount(`000000${r.accountNoLast4}`),
      purpose: r.purpose,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
