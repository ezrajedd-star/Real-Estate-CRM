import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, owner, suffix } from './helpers.js';

let o: pg.Client;
beforeAll(async () => {
  o = await owner();
});
afterAll(() => o.end());

const login = (sub: string, email: string) =>
  asUser(
    null,
    async (c) =>
      (
        await c.query<{ user_id: string }>(
          `SELECT user_id FROM identity.upsert_login($1, $2, 'X')`,
          [sub, email],
        )
      ).rows[0]!.user_id,
    {
      commit: true,
    },
  );

describe('login provisioning', () => {
  it('first login claims a pre-provisioned (pending) user with the same email, keeping its roles', async () => {
    const email = `new.hire.${suffix().toLowerCase()}@example.test`;
    const pending = (
      await o.query<{ id: string }>(`SELECT identity.preprovision_user($1, 'New Hire') AS id`, [
        email,
      ])
    ).rows[0]!.id;
    await o.query(
      `INSERT INTO identity.role_assignment (user_id, role, scope_type) VALUES ($1, 'EXECUTIVE', 'GLOBAL')`,
      [pending],
    );
    const userId = await login(`kc-${suffix()}`, email.toUpperCase());
    expect(userId).toBe(pending);
    const sub = (
      await o.query(`SELECT keycloak_sub FROM identity.app_user WHERE id = $1`, [pending])
    ).rows[0].keycloak_sub;
    expect(sub).not.toMatch(/^pending:/);
  });

  it('an already-linked account can never be taken over by another subject with the same email', async () => {
    const email = `linked.${suffix().toLowerCase()}@example.test`;
    await login(`kc-${suffix()}`, email);
    await expect(login(`kc-attacker-${suffix()}`, email)).rejects.toThrow(
      /duplicate key value violates unique constraint "app_user_email_uq"/,
    );
  });

  it('reserved subjects cannot be used to log in', async () => {
    await expect(login('pending:someone@example.test', 'someone@example.test')).rejects.toThrow(
      /reserved subject/,
    );
    await expect(login('system:worker', 'x@example.test')).rejects.toThrow(/reserved subject/);
  });

  it('the app role cannot pre-provision users', async () => {
    await expect(
      asUser(null, (c) => c.query(`SELECT identity.preprovision_user('a@b.test', 'A')`)),
    ).rejects.toThrow(/permission denied/);
  });
});
