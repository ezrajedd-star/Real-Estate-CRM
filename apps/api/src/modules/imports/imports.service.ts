import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  type Tx,
  company,
  companyContactRole,
  companyProperty,
  importBatch,
  importRow,
  person,
  uuidv7,
} from '@crm/db';
import {
  CompanyImportRow,
  ContactImportRow,
  IMPORT_ROW_SCHEMAS,
  MAX_IMPORT_ROWS,
  type ImportType,
} from '@crm/contracts';
import {
  canAccess,
  maskEmail,
  maskGovernmentId,
  maskPhone,
  maskTin,
  normalizeTin,
} from '@crm/domain';
import type { FieldCipher } from '@crm/platform';
import type { AuthedCtx } from '../../common/context.js';
import { BadRequest, Conflict, Forbidden, NotFound, pgCode } from '../../common/errors.js';
import { CIPHER } from '../../common/tokens.js';
import { AuditService } from '../../infra/audit.service.js';
import { DbService } from '../../infra/db.service.js';
import { DocumentsService } from '../documents/index.js';
import { hasGlobal } from '../contacts/index.js';
import { parseWorkbook } from './xlsx.js';

type RowError = { field: string; code: string; message: string };
const ROW_AAD = (id: string) => ({ table: 'imports.import_row', column: 'data_enc', rowId: id });
const SENSITIVE_IMPORT_FIELDS = new Set(['tin', 'company_tin', 'gov_id', 'email', 'phone']);

