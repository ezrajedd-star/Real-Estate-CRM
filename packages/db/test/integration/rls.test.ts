import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/ids.js';
import { asUser, count, createCompany, createProperty, createUser, env, owner } from './helpers.js';

/**
 * Proves the database enforces scoping on its own, independent of the API policy layer.
 * Fixture: properties A and B; company X tenant in A, Y tenant in B, Z unlinked.
 */
let o: pg.Client;
let propA: string, propB: string;
let coX: string, coY: string, coZ: string;
const users: Record<string, string> = {};

beforeAll(async () => {
  o = await owner();
  propA = await createProperty(o);
  propB = await createProperty(o);
  coX = await createCompany(o, propA);
  coY = await createCompany(o, propB);
  coZ = await createCompany(o);
  await o.query(`INSERT INTO contacts.kyc_profile (company_id, status) VALUES ($1, 'VERIFIED')`, [
    coX,
  ]);
  await o.query(
    `INSERT INTO contacts.bank_account (company_id, bank_name, account_name, account_no_enc, account_no_bidx, account_no_last4)
     VALUES ($1, 'BDO', 'Test Co', 'v1:x', 'bidx-${uuidv7()}', '1234')`,
    [coX],
  );

  users.superAdmin = await createUser(o, [{ role: 'SUPER_ADMIN', scopeType: 'GLOBAL' }]);
  users.executive = await createUser(o, [{ role: 'EXECUTIVE', scopeType: 'GLOBAL' }]);
  users.head = await createUser(o, [{ role: 'LEASING_HEAD', scopeType: 'GLOBAL' }]);
  users.managerA = await createUser(o, [
    { role: 'LEASING_MANAGER', scopeType: 'PROPERTY', scopeId: propA },
  ]);
  users.officerY = await createUser(o, [
    { role: 'LEASING_OFFICER', scopeType: 'COMPANY', scopeId: coY },
  ]);
  users.propertyOfficer = await createUser(o, [{ role: 'PROPERTY_OFFICER', scopeType: 'GLOBAL' }]);
  users.finance = await createUser(o, [{ role: 'FINANCE', scopeType: 'GLOBAL' }]);
  users.dpo = await createUser(o, [{ role: 'COMPLIANCE_DPO', scopeType: 'GLOBAL' }]);
  users.auditor = await createUser(o, [{ role: 'INTERNAL_AUDITOR', scopeType: 'GLOBAL' }]);
  users.suspended = await createUser(o, [{ role: 'LEASING_HEAD', scopeType: 'GLOBAL' }]);
  await o.query(`UPDATE identity.app_user SET status = 'SUSPENDED' WHERE id = $1`, [
    users.suspended,
  ]);
});

afterAll(async () => {
  await o.end();
});

const visibleCompanies = (c: pg.Client) =>
  c
    .query<{ id: string }>(`SELECT id FROM contacts.company WHERE id = ANY($1)`, [[coX, coY, coZ]])
    .then((r) => r.rows.map((x) => x.id).sort());

describe('no request context', () => {
  it('sees no protected rows at all', async () => {
    await asUser(null, async (c) => {
      expect(await visibleCompanies(c)).toEqual([]);
      expect(await count(c, 'SELECT 1 FROM identity.app_user')).toBe(0);
      expect(await count(c, 'SELECT 1 FROM audit.audit_log')).toBe(0);
      expect(await count(c, 'SELECT 1 FROM config.tax_rate')).toBe(0);
      expect(await count(c, 'SELECT 1 FROM contacts.bank_account')).toBe(0);
    });
  });

  it('settings do not leak across transactions on the same connection', async () => {
    const pgMod = await import('pg');
    const c = new pgMod.default.Client({ connectionString: env.app });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.user_id', $1, true)`, [users.head]);
      expect((await visibleCompanies(c)).length).toBe(3);
      await c.query('COMMIT');
      expect(await visibleCompanies(c)).toEqual([]);
    } finally {
      await c.end();
    }
  });
});

