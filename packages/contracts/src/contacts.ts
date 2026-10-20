import { LocalDateString, OptionalText, Reason, Text, Tin, Uuid, Version, z } from './common.js';

export const RegistrationType = z.enum(['SEC', 'DTI', 'CDA', 'GOVERNMENT', 'FOREIGN', 'OTHER']);
export const VatStatus = z.enum(['VAT', 'NON_VAT', 'VAT_EXEMPT', 'ZERO_RATED']);
export const CompanyStatus = z.enum(['PROSPECT', 'TENANT', 'FORMER_TENANT', 'BLOCKED']);
export const ContactRole = z.enum([
  'SIGNATORY',
  'BILLING_CONTACT',
  'GUARANTOR',
  'BENEFICIAL_OWNER',
  'OPERATIONS_CONTACT',
  'PRIMARY_CONTACT',
]);
export const GovIdType = z.enum([
  'PASSPORT',
  'DRIVERS_LICENSE',
  'UMID',
  'PHILSYS',
  'PRC',
  'POSTAL',
  'TIN',
  'OTHER',
]);

export const Email = z.string().trim().toLowerCase().email().max(254);
export const Phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, 'Phone may contain digits, spaces, (), - and a leading +');

export const CreateCompanyRequest = z
  .object({
    legalName: Text(300, 2),
    tradeName: OptionalText(300),
    registrationType: RegistrationType,
    registrationNo: OptionalText(50),
    tin: Tin.optional().nullable(),
    vatStatus: VatStatus.default('VAT'),
    registeredAddress: OptionalText(500),
    industry: OptionalText(100),
    propertyId: Uuid.optional().openapi({
      description:
        'Required for property-scoped users: the property this company is a prospect/tenant for',
    }),
  })
  .openapi('CreateCompanyRequest');
export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequest>;

export const UpdateCompanyRequest = z
  .object({
    version: Version,
    legalName: Text(300, 2).optional(),
    tradeName: OptionalText(300),
    registrationType: RegistrationType.optional(),
    registrationNo: OptionalText(50),
    tin: Tin.optional().nullable(),
    vatStatus: VatStatus.optional(),
    registeredAddress: OptionalText(500),
    industry: OptionalText(100),
    status: CompanyStatus.optional(),
  })
  .openapi('UpdateCompanyRequest');

export const CompanyContactDto = z.object({
  id: Uuid,
  personId: Uuid,
  fullName: z.string(),
  role: ContactRole,
  title: z.string().nullable(),
  emailMasked: z.string().nullable(),
  phoneMasked: z.string().nullable(),
  ownershipPct: z.string().nullable(),
  effectiveFrom: LocalDateString,
  effectiveTo: LocalDateString.nullable(),
});

export const CompanyDto = z
  .object({
    id: Uuid,
    legalName: z.string(),
    tradeName: z.string().nullable(),
    registrationType: RegistrationType,
    registrationNo: z.string().nullable(),
    tinMasked: z.string().nullable().openapi({ example: '•••-•••-•••-000' }),
    vatStatus: VatStatus,
    registeredAddress: z.string().nullable(),
    industry: z.string().nullable(),
    status: CompanyStatus,
    propertyIds: z.array(Uuid),
    kycStatus: z.string().nullable(),
    contacts: z.array(CompanyContactDto).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    version: z.number().int(),
  })
  .openapi('Company');

export const CompanySearchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  propertyId: Uuid.optional(),
  status: CompanyStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const RevealRequest = z
  .object({ field: z.enum(['tin', 'gov_id', 'email', 'phone', 'bank_account']), reason: Reason })
  .openapi('RevealRequest');

export const RevealResponse = z
  .object({ field: z.string(), value: z.string().nullable(), revealedAt: z.string().datetime() })
  .openapi('RevealResponse');

export const LinkPropertyRequest = z.object({
  propertyId: Uuid,
  relation: z.enum(['PROSPECT', 'TENANT', 'FORMER_TENANT']).default('PROSPECT'),
});

export const CreatePersonRequest = z
  .object({
    fullName: Text(200, 2),
    email: Email.optional().nullable(),
    phone: Phone.optional().nullable(),
    govIdType: GovIdType.optional().nullable(),
    govId: z.string().trim().min(4).max(40).optional().nullable(),
    nationality: OptionalText(60),
  })
  .refine((v) => !v.govId === !v.govIdType, {
    message: 'govId and govIdType go together',
    path: ['govIdType'],
  })
  .openapi('CreatePersonRequest');

export const PersonDto = z
  .object({
    id: Uuid,
    fullName: z.string(),
    emailMasked: z.string().nullable(),
    phoneMasked: z.string().nullable(),
    govIdType: GovIdType.nullable(),
    govIdMasked: z.string().nullable(),
    nationality: z.string().nullable(),
    version: z.number().int(),
  })
  .openapi('Person');

