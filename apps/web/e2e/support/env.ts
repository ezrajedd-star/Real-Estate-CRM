// Environment shared by every process the e2e run starts. Synthetic values only.
export const E2E = {
  web: 'http://localhost:3000',
  api: 'http://localhost:4000',
  idp: 'http://localhost:8180',
  s3Port: 9100,
  clamdPort: 3311,
};

export const serviceEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL_APP:
    process.env.DATABASE_URL_APP ?? 'postgres://app_rw:rw_dev@localhost:5432/leasing',
  DATABASE_URL_WORKER:
    process.env.DATABASE_URL_WORKER ?? 'postgres://app_worker:worker_dev@localhost:5432/leasing',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  PORT: '4000',
  PUBLIC_WEB_ORIGIN: E2E.web,
  API_BASE_URL: `${E2E.web}/api/v1`,
  API_INTERNAL_URL: E2E.api,
  OIDC_ISSUER: E2E.idp,
  OIDC_CLIENT_ID: 'leasing-staff',
  OIDC_CLIENT_SECRET: 'e2e-client-secret',
  COOKIE_SECURE: 'true',
  IP_HASH_KEY: 'e2e-ip-hash-key-0123456789abcdef0123456',
  LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
  S3_ENDPOINT: `http://localhost:${E2E.s3Port}`,
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: 'S3RVER',
  S3_SECRET_ACCESS_KEY: 'S3RVER',
  S3_BUCKET: 'leasing-documents',
  S3_AUDIT_BUCKET: 'leasing-audit',
  UPLOAD_ORIGIN: `http://localhost:${E2E.s3Port}`,
  CLAMD_HOST: '127.0.0.1',
  CLAMD_PORT: String(E2E.clamdPort),
  LOG_LEVEL: 'warn',
};
