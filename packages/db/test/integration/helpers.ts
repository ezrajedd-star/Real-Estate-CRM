import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { StaffRole, ScopeType } from '@crm/domain';
import { uuidv7 } from '../../src/ids.js';

export const env = {
  migrator:
    process.env.DATABASE_URL_MIGRATOR ??
    'postgres://app_migrator:migrator_dev@localhost:5432/leasing',
  app: process.env.DATABASE_URL_APP ?? 'postgres://app_rw:rw_dev@localhost:5432/leasing',
  worker:
    process.env.DATABASE_URL_WORKER ?? 'postgres://app_worker:worker_dev@localhost:5432/leasing',
  superuser: process.env.DATABASE_URL_SUPERUSER,
};

export const suffix = () => randomBytes(3).toString('hex').toUpperCase();

/** Owner connection: bypasses RLS, used only to build fixtures. */
export async function owner(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: env.migrator });
  await c.connect();
  return c;
}

export async function createUser(
  c: pg.Client,
  grants: Array<{ role: StaffRole; scopeType: ScopeType; scopeId?: string | null }>,
): Promise<string> {
  const id = uuidv7();
  const tag = suffix();
  await c.query(
    `INSERT INTO identity.app_user (id, keycloak_sub, email, display_name) VALUES ($1, $2, $3, $4)`,
    [id, `test-${tag}-${id}`, `user-${tag}-${id.slice(-6)}@test.invalid`, `Test ${tag}`],
  );
  for (const g of grants) {
    await c.query(
      `INSERT INTO identity.role_assignment (user_id, role, scope_type, scope_id) VALUES ($1, $2, $3, $4)`,
      [id, g.role, g.scopeType, g.scopeId ?? null],
    );
  }
  return id;
}

export async function createProperty(c: pg.Client): Promise<string> {
  const id = uuidv7();
  await c.query(`INSERT INTO properties.property (id, code, name) VALUES ($1, $2, $3)`, [
    id,
    `P-${suffix()}`,
    'Test Tower',
  ]);
  return id;
}

export async function createCompany(c: pg.Client, propertyId?: string): Promise<string> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO contacts.company (id, legal_name, registration_type) VALUES ($1, $2, 'SEC')`,
    [id, `Test Co ${suffix()} Inc.`],
  );
  if (propertyId) {
    await c.query(
      `INSERT INTO contacts.company_property (company_id, property_id, relation) VALUES ($1, $2, 'TENANT')`,
      [id, propertyId],
    );
  }
  return id;
}

/**
 * Runs `fn` as the app's runtime role inside a transaction with the given user bound,
 * mirroring withContext() in src/client.ts. Always rolls back so tests stay independent
 * (except where `commit` is requested).
 */
export async function asUser<T>(
  userId: string | null,
  fn: (c: pg.Client) => Promise<T>,
  opts: { url?: string; commit?: boolean } = {},
): Promise<T> {
  const c = new pg.Client({ connectionString: opts.url ?? env.app });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.request_id', $2, true)`,
      [userId ?? '', `test-${suffix()}`],
    );
    const out = await fn(c);
    await c.query(opts.commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

export async function count(
  c: pg.Client,
  sqlText: string,
  params: unknown[] = [],
): Promise<number> {
  const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sqlText}) q`, params);
  return Number(r.rows[0]!.n);
}
