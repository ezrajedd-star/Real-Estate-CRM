import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  type Tx,
  company,
  companyContactRole,
  companyProperty,
  kycProfile,
  person,
  property,
  uuidv7,
} from '@crm/db';
import type { z } from 'zod';
import type {
  AddContactRoleRequest,
  CompanySearchQuery,
  CreateCompanyRequest,
  CreatePersonRequest,
  UpdateCompanyRequest,
} from '@crm/contracts';
import {
  type Permission,
  canAccess,
  maskEmail,
  maskGovernmentId,
  maskPhone,
  maskTin,
  normalizeTin,
} from '@crm/domain';
import type { FieldCipher } from '@crm/platform';
import type { AuthedCtx } from '../../common/context.js';
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  pgCode,
  pgConstraint,
} from '../../common/errors.js';
import { CIPHER } from '../../common/tokens.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';
import { assertCompanyAccess, hasGlobal } from './scope.js';

type CompanyRow = typeof company.$inferSelect;
type PersonRow = typeof person.$inferSelect;
export type RevealField = 'tin' | 'gov_id' | 'email' | 'phone' | 'bank_account';

export const REVEAL_PERMISSION: Record<RevealField, Permission> = {
  tin: 'pii.reveal.tin',
  gov_id: 'pii.reveal.gov_id',
  email: 'pii.reveal.contact',
  phone: 'pii.reveal.contact',
  bank_account: 'pii.reveal.bank',
};

const TIN_AAD = (id: string) => ({ table: 'contacts.company', column: 'tin_enc', rowId: id });
const GOV_ID_AAD = (id: string) => ({ table: 'contacts.person', column: 'gov_id_enc', rowId: id });

