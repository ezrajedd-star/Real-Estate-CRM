import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL_WORKER: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  CLAMD_HOST: z.string().default('localhost'),
  CLAMD_PORT: z.coerce.number().int().default(3310),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ap-southeast-1'),
  S3_BUCKET: z.string().default('leasing-documents'),
  S3_AUDIT_BUCKET: z.string().default('leasing-audit'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  S3_SSE_KMS_KEY_ID: z.string().optional(),
  KMS_KEY_ID: z.string().optional(),
  LOCAL_KEK_BASE64: z.string().optional(),
  AUDIT_SHIP_EVERY_MS: z.coerce
    .number()
    .int()
    .default(5 * 60_000),
  AUDIT_VERIFY_EVERY_MS: z.coerce
    .number()
    .int()
    .default(60 * 60_000),
});
export type WorkerEnv = z.infer<typeof Env>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}
