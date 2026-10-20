# ADR-005: Application-level envelope encryption with AAD binding and blind indexes

## Context

TINs, government IDs, bank accounts, tenant financials and import rows must be encrypted in
the application (KMS) in addition to disk encryption. Some of these fields must be searchable
(TIN duplicate detection), and keys must be rotatable.

## Decision

- **KEK/DEK.**
  - A KMS key (`alias/<env>-app`) is the KEK. Only the API and worker task roles may use it,
    and only with an encryption context.
  - Each _purpose_ (`tin`, `gov_id`, `bank`, `financials`, `import`, `blind_index`) has a
    lineage of 32-byte DEKs, stored wrapped in `crypto.data_key (purpose, version, status)`.
    The wrap context is `{purpose, version}`.
  - Locally, `LocalKeyProvider` (AES-GCM, KEK from env) stands in for KMS. It refuses to run
    when `NODE_ENV=production`, and its key id is a fingerprint of the KEK.
- **Ciphertext.** The token format is `v1.<purpose>.<version>.<iv>.<ct>.<tag>` (AES-256-GCM).
  The **AAD is `table/column/rowId`**, so a ciphertext copied to another row or column fails
  to decrypt.
- **Blind index.** `HMAC-SHA256(normalised value)` with a per-field subkey derived by HKDF
  from the `blind_index` DEK. Equal values in different fields do not correlate. It is used
  for TIN uniqueness (`company_tin_bidx_uq`) and lookups.
- **Masking.** Each table also stores a safe display fragment (`tin_last3`, `gov_id_last4`,
  `account_no_last4`), so lists never decrypt anything.
- **Rotation (worker job `rotate-keys`).**
  1. Create the next version and mark the old one DECRYPT_ONLY.
  2. Re-encrypt every registered column (`ENCRYPTED_COLUMNS`) in batches.
  3. Retire old versions only when a final scan finds no ciphertext still using them.
     The API reads the active version on every encryption, so new values use the new key at
     once.
- **Caching.** Unwrapped DEKs are cached in memory for 10 minutes.

## Consequences

- **New encrypted columns** need an AAD convention and an entry in `ENCRYPTED_COLUMNS`
  (PR checklist).
- **The blind-index key is never rotated automatically.** Rotating it means rebuilding every
  index.
- **Losing the KEK means losing the data.** KMS keys have a 30-day deletion window and
  restricted administration.
