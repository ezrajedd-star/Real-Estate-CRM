import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clock,
  createProperty,
  createTestApp,
  logLines,
  ownerDb,
  randomTin,
  staff,
  tag,
} from './harness.js';

let app: NestFastifyApplication;
let db: pg.Client;

beforeAll(async () => {
  app = await createTestApp();
  db = await ownerDb();
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const uniqueTaxType = () => `TEST_${tag().toUpperCase()}`;

describe('maker–checker: config / tax rates', () => {
  it('a change applies only after a different authorised person approves it', async () => {
    const finance = await staff(app, db, [{ role: 'FINANCE' }]);
    const dpo = await staff(app, db, [{ role: 'COMPLIANCE_DPO' }]);
    const taxType = uniqueTaxType();

    const first = await finance.post('/config/changes', {
      kind: 'tax_rate',
      taxType,
      rate: '0.12',
      basis: 'Test VAT',
      effectiveFrom: '2024-01-01',
      justification: 'Seed rate for test',
    });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('PENDING');

    // Nothing changed yet
    let rates = (await finance.get('/config/tax-rates')).body.filter(
      (r: { taxType: string }) => r.taxType === taxType,
    );
    expect(rates).toHaveLength(0);

    // The maker cannot approve their own request (even though Finance holds config.approve)
    const self = await finance.post(`/approvals/${first.body.id}/decision`, {
      decision: 'APPROVE',
    });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toMatch(/request you made/);

    const ok = await dpo.post(`/approvals/${first.body.id}/decision`, { decision: 'APPROVE' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APPROVED');
    expect(ok.body.appliedAt).toBeTruthy();

    // A second change closes the first period instead of overwriting it
    const second = await finance.post('/config/changes', {
      kind: 'tax_rate',
      taxType,
      rate: '0.10',
      basis: 'Test VAT',
      effectiveFrom: '2026-07-01',
      confirmed: true,
      justification: 'Rate change for test',
    });
    expect(
      (await dpo.post(`/approvals/${second.body.id}/decision`, { decision: 'APPROVE' })).body
        .status,
    ).toBe('APPROVED');
    rates = (await finance.get('/config/tax-rates')).body.filter(
      (r: { taxType: string }) => r.taxType === taxType,
    );
    expect(
      rates.map(
        (r: {
          rate: string;
          effectiveFrom: string;
          effectiveTo: string | null;
          needsConfirmation: boolean;
        }) => [r.rate, r.effectiveFrom, r.effectiveTo, r.needsConfirmation],
      ),
    ).toEqual([
      ['0.120000', '2024-01-01', '2026-07-01', true],
      ['0.100000', '2026-07-01', null, false],
    ]);
  });

  it('a rejection needs a comment and applies nothing', async () => {
    const finance = await staff(app, db, [{ role: 'FINANCE' }]);
    const dpo = await staff(app, db, [{ role: 'COMPLIANCE_DPO' }]);
    const req = await finance.post('/config/changes', {
      kind: 'feature_flag',
      key: 'ai_assist',
      enabled: true,
      justification: 'Try AI assist',
    });
    expect(
      (await dpo.post(`/approvals/${req.body.id}/decision`, { decision: 'REJECT' })).status,
    ).toBe(400);
    const rej = await dpo.post(`/approvals/${req.body.id}/decision`, {
      decision: 'REJECT',
      comment: 'No DPA in place yet',
    });
    expect(rej.body.status).toBe('REJECTED');
    const flags = (await finance.get('/config/feature-flags')).body;
    expect(flags.find((f: { key: string }) => f.key === 'ai_assist').enabled).toBe(false);
    expect(
      (await dpo.post(`/approvals/${req.body.id}/decision`, { decision: 'APPROVE' })).status,
    ).toBe(409);
  });

  it('validates rates and periods', async () => {
    const finance = await staff(app, db, [{ role: 'FINANCE' }]);
    const bad = await finance.post('/config/changes', {
      kind: 'tax_rate',
      taxType: 'VAT',
      rate: '12',
      basis: 'x',
      effectiveFrom: '2026-01-01',
      justification: 'Bad rate value',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('rate');
    const float = await finance.post('/config/changes', {
      kind: 'tax_rate',
      taxType: 'VAT',
      rate: 0.12,
      basis: 'x',
      effectiveFrom: '2026-01-01',
      justification: 'Float not allowed',
    });
    expect(float.status).toBe(400);
  });
});

describe('maker–checker: role changes', () => {
  it('Super Admin proposes, DPO approves; nobody changes their own roles', async () => {
    const admin = await staff(app, db, [{ role: 'SUPER_ADMIN' }]);
    const dpo = await staff(app, db, [{ role: 'COMPLIANCE_DPO' }]);
    const target = await staff(app, db, [{ role: 'EXECUTIVE' }]);
    const prop = await createProperty(db);

    expect(
      (
        await admin.post(`/users/${admin.userId}/role-changes`, {
          action: 'GRANT',
          role: 'FINANCE',
          scopeType: 'GLOBAL',
          scopeId: null,
          justification: 'Self escalation',
        })
      ).status,
    ).toBe(403);

    const req = await admin.post(`/users/${target.userId}/role-changes`, {
      action: 'GRANT',
      role: 'LEASING_MANAGER',
      scopeType: 'PROPERTY',
      scopeId: prop,
      justification: 'New manager for tower',
    });
    expect(req.status).toBe(201);
    expect((await target.get('/auth/me')).body.permissions).not.toContain('company.write');
    expect(
      (await admin.post(`/approvals/${req.body.id}/decision`, { decision: 'APPROVE' })).status,
    ).toBe(403);
    expect(
      (await dpo.post(`/approvals/${req.body.id}/decision`, { decision: 'APPROVE' })).body.status,
    ).toBe('APPROVED');
    // Takes effect on the very next request — grants are loaded fresh each time.
    const me = (await target.get('/auth/me')).body;
    expect(
      me.grants.map((g: { role: string; scopeId: string | null }) => [g.role, g.scopeId]),
    ).toContainEqual(['LEASING_MANAGER', prop]);
  });

  it('role changes require recent re-authentication (step-up)', async () => {
    const admin = await staff(app, db, [{ role: 'SUPER_ADMIN' }]);
    const target = await staff(app, db, [{ role: 'EXECUTIVE' }]);
    const saved = clock.now();
    clock.advanceMs(10 * 60 * 1000);
    try {
      const res = await admin.post(`/users/${target.userId}/role-changes`, {
        action: 'GRANT',
        role: 'FINANCE',
        scopeType: 'GLOBAL',
        scopeId: null,
        justification: 'Stale session test',
      });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('STEP_UP_REQUIRED');
    } finally {
      clock.set(saved);
    }
  });
});

describe('leaver process', () => {
  it('offboarding cuts off all sessions immediately', async () => {
    const dpo = await staff(app, db, [{ role: 'COMPLIANCE_DPO' }]);
    const leaver = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    expect((await leaver.get('/companies')).status).toBe(200);
    const res = await dpo.post(`/users/${leaver.userId}/offboard`, {
      reason: 'Resigned effective today',
    });
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBe(1);
    expect((await leaver.get('/companies')).status).toBe(401);
    const status = await db.query(`SELECT status FROM identity.app_user WHERE id = $1`, [
      leaver.userId,
    ]);
    expect(status.rows[0].status).toBe('LEFT');
  });
});

describe('break-glass', () => {
  it('gives Super Admin time-boxed read-only access, with a critical alert', async () => {
    const admin = await staff(app, db, [{ role: 'SUPER_ADMIN' }]);
    const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const dpo = await staff(app, db, [{ role: 'COMPLIANCE_DPO' }]);
    const co = await head.post('/companies', {
      legalName: `Glass Co ${tag()}`,
      registrationType: 'SEC',
    });

    expect((await admin.post('/break-glass', { reason: 'too short', minutes: 10 })).status).toBe(
      400,
    );
    const bg = await admin.post('/break-glass', {
      reason: 'Incident INC-0042: verifying corrupted tenant record',
      minutes: 15,
    });
    expect(bg.status).toBe(201);

    // RLS grants read under break-glass; the app layer still has no company.read permission for
    // Super Admin, so the API keeps refusing — break-glass is for direct, logged DB investigation.
    const rows = await db.query(
      `SELECT kind, severity FROM audit.security_alert WHERE subject_user_id = $1`,
      [admin.userId],
    );
    expect(rows.rows).toContainEqual({ kind: 'BREAK_GLASS', severity: 'CRITICAL' });
    expect(
      (await dpo.get('/security/alerts')).body.some(
        (a: { kind: string; subjectUserId: string }) =>
          a.kind === 'BREAK_GLASS' && a.subjectUserId === admin.userId,
      ),
    ).toBe(true);
    expect(
      (await admin.patch(`/companies/${co.body.id}`, { version: 1, industry: 'x' })).status,
    ).toBe(403);
    expect((await admin.delete('/break-glass')).status).toBe(204);
  });
});

describe('contacts, encryption and PII handling', () => {
  it('TINs are encrypted at rest, deduplicated by blind index, and revealed only with a reason', async () => {
    const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const tin = randomTin();
    const created = await head.post('/companies', {
      legalName: `Pii Co ${tag()}`,
      registrationType: 'SEC',
      tin,
    });
    expect(created.status).toBe(201);
    expect(created.body.tinMasked).toBe('•••-•••-•••-000');
    expect(JSON.stringify(created.body)).not.toContain(tin.slice(0, 7));

    const raw = await db.query(`SELECT tin_enc, tin_bidx FROM contacts.company WHERE id = $1`, [
      created.body.id,
    ]);
    expect(raw.rows[0].tin_enc).toMatch(/^v1\.tin\.\d+\./);
    expect(raw.rows[0].tin_enc).not.toContain(tin.replace(/-/g, '').slice(0, 9));

    const dup = await head.post('/companies', {
      legalName: `Dup Co ${tag()}`,
      registrationType: 'SEC',
      tin: tin.replace(/-/g, ' '),
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_TIN');

    expect((await head.post(`/companies/${created.body.id}/reveal`, { field: 'tin' })).status).toBe(
      400,
    );
    const rev = await head.post(`/companies/${created.body.id}/reveal`, {
      field: 'tin',
      reason: 'Preparing lease contract',
    });
    expect(rev.status).toBe(200);
    expect(rev.body.value).toBe(tin.replace(/-/g, ''));
    const audit = await db.query(
      `SELECT details FROM audit.audit_log WHERE action = 'pii.reveal' AND subject_id = $1 AND outcome = 'SUCCESS'`,
      [created.body.id],
    );
    expect(audit.rows[0].details).toMatchObject({
      field: 'tin',
      reason: 'Preparing lease contract',
    });
    expect(JSON.stringify(audit.rows)).not.toContain(tin.replace(/-/g, ''));
  });

  it('people: contact details masked by default; government ID encrypted', async () => {
    const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const dpo = await staff(app, db, [{ role: 'COMPLIANCE_DPO' }]);
    const co = await head.post('/companies', {
      legalName: `People Co ${tag()}`,
      registrationType: 'SEC',
    });
    const p = await head.post('/people', {
      fullName: 'Ana Reyes',
      email: 'ana.reyes@example.ph',
      phone: '+63 917 555 0101',
      govIdType: 'UMID',
      govId: '0111-2222333-4',
    });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({
      emailMasked: 'a••••••••@example.ph',
      phoneMasked: '+•• ••• ••• 0101',
      govIdMasked: '••••333-4'.replace('333-4', '3334').replace(/^.*?(\d{4})$/, '••••$1'),
    });
    await head.post(`/companies/${co.body.id}/contacts`, {
      personId: p.body.id,
      role: 'SIGNATORY',
      title: 'President',
    });

    const company = await head.get(`/companies/${co.body.id}`);
    expect(company.body.contacts[0]).toMatchObject({
      fullName: 'Ana Reyes',
      role: 'SIGNATORY',
      emailMasked: 'a••••••••@example.ph',
    });

    expect(
      (
        await head.post(`/people/${p.body.id}/reveal`, {
          field: 'gov_id',
          reason: 'Leasing head wants it',
        })
      ).status,
    ).toBe(403);
    const gov = await dpo.post(`/people/${p.body.id}/reveal`, {
      field: 'gov_id',
      reason: 'KYC verification for AMLA',
    });
    expect(gov.body.value).toBe('0111-2222333-4');

    const search = await head.post('/people/search', { email: 'ANA.REYES@example.ph' });
    expect(search.body.map((x: { id: string }) => x.id)).toContain(p.body.id);
  });

  it('bank accounts: encrypted, masked, step-up to add, reveal only with pii.reveal.bank', async () => {
    const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const finance = await staff(app, db, [{ role: 'FINANCE' }]);
    const co = await head.post('/companies', {
      legalName: `Bank Co ${tag()}`,
      registrationType: 'SEC',
    });
    const acct = await head.post(`/companies/${co.body.id}/bank-accounts`, {
      bankName: 'BPI',
      accountName: 'Bank Co',
      accountNo: '1234 5678 9012',
    });
    expect(acct.body.accountNoMasked).toBe('••••••9012');
    const rev = await finance.post(
      `/companies/${co.body.id}/bank-accounts/${acct.body.id}/reveal`,
      { field: 'bank_account', reason: 'Deposit refund payout' },
    );
    expect(rev.body.value).toBe('123456789012');
  });

  it('no PII from any of the above reached the logs', () => {
    const text = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(10);
    for (const needle of [
      'ana.reyes@example.ph',
      '917 555 0101',
      '0111-2222333-4',
      '123456789012',
      'Ana Reyes',
    ]) {
      expect(text, needle).not.toContain(needle);
    }
  });
});

describe('approval-gated bulk export', () => {
  it('export → approval by someone else → single watermarked, masked download', async () => {
    const head = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const finance = await staff(app, db, [{ role: 'FINANCE' }]);
    const tin = randomTin();
    await head.post('/companies', {
      legalName: `Export Co ${tag()}`,
      registrationType: 'SEC',
      tin,
    });

    const req = await head.post('/exports', {
      kind: 'companies',
      justification: 'Quarterly tenant review',
    });
    expect(req.status).toBe(201);
    expect((await head.post(`/exports/${req.body.id}/download`)).status).toBe(409);
    expect(
      (await head.post(`/approvals/${req.body.approvalId}/decision`, { decision: 'APPROVE' }))
        .status,
    ).toBe(403); // maker
    expect(
      (await finance.post(`/approvals/${req.body.approvalId}/decision`, { decision: 'APPROVE' }))
        .body.status,
    ).toBe('APPROVED');

    const dl = await head.post(`/exports/${req.body.id}/download`);
    expect(dl.status).toBe(201);
    expect(dl.headers['content-type']).toMatch(/text\/csv/);
    expect(dl.text.split('\r\n')[0]).toMatch(
      new RegExp(`^# CONFIDENTIAL — exported by .* \\(${head.userId}\\) at `),
    );
    expect(dl.text).not.toContain(tin.replace(/-/g, ''));
    expect((await head.post(`/exports/${req.body.id}/download`)).status).toBe(409);
  });
});
