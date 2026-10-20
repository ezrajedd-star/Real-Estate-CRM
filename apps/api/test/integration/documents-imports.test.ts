import ExcelJS from 'exceljs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@crm/db';
import { createLogger } from '@crm/platform';
// The worker's real scan job, run inline (the API only enqueues it).
import { scanDocument } from '../../../worker/src/jobs/scan-document.js';
import { S3ObjectStore } from '../../../worker/src/storage.js';
import { EICAR, startFakeClamd, startS3 } from '../../../worker/test/fakes.js';
import { ClamdScanner } from '../../../worker/src/scanning/clamd.js';
import {
  type Agent,
  clock,
  createProperty,
  createTestApp,
  ownerDb,
  randomTin,
  staff,
  tag,
} from './harness.js';

let app: NestFastifyApplication;
let db: pg.Client;
let s3: Awaited<ReturnType<typeof startS3>>;
let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
let runScan: (id: string) => Promise<string>;
const worker = createDb(
  process.env.DATABASE_URL_WORKER ?? 'postgres://app_worker:worker_dev@localhost:5432/leasing',
  { max: 2 },
);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

beforeAll(async () => {
  s3 = await startS3(['leasing-documents']);
  process.env.S3_ENDPOINT = s3.endpoint;
  process.env.S3_ACCESS_KEY_ID = 'S3RVER';
  process.env.S3_SECRET_ACCESS_KEY = 'S3RVER';
  clamd = await startFakeClamd();
  app = await createTestApp();
  db = await ownerDb();
  const store = new S3ObjectStore({
    endpoint: s3.endpoint,
    region: 'ap-southeast-1',
    bucket: 'leasing-documents',
    accessKeyId: 'S3RVER',
    secretAccessKey: 'S3RVER',
    forcePathStyle: true,
  });
  const scanner = new ClamdScanner('127.0.0.1', clamd.port);
  runScan = (id) =>
    scanDocument(
      { db: worker.db, store, scanner, log: createLogger({ name: 't', level: 'silent' }) },
      id,
    );
});

afterAll(async () => {
  await app.close();
  await db.end();
  await worker.close();
  await s3.close();
  clamd.server.close();
});

/** Full browser-equivalent upload: initiate → PUT to presigned URL → complete → scan. */
async function upload(
  a: Agent,
  bytes: Buffer,
  meta: { contentType: string; name: string; companyId?: string; category?: string },
) {
  const init = await a.post('/documents', {
    ownerType: meta.companyId ? 'company' : 'import_batch',
    ownerId: meta.companyId ?? a.userId,
    companyId: meta.companyId ?? null,
    category: meta.category ?? (meta.contentType === XLSX ? 'IMPORT_FILE' : 'OTHER'),
    originalName: meta.name,
    contentType: meta.contentType,
    sizeBytes: bytes.length,
  });
  expect(init.status, JSON.stringify(init.body)).toBe(201);
  const put = await fetch(init.body.uploadUrl, {
    method: 'PUT',
    body: bytes,
    headers: init.body.headers,
  });
  expect(put.status).toBe(200);
  const done = await a.post(`/documents/${init.body.documentId}/complete`);
  expect(done.body.status).toBe('QUARANTINED');
  return { id: init.body.documentId as string, scanned: await runScan(init.body.documentId) };
}

