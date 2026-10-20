import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const crypto = pgSchema('crypto');
export const config = pgSchema('config');
export const approvals = pgSchema('approvals');
export const documents = pgSchema('documents');
export const imports = pgSchema('imports');
export const exportsSchema = pgSchema('exports');

export const dataKey = crypto.table('data_key', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  purpose: text('purpose').notNull(),
  version: integer('version').notNull().default(1),
  kekId: text('kek_id').notNull(),
  wrappedKey: text('wrapped_key').notNull(),
  status: text('status', { enum: ['ACTIVE', 'DECRYPT_ONLY', 'RETIRED'] })
    .notNull()
    .default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const configValue = config.table('config_value', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  key: text('key').notNull(),
  scopeType: text('scope_type', { enum: ['GLOBAL', 'PROPERTY', 'COMPANY'] })
    .notNull()
    .default('GLOBAL'),
  scopeId: uuid('scope_id'),
  value: jsonb('value').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  needsConfirmation: boolean('needs_confirmation').notNull().default(true),
  notes: text('notes'),
  approvalRequestId: uuid('approval_request_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const taxRate = config.table('tax_rate', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  taxType: text('tax_type').notNull(),
  rate: numeric('rate', { precision: 9, scale: 6 }),
  brackets: jsonb('brackets'),
  basis: text('basis').notNull(),
  sourceReference: text('source_reference'),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  needsConfirmation: boolean('needs_confirmation').notNull(),
  approvalRequestId: uuid('approval_request_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

export const featureFlag = config.table('feature_flag', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  description: text('description').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export const approvalRequest = approvals.table('approval_request', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  type: text('type').notNull(),
  subjectType: text('subject_type'),
  subjectId: text('subject_id'),
  summary: text('summary').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  makerId: uuid('maker_id').notNull(),
  status: text('status', { enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] })
    .notNull()
    .default('PENDING'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
});

export const approvalDecision = approvals.table('approval_decision', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  requestId: uuid('request_id').notNull(),
  stepIndex: integer('step_index').notNull(),
  deciderId: uuid('decider_id').notNull(),
  decision: text('decision', { enum: ['APPROVE', 'REJECT'] }).notNull(),
  comment: text('comment'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
});

export const document = documents.table('document', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  companyId: uuid('company_id'),
  ownerType: text('owner_type').notNull(),
  ownerId: uuid('owner_id').notNull(),
  category: text('category').notNull(),
  classification: text('classification', { enum: ['GENERAL', 'SENSITIVE'] })
    .notNull()
    .default('GENERAL'),
  originalName: text('original_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256'),
  storageKey: text('storage_key').notNull(),
  status: text('status', {
    enum: ['PENDING_UPLOAD', 'QUARANTINED', 'CLEAN', 'INFECTED', 'REJECTED'],
  })
    .notNull()
    .default('PENDING_UPLOAD'),
  scanDetail: text('scan_detail'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }),
  uploadedBy: uuid('uploaded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
});

export const importBatch = imports.table('import_batch', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  importType: text('import_type').notNull(),
  documentId: uuid('document_id').notNull(),
  propertyId: uuid('property_id'),
  status: text('status', {
    enum: ['UPLOADED', 'VALIDATING', 'VALIDATED', 'COMMITTING', 'COMMITTED', 'FAILED', 'CANCELLED'],
  })
    .notNull()
    .default('UPLOADED'),
  totalRows: integer('total_rows').notNull().default(0),
  validRows: integer('valid_rows').notNull().default(0),
  errorRows: integer('error_rows').notNull().default(0),
  failure: text('failure'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
});

export interface ImportRowError {
  field: string;
  code: string;
  message: string;
}

export const importRow = imports.table('import_row', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  batchId: uuid('batch_id').notNull(),
  rowNumber: integer('row_number').notNull(),
  dataEnc: text('data_enc').notNull(),
  errors: jsonb('errors').$type<ImportRowError[]>().notNull().default([]),
  targetId: uuid('target_id'),
});

export const exportJob = exportsSchema.table('export_job', {
  id: uuid('id')
    .primaryKey()
    .default(sql`app.uuid_v7()`),
  kind: text('kind').notNull(),
  filters: jsonb('filters').$type<Record<string, unknown>>().notNull().default({}),
  approvalRequestId: uuid('approval_request_id').notNull(),
  rowCount: integer('row_count'),
  watermark: text('watermark'),
  requestedBy: uuid('requested_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  downloadedAt: timestamp('downloaded_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '24 hours'`),
});
