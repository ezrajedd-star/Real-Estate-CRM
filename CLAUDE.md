# CLAUDE.md — Commercial Leasing CRM (Philippines)

This file captures the conventions and non-negotiable rules for this repository. Read it at
the start of every session. The original brief lives in `docs/brief.md`; the approved plan
and ADRs live in `docs/adr/`.

## Scope

- **Commercial leasing only.** Residential unit sales is a separate future system. Do not
  build sales features.
- `contacts`, `identity` and `audit` must stay shareable: one Keycloak realm (SSO) with a
  separate client + role set per system, and a versioned contacts API at `/api/v1/contacts`.

## Business-rule rules

- Anything marked **[CONFIRM]** in the brief must be asked of the user before it is
  hard-coded. Open items: accounting system / BIR invoicing, CUSA basis, percentage-rent
  tenants, payment allocation order, reminder offsets, deal approval thresholds, DST bearer,
  retention periods, SMS provider, RPO/RTO, broker-tag window.
- **All tax rates, thresholds and legal periods live in config tables with effective
  dates** (`config_value`, `tax_rate_table`), never in code. Seeded rows carry
  `needs_confirmation = true`.
- **Negotiated per deal, no global defaults:** security deposit months, advance rent
  months, escalation, late-payment penalty, broker commission. These are per-lease /
  per-deal fields. Term templates may only _pre-fill_ forms. A blank negotiated field blocks
  lease activation until filled or explicitly set to `NONE`. Never add a global setting
  for them.
- Never edit posted financial records — reverse and re-post. Lease terms are versioned;
  amendments create a new `lease_version`.

## Engineering conventions

- Monorepo: pnpm workspaces + Turborepo.
  - `apps/web` — Next.js App Router (staff app; later tenant/broker portals as route groups)
  - `apps/api` — NestJS REST, `/api/v1`, OpenAPI
  - `apps/worker` — BullMQ jobs (idempotent, logged)
  - `packages/domain` — pure TS business logic, no I/O, ≥ 80 % coverage
  - `packages/db` — Drizzle schema, SQL migrations, RLS policies, seed
  - `packages/contracts` — Zod DTOs shared by api + web
  - `packages/ui`, `packages/config`
- Strict TypeScript, ESLint, Prettier. **No `any` in domain code.**
- Modules (`identity`, `contacts`, `properties`, `pipeline`, `leases`, `billing`,
  `receivables`, `reminders`, `brokers`, `commissions`, `operations`, `compliance`,
  `documents`, `notifications`, `reporting`, `config`, `audit`) talk through service
  interfaces and domain events — **never read another module's tables**.
- **Money:** `NUMERIC(14,2)` in Postgres; `Money` (decimal.js) in code. **Never floats.**
  All rounding goes through `packages/domain/src/money/rounding.ts`.
- **Time:** `timestamptz` for instants; business dates are `date` in **Asia/Manila**.
  Display `MMM DD, YYYY`. Currency PHP (₱). English UI, i18n-ready.
- **IDs:** UUIDv7 for every primary/external id.
- **Tests:** table-driven unit tests for all money logic (leap years, month-end due dates,
  partial/over-payments, mid-term amendments …). One integration test per role proving
  what it **cannot** access. Reminder engine tested with a controllable clock — no real
  sleeps. RLS policies covered by tests.
- Feature flags: `invoicing`, `online_payments`, `portals`, `ai_assist` (all off by default).
- Every migration is reviewed. Changes to auth, permissions, crypto or money logic are
  flagged for extra review in the PR description.
- Pin exact dependency versions; Renovate keeps them current.

## Security rules (non-negotiable — OWASP ASVS L2, L3 for auth/financial/audit)

- **AuthN:** Keycloak (OIDC). Staff MFA mandatory — passkeys/WebAuthn preferred, TOTP
  fallback, **no SMS OTP for staff**. Google Workspace via IdP brokering. Passwords
  ≥ 12 chars + breached check, no forced rotation, progressive lockout.
- **Sessions:** BFF pattern — tokens stay server-side (Redis); browser gets an
  `__Host-` httpOnly, Secure, SameSite=Strict cookie. Idle 15 min, absolute 12 h; step-up
  re-auth for sensitive actions; remote session revoke; leavers revoked immediately.
- **AuthZ:** RBAC + ABAC (property / tenant / broker-firm scope) enforced server-side in the
  policy layer **and** in Postgres RLS. The app connects as `app_rw` (no `BYPASSRLS`, not
  table owner); every request runs in a transaction that sets `app.*` session variables.
  Never trust client filters. IDOR: authorize every object access; unknown/out-of-scope
  ids return 404.
- **Super Admin has no default PII/financial access.** Break-glass requires a reason,
  is audited and alerts.
- **Maker–checker** for deal sheets outside limits, billing run issuance, credit memos /
  write-offs, payment reversals, deposit refunds, commission releases, bulk exports,
  role/permission changes, config/rate changes. **A maker can never approve their own item**
  (enforced in service and DB).
- **Field encryption:** TINs, government IDs, bank accounts, tenant financials, scanned IDs
  use envelope encryption (AWS KMS in prod; local KEK only in dev/test) with AES-256-GCM
  and AAD bound to table/column/row. Searchable fields use an HMAC blind index. Masked by
  default; "reveal" needs a permission + reason and is audited.
- **No PII in logs, URLs, query strings, analytics or error trackers.** All logging goes
  through the redaction layer; tests prove it.
- **Audit log** is append-only and hash-chained (DB triggers forbid UPDATE/DELETE), shipped
  to write-once storage. Log logins/failures, MFA changes, permission changes, PII reveals,
  document views/downloads, exports, every financial change (before/after), approvals,
  config/rate changes.
- **Documents:** private bucket, malware scan before use, type allowlist, size limits,
  metadata stripped, served only via signed URLs ≤ 5 min after an authz check; every access
  audited.
- Zod validation on every endpoint; parameterised queries / ORM only; strict CSP; CSRF;
  CORS allowlist; rate limits on auth, OTP, search, export and file endpoints.
- Secrets only from env / secrets manager — never committed (gitleaks pre-commit + CI).
- **No production data outside prod.** Seed data is synthetic.
- AI assist (later) is feature-flagged; no PII to external AI without a DPA and minimisation.

## Commands

```bash
pnpm install
pnpm infra:up          # docker compose: postgres, redis, keycloak, minio, clamav, mailpit
pnpm db:migrate        # apply migrations (as app_migrator)
pnpm db:seed           # synthetic seed data
pnpm dev               # api + web + worker
pnpm lint && pnpm typecheck && pnpm test
pnpm test:integration  # needs Postgres (DATABASE_URL_MIGRATOR / DATABASE_URL_APP)
```