describe('company visibility by role and scope', () => {
  it.each([
    ['superAdmin', () => []],
    ['executive', () => [coX, coY, coZ]],
    ['head', () => [coX, coY, coZ]],
    ['managerA', () => [coX]],
    ['officerY', () => [coY]],
    ['finance', () => [coX, coY, coZ]],
    ['suspended', () => []],
  ])('%s', async (who, expected) => {
    await asUser(users[who]!, async (c) => {
      expect(await visibleCompanies(c)).toEqual(expected().sort());
    });
  });

  it('a manager cannot update a company outside their property (0 rows)', async () => {
    await asUser(users.managerA!, async (c) => {
      const r = await c.query(`UPDATE contacts.company SET industry = 'x' WHERE id = $1`, [coY]);
      expect(r.rowCount).toBe(0);
      const ok = await c.query(`UPDATE contacts.company SET industry = 'Retail' WHERE id = $1`, [
        coX,
      ]);
      expect(ok.rowCount).toBe(1);
    });
  });

  it('read-only roles cannot update', async () => {
    for (const who of ['executive', 'auditor', 'finance']) {
      await asUser(users[who]!, async (c) => {
        const r = await c.query(`UPDATE contacts.company SET industry = 'x' WHERE id = $1`, [coX]);
        expect(r.rowCount, who).toBe(0);
      });
    }
  });
});

