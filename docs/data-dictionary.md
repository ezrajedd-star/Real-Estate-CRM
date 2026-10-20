# Data dictionary — Phase 1

Conventions:

- Every table has a `uuid` primary key (UUIDv7).
- Most tables have `created_at`/`updated_at` (`timestamptz`) and `version` (optimistic
  lock, bumped by trigger).
- Business dates are `date` in Asia/Manila. Money is `NUMERIC(14,2)`; rates are
  `NUMERIC(9,6)`.

Classification:

- **P**: personal data.
- **S**: sensitive (encrypted at field level).
- **F**: financial.
- **A**: append-only.

## identity

| Table               | Purpose                                      | Notable columns                                                                                                                         |
| ------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `app_user`          | Staff account (mirrors the Keycloak subject) | `keycloak_sub` (`pending:` before first login, `system:` reserved), `email` **P**, `display_name` **P**, `status` ACTIVE/SUSPENDED/LEFT |
| `role_assignment`   | Role in a scope                              | `role`, `scope_type` GLOBAL/PROPERTY/COMPANY, `scope_id`, `granted_by`, `revoked_at`                                                    |
| `role_permission`   | Catalogue copy for RLS                       | synced from `packages/domain` on every migrate                                                                                          |
| `user_session`      | Index of server-side sessions                | `id` = SHA-256 of the session id, `idle_expires_at`, `absolute_expires_at`, `amr`, `ip_hash`                                            |
| `break_glass_grant` | Emergency access                             | `reason` (≥ 15 chars), `expires_at` ≤ 2 h after start                                                                                   |
| `access_review`     | Quarterly access snapshot                    | `snapshot` jsonb (users × roles × scopes, flags)                                                                                        |

## audit (**A**)

| Table            | Purpose                                  | Notable columns                                                                                                                                                         |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_log`      | Hash-chained event log                   | `seq`, `occurred_at`, `actor_id`/`actor_type`, `action`, `subject_type`/`subject_id`, `outcome`, `details` (no clear PII), `request_id`, `ip_hash`, `prev_hash`, `hash` |
| `ship_cursor`    | Progress of shipping to the WORM archive | `last_seq`, `last_hash`, `last_object_key`                                                                                                                              |
| `security_alert` | Monitoring alerts                        | `kind`, `severity`, `details`, `acknowledged_by`                                                                                                                        |

## crypto

| Table      | Purpose      | Notable columns                                                                     |
| ---------- | ------------ | ----------------------------------------------------------------------------------- |
| `data_key` | Wrapped DEKs | `purpose`, `version`, `kek_id`, `wrapped_key`, `status` ACTIVE/DECRYPT_ONLY/RETIRED |

## config

| Table          | Purpose                   | Notable columns                                                                                                                          |
| -------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `config_value` | Effective-dated settings  | `key`, `scope_type`/`scope_id`, `value` jsonb, `effective_from`/`effective_to` (exclusive), `needs_confirmation`; no overlapping periods |
| `tax_rate`     | Effective-dated tax rates | `tax_type` (VAT, EWT_RENT, EWT_BROKER, DST_LEASE…), `rate` or `brackets`, `basis`, `source_reference`                                    |
| `feature_flag` | Feature switches          | `invoicing`, `online_payments`, `portals`, `ai_assist` (all off)                                                                         |

## approvals

| Table                       | Purpose               | Notable columns                                                                               |
| --------------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `approval_request`          | Maker–checker request | `type` ROLE_CHANGE/CONFIG_CHANGE/BULK_EXPORT, `payload`, `maker_id`, `status`, `applied_at`   |
| `approval_decision` (**A**) | One decision per step | `step_index`, `decider_id` (≠ maker, = current user; trigger-enforced), `decision`, `comment` |

## properties

| Table      | Purpose                                    | Notable columns           |
| ---------- | ------------------------------------------ | ------------------------- |
| `property` | Scoping anchor (full inventory in Phase 2) | `code`, `name`, `address` |

## contacts

| Table                    | Purpose                                             | Notable columns                                                                                                                              |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `company`                | Tenant / prospect company                           | `legal_name`, `trade_name`, `registration_type`/`registration_no`, `tin_enc` **S**, `tin_bidx` (unique), `tin_last3`, `vat_status`, `status` |
| `company_property`       | Company ↔ property relation (drives property scope) | `relation` PROSPECT/TENANT/FORMER_TENANT                                                                                                     |
| `person`                 | Individual                                          | `full_name` **P**, `email` **P**, `phone` **P** (masked in the UI), `gov_id_type`, `gov_id_enc` **S**, `gov_id_bidx`, `gov_id_last4`         |
| `company_contact_role`   | Person's role at a company                          | `role` SIGNATORY/BILLING_CONTACT/GUARANTOR/BENEFICIAL_OWNER/…, `authority_document_id`, `ownership_pct`, effective dates                     |
| `kyc_profile`            | AMLA basic KYC                                      | `status`, `risk_rating`, `financials_enc` **S F**, `next_review_on`                                                                          |
| `bank_account`           | Tenant bank account (refunds)                       | `account_no_enc` **S F**, `account_no_bidx`, `account_no_last4`                                                                              |
| `privacy_notice` (**A**) | Versioned notices                                   | `version_label`, `audience`, `body_markdown`, `body_sha256`                                                                                  |
| `consent` (**A**)        | Consent / acknowledgement records                   | `purpose`, `lawful_basis`, `action` GRANTED/WITHDRAWN/ACKNOWLEDGED, `channel`                                                                |

## documents, imports, exports

| Table                  | Purpose                     | Notable columns                                                                                                                                            |
| ---------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents.document`   | File metadata (bytes in S3) | `company_id` (scope), `category`, `classification` GENERAL/SENSITIVE, `status` PENDING_UPLOAD→QUARANTINED→CLEAN/INFECTED/REJECTED, `sha256`, `storage_key` |
| `imports.import_batch` | Excel import                | `import_type`, `document_id`, `property_id`, `status`, row counts                                                                                          |
| `imports.import_row`   | Imported row                | `data_enc` **S** (raw row), `errors` (field/code/message, never values), `target_id`                                                                       |
| `exports.export_job`   | Approved bulk export        | `approval_request_id`, `filters`, `row_count`, `watermark`, `downloaded_at` (single use), `expires_at`                                                     |

## Retention (all **[CONFIRM]**)

Retention periods per record type (tax, contracts, KYC, audit logs) are open decisions. Phase 4
adds `compliance.retention_policy` and `legal_hold`, plus the anonymise/delete jobs. Until then
nothing is deleted automatically, except abandoned quarantine uploads (1 day).
