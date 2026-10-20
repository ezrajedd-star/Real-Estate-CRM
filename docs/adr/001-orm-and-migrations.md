# ADR-001: Drizzle ORM and hand-written SQL migrations

## Context

The brief requires PostgreSQL Row-Level Security driven by per-request session variables,
and asks us to choose Prisma or Drizzle based on how cleanly each works with that.

RLS needs every statement of a request to run on one connection, inside one transaction,
after `set_config('app.user_id', …, true)`. Policies, triggers, grants and
`SECURITY DEFINER` functions are central to the design and must be reviewed as SQL.

## Decision

- **Drizzle ORM** (`drizzle-orm/node-postgres`) for typed queries. `db.transaction(tx => …)`
  gives us the single connection + transaction; `withContext()` (`packages/db/src/client.ts`)
  issues the `set_config` calls as the first statement and is the only way the API reaches
  the database. Prisma's RLS story needs client extensions wrapping every query in an
  interactive transaction and keeps policies outside its schema; Drizzle is thinner and
  SQL-first.
- **Migrations are plain SQL** in `packages/db/migrations/NNNN_name.sql`, applied in order by
  a small runner (`packages/db/src/migrator.ts`) as the `app_migrator` role, each in its own
  transaction, with a SHA-256 checksum. Editing an applied migration is a hard error.
- The Drizzle schema (`packages/db/src/schema`) mirrors the SQL for typing only; it is not
  used to generate migrations.
- The migrator re-syncs `identity.role_permission` from the TypeScript role catalogue on
  every run, so the policy layer and RLS cannot drift.

## Consequences

- Every schema change is a reviewed SQL file (CODEOWNERS requires a security reviewer).
- Schema and SQL must be kept in step by hand; integration tests catch mismatches.
- No ORM "magic" bypasses RLS: the runtime roles are not table owners and have `NOBYPASSRLS`.
