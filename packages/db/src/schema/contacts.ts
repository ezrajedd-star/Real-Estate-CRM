import { date, integer, numeric, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const properties = pgSchema('properties');
export const contacts = pgSchema('contacts');

export const property = properties.table('property', {
  id: uuid('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  address: text('address'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull(),
});

export const REGISTRATION_TYPES = ['SEC', 'DTI', 'CDA', 'GOVERNMENT', 'FOREIGN', 'OTHER'] as const;
export const VAT_STATUSES = ['VAT', 'NON_VAT', 'VAT_EXEMPT', 'ZERO_RATED'] as const;
export const COMPANY_STATUSES = ['PROSPECT', 'TENANT', 'FORMER_TENANT', 'BLOCKED'] as const;

export const company = contacts.table('company', {
  id: uuid('id').primaryKey(),
  legalName: text('legal_name').notNull(),
  tradeName: text('trade_name'),
  registrationType: text('registration_type', { enum: REGISTRATION_TYPES }).notNull(),
  registrationNo: text('registration_no'),
  tinEnc: text('tin_enc'),
  tinBidx: text('tin_bidx'),
  tinLast3: text('tin_last3'),
  vatStatus: text('vat_status', { enum: VAT_STATUSES }).notNull(),
  registeredAddress: text('registered_address'),
  industry: text('industry'),
  status: text('status', { enum: COMPANY_STATUSES }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull(),
});

export const companyProperty = contacts.table('company_property', {
  companyId: uuid('company_id').notNull(),
  propertyId: uuid('property_id').notNull(),
  relation: text('relation', { enum: ['PROSPECT', 'TENANT', 'FORMER_TENANT'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by'),
});

export const GOV_ID_TYPES = [
  'PASSPORT',
  'DRIVERS_LICENSE',
  'UMID',
  'PHILSYS',
  'PRC',
  'POSTAL',
  'TIN',
  'OTHER',
] as const;

export const person = contacts.table('person', {
  id: uuid('id').primaryKey(),
  fullName: text('full_name').notNull(),
  email: text('email'),
  phone: text('phone'),
  govIdType: text('gov_id_type', { enum: GOV_ID_TYPES }),
  govIdEnc: text('gov_id_enc'),
  govIdBidx: text('gov_id_bidx'),
  govIdLast4: text('gov_id_last4'),
  nationality: text('nationality'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull(),
});

export const CONTACT_ROLES = [
  'SIGNATORY',
  'BILLING_CONTACT',
  'GUARANTOR',
  'BENEFICIAL_OWNER',
  'OPERATIONS_CONTACT',
  'PRIMARY_CONTACT',
] as const;

export const companyContactRole = contacts.table('company_contact_role', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull(),
  personId: uuid('person_id').notNull(),
  role: text('role', { enum: CONTACT_ROLES }).notNull(),
  title: text('title'),
  authorityDocumentId: uuid('authority_document_id'),
  ownershipPct: numeric('ownership_pct', { precision: 5, scale: 2 }),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by'),
});

export const kycProfile = contacts.table('kyc_profile', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull(),
  status: text('status', {
    enum: ['PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED'],
  }).notNull(),
  riskRating: text('risk_rating', { enum: ['LOW', 'MEDIUM', 'HIGH'] }),
  financialsEnc: text('financials_enc'),
  notes: text('notes'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  nextReviewOn: date('next_review_on'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull(),
});

export const bankAccount = contacts.table('bank_account', {
  id: uuid('id').primaryKey(),
  companyId: uuid('company_id').notNull(),
  bankName: text('bank_name').notNull(),
  accountName: text('account_name').notNull(),
  accountNoEnc: text('account_no_enc').notNull(),
  accountNoBidx: text('account_no_bidx').notNull(),
  accountNoLast4: text('account_no_last4').notNull(),
  purpose: text('purpose', { enum: ['REFUND', 'OTHER'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  version: integer('version').notNull(),
});

export const privacyNotice = contacts.table('privacy_notice', {
  id: uuid('id').primaryKey(),
  versionLabel: text('version_label').notNull(),
  audience: text('audience', { enum: ['TENANT_CONTACT', 'BROKER', 'PROSPECT', 'STAFF'] }).notNull(),
  title: text('title').notNull(),
  bodyMarkdown: text('body_markdown').notNull(),
  bodySha256: text('body_sha256').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  publishedBy: uuid('published_by'),
});

export const CONSENT_PURPOSES = [
  'LEASE_ADMINISTRATION',
  'BILLING_AND_COLLECTION',
  'KYC_AML',
  'MARKETING',
  'TENANT_REMINDERS',
] as const;
export const LAWFUL_BASES = [
  'CONSENT',
  'CONTRACT',
  'LEGAL_OBLIGATION',
  'LEGITIMATE_INTEREST',
] as const;

export const consent = contacts.table('consent', {
  id: uuid('id').primaryKey(),
  personId: uuid('person_id').notNull(),
  noticeId: uuid('notice_id').notNull(),
  purpose: text('purpose', { enum: CONSENT_PURPOSES }).notNull(),
  lawfulBasis: text('lawful_basis', { enum: LAWFUL_BASES }).notNull(),
  action: text('action', { enum: ['GRANTED', 'WITHDRAWN', 'ACKNOWLEDGED'] }).notNull(),
  channel: text('channel', { enum: ['PAPER', 'EMAIL', 'PORTAL', 'IN_PERSON', 'IMPORT'] }).notNull(),
  evidenceDocumentId: uuid('evidence_document_id'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  capturedBy: uuid('captured_by'),
});