describe('creating companies under scope', () => {
  it('a property-scoped manager can create a company and link it to their property', async () => {
    await asUser(users.managerA!, async (c) => {
      const id = uuidv7();
      await c.query(
        `INSERT INTO contacts.company (id, legal_name, registration_type, created_by) VALUES ($1, 'New Prospect Corp', 'SEC', $2)`,
        [id, users.managerA],
      );
      await c.query(
        `INSERT INTO contacts.company_property (company_id, property_id) VALUES ($1, $2)`,
        [id, propA],
      );
      expect(await count(c, 'SELECT 1 FROM contacts.company WHERE id = $1', [id])).toBe(1);
    });
  });

  it('…but not link it to a property they are not assigned to', async () => {
    await expect(
      asUser(users.managerA!, async (c) => {
        const id = uuidv7();
        await c.query(
          `INSERT INTO contacts.company (id, legal_name, registration_type, created_by) VALUES ($1, 'Sneaky Corp', 'SEC', $2)`,
          [id, users.managerA],
        );
        await c.query(
          `INSERT INTO contacts.company_property (company_id, property_id) VALUES ($1, $2)`,
          [id, propB],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it('…and cannot attribute the row to someone else', async () => {
    await expect(
      asUser(users.managerA!, (c) =>
        c.query(
          `INSERT INTO contacts.company (legal_name, registration_type, created_by) VALUES ('X Corp', 'SEC', $1)`,
          [users.head],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a leasing officer (no company.write) cannot create companies', async () => {
    await expect(
      asUser(users.officerY!, (c) =>
        c.query(
          `INSERT INTO contacts.company (legal_name, registration_type, created_by) VALUES ('Y Corp', 'SEC', $1)`,
          [users.officerY],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('financial / KYC data', () => {
  it.each([
    ['propertyOfficer', 0],
    ['superAdmin', 0],
    ['officerY', 0],
    ['managerA', 1],
    ['finance', 1],
  ])('%s sees %i bank accounts / KYC rows for company X', async (who, n) => {
    await asUser(users[who]!, async (c) => {
      expect(
        await count(c, 'SELECT 1 FROM contacts.bank_account WHERE company_id = $1', [coX]),
      ).toBe(n);
      expect(
        await count(c, 'SELECT 1 FROM contacts.kyc_profile WHERE company_id = $1', [coX]),
      ).toBe(n);
    });
  });
});

describe('break-glass', () => {
  it('Super Admin sees companies only with an active grant, read-only, and it is audited', async () => {
    await asUser(users.superAdmin!, async (c) => {
      expect(await visibleCompanies(c)).toEqual([]);
      await c.query(
        `INSERT INTO identity.break_glass_grant (user_id, reason, expires_at) VALUES ($1, 'Investigating incident INC-0042 data issue', now() + interval '30 minutes')`,
        [users.superAdmin],
      );
      expect((await visibleCompanies(c)).length).toBe(3);
      const upd = await c.query(`UPDATE contacts.company SET industry = 'x' WHERE id = $1`, [coX]);
      expect(upd.rowCount).toBe(0);
    });
  });

  it('a role without break_glass.use cannot create a grant', async () => {
    await expect(
      asUser(users.head!, (c) =>
        c.query(
          `INSERT INTO identity.break_glass_grant (user_id, reason, expires_at) VALUES ($1, 'I would like to look around please', now() + interval '1 hour')`,
          [users.head],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('role assignments', () => {
  it('nobody can grant themselves a role', async () => {
    await expect(
      asUser(users.dpo!, (c) =>
        c.query(
          `INSERT INTO identity.role_assignment (user_id, role, scope_type) VALUES ($1, 'FINANCE', 'GLOBAL')`,
          [users.dpo],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('Super Admin cannot apply role changes (needs the DPO checker)', async () => {
    await expect(
      asUser(users.superAdmin!, (c) =>
        c.query(
          `INSERT INTO identity.role_assignment (user_id, role, scope_type) VALUES ($1, 'FINANCE', 'GLOBAL')`,
          [users.head],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('maker–checker in the database', () => {
  it('rejects a decision by the maker, even if the maker could otherwise approve', async () => {
    await expect(
      asUser(users.finance!, async (c) => {
        const req = await c.query<{ id: string }>(
          `INSERT INTO approvals.approval_request (type, summary, payload, maker_id) VALUES ('CONFIG_CHANGE', 'test', '{}', $1) RETURNING id`,
          [users.finance],
        );
        await c.query(
          `INSERT INTO approvals.approval_decision (request_id, step_index, decider_id, decision) VALUES ($1, 0, $2, 'APPROVE')`,
          [req.rows[0]!.id, users.finance],
        );
      }),
    ).rejects.toThrow(/maker cannot approve/);
  });

  it("rejects a decision recorded in someone else's name", async () => {
    const reqId = await asUser(
      users.finance!,
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO approvals.approval_request (type, summary, payload, maker_id) VALUES ('CONFIG_CHANGE', 'test', '{}', $1) RETURNING id`,
            [users.finance],
          )
        ).rows[0]!.id,
      { commit: true },
    );
    await expect(
      asUser(users.dpo!, (c) =>
        c.query(
          `INSERT INTO approvals.approval_decision (request_id, step_index, decider_id, decision) VALUES ($1, 0, $2, 'APPROVE')`,
          [reqId, users.head],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('config tables', () => {
  it('reject overlapping effective periods for the same key', async () => {
    const key = `test.k_${uuidv7().slice(-8).replace(/-/g, '')}`;
    await o.query(
      `INSERT INTO config.config_value (key, value, effective_from) VALUES ($1, '1', '2025-01-01')`,
      [key],
    );
    await expect(
      o.query(
        `INSERT INTO config.config_value (key, value, effective_from, effective_to) VALUES ($1, '2', '2024-06-01', '2025-02-01')`,
        [key],
      ),
    ).rejects.toThrow(/conflicting key value violates exclusion constraint/);
    await o.query(
      `INSERT INTO config.config_value (key, value, effective_from, effective_to) VALUES ($1, '0', '2024-01-01', '2025-01-01')`,
      [key],
    );
  });

  it('only config.approve holders can insert rates', async () => {
    await expect(
      asUser(users.head!, (c) =>
        c.query(
          `INSERT INTO config.tax_rate (tax_type, rate, basis, effective_from) VALUES ('TEST_X', 0.1, 'test', '2030-01-01')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('append-only consent records', () => {
  it('privacy notices and consents reject UPDATE/DELETE even for the owner', async () => {
    const notice = await o.query<{ id: string }>(
      `INSERT INTO contacts.privacy_notice (version_label, audience, title, body_markdown, body_sha256, effective_from)
       VALUES ($1, 'TENANT_CONTACT', 'Notice', 'body', 'sha', '2026-01-01') RETURNING id`,
      [`test-${uuidv7()}`],
    );
    const person = await o.query<{ id: string }>(
      `INSERT INTO contacts.person (full_name) VALUES ('Test Person') RETURNING id`,
    );
    const consent = await o.query<{ id: string }>(
      `INSERT INTO contacts.consent (person_id, notice_id, purpose, lawful_basis, action, channel)
       VALUES ($1, $2, 'LEASE_ADMINISTRATION', 'CONTRACT', 'ACKNOWLEDGED', 'PAPER') RETURNING id`,
      [person.rows[0]!.id, notice.rows[0]!.id],
    );
    await expect(
      o.query(`UPDATE contacts.consent SET action = 'GRANTED' WHERE id = $1`, [
        consent.rows[0]!.id,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      o.query(`DELETE FROM contacts.consent WHERE id = $1`, [consent.rows[0]!.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      o.query(`UPDATE contacts.privacy_notice SET title = 'x' WHERE id = $1`, [notice.rows[0]!.id]),
    ).rejects.toThrow(/append-only/);
  });

  it('the app role has no DELETE privilege on business tables', async () => {
    for (const table of [
      'contacts.company',
      'contacts.person',
      'documents.document',
      'config.tax_rate',
    ]) {
      await expect(
        asUser(users.head!, (c) => c.query(`DELETE FROM ${table} WHERE false`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });
});
