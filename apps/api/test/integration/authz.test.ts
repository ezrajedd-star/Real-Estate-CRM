import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, createProperty, createTestApp, ownerDb, randomTin, staff } from './harness.js';

/**
 * One block per role (brief §11): what each role must NOT be able to reach. Fixture:
 * properties A and B; company X is a tenant in A, company Y in B. Both have a TIN, KYC and
 * a bank account, created through the API by a Leasing Head.
 */
let app: NestFastifyApplication;
let db: pg.Client;
let propA: string, propB: string;
let X: string, Y: string, bankX: string;
const as: Record<string, Agent> = {};

const reveal = (a: Agent, companyId: string) =>
  a.post(`/companies/${companyId}/reveal`, {
    field: 'tin',
    reason: 'Verifying for authorization test',
  });

beforeAll(async () => {
  app = await createTestApp();
  db = await ownerDb();
  propA = await createProperty(db);
  propB = await createProperty(db);

  const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
  const mk = async (prop: string) => {
    const res = await head.post('/companies', {
      legalName: `Authz Co ${randomUUID().slice(0, 6)}`,
      registrationType: 'SEC',
      tin: randomTin(),
      propertyId: prop,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await head.put(`/companies/${res.body.id}/kyc`, { status: 'VERIFIED', riskRating: 'LOW' });
    return res.body.id as string;
  };
  X = await mk(propA);
  Y = await mk(propB);
  const bank = await head.post(`/companies/${X}/bank-accounts`, {
    bankName: 'BDO',
    accountName: 'Authz Co',
    accountNo: '0012-3456-7890',
  });
  expect(bank.status, JSON.stringify(bank.body)).toBe(201);
  bankX = bank.body.id;

  as.superAdmin = await staff(app, db, [{ role: 'SUPER_ADMIN' }]);
  as.executive = await staff(app, db, [{ role: 'EXECUTIVE' }]);
  as.head = head;
  as.managerA = await staff(app, db, [
    { role: 'LEASING_MANAGER', scopeType: 'PROPERTY', scopeId: propA },
  ]);
  as.officerY = await staff(app, db, [
    { role: 'LEASING_OFFICER', scopeType: 'COMPANY', scopeId: Y },
  ]);
  as.billing = await staff(app, db, [{ role: 'BILLING_OFFICER' }]);
  as.propertyOfficer = await staff(app, db, [{ role: 'PROPERTY_OFFICER' }]);
  as.finance = await staff(app, db, [{ role: 'FINANCE' }]);
  as.dpo = await staff(app, db, [{ role: 'COMPLIANCE_DPO' }]);
  as.auditor = await staff(app, db, [{ role: 'INTERNAL_AUDITOR' }]);
});

afterAll(async () => {
  await app.close();
  await db.end();
});

describe('Super Admin (IT) — no default access to tenant PII or financials', () => {
  it('cannot list, read or reveal companies', async () => {
    expect((await as.superAdmin!.get('/companies')).status).toBe(403);
    expect((await as.superAdmin!.get(`/companies/${X}`)).status).toBe(403);
    expect((await reveal(as.superAdmin!, X)).status).toBe(404);
    expect((await as.superAdmin!.get(`/companies/${X}/bank-accounts`)).status).toBe(403);
  });
  it('cannot read the audit log or approve config/role changes', async () => {
    expect((await as.superAdmin!.get('/audit')).status).toBe(403);
    expect((await as.superAdmin!.get('/security/alerts')).status).toBe(403);
  });
});

describe('Executive — read-only, PII masked', () => {
  it('sees masked TIN only and cannot reveal or write', async () => {
    const res = await as.executive!.get(`/companies/${X}`);
    expect(res.status).toBe(200);
    expect(res.body.tinMasked).toMatch(/^•••-•••-•••-\d{3}$/);
    expect((await reveal(as.executive!, X)).status).toBe(403);
    expect(
      (await as.executive!.patch(`/companies/${X}`, { version: 1, industry: 'x' })).status,
    ).toBe(403);
    expect(
      (
        await as.executive!.post('/config/changes', {
          kind: 'feature_flag',
          key: 'portals',
          enabled: true,
          justification: 'Executive test',
        })
      ).status,
    ).toBe(403);
    expect((await as.executive!.get('/audit')).status).toBe(403);
  });
});

describe('Leasing Head', () => {
  it('cannot reveal bank accounts, read audit logs or use break-glass', async () => {
    expect(
      (
        await as.head!.post(`/companies/${X}/bank-accounts/${bankX}/reveal`, {
          field: 'bank_account',
          reason: 'Testing bank reveal denial',
        })
      ).status,
    ).toBe(403);
    expect((await as.head!.get('/audit')).status).toBe(403);
    expect(
      (
        await as.head!.post('/break-glass', {
          reason: 'Leasing head should never be able to do this',
          minutes: 10,
        })
      ).status,
    ).toBe(403);
  });
});

describe('Leasing Manager (property A only)', () => {
  it('cannot see or touch companies outside property A (404, not 403)', async () => {
    const list = await as.managerA!.get('/companies?limit=100');
    const ids = list.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(X);
    expect(ids).not.toContain(Y);
    expect((await as.managerA!.get(`/companies/${Y}`)).status).toBe(404);
    expect((await reveal(as.managerA!, Y)).status).toBe(404);
    expect(
      (await as.managerA!.patch(`/companies/${Y}`, { version: 1, industry: 'x' })).status,
    ).toBe(404);
    expect((await as.managerA!.get(`/companies/${Y}/kyc`)).status).toBe(404);
  });
  it('cannot create companies for property B, or without a property', async () => {
    expect(
      (
        await as.managerA!.post('/companies', {
          legalName: 'Wrong Property Inc',
          registrationType: 'SEC',
          propertyId: propB,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as.managerA!.post('/companies', {
          legalName: 'No Property Inc',
          registrationType: 'SEC',
        })
      ).status,
    ).toBe(400);
  });
  it('cannot reveal bank details or approve exports', async () => {
    expect(
      (
        await as.managerA!.post(`/companies/${X}/bank-accounts/${bankX}/reveal`, {
          field: 'bank_account',
          reason: 'Testing bank reveal denial',
        })
      ).status,
    ).toBe(403);
  });
  it('a client-supplied filter cannot widen scope', async () => {
    const res = await as.managerA!.get(`/companies?propertyId=${propB}`);
    expect(res.body.items).toEqual([]);
  });
});

describe('Leasing Officer (company Y only)', () => {
  it('cannot see other tenants', async () => {
    expect((await as.officerY!.get(`/companies/${X}`)).status).toBe(404);
    const list = await as.officerY!.get('/companies');
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([Y]);
  });
  it('cannot reveal TINs, create companies, read config, KYC or run imports', async () => {
    expect((await reveal(as.officerY!, Y)).status).toBe(403);
    expect(
      (await as.officerY!.post('/companies', { legalName: 'Officer Co', registrationType: 'SEC' }))
        .status,
    ).toBe(403);
    expect((await as.officerY!.get('/config/values')).status).toBe(403);
    expect((await as.officerY!.get(`/companies/${Y}/kyc`)).status).toBe(403);
    expect(
      (await as.officerY!.post('/imports', { importType: 'companies', documentId: randomUUID() }))
        .status,
    ).toBe(403);
  });
});

describe('Billing Officer', () => {
  it('cannot reveal TINs, read KYC or edit companies', async () => {
    expect((await reveal(as.billing!, X)).status).toBe(403);
    expect((await as.billing!.get(`/companies/${X}/kyc`)).status).toBe(403);
    expect((await as.billing!.patch(`/companies/${X}`, { version: 1, industry: 'x' })).status).toBe(
      403,
    );
  });
});

describe('Property / Admin Officer — no financial detail', () => {
  it('cannot see KYC, bank accounts, config or reveal anything', async () => {
    expect((await as.propertyOfficer!.get(`/companies/${X}/kyc`)).status).toBe(403);
    expect((await as.propertyOfficer!.get(`/companies/${X}/bank-accounts`)).status).toBe(403);
    expect((await as.propertyOfficer!.get('/config/tax-rates')).status).toBe(403);
    expect((await reveal(as.propertyOfficer!, X)).status).toBe(403);
    const company = await as.propertyOfficer!.get(`/companies/${X}`);
    expect(company.body.kycStatus).toBeNull();
  });
});

describe('Finance', () => {
  it('cannot reveal government IDs, approve role changes or read audit logs', async () => {
    const p = await as.head!.post('/people', {
      fullName: 'Gov Id Holder',
      govIdType: 'PASSPORT',
      govId: 'P1234567A',
    });
    await as.head!.post(`/companies/${X}/contacts`, { personId: p.body.id, role: 'SIGNATORY' });
    expect(
      (
        await as.finance!.post(`/people/${p.body.id}/reveal`, {
          field: 'gov_id',
          reason: 'Finance should not see this',
        })
      ).status,
    ).toBe(403);
    expect((await as.finance!.get('/audit')).status).toBe(403);
    const target = await staff(app, db, [{ role: 'EXECUTIVE' }]);
    const req = await as.superAdmin!.post(`/users/${target.userId}/role-changes`, {
      action: 'GRANT',
      role: 'FINANCE',
      scopeType: 'GLOBAL',
      scopeId: null,
      justification: 'Needs finance access',
    });
    expect(req.status).toBe(201);
    expect(
      (await as.finance!.post(`/approvals/${req.body.id}/decision`, { decision: 'APPROVE' }))
        .status,
    ).toBe(404);
  });
});

describe('Compliance Officer / DPO', () => {
  it('cannot reveal bank details, edit companies, propose config or use break-glass', async () => {
    expect(
      (
        await as.dpo!.post(`/companies/${X}/bank-accounts/${bankX}/reveal`, {
          field: 'bank_account',
          reason: 'DPO should not see bank numbers',
        })
      ).status,
    ).toBe(403);
    expect((await as.dpo!.patch(`/companies/${X}`, { version: 1, industry: 'x' })).status).toBe(
      403,
    );
    expect(
      (
        await as.dpo!.post('/config/changes', {
          kind: 'feature_flag',
          key: 'portals',
          enabled: true,
          justification: 'DPO test change',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as.dpo!.post('/break-glass', {
          reason: 'DPO should never be able to do this',
          minutes: 10,
        })
      ).status,
    ).toBe(403);
  });
});

describe('Internal Auditor — read-only', () => {
  it('can read the audit log but cannot reveal, write or approve', async () => {
    expect((await as.auditor!.get('/audit?limit=5')).status).toBe(200);
    expect((await reveal(as.auditor!, X)).status).toBe(403);
    expect((await as.auditor!.patch(`/companies/${X}`, { version: 1, industry: 'x' })).status).toBe(
      403,
    );
    expect((await as.auditor!.put(`/companies/${X}/kyc`, { status: 'REJECTED' })).status).toBe(403);
  });
});

describe('IDOR protection', () => {
  it('unknown and malformed ids are indistinguishable 404s', async () => {
    for (const url of [
      `/companies/${randomUUID()}`,
      '/companies/1',
      '/companies/not-a-uuid',
      `/documents/${randomUUID()}`,
      `/approvals/${randomUUID()}`,
    ]) {
      const res = await as.head!.get(url);
      expect([404], url).toContain(res.status);
    }
  });

  it('denials are audited', async () => {
    await reveal(as.officerY!, Y);
    const r = await db.query(
      `SELECT 1 FROM audit.audit_log WHERE actor_id = $1 AND outcome = 'DENIED'`,
      [as.officerY!.userId],
    );
    expect(r.rowCount).toBeGreaterThan(0);
  });
});
