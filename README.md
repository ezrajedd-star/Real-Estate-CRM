# Commercial Leasing CRM (Philippines)

Lease administration, billing, receivables and collections for commercial space. The full
brief is in [`docs/brief.md`](docs/brief.md); conventions and security rules are in
[`CLAUDE.md`](CLAUDE.md).

**Status: Phase 1 — foundation & security.** Phase 1 delivers authentication, authorization
(RBAC + ABAC + RLS), audit, encryption, documents, config/rate tables,
companies/contacts/KYC, Excel import, CI security scanning and IaC. Leasing features start in
Phase 2.

## Layout

```
apps/api        NestJS (Fastify) REST API, /api/v1 — BFF auth, policy layer, modules
apps/worker     BullMQ jobs: malware scan, audit shipping/verification, key rotation
apps/web        Next.js staff app (strict CSP, same-origin API proxy)
packages/domain Pure business logic: Money, Manila dates, effective dating, roles, maker–checker
packages/db     SQL migrations (RLS, triggers), Drizzle schema, request-context client
packages/platform Envelope encryption, blind index, PII-redacting logger
packages/contracts Zod DTOs → validation + OpenAPI (docs/api/openapi.json)
packages/ui     Shared React components and formatters
tools/seed      Synthetic seed data          tools/test-idp  TEST-ONLY OIDC provider for e2e
infra/docker    Local stack                  infra/keycloak  Realm as code
infra/terraform AWS ap-southeast-1           docs/           ADRs, security, data dictionary, guides
```

## Local development

Requirements: Node 22, pnpm 10, Docker.

```bash
cp .env.example .env          # fill every CHANGE_ME with random values
pnpm install
pnpm infra:up                 # Postgres, Redis, Keycloak, MinIO, ClamAV, Mailpit
pnpm db:migrate && pnpm db:seed
pnpm dev                      # api :4000, web :3000, worker
```

Create a user in Keycloak (http://localhost:8080) with one of the seeded staff emails (e.g.
`leasing.head@example.test`). Sign in at http://localhost:3000; you will be asked to enrol
TOTP or a passkey.

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test     # unit (domain coverage gate ≥ 80 %)
pnpm test:integration                        # needs Postgres + Redis (see .github/workflows/ci.yml)
pnpm --filter @crm/api build && pnpm --filter @crm/web build && pnpm --filter @crm/web e2e
```

The e2e suite starts the real API, worker and web app against a test OIDC provider, an
S3-compatible server and a clamd stand-in.

## Security

Start with [`docs/security/threat-model.md`](docs/security/threat-model.md),
[`docs/security/asvs-checklist-phase1.md`](docs/security/asvs-checklist-phase1.md) and
[`docs/security/incident-response.md`](docs/security/incident-response.md). Changes to auth,
permissions, crypto, money logic, migrations or IaC need a security reviewer (CODEOWNERS).

## Open decisions

Each item below must be confirmed by the business before it is hard-coded:

- accounting system and BIR invoicing;
- CUSA basis and which tenants pay percentage rent;
- payment allocation order;
- reminder offsets;
- deal approval thresholds;
- who bears documentary stamp tax (DST);
- retention periods;
- SMS provider;
- RPO/RTO;
- broker-tag window;
- DR region;
- rounding mode.

Seeded values are flagged `needs_confirmation`.
