import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { ROLE_PERMISSIONS, STAFF_ROLES } from '@crm/domain';

/**
 * Plain-SQL migration runner (ADR-001). Migrations are hand-written, reviewed SQL — RLS
 * policies, triggers and grants do not round-trip through an ORM generator — and are
 * applied in filename order, each in its own transaction, as `app_migrator`.
 * An applied migration whose file has since changed is a hard error.
 */
export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(databaseUrl: string, migrationsDir: string): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migration (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map(
      (
        await client.query<{ version: string; checksum: string }>(
          'SELECT version, checksum FROM public.schema_migration',
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );

    const files = (await readdir(migrationsDir))
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
      .sort();
    const result: MigrateResult = { applied: [], skipped: [] };
    for (const file of files) {
      const sqlText = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sqlText).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) {
          throw new Error(
            `Migration ${file} was modified after being applied. Add a new migration instead.`,
          );
        }
        result.skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sqlText);
        await client.query(
          'INSERT INTO public.schema_migration (version, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }

    await syncRolePermissions(client);
    return result;
  } finally {
    await client.end();
  }
}

/** Makes identity.role_permission exactly match the catalogue in packages/domain. */
export async function syncRolePermissions(client: pg.Client): Promise<void> {
  const pairs = STAFF_ROLES.flatMap((role) =>
    ROLE_PERMISSIONS[role].map((p) => [role, p] as const),
  );
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM identity.role_permission');
    if (pairs.length > 0) {
      const values = pairs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
      await client.query(
        `INSERT INTO identity.role_permission (role, permission) VALUES ${values}`,
        pairs.flat(),
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
