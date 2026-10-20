# ADR-003: Authorization — RBAC + ABAC scopes, enforced in the policy layer and in Postgres RLS

## Context

Roles (brief §7.1) are scoped. A Leasing Manager sees assigned properties, a Leasing Officer
sees assigned tenants, and Super Admin sees no tenant PII. The brief requires enforcement
server-side in the application **and** in RLS, plus maker–checker for role changes.

## Decision

- **Catalogue in code.** `packages/domain/src/authz/catalogue.ts` holds `STAFF_ROLES`,
  `PERMISSIONS` and `ROLE_PERMISSIONS`. Permissions are fine-grained (`company.read`,
  `pii.reveal.tin`, `config.approve`, …).
- **Assignments in the database.** `identity.role_assignment` holds (user, role, scope_type
  `GLOBAL | PROPERTY | COMPANY`, scope_id). Granting or revoking is an approval request
  applied by a _different_ user who holds `user.approve_role_change` (the DPO). RLS forbids
  self-grants.
- **Layer 1, the policy layer (API).**
  1. Global guards run in order: auth → CSRF → `@Can(...)` → step-up → rate limit.
  2. Services check object scope with `canAccess(grants, permission, {companyId, propertyIds})`
     (`assertCompanyAccess`).
  3. Unknown and out-of-scope ids both return **404**, so ids cannot be probed. Denials are
     audited.
- **Layer 2, Postgres RLS.**
  - The API connects as `app_rw` and the worker as `app_worker`. Both are `NOBYPASSRLS` and
    own no tables.
  - Every request transaction sets `app.user_id` (and request id / IP hash) with
    `set_config(..., is_local => true)`. The values vanish at commit, so pooled connections
    never leak identity.
  - Policies call `SECURITY DEFINER` helpers (`app.has_permission`,
    `app.can_access_company`, …). These read `identity.role_assignment` ×
    `identity.role_permission`, the latter synced from the catalogue on every migrate.
  - With no user set, protected tables return zero rows.
- **Separation of duties.** Super Admin has no `company.read` or PII permissions. Break-glass
  is a time-boxed (≤ 2 h) grant with a stated reason. It gives read-only RLS visibility,
  raises a CRITICAL alert and is fully audited.
- **Field level.** Sensitive fields are masked in every DTO. A reveal is a separate POST that
  needs a field-specific permission (`pii.reveal.tin|gov_id|bank|contact`) and a reason. It
  is rate-limited and audited, and denials are audited too.
- **Maker–checker.** Every check runs on the same rules (`packages/domain/src/approvals`), and
  the database independently rejects `decider = maker` with a trigger.

## Consequences

- Two independent layers must agree. Integration tests prove each role's _denials_ at both
  layers (`packages/db/test/integration/rls.test.ts`, `apps/api/test/integration/authz.test.ts`).
- Property-scoped users create companies with client-generated UUIDv7 ids and link them to
  their property in the same transaction. They cannot see the row until it is linked, so
  `RETURNING` is not used.
- Adding a table means adding RLS policies plus a denial test (PR checklist).
