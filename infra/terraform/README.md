# Infrastructure (AWS ap-southeast-1, Singapore)

```
environments/{staging,production}   → thin roots: backend, providers, sizing
modules/stack                       → wires one environment together (+ cross-region backups)
modules/network                     → VPC, public (ALB/NAT) + private subnets, S3 endpoint, flow logs, SGs
modules/iam                         → one task role per service + ECS execution role
modules/kms                         → CMKs: app (envelope KEK), data, logs — rotation on
modules/data                        → RDS PostgreSQL 16, ElastiCache Redis, document + WORM audit + access-log buckets
modules/app                         → ALB + WAF, ECS Fargate (api, web, worker+ClamAV, keycloak), migrate task
```

Validated in this repo with `terraform validate` (both environments), `terraform fmt`,
tflint and Checkov (accepted findings are listed with reasons in `.checkov.yaml`). It has
**not been applied** — no AWS account was available while building Phase 1.

## Security properties

- No public database or cache endpoints; tasks run in private subnets; the ALB is the only
  public entry point, behind AWS WAF (IP reputation, common rules, known bad inputs/Log4j,
  SQLi, per-IP rate limit). WAF logs redact `cookie` and `authorization`.
- TLS 1.2+ only (`ELBSecurityPolicy-TLS13-1-2-2021-06`); HTTP redirects to HTTPS;
  `rds.force_ssl=1`; Redis in-transit encryption + AUTH; S3 bucket policies deny non-TLS.
- Encryption at rest everywhere with customer-managed keys; the application KEK can only be
  used by the API and worker task roles, with an encryption context.
- Audit archive: S3 Object Lock in **COMPLIANCE** mode (cannot be deleted or shortened, even
  by root); the worker may only `PutObject` into it.
- Backups: RDS PITR 35 days + automated-backup replication to the backup region; clean
  documents replicated cross-region. Targets RPO ≤ 15 min, RTO ≤ 4 h **[CONFIRM]**.
- ECS: read-only root filesystems for Node services, non-root user, all Linux capabilities
  dropped, no ECS Exec (no shell into production), circuit-breaker rollback.
- Secrets: Terraform creates Secrets Manager containers only; values are set out-of-band so
  they never enter Terraform state.

## First-time setup (per environment)

1. Create the state bucket + DynamoDB lock table (separate security account), then
   `terraform init -backend-config=backend.hcl` (bucket, key, region, dynamodb_table, encrypt=true).
2. Request an ACM certificate for `app_domain` and `auth_domain`; pass `certificate_arn`.
3. Build, scan and push images (CI `images` job); pass them **by digest** in `images`
   (`api`, `worker`, `web`, `keycloak`, `clamav`).
4. `terraform apply`.
5. Set secret values in Secrets Manager (`<name>/database_url_app`, …).
6. Bootstrap database roles once, from a bastion-less one-off task using the RDS master
   secret: run `infra/docker/postgres/init/01-roles.sh` (creates `app_migrator`, `app_rw`,
   `app_worker` with NOBYPASSRLS and the `pgcrypto`/`btree_gist` extensions), plus a
   `keycloak` database and role.
7. Before every deploy: `aws ecs run-task --task-definition <name>-migrate …` (runs
   `node node_modules/@crm/db/dist/cli/migrate.js` as `app_migrator`).

## Open decisions

- DR/backup region (default `ap-southeast-3`, Jakarta) **[CONFIRM]**.
- Audit/document retention periods **[CONFIRM]** (`audit_retention_days`).
- End-to-end TLS from ALB to tasks (currently HTTP inside the VPC; see `.checkov.yaml`).
- Cross-region replication of the Object-Lock audit archive (needs a locked destination).
