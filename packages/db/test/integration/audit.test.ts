import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/ids.js';
import { asUser, createCompany, createUser, env, owner } from './helpers.js';

let o: pg.Client;
let auditor: string;
let head: string;

beforeAll(async () => {
  o = await owner();
  auditor = await createUser(o, [{ role: 'INTERNAL_AUDITOR', scopeType: 'GLOBAL' }]);
  head = await createUser(o, [{ role: 'LEASING_HEAD', scopeType: 'GLOBAL' }]);
});
afterAll(() => o.end());

describe('audit log', () => {
  it('forces actor, timestamp and request id from context — callers cannot forge them', async () => {
    const id = uuidv7();
    // No RETURNING: a non-auditor may append but not read the log.
    await asUser(
      head,
      (c) =>
        c.query(
          `INSERT INTO audit.audit_log (id, action, actor_id, actor_type, occurred_at, prev_hash, hash)
           VALUES ($1, 'test.forge_attempt', $2, 'SYSTEM', '2000-01-01', 'x', 'y')`,
          [id, auditor],
        ),
      { commit: true },
    );
    const row = (await o.query(`SELECT * FROM audit.audit_log WHERE id = $1`, [id])).rows[0];
    expect(row.actor_id).toBe(head);
    expect(row.actor_type).toBe('USER');
    expect(new Date(row.occurred_at).getFullYear()).toBeGreaterThan(2020);
    expect(row.request_id).toMatch(/^test-/);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.prev_hash).not.toBe('x');
  });

  it('only audit.read holders can read it', async () => {
    expect(
      await asUser(
        head,
        async (c) => (await c.query('SELECT 1 FROM audit.audit_log LIMIT 1')).rowCount,
      ),
    ).toBe(0);
    expect(
      await asUser(
        auditor,
        async (c) => (await c.query('SELECT 1 FROM audit.audit_log LIMIT 1')).rowCount,
      ),
    ).toBe(1);
  });

  it('cannot be updated, deleted or truncated by the app role (no privilege)', async () => {
    for (const stmt of [
      'UPDATE audit.audit_log SET action = action',
      'DELETE FROM audit.audit_log',
      'TRUNCATE audit.audit_log',
    ]) {
      await expect(asUser(auditor, (c) => c.query(stmt))).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot be updated or deleted even by the table owner (trigger)', async () => {
    await expect(
      o.query(
        `UPDATE audit.audit_log SET action = 'x.y' WHERE seq = (SELECT max(seq) FROM audit.audit_log)`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      o.query(`DELETE FROM audit.audit_log WHERE seq = (SELECT max(seq) FROM audit.audit_log)`),
    ).rejects.toThrow(/append-only/);
    await expect(o.query(`TRUNCATE audit.audit_log`)).rejects.toThrow(/append-only/);
  });

  it('records row changes with before/after values but never ciphertext or contact PII', async () => {
    const companyId = await createCompany(o);
    await o.query(
      `UPDATE contacts.company SET industry = 'F&B', tin_enc = 'v1:secret', tin_bidx = 'b' WHERE id = $1`,
      [companyId],
    );
    const r = await o.query(
      `SELECT details FROM audit.audit_log WHERE subject_type = 'contacts.company' AND subject_id = $1 AND action = 'row.update'`,
      [companyId],
    );
    const changes = r.rows[0].details.changes;
    expect(changes.industry).toEqual({ before: null, after: 'F&B' });
    expect(changes.tin_enc).toEqual({ changed: true });
    expect(changes.tin_bidx).toEqual({ changed: true });
    expect(JSON.stringify(r.rows)).not.toContain('v1:secret');

    const p = await o.query<{ id: string }>(
      `INSERT INTO contacts.person (full_name, email, phone) VALUES ('Juan Dela Cruz', 'juan@example.com', '+63 917 000 0000') RETURNING id`,
    );
    const pr = await o.query(`SELECT details FROM audit.audit_log WHERE subject_id = $1`, [
      p.rows[0]!.id,
    ]);
    const text = JSON.stringify(pr.rows);
    expect(text).not.toContain('juan@example.com');
    expect(text).not.toContain('917');
    expect(text).not.toContain('Juan Dela Cruz');
  });

  it('hash chain verifies, and detects tampering', async () => {
    const worker = new pg.Client({ connectionString: env.worker });
    await worker.connect();
    try {
      const intact = await worker.query(`SELECT * FROM audit.verify_chain()`);
      expect(intact.rows).toEqual([]);

      if (!env.superuser) return; // tampering needs a superuser to bypass the guard triggers
      const su = new pg.Client({ connectionString: env.superuser });
      await su.connect();
      try {
        const victim = (
          await su.query(
            `SELECT seq, action FROM audit.audit_log ORDER BY seq DESC OFFSET 1 LIMIT 1`,
          )
        ).rows[0];
        await su.query('ALTER TABLE audit.audit_log DISABLE TRIGGER audit_log_no_update');
        await su.query(`UPDATE audit.audit_log SET action = 'tampered.row' WHERE seq = $1`, [
          victim.seq,
        ]);
        const broken = await worker.query(`SELECT * FROM audit.verify_chain()`);
        expect(broken.rows[0].broken_seq).toBe(String(victim.seq));
        expect(broken.rows[0].problem).toMatch(/does not match its hash/);
        await su.query(`UPDATE audit.audit_log SET action = $1 WHERE seq = $2`, [
          victim.action,
          victim.seq,
        ]);
        await su.query('ALTER TABLE audit.audit_log ENABLE TRIGGER audit_log_no_update');
        expect((await worker.query(`SELECT * FROM audit.verify_chain()`)).rows).toEqual([]);
      } finally {
        await su
          .query('ALTER TABLE audit.audit_log ENABLE TRIGGER audit_log_no_update')
          .catch(() => undefined);
        await su.end();
      }
    } finally {
      await worker.end();
    }
  });

  it('the app role cannot run verify_chain (worker only)', async () => {
    await expect(
      asUser(auditor, (c) => c.query('SELECT * FROM audit.verify_chain()')),
    ).rejects.toThrow(/permission denied/);
  });
});
