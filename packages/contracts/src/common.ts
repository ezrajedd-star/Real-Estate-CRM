import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { isLocalDate, normalizeTin } from '@crm/domain';

extendZodWithOpenApi(z);

export { z };

export const Uuid = z.string().uuid().openapi({ example: '01928f1e-7c2a-7b3e-9a1d-3f4e5a6b7c8d' });

export const LocalDateString = z
  .string()
  .refine(isLocalDate, 'Must be a valid date in YYYY-MM-DD format')
  .openapi({ example: '2026-11-01', description: 'Business date (Asia/Manila)' });

/** Free text with sane bounds; trims and rejects control characters. */
export const Text = (max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine(
      (s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s),
      'Contains control characters',
    );

export const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const Tin = z
  .string()
  .trim()
  .refine((v) => {
    try {
      normalizeTin(v);
      return true;
    } catch {
      return false;
    }
  }, 'TIN must have 9 digits plus an optional 3- or 5-digit branch code')
  .openapi({ example: '123-456-789-000' });

/** A reason for a sensitive action (PII reveal, break-glass). Logged in the audit trail. */
export const Reason = Text(500, 10).openapi({
  description: 'Why this access is needed (≥ 10 characters)',
});

export const Page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const ErrorBody = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
      details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    }),
  })
  .openapi('Error');

export const Version = z
  .number()
  .int()
  .positive()
  .openapi({ description: 'Optimistic-lock version from the last read' });
