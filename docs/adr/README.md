# Architecture Decision Records

| #                                      | Decision                                                                                      | Status                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| [001](001-orm-and-migrations.md)       | Drizzle ORM + hand-written SQL migrations                                                     | Accepted                           |
| [002](002-identity-and-sessions.md)    | Keycloak (OIDC) + BFF server-side sessions, MFA enforced in the app                           | Accepted                           |
| [003](003-authorization-and-rls.md)    | Authorization in the app DB: RBAC + ABAC scopes, enforced twice (policy layer + Postgres RLS) | Accepted                           |
| [004](004-audit-log.md)                | Append-only, hash-chained audit log in Postgres, shipped to S3 Object Lock                    | Accepted                           |
| [005](005-field-encryption.md)         | Envelope encryption (KMS) with AAD binding and HMAC blind indexes                             | Accepted                           |
| [006](006-documents.md)                | Private object storage, quarantine → scan → clean, ≤ 5-minute signed URLs                     | Accepted                           |
| [007](007-money-and-dates.md)          | Money as NUMERIC(14,2)/Decimal, one rounding module; business dates in Asia/Manila            | Accepted (rounding mode [CONFIRM]) |
| [008](008-config-and-maker-checker.md) | Effective-dated config/rate tables, changed only through maker–checker                        | Accepted                           |

New ADRs: copy the structure (Context → Decision → Consequences), number sequentially,
never rewrite an accepted ADR — supersede it with a new one.