/**
 * Excel import framework (brief §4.12): upload → validate (preview with per-row errors) →
 * commit. Raw rows are stored encrypted (they can hold TINs). Commit is transactional and
 * idempotent: committed rows record their target id and are skipped on retry.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    @Inject(CIPHER) private readonly cipher: FieldCipher,
  ) {}

  async create(
    ctx: AuthedCtx,
    input: { importType: ImportType; documentId: string; propertyId?: string | null },
  ) {
    const global = hasGlobal(ctx, 'company.write');
    if (input.importType === 'companies' && !global) {
      if (!input.propertyId)
        throw BadRequest('PROPERTY_REQUIRED', 'Choose the property these companies belong to');
      if (!canAccess(ctx.user.grants, 'company.write', { propertyIds: [input.propertyId] }))
        throw Forbidden();
    }
    const doc = await this.documents.get(ctx, input.documentId);
    if (doc.contentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      throw BadRequest('NOT_XLSX', 'Imports must be .xlsx workbooks');
    }
    return this.db.run(ctx, async (tx) => {
      const [row] = await tx
        .insert(importBatch)
        .values({
          importType: input.importType,
          documentId: input.documentId,
          propertyId: input.propertyId ?? null,
          createdBy: ctx.user.id,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'import.created',
        subjectType: 'import_batch',
        subjectId: row!.id,
        details: { importType: input.importType },
      });
      return this.batchDto(row!);
    });
  }

  async validate(ctx: AuthedCtx, batchId: string) {
    const batch = await this.loadBatch(ctx, batchId);
    // Validation runs once per batch; a corrected file is a new import (rows are never deleted).
    if (!['UPLOADED', 'FAILED'].includes(batch.status)) {
      throw Conflict('BAD_STATE', `Cannot validate an import that is ${batch.status}`);
    }
    const { bytes } = await this.documents.readClean(ctx, batch.documentId);
    let parsed;
    try {
      parsed = await parseWorkbook(bytes, MAX_IMPORT_ROWS);
    } catch (err) {
      await this.db.run(ctx, (tx) =>
        tx
          .update(importBatch)
          .set({ status: 'FAILED', failure: (err as Error).message })
          .where(eq(importBatch.id, batchId)),
      );
      throw BadRequest('UNREADABLE_WORKBOOK', (err as Error).message);
    }

    const schema = IMPORT_ROW_SCHEMAS[batch.importType as ImportType];
    const seenKeys = new Map<string, number>();
    const prepared: Array<{ id: string; rowNumber: number; dataEnc: string; errors: RowError[] }> =
      [];

    for (const r of parsed.rows) {
      const result = schema.safeParse(r.values);
      const errors: RowError[] = result.success
        ? []
        : result.error.issues.map((i) => ({
            field: String(i.path[0] ?? ''),
            code: i.code,
            message: i.message,
          }));
      if (result.success) {
        const dupKey = await this.duplicateKey(batch.importType as ImportType, result.data);
        if (dupKey) {
          const first = seenKeys.get(dupKey);
          if (first)
            errors.push({
              field: batch.importType === 'companies' ? 'tin' : 'email',
              code: 'duplicate_in_file',
              message: `Duplicate of row ${first}`,
            });
          else seenKeys.set(dupKey, r.rowNumber);
        }
      }
      const id = uuidv7();
      prepared.push({
        id,
        rowNumber: r.rowNumber,
        dataEnc: await this.cipher.encrypt('import', JSON.stringify(r.values), ROW_AAD(id)),
        errors,
      });
    }

    // Cross-check against existing data (TIN already registered / company TIN unknown).
    if (batch.importType === 'companies') {
      const bidxByRow = new Map<number, string>();
      for (const p of prepared) {
        const parsedRow = CompanyImportRow.safeParse(
          parsed.rows.find((x) => x.rowNumber === p.rowNumber)!.values,
        );
        if (parsedRow.success && parsedRow.data.tin)
          bidxByRow.set(
            p.rowNumber,
            await this.cipher.blindIndex('company.tin', normalizeTin(parsedRow.data.tin)),
          );
      }
      const existing = new Set(await this.existingTinIndexes(ctx, [...bidxByRow.values()]));
      for (const p of prepared) {
        const b = bidxByRow.get(p.rowNumber);
        if (b && existing.has(b))
          p.errors.push({
            field: 'tin',
            code: 'already_registered',
            message: 'A company with this TIN is already registered',
          });
      }
    }

    const errorRows = prepared.filter((p) => p.errors.length).length;
    await this.db.run(ctx, async (tx) => {
      const already = await tx
        .select({ id: importRow.id })
        .from(importRow)
        .where(eq(importRow.batchId, batchId))
        .limit(1);
      if (already.length)
        throw Conflict(
          'ALREADY_VALIDATED',
          'This import was already validated. Upload a corrected file as a new import.',
        );
      for (let i = 0; i < prepared.length; i += 500) {
        await tx
          .insert(importRow)
          .values(prepared.slice(i, i + 500).map((p) => ({ ...p, batchId })));
      }
      await tx
        .update(importBatch)
        .set({
          status: 'VALIDATED',
          totalRows: prepared.length,
          validRows: prepared.length - errorRows,
          errorRows,
          failure: null,
        })
        .where(eq(importBatch.id, batchId));
      await this.audit.record(tx, {
        action: 'import.validated',
        subjectType: 'import_batch',
        subjectId: batchId,
        details: { total: prepared.length, errorRows },
      });
    });
    return this.preview(ctx, batchId);
  }

  async preview(ctx: AuthedCtx, batchId: string) {
    const batch = await this.loadBatch(ctx, batchId);
    const rows = await this.db.run(ctx, (tx) =>
      tx
        .select()
        .from(importRow)
        .where(eq(importRow.batchId, batchId))
        .orderBy(asc(importRow.rowNumber))
        .limit(1000),
    );
    const out = [];
    for (const r of rows) {
      const values = JSON.parse(await this.cipher.decrypt(r.dataEnc, ROW_AAD(r.id))) as Record<
        string,
        string | null
      >;
      out.push({
        rowNumber: r.rowNumber,
        preview: maskRow(values),
        errors: r.errors,
        targetId: r.targetId,
      });
    }
    return { batch: this.batchDto(batch), rows: out };
  }

  async commit(ctx: AuthedCtx, batchId: string) {
    const batch = await this.loadBatch(ctx, batchId);
    if (batch.status === 'COMMITTED') return this.preview(ctx, batchId); // idempotent
    if (batch.status !== 'VALIDATED')
      throw Conflict('BAD_STATE', 'Validate the import before committing');
    if (batch.errorRows > 0)
      throw Conflict('HAS_ERRORS', 'Fix the rows with errors and import the corrected file');

    await this.db.run(ctx, async (tx) => {
      // Lock the batch row so two concurrent commits cannot both run.
      const [locked] = await tx
        .select()
        .from(importBatch)
        .where(eq(importBatch.id, batchId))
        .for('update');
      if (locked!.status !== 'VALIDATED')
        throw Conflict('BAD_STATE', 'This import is already being committed');
      await tx.update(importBatch).set({ status: 'COMMITTING' }).where(eq(importBatch.id, batchId));
      const rows = await tx
        .select()
        .from(importRow)
        .where(and(eq(importRow.batchId, batchId), isNull(importRow.targetId)))
        .orderBy(asc(importRow.rowNumber));
      for (const r of rows) {
        const values = JSON.parse(await this.cipher.decrypt(r.dataEnc, ROW_AAD(r.id))) as Record<
          string,
          string | null
        >;
        let targetId: string;
        try {
          targetId =
            locked!.importType === 'companies'
              ? await this.commitCompany(
                  tx,
                  ctx,
                  CompanyImportRow.parse(values),
                  locked!.propertyId,
                )
              : await this.commitContact(tx, ctx, ContactImportRow.parse(values));
        } catch (err) {
          if (pgCode(err) === '23505') {
            throw Conflict(
              'DUPLICATE_ROW',
              `Row ${r.rowNumber} duplicates an existing record (registered since validation)`,
            );
          }
          throw err;
        }
        await tx.update(importRow).set({ targetId }).where(eq(importRow.id, r.id));
      }
      await tx
        .update(importBatch)
        .set({ status: 'COMMITTED', committedAt: new Date() })
        .where(eq(importBatch.id, batchId));
      await this.audit.record(tx, {
        action: 'import.committed',
        subjectType: 'import_batch',
        subjectId: batchId,
        details: { rows: rows.length },
      });
    });
    return this.preview(ctx, batchId);
  }

  private async commitCompany(
    tx: Tx,
    ctx: AuthedCtx,
    row: CompanyImportRow,
    propertyId: string | null,
  ): Promise<string> {
    const id = uuidv7();
    let tin = null;
    if (row.tin) {
      const normalized = normalizeTin(row.tin);
      tin = {
        tinEnc: await this.cipher.encrypt('tin', normalized, {
          table: 'contacts.company',
          column: 'tin_enc',
          rowId: id,
        }),
        tinBidx: await this.cipher.blindIndex('company.tin', normalized),
        tinLast3: normalized.slice(9, 12),
      };
    }
    await tx.insert(company).values({
      id,
      legalName: row.legal_name,
      tradeName: row.trade_name,
      registrationType: row.registration_type,
      registrationNo: row.registration_no,
      vatStatus: row.vat_status,
      registeredAddress: row.registered_address,
      industry: row.industry,
      createdBy: ctx.user.id,
      ...(tin ?? {}),
    });
    if (propertyId)
      await tx
        .insert(companyProperty)
        .values({ companyId: id, propertyId, relation: 'TENANT', createdBy: ctx.user.id });
    return id;
  }

  private async commitContact(tx: Tx, ctx: AuthedCtx, row: ContactImportRow): Promise<string> {
    const bidx = await this.cipher.blindIndex('company.tin', normalizeTin(row.company_tin));
    const [co] = await tx.select({ id: company.id }).from(company).where(eq(company.tinBidx, bidx));
    if (!co)
      throw Conflict(
        'COMPANY_NOT_FOUND',
        'A contact row refers to a company TIN that is not registered or not in your scope',
      );
    const id = uuidv7();
    let gov = null;
    if (row.gov_id && row.gov_id_type) {
      const normalized = row.gov_id.replace(/[\s-]/g, '').toUpperCase();
      gov = {
        govIdType: row.gov_id_type,
        govIdEnc: await this.cipher.encrypt('gov_id', row.gov_id, {
          table: 'contacts.person',
          column: 'gov_id_enc',
          rowId: id,
        }),
        govIdBidx: await this.cipher.blindIndex(`person.gov_id.${row.gov_id_type}`, normalized),
        govIdLast4: normalized.slice(-4),
      };
    }
    await tx.insert(person).values({
      id,
      fullName: row.full_name,
      email: row.email ?? null,
      phone: row.phone ?? null,
      createdBy: ctx.user.id,
      ...(gov ?? {}),
    });
    await tx.insert(companyContactRole).values({
      companyId: co.id,
      personId: id,
      role: row.role,
      title: row.title,
      createdBy: ctx.user.id,
    });
    return id;
  }

  private async duplicateKey(type: ImportType, data: unknown): Promise<string | null> {
    if (type === 'companies') {
      const tin = (data as CompanyImportRow).tin;
      return tin ? `tin:${normalizeTin(tin)}` : null;
    }
    const c = data as ContactImportRow;
    return c.email ? `email:${normalizeTin(c.company_tin)}:${c.email.toLowerCase()}` : null;
  }

  /**
   * Which of these TIN blind indexes already exist — across ALL companies, not just the
   * caller's scope, because the unique index is global (contacts.existing_tin_bidx is a
   * narrow SECURITY DEFINER function returning only the matching indexes, no rows).
   */
  private async existingTinIndexes(ctx: AuthedCtx, bidx: string[]): Promise<string[]> {
    if (!bidx.length) return [];
    const res = await this.db.run(ctx, (tx) =>
      // Blind indexes are hex strings, so a comma-joined list is unambiguous.
      tx.execute<{ bidx: string }>(
        sql`SELECT bidx FROM contacts.existing_tin_bidx(string_to_array(${bidx.join(',')}, ',')) AS bidx`,
      ),
    );
    return res.rows.map((r) => r.bidx);
  }

  private async loadBatch(ctx: AuthedCtx, id: string) {
    const [row] = await this.db.run(ctx, (tx) =>
      tx.select().from(importBatch).where(eq(importBatch.id, id)),
    );
    if (!row) throw NotFound('Import');
    return row;
  }

  private batchDto(b: typeof importBatch.$inferSelect) {
    return {
      id: b.id,
      importType: b.importType as ImportType,
      status: b.status,
      totalRows: b.totalRows,
      validRows: b.validRows,
      errorRows: b.errorRows,
      failure: b.failure,
      createdAt: b.createdAt.toISOString(),
      committedAt: b.committedAt?.toISOString() ?? null,
    };
  }
}

/** Preview values with sensitive columns masked — the preview never shows clear PII. */
export function maskRow(values: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === null || !SENSITIVE_IMPORT_FIELDS.has(k)) {
      out[k] = v;
      continue;
    }
    if (k === 'email') out[k] = maskEmail(v);
    else if (k === 'phone') out[k] = maskPhone(v);
    else if (k === 'gov_id') out[k] = maskGovernmentId(v);
    else out[k] = maskTin(v);
  }
  return out;
}
