import { Text, Uuid, z } from './common.js';

/**
 * File-type allowlist and size limits (brief §8.1). Content is re-checked by magic bytes in
 * the scan worker; the declared type is never trusted on its own.
 */
export const ALLOWED_CONTENT_TYPES = {
  'application/pdf': { ext: ['pdf'], maxBytes: 25 * 1024 * 1024 },
  'image/jpeg': { ext: ['jpg', 'jpeg'], maxBytes: 15 * 1024 * 1024 },
  'image/png': { ext: ['png'], maxBytes: 15 * 1024 * 1024 },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    ext: ['xlsx'],
    maxBytes: 10 * 1024 * 1024,
  },
} as const;
export type AllowedContentType = keyof typeof ALLOWED_CONTENT_TYPES;

export const DOCUMENT_CATEGORIES = [
  'SEC_REGISTRATION',
  'DTI_REGISTRATION',
  'BIR_COR',
  'BOARD_RESOLUTION',
  'SECRETARY_CERTIFICATE',
  'GOV_ID',
  'FINANCIAL_STATEMENT',
  'CONSENT_FORM',
  'IMPORT_FILE',
  'OTHER',
] as const;

/** Categories that always hold sensitive personal or financial data. */
export const SENSITIVE_CATEGORIES: readonly string[] = ['GOV_ID', 'FINANCIAL_STATEMENT'];

export const InitiateUploadRequest = z
  .object({
    ownerType: z.enum(['company', 'person', 'kyc_profile', 'import_batch', 'consent']),
    ownerId: Uuid,
    companyId: Uuid.optional().nullable(),
    category: z.enum(DOCUMENT_CATEGORIES),
    classification: z.enum(['GENERAL', 'SENSITIVE']).default('GENERAL'),
    originalName: Text(200).refine(
      (n) => !/[/\\]/.test(n),
      'File name must not contain path separators',
    ),
    contentType: z.enum(
      Object.keys(ALLOWED_CONTENT_TYPES) as [AllowedContentType, ...AllowedContentType[]],
    ),
    sizeBytes: z.number().int().positive(),
  })
  .superRefine((v, ctx) => {
    const rule = ALLOWED_CONTENT_TYPES[v.contentType];
    if (v.sizeBytes > rule.maxBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['sizeBytes'],
        message: `Maximum size for this type is ${rule.maxBytes} bytes`,
      });
    }
    const ext = v.originalName.split('.').pop()?.toLowerCase() ?? '';
    if (!(rule.ext as readonly string[]).includes(ext)) {
      ctx.addIssue({
        code: 'custom',
        path: ['originalName'],
        message: `Extension must be one of: ${rule.ext.join(', ')}`,
      });
    }
  })
  .openapi('InitiateUploadRequest');

export const InitiateUploadResponse = z
  .object({
    documentId: Uuid,
    uploadUrl: z.string().url(),
    method: z.literal('PUT'),
    headers: z.record(z.string()),
    expiresAt: z.string().datetime(),
  })
  .openapi('InitiateUploadResponse');

export const DocumentDto = z
  .object({
    id: Uuid,
    ownerType: z.string(),
    ownerId: Uuid,
    companyId: Uuid.nullable(),
    category: z.string(),
    classification: z.enum(['GENERAL', 'SENSITIVE']),
    originalName: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    status: z.enum(['PENDING_UPLOAD', 'QUARANTINED', 'CLEAN', 'INFECTED', 'REJECTED']),
    createdAt: z.string().datetime(),
  })
  .openapi('Document');

export const DownloadUrlResponse = z
  .object({ url: z.string().url(), expiresAt: z.string().datetime() })
  .openapi('DownloadUrl');
