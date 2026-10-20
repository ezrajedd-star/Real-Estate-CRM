import { OptionalText, Text, Tin, Uuid, z } from './common.js';
import { Email, GovIdType, Phone, RegistrationType, VatStatus } from './contacts.js';

export const IMPORT_TYPES = ['companies', 'contacts'] as const;
export const ImportType = z.enum(IMPORT_TYPES);
export type ImportType = z.infer<typeof ImportType>;

export const MAX_IMPORT_ROWS = 5000;

/**
 * Row schemas for Excel imports. Column headers are matched case-insensitively against
 * the keys below (spaces → underscores), e.g. "Legal Name" → legal_name.
 */
export const CompanyImportRow = z.object({
  legal_name: Text(300, 2),
  trade_name: OptionalText(300),
  registration_type: RegistrationType,
  registration_no: OptionalText(50),
  tin: Tin.optional()
    .nullable()
    .transform((v) => v || null),
  vat_status: VatStatus.default('VAT'),
  registered_address: OptionalText(500),
  industry: OptionalText(100),
});
export type CompanyImportRow = z.infer<typeof CompanyImportRow>;

export const ContactImportRow = z.object({
  company_tin: Tin,
  full_name: Text(200, 2),
  role: z.enum([
    'SIGNATORY',
    'BILLING_CONTACT',
    'GUARANTOR',
    'BENEFICIAL_OWNER',
    'OPERATIONS_CONTACT',
    'PRIMARY_CONTACT',
  ]),
  title: OptionalText(100),
  email: Email.optional().nullable(),
  phone: Phone.optional().nullable(),
  gov_id_type: GovIdType.optional().nullable(),
  gov_id: z.string().trim().min(4).max(40).optional().nullable(),
});
export type ContactImportRow = z.infer<typeof ContactImportRow>;

export const IMPORT_ROW_SCHEMAS = {
  companies: CompanyImportRow,
  contacts: ContactImportRow,
} as const;

export const CreateImportRequest = z
  .object({ importType: ImportType, documentId: Uuid, propertyId: Uuid.optional().nullable() })
  .openapi('CreateImportRequest');

export const ImportRowErrorDto = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
});

export const ImportBatchDto = z
  .object({
    id: Uuid,
    importType: ImportType,
    status: z.enum([
      'UPLOADED',
      'VALIDATING',
      'VALIDATED',
      'COMMITTING',
      'COMMITTED',
      'FAILED',
      'CANCELLED',
    ]),
    totalRows: z.number().int(),
    validRows: z.number().int(),
    errorRows: z.number().int(),
    failure: z.string().nullable(),
    createdAt: z.string().datetime(),
    committedAt: z.string().datetime().nullable(),
  })
  .openapi('ImportBatch');

export const ImportPreviewDto = z
  .object({
    batch: ImportBatchDto,
    rows: z.array(
      z.object({
        rowNumber: z.number().int(),
        preview: z
          .record(z.string().nullable())
          .describe('Row values with sensitive fields masked'),
        errors: z.array(ImportRowErrorDto),
        targetId: Uuid.nullable(),
      }),
    ),
  })
  .openapi('ImportPreview');

export const CreateExportRequest = z
  .object({
    kind: z.enum(['companies']),
    filters: z
      .object({ propertyId: Uuid.optional(), status: z.string().max(30).optional() })
      .default({}),
    justification: Text(500, 10),
  })
  .openapi('CreateExportRequest');