@Injectable()
export class ContactsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(CIPHER) private readonly cipher: FieldCipher,
  ) {}

  // ------------------------------------------------------------------ companies

  async createCompany(ctx: AuthedCtx, input: z.infer<typeof CreateCompanyRequest>) {
    const global = hasGlobal(ctx, 'company.write');
    if (!global) {
      if (!input.propertyId)
        throw BadRequest('PROPERTY_REQUIRED', 'Choose the property this company is for');
      if (!canAccess(ctx.user.grants, 'company.write', { propertyIds: [input.propertyId] }))
        throw Forbidden();
    }
    const id = uuidv7();
    const tin = input.tin ? await this.encryptTin(id, input.tin) : null;

    return this.db.run(ctx, async (tx) => {
      try {
        // No RETURNING: scoped users cannot see the row until it is linked to their property.
        await tx.insert(company).values({
          id,
          legalName: input.legalName,
          tradeName: input.tradeName,
          registrationType: input.registrationType,
          registrationNo: input.registrationNo,
          tinEnc: tin?.enc ?? null,
          tinBidx: tin?.bidx ?? null,
          tinLast3: tin?.last3 ?? null,
          vatStatus: input.vatStatus,
          registeredAddress: input.registeredAddress,
          industry: input.industry,
          createdBy: ctx.user.id,
        });
      } catch (err) {
        if (pgCode(err) === '23505' && pgConstraint(err) === 'company_tin_bidx_uq') {
          throw Conflict(
            'DUPLICATE_TIN',
            'A company with this TIN is already registered. Ask the Leasing Head to resolve the conflict.',
          );
        }
        throw err;
      }
      if (input.propertyId) {
        await tx
          .insert(companyProperty)
          .values({ companyId: id, propertyId: input.propertyId, createdBy: ctx.user.id });
      }
      await this.audit.record(tx, {
        action: 'company.created',
        subjectType: 'company',
        subjectId: id,
      });
      return this.companyDto(
        tx,
        ctx,
        (await assertCompanyAccess(tx, ctx, id, 'company.read')).company,
      );
    });
  }

  async updateCompany(ctx: AuthedCtx, id: string, input: z.infer<typeof UpdateCompanyRequest>) {
    const tin = input.tin ? await this.encryptTin(id, input.tin) : undefined;
    return this.db.run(ctx, async (tx) => {
      const { company: current } = await assertCompanyAccess(tx, ctx, id, 'company.write');
      if (current.version !== input.version)
        throw Conflict(
          'STALE_VERSION',
          'This company was changed by someone else. Reload and try again.',
        );
      try {
        await tx
          .update(company)
          .set({
            ...(input.legalName !== undefined && { legalName: input.legalName }),
            ...(input.tradeName !== undefined && { tradeName: input.tradeName }),
            ...(input.registrationType !== undefined && {
              registrationType: input.registrationType,
            }),
            ...(input.registrationNo !== undefined && { registrationNo: input.registrationNo }),
            ...(input.vatStatus !== undefined && { vatStatus: input.vatStatus }),
            ...(input.registeredAddress !== undefined && {
              registeredAddress: input.registeredAddress,
            }),
            ...(input.industry !== undefined && { industry: input.industry }),
            ...(input.status !== undefined && { status: input.status }),
            ...(tin && { tinEnc: tin.enc, tinBidx: tin.bidx, tinLast3: tin.last3 }),
            ...(input.tin === null && { tinEnc: null, tinBidx: null, tinLast3: null }),
          })
          .where(and(eq(company.id, id), eq(company.version, input.version)));
      } catch (err) {
        if (pgCode(err) === '23505' && pgConstraint(err) === 'company_tin_bidx_uq') {
          throw Conflict('DUPLICATE_TIN', 'Another company already has this TIN.');
        }
        throw err;
      }
      const [updated] = await tx.select().from(company).where(eq(company.id, id));
      return this.companyDto(tx, ctx, updated!);
    });
  }

  async getCompany(ctx: AuthedCtx, id: string) {
    return this.db.run(ctx, async (tx) => {
      const { company: row } = await assertCompanyAccess(tx, ctx, id, 'company.read');
      return this.companyDto(tx, ctx, row, { withContacts: true });
    });
  }

  async searchCompanies(ctx: AuthedCtx, q: z.infer<typeof CompanySearchQuery>) {
    return this.db.run(ctx, async (tx) => {
      const conds = [];
      if (q.q)
        conds.push(ilike(sql`name_search`, `%${q.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`));
      if (q.status) conds.push(eq(company.status, q.status));
      if (q.propertyId) {
        conds.push(
          exists(
            tx
              .select({ x: sql`1` })
              .from(companyProperty)
              .where(
                and(
                  eq(companyProperty.companyId, company.id),
                  eq(companyProperty.propertyId, q.propertyId),
                ),
              ),
          ),
        );
      }
      // RLS limits rows to the caller's scope; we never rely on a client-supplied filter for that.
      const rows = await tx
        .select()
        .from(company)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(company.legalName))
        .limit(q.limit)
        .offset(q.offset);
      const items = [];
      for (const r of rows) items.push(await this.companyDto(tx, ctx, r));
      return { items, limit: q.limit, offset: q.offset };
    });
  }

  async linkProperty(
    ctx: AuthedCtx,
    companyId: string,
    propertyId: string,
    relation: 'PROSPECT' | 'TENANT' | 'FORMER_TENANT',
  ) {
    return this.db.run(ctx, async (tx) => {
      await assertCompanyAccess(tx, ctx, companyId, 'company.write');
      if (!canAccess(ctx.user.grants, 'company.write', { propertyIds: [propertyId] }))
        throw Forbidden();
      await tx
        .insert(companyProperty)
        .values({ companyId, propertyId, relation, createdBy: ctx.user.id })
        .onConflictDoUpdate({
          target: [companyProperty.companyId, companyProperty.propertyId],
          set: { relation },
        });
      await this.audit.record(tx, {
        action: 'company.property_linked',
        subjectType: 'company',
        subjectId: companyId,
        details: { propertyId, relation },
      });
    });
  }

  // ------------------------------------------------------------------ people

  async createPerson(ctx: AuthedCtx, input: z.infer<typeof CreatePersonRequest>) {
    const id = uuidv7();
    let gov: { enc: string; bidx: string; last4: string } | null = null;
    if (input.govId && input.govIdType) {
      const normalized = input.govId.replace(/[\s-]/g, '').toUpperCase();
      gov = {
        enc: await this.cipher.encrypt('gov_id', input.govId, GOV_ID_AAD(id)),
        bidx: await this.cipher.blindIndex(`person.gov_id.${input.govIdType}`, normalized),
        last4: normalized.slice(-4),
      };
    }
    return this.db.run(ctx, async (tx) => {
      await tx.insert(person).values({
        id,
        fullName: input.fullName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        govIdType: input.govIdType ?? null,
        govIdEnc: gov?.enc ?? null,
        govIdBidx: gov?.bidx ?? null,
        govIdLast4: gov?.last4 ?? null,
        nationality: input.nationality ?? null,
        createdBy: ctx.user.id,
      });
      await this.audit.record(tx, {
        action: 'person.created',
        subjectType: 'person',
        subjectId: id,
      });
      const [row] = await tx.select().from(person).where(eq(person.id, id));
      return this.personDto(row!);
    });
  }

  async getPerson(ctx: AuthedCtx, id: string) {
    return this.db.run(ctx, async (tx) => {
      const [row] = await tx.select().from(person).where(eq(person.id, id));
      if (!row) throw NotFound('Person');
      return this.personDto(row);
    });
  }

  /** Lookup by email or name. Takes a body (not query string) so PII never lands in URLs/logs. */
  async searchPeople(ctx: AuthedCtx, q: { email?: string; name?: string }) {
    return this.db.run(ctx, async (tx) => {
      const conds = [];
      if (q.email) conds.push(eq(sql`lower(${person.email})`, q.email.toLowerCase()));
      if (q.name) conds.push(ilike(person.fullName, `%${q.name.replace(/[%_\\]/g, '\\$&')}%`));
      const rows = await tx
        .select()
        .from(person)
        .where(or(...conds))
        .orderBy(asc(person.fullName))
        .limit(25);
      await this.audit.record(tx, {
        action: 'person.searched',
        details: { by: q.email ? 'email' : 'name', results: rows.length },
      });
      return rows.map((r) => this.personDto(r));
    });
  }

  async addContactRole(
    ctx: AuthedCtx,
    companyId: string,
    input: z.infer<typeof AddContactRoleRequest>,
  ) {
    return this.db.run(ctx, async (tx) => {
      await assertCompanyAccess(tx, ctx, companyId, 'contact.write');
      const [p] = await tx
        .select({ id: person.id })
        .from(person)
        .where(eq(person.id, input.personId));
      if (!p) throw NotFound('Person');
      const [row] = await tx
        .insert(companyContactRole)
        .values({
          companyId,
          personId: input.personId,
          role: input.role,
          title: input.title,
          authorityDocumentId: input.authorityDocumentId ?? null,
          ownershipPct: input.ownershipPct ?? null,
          ...(input.effectiveFrom && { effectiveFrom: input.effectiveFrom }),
          createdBy: ctx.user.id,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'company.contact_added',
        subjectType: 'company',
        subjectId: companyId,
        details: { role: input.role, contactRoleId: row!.id },
      });
      return { id: row!.id };
    });
  }

  async endContactRole(ctx: AuthedCtx, companyId: string, roleId: string, effectiveTo: string) {
    return this.db.run(ctx, async (tx) => {
      await assertCompanyAccess(tx, ctx, companyId, 'contact.write');
      const res = await tx
        .update(companyContactRole)
        .set({ effectiveTo })
        .where(
          and(
            eq(companyContactRole.id, roleId),
            eq(companyContactRole.companyId, companyId),
            isNull(companyContactRole.effectiveTo),
          ),
        )
        .returning({ id: companyContactRole.id });
      if (!res.length) throw NotFound('Contact role');
      await this.audit.record(tx, {
        action: 'company.contact_ended',
        subjectType: 'company',
        subjectId: companyId,
        details: { contactRoleId: roleId },
      });
    });
  }

  // ------------------------------------------------------------------ reveal

  /** Returns a clear value. Requires the field's permission and a reason; always audited. */
  async revealCompanyField(ctx: AuthedCtx, companyId: string, field: RevealField, reason: string) {
    if (field !== 'tin')
      throw BadRequest('UNSUPPORTED_FIELD', 'Only the TIN can be revealed on a company');
    return this.db.run(ctx, async (tx) => {
      const { company: row, propertyIds } = await assertCompanyAccess(
        tx,
        ctx,
        companyId,
        'company.read',
      );
      if (!canAccess(ctx.user.grants, REVEAL_PERMISSION.tin, { companyId, propertyIds })) {
        await this.denyReveal(ctx, 'company', companyId, field);
      }
      const value = row.tinEnc ? await this.cipher.decrypt(row.tinEnc, TIN_AAD(companyId)) : null;
      await this.audit.record(tx, {
        action: 'pii.reveal',
        subjectType: 'company',
        subjectId: companyId,
        details: { field, reason },
      });
      return { field, value, revealedAt: new Date().toISOString() };
    });
  }

  async revealPersonField(ctx: AuthedCtx, personId: string, field: RevealField, reason: string) {
    if (!['gov_id', 'email', 'phone'].includes(field))
      throw BadRequest('UNSUPPORTED_FIELD', 'This field cannot be revealed on a person');
    return this.db.run(ctx, async (tx) => {
      const [row] = await tx.select().from(person).where(eq(person.id, personId));
      if (!row) throw NotFound('Person');
      const scopes = await tx
        .select({ companyId: companyContactRole.companyId, propertyId: companyProperty.propertyId })
        .from(companyContactRole)
        .leftJoin(companyProperty, eq(companyProperty.companyId, companyContactRole.companyId))
        .where(eq(companyContactRole.personId, personId));
      const perm = REVEAL_PERMISSION[field];
      const allowed =
        hasGlobal(ctx, perm) ||
        scopes.some((s) =>
          canAccess(ctx.user.grants, perm, {
            companyId: s.companyId,
            propertyIds: s.propertyId ? [s.propertyId] : [],
          }),
        ) ||
        (scopes.length === 0 && row.createdBy === ctx.user.id && ctx.user.permissions.has(perm));
      if (!allowed) await this.denyReveal(ctx, 'person', personId, field);

      let value: string | null = null;
      if (field === 'gov_id')
        value = row.govIdEnc ? await this.cipher.decrypt(row.govIdEnc, GOV_ID_AAD(personId)) : null;
      if (field === 'email') value = row.email;
      if (field === 'phone') value = row.phone;
      await this.audit.record(tx, {
        action: 'pii.reveal',
        subjectType: 'person',
        subjectId: personId,
        details: { field, reason },
      });
      return { field, value, revealedAt: new Date().toISOString() };
    });
  }

  private async denyReveal(
    ctx: AuthedCtx,
    subjectType: string,
    subjectId: string,
    field: string,
  ): Promise<never> {
    // Separate transaction: the denial must be recorded even though the request fails.
    await this.audit.recordStandalone(ctx, {
      action: 'pii.reveal',
      outcome: 'DENIED',
      subjectType,
      subjectId,
      details: { field },
    });
    throw Forbidden('You are not allowed to reveal this field');
  }

  // ------------------------------------------------------------------ helpers

  private async encryptTin(companyId: string, tin: string) {
    const normalized = normalizeTin(tin);
    return {
      enc: await this.cipher.encrypt('tin', normalized, TIN_AAD(companyId)),
      bidx: await this.cipher.blindIndex('company.tin', normalized),
      last3: normalized.slice(9, 12),
    };
  }

  /** Blind index for TIN lookups (imports, dedupe). */
  tinBlindIndex(tin: string): Promise<string> {
    return this.cipher.blindIndex('company.tin', normalizeTin(tin));
  }

  async companyDto(tx: Tx, ctx: AuthedCtx, r: CompanyRow, opts: { withContacts?: boolean } = {}) {
    const links = await tx
      .select({ propertyId: companyProperty.propertyId })
      .from(companyProperty)
      .where(eq(companyProperty.companyId, r.id));
    const [kyc] = ctx.user.permissions.has('kyc.read')
      ? await tx
          .select({ status: kycProfile.status })
          .from(kycProfile)
          .where(eq(kycProfile.companyId, r.id))
      : [];
    let contacts;
    if (opts.withContacts && ctx.user.permissions.has('contact.read')) {
      const rows = await tx
        .select({ role: companyContactRole, person })
        .from(companyContactRole)
        .innerJoin(person, eq(person.id, companyContactRole.personId))
        .where(eq(companyContactRole.companyId, r.id))
        .orderBy(desc(companyContactRole.effectiveFrom));
      contacts = rows.map(({ role, person: p }) => ({
        id: role.id,
        personId: p.id,
        fullName: p.fullName,
        role: role.role,
        title: role.title,
        emailMasked: p.email ? maskEmail(p.email) : null,
        phoneMasked: p.phone ? maskPhone(p.phone) : null,
        ownershipPct: role.ownershipPct,
        effectiveFrom: role.effectiveFrom,
        effectiveTo: role.effectiveTo,
      }));
    }
    return {
      id: r.id,
      legalName: r.legalName,
      tradeName: r.tradeName,
      registrationType: r.registrationType,
      registrationNo: r.registrationNo,
      tinMasked: r.tinLast3 ? maskTin(`000-000-000-${r.tinLast3}`) : null,
      vatStatus: r.vatStatus,
      registeredAddress: r.registeredAddress,
      industry: r.industry,
      status: r.status,
      propertyIds: links.map((l) => l.propertyId),
      kycStatus: kyc?.status ?? null,
      ...(contacts && { contacts }),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      version: r.version,
    };
  }

  personDto(r: PersonRow) {
    return {
      id: r.id,
      fullName: r.fullName,
      emailMasked: r.email ? maskEmail(r.email) : null,
      phoneMasked: r.phone ? maskPhone(r.phone) : null,
      govIdType: r.govIdType,
      govIdMasked: r.govIdLast4 ? maskGovernmentId(`0000${r.govIdLast4}`) : null,
      nationality: r.nationality,
      version: r.version,
    };
  }

  async listProperties(ctx: AuthedCtx) {
    return this.db.run(ctx, (tx) => tx.select().from(property).orderBy(asc(property.code)));
  }

  async createProperty(
    ctx: AuthedCtx,
    input: { code: string; name: string; address: string | null },
  ) {
    if (!hasGlobal(ctx, 'property.write')) throw Forbidden();
    return this.db.run(ctx, async (tx) => {
      try {
        const [row] = await tx
          .insert(property)
          .values({ ...input, createdBy: ctx.user.id })
          .returning();
        return row!;
      } catch (err) {
        if (pgCode(err) === '23505')
          throw Conflict('DUPLICATE_CODE', 'A property with this code already exists');
        throw err;
      }
    });
  }

  async companiesByIds(ctx: AuthedCtx, ids: string[]) {
    if (!ids.length) return [];
    return this.db.run(ctx, (tx) => tx.select().from(company).where(inArray(company.id, ids)));
  }
}
