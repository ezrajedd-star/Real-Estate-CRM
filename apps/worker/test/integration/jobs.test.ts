import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@crm/db';
import { DbKeyStore, FieldCipher, LocalKeyProvider, createLogger } from '@crm/platform';
import { shipAuditLog, verifyAuditChain } from '../../src/jobs/audit.js';
import { rotateKeys } from '../../src/jobs/rotate-keys.js';
import { scanDocument } from '../../src/jobs/scan-document.js';
import { ClamdScanner } from '../../src/scanning/clamd.js';
import { S3ObjectStore } from '../../src/storage.js';
import { EICAR, startFakeClamd, startS3 } from '../fakes.js';

const WORKER_URL =
  process.env.DATABASE_URL_WORKER ?? 'postgres://app_worker:worker_dev@localhost:5432/leasing';
const MIGRATOR_URL =
  process.env.DATABASE_URL_MIGRATOR ??
  'postgres://app_migrator:migrator_dev@localhost:5432/leasing';

const log = createLogger({ name: 'worker-test', level: 'silent' });
const handle = createDb(WORKER_URL, { max: 3 });
const db = handle.db;
let owner: pg.Client;
let s3: Awaited<ReturnType<typeof startS3>>;
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
let store: S3ObjectStore;
let auditStore: S3ObjectStore;
let scanner: ClamdScanner;
let uploader: string;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: MIGRATOR_URL });
  await owner.connect();
  s3 = await startS3(['leasing-documents', 'leasing-audit']);
  clamd = await startFakeClamd();
  const cfg = {
    endpoint: s3.endpoint,
    region: 'ap-southeast-1',
    accessKeyId: 'S3RVER',
    secretAccessKey: 'S3RVER',
    forcePathStyle: true,
  };
  store = new S3ObjectStore({ ...cfg, bucket: 'leasing-documents' });
  auditStore = new S3ObjectStore({ ...cfg, bucket: 'leasing-audit' });
  scanner = new ClamdScanner('127.0.0.1', clamd.port);
  const u = await owner.query<{ user_id: string }>(
    `SELECT user_id FROM identity.upsert_login($1, $2, 'Uploader')`,
    [`kc-${randomUUID()}`, `up-${randomUUID().slice(0, 8)}@example.test`],
  );
  uploader = u.rows[0]!.user_id;
});

afterAll(async () => {
  await owner.end();
  await handle.close();
  await s3.close();
  clamd.server.close();
});

