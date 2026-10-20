# ADR-004: Append-only, hash-chained audit log

## Context

Brief §8.3 requires an append-only, hash-chained audit log covering logins, MFA and permission
changes, PII reveals, document access, exports, financial changes (before/after), approvals
and config/rate changes. It must ship to a separate write-once store.

## Decision

- **Table.** `audit.audit_log` lives in Postgres. On insert, a `SECURITY DEFINER` trigger:
  1. takes a transaction-level advisory lock, so the chain is strictly serial;
  2. assigns `seq` and forces `occurred_at = clock_timestamp()`;
  3. forces the actor from `app.user_id` (actor type SYSTEM when the session role is
     `app_worker`), plus the request id and IP hash. Callers cannot forge any of these;
  4. computes `hash = sha256(prev_hash ‖ canonical(row))`.
- **Immutability.** UPDATE, DELETE and TRUNCATE are revoked from every runtime role, and
  triggers reject them even for the owner. Only a superuser disabling triggers can alter
  rows, and `audit.verify_chain()` then detects it (covered by a test).
- **Two sources of entries.**
  - Application events go through `AuditService.record(tx, …)` in the same transaction as
    the action. Denials and failures use `recordStandalone`.
  - Row-change triggers (`audit.capture_row_change`) on sensitive tables record
    before/after values. Ciphertext, blind indexes and contact PII columns are recorded only
    as `{changed: true}`.
- **Write-once copy.** The worker ships new rows every 5 minutes as JSONL objects to an S3
  bucket with Object Lock in COMPLIANCE mode. It advances the cursor only after a successful
  write and checks that the first unshipped row chains to the last shipped hash. An hourly
  `verify_chain` raises a CRITICAL `AUDIT_CHAIN_BROKEN` alert.
- **Readers.** Only `audit.read` holders (DPO, Internal Auditor) can read the log, and every
  read is itself audited.

## Consequences

- **Throughput.** The chain lock serialises audit-writing transactions from their first
  audit insert until commit. Writes are kept short and audit inserts come late in the
  transaction. **Never call `recordStandalone` while holding an audit lock in another
  transaction** (it would self-deadlock).
- **If this becomes a bottleneck** (Phase 3 billing runs), move to per-partition chains or
  asynchronous chaining by the worker. Either needs a new ADR.
- Retention of the archive is a [CONFIRM] item (`audit_retention_days`).
