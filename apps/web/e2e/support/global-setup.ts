import pg from 'pg';

export const E2E_USERS = {
  head: 'leasing.head@e2e.test',
  officer: 'leasing.officer@e2e.test',
};

/**
 * Pre-provisions e2e staff with roles (users are otherwise created just-in-time at their
 * first login, with no roles). The test IdP uses the email as the subject.
 */
export default async function globalSetup(): Promise<void> {
  const db = new pg.Client({
    connectionString:
      process.env.DATABASE_URL_MIGRATOR ??
      'postgres://app_migrator:migrator_dev@localhost:5432/leasing',
  });
  await db.connect();
  try {
    for (const [role, email] of [
      ['LEASING_HEAD', E2E_USERS.head],
      ['LEASING_OFFICER', E2E_USERS.officer],
    ] as const) {
      const r = await db.query<{ user_id: string }>(
        `SELECT user_id FROM identity.upsert_login($1, $1, $2)`,
        [email, role],
      );
      await db.query(
        `INSERT INTO identity.role_assignment (user_id, role, scope_type)
         SELECT $1, $2, 'GLOBAL' WHERE NOT EXISTS (
           SELECT 1 FROM identity.role_assignment WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL)`,
        [r.rows[0]!.user_id, role === 'LEASING_OFFICER' ? 'BILLING_OFFICER' : role],
      );
    }
  } finally {
    await db.end();
  }
}