export const PersonSearchRequest = z
  .object({ email: Email.optional(), name: z.string().trim().min(2).max(100).optional() })
  .refine((v) => v.email || v.name, 'Provide email or name')
  .openapi('PersonSearchRequest', { description: 'Sent in the body so PII never appears in URLs' });

export const AddContactRoleRequest = z
  .object({
    personId: Uuid,
    role: ContactRole,
    title: OptionalText(100),
    authorityDocumentId: Uuid.optional().nullable(),
    ownershipPct: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/)
      .optional()
      .nullable(),
    effectiveFrom: LocalDateString.optional(),
  })
  .refine((v) => v.role === 'BENEFICIAL_OWNER' || !v.ownershipPct, {
    message: 'Ownership % applies to beneficial owners only',
    path: ['ownershipPct'],
  });

export const EndContactRoleRequest = z.object({ effectiveTo: LocalDateString });

export const KycDto = z
  .object({
    companyId: Uuid,
    status: z.enum(['PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED']),
    riskRating: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable(),
    hasFinancials: z.boolean(),
    notes: z.string().nullable(),
    reviewedBy: Uuid.nullable(),
    reviewedAt: z.string().datetime().nullable(),
    nextReviewOn: LocalDateString.nullable(),
    version: z.number().int(),
  })
  .openapi('Kyc');

export const UpsertKycRequest = z
  .object({
    version: Version.optional(),
    status: z.enum(['PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED']),
    riskRating: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable().optional(),
    notes: OptionalText(4000),
    nextReviewOn: LocalDateString.nullable().optional(),
    financialsSummary: z
      .string()
      .max(20_000)
      .optional()
      .openapi({ description: 'Stored encrypted' }),
  })
  .openapi('UpsertKycRequest');

export const CreateBankAccountRequest = z
  .object({
    bankName: Text(100),
    accountName: Text(200),
    accountNo: z
      .string()
      .trim()
      .regex(/^[0-9 -]{6,30}$/, 'Digits, spaces and dashes only'),
    purpose: z.enum(['REFUND', 'OTHER']).default('REFUND'),
  })
  .openapi('CreateBankAccountRequest');

export const BankAccountDto = z
  .object({
    id: Uuid,
    bankName: z.string(),
    accountName: z.string(),
    accountNoMasked: z.string(),
    purpose: z.enum(['REFUND', 'OTHER']),
    createdAt: z.string().datetime(),
  })
  .openapi('BankAccount');

export const PrivacyNoticeDto = z
  .object({
    id: Uuid,
    versionLabel: z.string(),
    audience: z.enum(['TENANT_CONTACT', 'BROKER', 'PROSPECT', 'STAFF']),
    title: z.string(),
    bodyMarkdown: z.string(),
    effectiveFrom: LocalDateString,
    publishedAt: z.string().datetime(),
  })
  .openapi('PrivacyNotice');

export const PublishNoticeRequest = z
  .object({
    versionLabel: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
    audience: z.enum(['TENANT_CONTACT', 'BROKER', 'PROSPECT', 'STAFF']),
    title: Text(200),
    bodyMarkdown: z.string().min(50).max(100_000),
    effectiveFrom: LocalDateString,
  })
  .openapi('PublishNoticeRequest');

export const CaptureConsentRequest = z
  .object({
    noticeId: Uuid,
    purpose: z.enum([
      'LEASE_ADMINISTRATION',
      'BILLING_AND_COLLECTION',
      'KYC_AML',
      'MARKETING',
      'TENANT_REMINDERS',
    ]),
    lawfulBasis: z.enum(['CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'LEGITIMATE_INTEREST']),
    action: z.enum(['GRANTED', 'WITHDRAWN', 'ACKNOWLEDGED']),
    channel: z.enum(['PAPER', 'EMAIL', 'PORTAL', 'IN_PERSON', 'IMPORT']),
    evidenceDocumentId: Uuid.optional().nullable(),
  })
  .refine(
    (v) => v.lawfulBasis === 'CONSENT' || v.action !== 'GRANTED' || v.purpose !== 'MARKETING',
    {
      message: 'Marketing requires consent as its lawful basis',
      path: ['lawfulBasis'],
    },
  )
  .openapi('CaptureConsentRequest');

export const ConsentDto = z
  .object({
    id: Uuid,
    noticeId: Uuid,
    purpose: z.string(),
    lawfulBasis: z.string(),
    action: z.string(),
    channel: z.string(),
    capturedAt: z.string().datetime(),
    capturedBy: Uuid.nullable(),
  })
  .openapi('Consent');

export const PropertyDto = z
  .object({ id: Uuid, code: z.string(), name: z.string(), address: z.string().nullable() })
  .openapi('Property');

export const CreatePropertyRequest = z
  .object({
    code: z.string().regex(/^[A-Z0-9-]{2,20}$/),
    name: Text(200),
    address: OptionalText(500),
  })
  .openapi('CreatePropertyRequest');
