import { LocalDateString, OptionalText, Text, Uuid, z } from './common.js';

export const ConfigValueDto = z
  .object({
    id: Uuid,
    key: z.string(),
    scopeType: z.enum(['GLOBAL', 'PROPERTY', 'COMPANY']),
    scopeId: Uuid.nullable(),
    value: z.unknown(),
    effectiveFrom: LocalDateString,
    effectiveTo: LocalDateString.nullable(),
    needsConfirmation: z.boolean(),
    notes: z.string().nullable(),
  })
  .openapi('ConfigValue');

export const TaxRateDto = z
  .object({
    id: Uuid,
    taxType: z.string(),
    rate: z.string().nullable().openapi({ example: '0.120000' }),
    brackets: z.unknown().nullable(),
    basis: z.string(),
    sourceReference: z.string().nullable(),
    effectiveFrom: LocalDateString,
    effectiveTo: LocalDateString.nullable(),
    needsConfirmation: z.boolean(),
  })
  .openapi('TaxRate');

export const FeatureFlagDto = z
  .object({
    key: z.string(),
    enabled: z.boolean(),
    description: z.string(),
    updatedAt: z.string().datetime(),
  })
  .openapi('FeatureFlag');

const RateString = z
  .string()
  .regex(
    /^(0(\.\d{1,6})?|1(\.0{1,6})?)$/,
    'A rate between 0 and 1 with up to 6 decimals, e.g. 0.12',
  );

/** A proposed config change. It takes effect only after a different person approves it. */
export const ConfigChangeRequest = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('config_value'),
      key: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/),
      scopeType: z.enum(['GLOBAL', 'PROPERTY', 'COMPANY']).default('GLOBAL'),
      scopeId: Uuid.nullable().default(null),
      value: z.unknown(),
      effectiveFrom: LocalDateString,
      effectiveTo: LocalDateString.nullable().default(null),
      confirmed: z.boolean().default(false),
      notes: OptionalText(1000),
      justification: Text(1000, 10),
    }),
    z.object({
      kind: z.literal('tax_rate'),
      taxType: z.string().regex(/^[A-Z0-9_]+$/),
      rate: RateString.nullable().default(null),
      brackets: z.unknown().nullable().default(null),
      basis: Text(500),
      sourceReference: OptionalText(500),
      effectiveFrom: LocalDateString,
      effectiveTo: LocalDateString.nullable().default(null),
      confirmed: z.boolean().default(false),
      justification: Text(1000, 10),
    }),
    z.object({
      kind: z.literal('feature_flag'),
      key: z.enum(['invoicing', 'online_payments', 'portals', 'ai_assist']),
      enabled: z.boolean(),
      justification: Text(1000, 10),
    }),
  ])
  .superRefine((v, ctx) => {
    if (v.kind === 'tax_rate' && (v.rate === null) === (v.brackets === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['rate'],
        message: 'Provide either a flat rate or brackets',
      });
    }
    if (v.kind !== 'feature_flag' && v.effectiveTo !== null && v.effectiveTo <= v.effectiveFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['effectiveTo'],
        message: 'effectiveTo must be after effectiveFrom',
      });
    }
    if (v.kind === 'config_value' && (v.scopeType === 'GLOBAL') !== (v.scopeId === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['scopeId'],
        message: 'GLOBAL scope has no scopeId; other scopes require one',
      });
    }
  })
  .openapi('ConfigChangeRequest');
export type ConfigChangeRequest = z.infer<typeof ConfigChangeRequest>;
