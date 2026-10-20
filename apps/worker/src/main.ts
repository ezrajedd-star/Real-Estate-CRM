import { Queue, Worker } from 'bullmq';
import { createDb } from '@crm/db';
import {
  DbKeyStore,
  ENCRYPTION_PURPOSES,
  type EncryptionPurpose,
  FieldCipher,
  createLogger,
  keyProviderFromEnv,
} from '@crm/platform';
import { loadWorkerEnv } from './env.js';
import { shipAuditLog, verifyAuditChain } from './jobs/audit.js';
import { rotateKeys } from './jobs/rotate-keys.js';
import { scanDocument } from './jobs/scan-document.js';
import { ClamdScanner } from './scanning/clamd.js';
import { S3ObjectStore } from './storage.js';

const env = loadWorkerEnv();
const log = createLogger({ name: 'worker' });
const { db, close } = createDb(env.DATABASE_URL_WORKER, { max: 5 });
const connection = { url: env.REDIS_URL };
const s3 = {
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  sseKmsKeyId: env.S3_SSE_KMS_KEY_ID,
};
const store = new S3ObjectStore({ ...s3, bucket: env.S3_BUCKET });
const auditStore = new S3ObjectStore({ ...s3, bucket: env.S3_AUDIT_BUCKET });
const keyStore = new DbKeyStore(db);
const cipher = new FieldCipher(keyProviderFromEnv(env as unknown as NodeJS.ProcessEnv), keyStore);
const scanner = new ClamdScanner(env.CLAMD_HOST, env.CLAMD_PORT);

// Queue names are shared with the API (apps/api/src/infra/infra.module.ts).
const workers = [
  new Worker(
    'document-scan',
    async (job) => scanDocument({ db, store, scanner, log }, String(job.data.documentId)),
    {
      connection,
      concurrency: 4,
    },
  ),
  new Worker(
    'maintenance',
    async (job) => {
      switch (job.name) {
        case 'audit-ship':
          return shipAuditLog({ db, auditStore, log });
        case 'audit-verify':
          return verifyAuditChain({ db, auditStore, log });
        case 'rotate-keys': {
          const purpose = String(job.data.purpose) as EncryptionPurpose;
          if (!ENCRYPTION_PURPOSES.includes(purpose)) throw new Error('Unknown key purpose');
          return rotateKeys({ db, cipher, store: keyStore, log }, purpose);
        }
        default:
          throw new Error(`Unknown maintenance job ${job.name}`);
      }
    },
    { connection, concurrency: 1 },
  ),
];
for (const w of workers) {
  w.on('failed', (job, err) =>
    log.error({ queue: w.name, job: job?.name, jobId: job?.id, err }, 'job failed'),
  );
}

// Recurring jobs (idempotent: fixed job ids per schedule).
const maintenance = new Queue('maintenance', { connection });
await maintenance.upsertJobScheduler(
  'audit-ship',
  { every: env.AUDIT_SHIP_EVERY_MS },
  { name: 'audit-ship' },
);
await maintenance.upsertJobScheduler(
  'audit-verify',
  { every: env.AUDIT_VERIFY_EVERY_MS },
  { name: 'audit-verify' },
);
log.info({ queues: workers.map((w) => w.name) }, 'worker started');

const shutdown = async () => {
  log.info('worker shutting down');
  await Promise.all(workers.map((w) => w.close()));
  await maintenance.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