async function quarantined(bytes: Buffer, contentType: string, name: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO documents.document (id, owner_type, owner_id, category, original_name, content_type, size_bytes, storage_key, status, uploaded_by)
     VALUES ($1, 'company', $1, 'OTHER', $2, $3, $4, $5, 'QUARANTINED', $6)`,
    [id, name, contentType, bytes.length, `quarantine/${id}`, uploader],
  );
  await store.put(`quarantine/${id}`, bytes, contentType, { sse: false });
  return id;
}

const statusOf = async (id: string) =>
  (
    await owner.query(`SELECT status, scan_detail, sha256 FROM documents.document WHERE id = $1`, [
      id,
    ])
  ).rows[0];

describe('document scan job', () => {
  it('promotes a clean PDF to clean/ and deletes the quarantine copy', async () => {
    const pdf = Buffer.from(
      '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n',
    );
    const id = await quarantined(pdf, 'application/pdf', 'permit.pdf');
    expect(await scanDocument({ db, store, scanner, log }, id)).toBe('CLEAN');
    const row = await statusOf(id);
    expect(row.status).toBe('CLEAN');
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await store.get(`clean/${id}`)).equals(pdf)).toBe(true);
    await expect(store.get(`quarantine/${id}`)).rejects.toThrow();
    // idempotent: a second run is a no-op
    expect(await scanDocument({ db, store, scanner, log }, id)).toBe('SKIPPED');
  });

  it('rejects EICAR as INFECTED, deletes it and raises an alert', async () => {
    const bytes = Buffer.from(`%PDF-1.7\n${EICAR}\n%%EOF`);
    const id = await quarantined(bytes, 'application/pdf', 'evil.pdf');
    expect(await scanDocument({ db, store, scanner, log }, id)).toBe('INFECTED');
    expect((await statusOf(id)).status).toBe('INFECTED');
    await expect(store.get(`quarantine/${id}`)).rejects.toThrow();
    await expect(store.get(`clean/${id}`)).rejects.toThrow();
    const alert = await owner.query(
      `SELECT kind FROM audit.security_alert WHERE details->>'documentId' = $1`,
      [id],
    );
    expect(alert.rows[0].kind).toBe('MALWARE_UPLOAD');
  });

  it('rejects content whose magic bytes do not match the declared type', async () => {
    const id = await quarantined(
      Buffer.from('MZ\x90\x00 this is really an .exe'),
      'application/pdf',
      'invoice.pdf',
    );
    expect(await scanDocument({ db, store, scanner, log }, id)).toBe('REJECTED');
    expect((await statusOf(id)).scan_detail).toMatch(/does not match declared type/);
  });

  it('strips EXIF/GPS metadata from images', async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'Secret Owner', Artist: 'Juan Dela Cruz' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const id = await quarantined(jpeg, 'image/jpeg', 'id-photo.jpg');
    expect(await scanDocument({ db, store, scanner, log }, id)).toBe('CLEAN');
    const cleaned = await store.get(`clean/${id}`);
    expect((await sharp(cleaned).metadata()).exif).toBeUndefined();
    expect(cleaned.toString('latin1')).not.toContain('Juan Dela Cruz');
  });

  it('a scanner outage throws (job retried), leaving the file quarantined', async () => {
    const id = await quarantined(Buffer.from('%PDF-1.7 ok'), 'application/pdf', 'later.pdf');
    await expect(
      scanDocument({ db, store, scanner: new ClamdScanner('127.0.0.1', 1), log }, id),
    ).rejects.toThrow();
    expect((await statusOf(id)).status).toBe('QUARANTINED');
  });
});

describe('audit shipping and verification', () => {
  it('ships new rows to write-once storage as JSONL and advances the cursor', async () => {
    const first = await shipAuditLog({ db, auditStore, log });
    expect(first.shipped).toBeGreaterThan(0);
    const body = (await auditStore.get(first.key!)).toString();
    const lines = body
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toHaveProperty('hash');
    expect(lines.at(-1).seq).toBeGreaterThan(lines[0].seq);
    // nothing new → nothing shipped
    let again = await shipAuditLog({ db, auditStore, log });
    while (again.shipped > 0) again = await shipAuditLog({ db, auditStore, log }); // drain concurrent writes
    expect(again.shipped).toBe(0);
  });

  it('verifies an intact chain', async () => {
    expect(await verifyAuditChain({ db, auditStore, log })).toEqual({ intact: true });
  });
});

describe('key rotation', () => {
  it('re-encrypts every TIN with the new key version and retires the old one', async () => {
    const provider = new LocalKeyProvider(
      process.env.LOCAL_KEK_BASE64 ?? Buffer.alloc(32, 7).toString('base64'),
      'test',
    );
    const keyStore = new DbKeyStore(db);
    const cipher = new FieldCipher(provider, keyStore);
    const id = randomUUID();
    const tin = `${randomBytes(4).readUInt32BE() % 1_000_000_000}`.padStart(9, '0') + '000';
    const enc = await cipher.encrypt('tin', tin, {
      table: 'contacts.company',
      column: 'tin_enc',
      rowId: id,
    });
    await owner.query(
      `INSERT INTO contacts.company (id, legal_name, registration_type, tin_enc, tin_bidx, tin_last3) VALUES ($1, 'Rotate Co', 'SEC', $2, $3, '000')`,
      [id, enc, `bidx-${id}`],
    );
    const before = FieldCipher.versionOf(enc).version;

    const result = await rotateKeys({ db, cipher, store: keyStore, log }, 'tin');
    expect(result.newVersion).toBe(before + 1);
    expect(result.reencrypted).toBeGreaterThanOrEqual(1);

    const after = (await owner.query(`SELECT tin_enc FROM contacts.company WHERE id = $1`, [id]))
      .rows[0].tin_enc;
    expect(FieldCipher.versionOf(after).version).toBe(result.newVersion);
    expect(
      await new FieldCipher(provider, keyStore).decrypt(after, {
        table: 'contacts.company',
        column: 'tin_enc',
        rowId: id,
      }),
    ).toBe(tin);
    const statuses = await owner.query(
      `SELECT version, status FROM crypto.data_key WHERE purpose = 'tin' ORDER BY version`,
    );
    expect(statuses.rows.at(-1)).toEqual({ version: result.newVersion, status: 'ACTIVE' });
    expect(statuses.rows.slice(0, -1).every((r) => r.status === 'RETIRED')).toBe(true);
  });
});
