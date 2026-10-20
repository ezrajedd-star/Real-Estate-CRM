import { z } from 'zod';

/**
 * All runtime configuration, validated at startup. Secrets come from the environment,
 * which is populated from AWS Secrets Manager in production — never from the repository.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(4000),
    PUBLIC_WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    API_BASE_URL: z.string().url().default('http://localhost:3000/api/v1'),

    DATABASE_URL_APP: z.string().min(1),
    REDIS_URL: z.string().default('redis://localhost:6379'),

    OIDC_ISSUER: z.string().url().default('http://localhost:8080/realms/pmo'),
    OIDC_CLIENT_ID: z.string().default('leasing-staff'),
    OIDC_CLIENT_SECRET: z.string().min(1),
    /** ACR values that count as multi-factor (Keycloak LoA mapping). */
    OIDC_MFA_ACR_VALUES: z
      .string()
      .default('mfa')
      .transform((s) => s.split(',').map((x) => x.trim())),
    KEYCLOAK_ADMIN_CLIENT_ID: z.string().optional(),
    KEYCLOAK_ADMIN_CLIENT_SECRET: z.string().optional(),

    SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(24).default(12),
    STEP_UP_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(1800).default(300),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    IP_HASH_KEY: z.string().min(32),
    KMS_KEY_ID: z.string().optional(),
    LOCAL_KEK_BASE64: z.string().optional(),

    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('ap-southeast-1'),
    S3_BUCKET: z.string().default('leasing-documents'),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    S3_SSE_KMS_KEY_ID: z.string().optional(),

    EXPORT_MAX_ROWS: z.coerce.number().int().default(10_000),
    EXPORT_ALERT_ROWS: z.coerce.number().int().default(2_000),
    ADMIN_IP_ALLOWLIST: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(',').map((x) => x.trim()) : [])),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (!env.KMS_KEY_ID)
        ctx.addIssue({ code: 'custom', path: ['KMS_KEY_ID'], message: 'required in production' });
      if (env.LOCAL_KEK_BASE64)
        ctx.addIssue({
          code: 'custom',
          path: ['LOCAL_KEK_BASE64'],
          message: 'must not be set in production',
        });
      if (!env.COOKIE_SECURE)
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'must be true in production',
        });
    } else if (!env.KMS_KEY_ID && !env.LOCAL_KEK_BASE64) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOCAL_KEK_BASE64'],
        message: 'set LOCAL_KEK_BASE64 (dev/test) or KMS_KEY_ID',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Report which variables are wrong, never their values.
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