async function workbook(rows: Array<Record<string, string | null>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Companies');
  const headers = Object.keys(rows[0]!);
  ws.addRow(headers.map((h) => h.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())));
  for (const r of rows) ws.addRow(headers.map((h) => r[h]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('documents', () => {
  it('validates type, extension and size before issuing an upload URL', async () => {
    const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const base = { ownerType: 'company', ownerId: head.userId, category: 'OTHER' };
    expect(
      (
        await head.post('/documents', {
          ...base,
          originalName: 'x.exe',
          contentType: 'application/x-msdownload',
          sizeBytes: 10,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await head.post('/documents', {
          ...base,
          originalName: 'x.png',
          contentType: 'application/pdf',
          sizeBytes: 10,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await head.post('/documents', {
          ...base,
          originalName: 'x.pdf',
          contentType: 'application/pdf',
          sizeBytes: 26 * 1024 * 1024,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await head.post('/documents', {
          ...base,
          originalName: '../../etc/passwd.pdf',
          contentType: 'application/pdf',
          sizeBytes: 10,
        })
      ).status,
    ).toBe(400);
  });

  it('clean upload → audited download URL that expires within 5 minutes', async () => {
    const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const co = await head.post('/companies', {
      legalName: `Doc Co ${tag()}`,
      registrationType: 'SEC',
    });
    const pdf = Buffer.from('%PDF-1.7\n%%EOF\n');
    const { id, scanned } = await upload(head, pdf, {
      contentType: 'application/pdf',
      name: 'sec-cert.pdf',
      companyId: co.body.id,
      category: 'SEC_REGISTRATION',
    });
    expect(scanned).toBe('CLEAN');

    const dl = await head.post(`/documents/${id}/download-url`);
    expect(dl.status).toBe(200);
    const url = new URL(dl.body.url);
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
    expect(new Date(dl.body.expiresAt).getTime() - clock.now().getTime()).toBeLessThanOrEqual(
      300_000,
    );
    const file = await fetch(dl.body.url);
    expect(Buffer.from(await file.arrayBuffer()).equals(pdf)).toBe(true);
    const audit = await db.query(
      `SELECT 1 FROM audit.audit_log WHERE action = 'document.download_url' AND subject_id = $1`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('an infected upload can never be downloaded', async () => {
    const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const co = await head.post('/companies', {
      legalName: `Evil Doc Co ${tag()}`,
      registrationType: 'SEC',
    });
    const { id, scanned } = await upload(head, Buffer.from(`%PDF-1.7\n${EICAR}\n`), {
      contentType: 'application/pdf',
      name: 'evil.pdf',
      companyId: co.body.id,
    });
    expect(scanned).toBe('INFECTED');
    expect((await head.post(`/documents/${id}/download-url`)).status).toBe(409);
  });

  it('sensitive documents (government IDs) need document.read_sensitive', async () => {
    const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const exec = await staff(app, db, [{ role: 'EXECUTIVE' }]);
    const co = await head.post('/companies', {
      legalName: `Id Co ${tag()}`,
      registrationType: 'SEC',
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const { id } = await upload(head, png, {
      contentType: 'image/png',
      name: 'passport.png',
      companyId: co.body.id,
      category: 'GOV_ID',
    });
    expect((await head.get(`/documents/${id}`)).body.classification).toBe('SENSITIVE');
    expect((await exec.post(`/documents/${id}/download-url`)).status).toBe(404);
    expect((await head.post(`/documents/${id}/download-url`)).status).toBe(200);
  });
});

describe('Excel import framework', () => {
  it('validates with per-row errors, masks the preview, refuses to commit errors', async () => {
    const manager = await staff(app, db, [
      { role: 'LEASING_MANAGER', scopeType: 'PROPERTY', scopeId: await createProperty(db) },
    ]);
    const sameTin = randomTin();
    const bytes = await workbook([
      {
        legal_name: 'Alpha Retail Corp',
        registration_type: 'SEC',
        tin: sameTin,
        vat_status: 'VAT',
      },
      { legal_name: 'Beta Foods Inc', registration_type: 'NOPE', tin: '12', vat_status: 'VAT' },
      {
        legal_name: 'Alpha Duplicate Corp',
        registration_type: 'SEC',
        tin: sameTin,
        vat_status: 'VAT',
      },
    ]);
    const { id: docId, scanned } = await upload(manager, bytes, {
      contentType: XLSX,
      name: 'companies.xlsx',
    });
    expect(scanned).toBe('CLEAN');

    expect(
      (await manager.post('/imports', { importType: 'companies', documentId: docId })).status,
    ).toBe(400); // property required
    const me = (await manager.get('/auth/me')).body;
    const batch = await manager.post('/imports', {
      importType: 'companies',
      documentId: docId,
      propertyId: me.grants[0].scopeId,
    });
    expect(batch.status).toBe(201);

    const preview = await manager.post(`/imports/${batch.body.id}/validate`);
    expect(preview.status).toBe(200);
    expect(preview.body.batch).toMatchObject({ status: 'VALIDATED', totalRows: 3, errorRows: 2 });
    const [r1, r2, r3] = preview.body.rows;
    expect(r1.errors).toEqual([]);
    expect(r1.preview.tin).toMatch(/^•••-•••-•••-000$/);
    expect(r2.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'registration_type',
      'tin',
    ]);
    expect(r3.errors[0]).toMatchObject({ field: 'tin', code: 'duplicate_in_file' });
    expect(JSON.stringify(preview.body)).not.toContain(sameTin.replace(/-/g, '').slice(0, 9));

    expect((await manager.post(`/imports/${batch.body.id}/commit`)).status).toBe(409);
    const raw = await db.query(`SELECT data_enc FROM imports.import_row WHERE batch_id = $1`, [
      batch.body.id,
    ]);
    expect(raw.rows.every((r) => r.data_enc.startsWith('v1.import.'))).toBe(true);
  });

  it("commits a clean file into the importer's scope, idempotently", async () => {
    const prop = await createProperty(db);
    const manager = await staff(app, db, [
      { role: 'LEASING_MANAGER', scopeType: 'PROPERTY', scopeId: prop },
    ]);
    const tins = [randomTin(), randomTin()];
    const bytes = await workbook([
      {
        legal_name: `Gamma ${tag()} Corp`,
        registration_type: 'SEC',
        tin: tins[0]!,
        vat_status: 'VAT',
      },
      {
        legal_name: `Delta ${tag()} Inc`,
        registration_type: 'DTI',
        tin: tins[1]!,
        vat_status: 'NON_VAT',
      },
    ]);
    const { id: docId } = await upload(manager, bytes, { contentType: XLSX, name: 'clean.xlsx' });
    const batch = await manager.post('/imports', {
      importType: 'companies',
      documentId: docId,
      propertyId: prop,
    });
    await manager.post(`/imports/${batch.body.id}/validate`);
    const committed = await manager.post(`/imports/${batch.body.id}/commit`);
    expect(committed.status).toBe(200);
    expect(committed.body.batch.status).toBe('COMMITTED');
    const ids = committed.body.rows.map((r: { targetId: string }) => r.targetId);
    expect(ids.every(Boolean)).toBe(true);

    const again = await manager.post(`/imports/${batch.body.id}/commit`);
    expect(again.body.rows.map((r: { targetId: string }) => r.targetId)).toEqual(ids);
    const list = await manager.get(`/companies?propertyId=${prop}`);
    expect(list.body.items.map((c: { id: string }) => c.id).sort()).toEqual([...ids].sort());

    // Re-importing the same TINs is caught at validation, even by someone who cannot see them.
    const other = await staff(app, db, [
      { role: 'LEASING_MANAGER', scopeType: 'PROPERTY', scopeId: await createProperty(db) },
    ]);
    const otherProp = (await other.get('/auth/me')).body.grants[0].scopeId;
    const { id: doc2 } = await upload(other, bytes, { contentType: XLSX, name: 'again.xlsx' });
    const b2 = await other.post('/imports', {
      importType: 'companies',
      documentId: doc2,
      propertyId: otherProp,
    });
    const p2 = await other.post(`/imports/${b2.body.id}/validate`);
    expect(
      p2.body.rows.every((r: { errors: Array<{ code: string }> }) =>
        r.errors.some((e) => e.code === 'already_registered'),
      ),
    ).toBe(true);
  });
});
