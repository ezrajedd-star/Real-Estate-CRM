# ADR-008: Effective-dated configuration and maker–checker changes

## Context

Philippine tax rates, thresholds and legal periods change and must be validated by the
accountant or lawyer. The brief forbids hard-coding them. Some items are **negotiated per
deal** (deposit and advance months, escalation, penalty, broker commission) and must have
**no global defaults**.

## Decision

- **Tables.**
  - `config.config_value(key, scope GLOBAL|PROPERTY|COMPANY, value jsonb, effective_from,
effective_to, needs_confirmation)`.
  - `config.tax_rate(tax_type, rate | brackets, basis, source_reference, effective range,
needs_confirmation)`.
  - A `btree_gist` EXCLUDE constraint makes overlapping periods for the same key impossible.
- **Effective dating.** `effective_to` is exclusive. Lookups go through
  `resolveEffective(rows, asOf)`, which throws on overlaps.
- **Changes.** A change is a `CONFIG_CHANGE` approval request. When a different user with
  `config.approve` approves it, the handler (in the same transaction) closes the open period
  at the new start date and inserts the new row. History is never edited. Feature flags
  (`invoicing`, `online_payments`, `portals`, `ai_assist`, all off) change the same way.
- **Unconfirmed values.** Seeded values carry `needs_confirmation = true` and are badged in
  the UI. A checker can mark a row confirmed when approving it.
- **Negotiated terms.** There are deliberately no config keys for deposit, advance,
  escalation, penalty or commission. Phase 2 stores them per lease or deal. Templates only
  pre-fill forms, and a blank negotiated field blocks lease activation.

## Consequences

- Billing in Phase 3 resolves every rate by business date, so past statements stay
  reproducible after a rate change.
- The maker–checker engine (`ApprovalsService` + handlers) is reused for later approval types
  (deal sheets, credit memos, refunds, commission releases).
