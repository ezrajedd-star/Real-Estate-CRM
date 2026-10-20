// Starts the e2e stand-ins for infrastructure that runs in Docker in real environments:
// an S3-compatible server (with CORS for browser uploads) and a clamd speaking INSTREAM,
// then the real worker process against them.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';
import { startFakeClamd } from '../../../worker/test/fakes.js';
import { E2E, serviceEnv } from './env.js';

const cors = `<CORSConfiguration><CORSRule><AllowedOrigin>${E2E.web}</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedHeader>*</AllowedHeader></CORSRule></CORSConfiguration>`;
const dir = mkdtempSync(join(tmpdir(), 'e2e-s3-'));

await new S3rver({
  port: E2E.s3Port,
  address: '127.0.0.1',
  silent: true,
  directory: join(dir, 'data'),
  configureBuckets: [{ name: 'leasing-documents', configs: [cors] }, { name: 'leasing-audit' }],
}).run();

// The fake clamd must listen on the fixed port the worker is configured with.
const clamd = await startFakeClamd({ port: E2E.clamdPort });
process.stdout.write(`e2e services: s3 :${E2E.s3Port}, clamd :${clamd.port}\n`);

Object.assign(process.env, serviceEnv);
await import('../../../worker/src/main.js');
