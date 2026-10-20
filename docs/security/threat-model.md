# Threat model (STRIDE) — Phase 1

Last reviewed: Phase 1 delivery. Update this document whenever a trust boundary, data store
or privileged flow changes (PR checklist).

## Assets

| Asset                                                                          | Why it matters                              |
| ------------------------------------------------------------------------------ | ------------------------------------------- |
| Tenant/contact PII: names, emails, phones, government IDs, TINs                | Data Privacy Act (RA 10173); identity fraud |
| Financial data: bank accounts, tenant financials, (later) billing and payments | Fraud, confidentiality                      |
| Role assignments and approvals                                                 | Privilege escalation, separation of duties  |
| Audit log                                                                      | Accountability, NPC breach investigation    |
| Config / tax rates                                                             | Wrong billing, tax exposure                 |
| KMS KEK, data keys, session secrets, OIDC client secrets                       | Total compromise                            |

## Trust boundaries and data flows

```
[Browser] ──TLS──▶ [ALB + WAF] ──▶ [web (Next.js)]           (pages, CSP nonce)
    │                         └──▶ [api (NestJS, BFF)] ──▶ [Postgres (RLS)]
    │                                   │   ├──▶ [Redis: sessions, rate limits, queues]
    │                                   │   ├──▶ [KMS: unwrap DEKs]
    │                                   │   └──▶ [S3: presign only]
    ├──TLS──▶ [S3 presigned PUT/GET (≤5 min)]
    └──TLS──▶ [Keycloak] ◀──OIDC code+PKCE──▶ [api]
                         ◀──broker──▶ [Google Workspace]
[worker] ──▶ Postgres (app_worker), S3 (quarantine/clean, audit PutObject only), ClamAV (localhost), KMS
[admins] ──▶ Keycloak admin console (IP allowlist) ; no shell into ECS tasks
```

B1 Internet ↔ ALB · B2 ALB ↔ tasks · B3 API ↔ Postgres · B4 API/worker ↔ KMS/S3 · B5 Browser ↔ S3 ·
B6 API ↔ Keycloak/Google · B7 operators ↔ AWS/Keycloak admin.

## STRIDE analysis

| #   | Threat                                              | Boundary | Mitigations (where)                                                                                                                                                                                                                      | Residual / follow-up                                                                                                                           |
| --- | --------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Credential stuffing / phishing of staff passwords   | B1, B6   | MFA mandatory and **verified by the app** from acr/amr (`auth.controller.ts`); passkeys preferred; Keycloak brute-force back-off; breached-password list; WAF rate limit; per-IP/account limits on auth routes; failed-login burst alert | Passkey adoption campaign; phishing-resistant MFA mandatory for admins (Phase 4)                                                               |
| S2  | Session hijack / fixation                           | B1       | `__Host-` httpOnly Secure SameSite=Strict cookie; server-side session keyed by SHA-256; rotation at login; 15 min idle / 12 h absolute; remote revoke; leaver revokes all                                                                | —                                                                                                                                              |
| S3  | Login CSRF / OIDC code injection                    | B6       | State bound to browser cookie, single-use state in Redis, PKCE S256, nonce check, ID-token signature + issuer/audience via openid-client                                                                                                 | —                                                                                                                                              |
| S4  | Forged identity fields in audit / approvals         | B3       | Audit actor/time/request id set by trigger; approval decider must equal `app.user_id` (trigger)                                                                                                                                          | —                                                                                                                                              |
| T1  | Tampering with audit history                        | B3, B7   | Revoked UPDATE/DELETE/TRUNCATE + guard triggers; hash chain + hourly verify; JSONL copy in S3 Object Lock COMPLIANCE                                                                                                                     | DB superuser could rewrite _and_ re-chain recent unshipped rows (≤ 5 min window) — mitigated by shipping cadence and superuser access controls |
| T2  | Tampering with ciphertext (swap TINs between rows)  | B3       | AES-GCM with AAD = table/column/row                                                                                                                                                                                                      | —                                                                                                                                              |
| T3  | Malicious upload (malware, polyglot, metadata leak) | B5       | Type/size allowlist, magic-byte check, ClamAV (fail closed), image re-encode, quarantine prefix + expiry, signed headers on PUT                                                                                                          | PDF metadata not rewritten (ADR-006)                                                                                                           |
| T4  | Config/rate manipulation                            | B3       | Maker–checker with DB-enforced maker ≠ checker; effective-dated rows never edited; row-change audit                                                                                                                                      | —                                                                                                                                              |
| R1  | User denies a PII reveal / export / approval        | —        | Reveal requires reason, audited with actor and request id; exports watermarked with user + time; approvals and decisions immutable                                                                                                       | —                                                                                                                                              |
| I1  | IDOR across properties/tenants                      | B2, B3   | Object scope check in services → 404; Postgres RLS as second layer; per-role denial tests at both layers                                                                                                                                 | —                                                                                                                                              |
| I2  | PII in logs / errors / URLs                         | all      | Redaction layer on every log line (key denylist + value scrubbers) with leak tests; URLs logged without query strings; PII lookups via POST bodies; error envelope without stack traces; RDS `log_statement=none`; WAF log redaction     | Free-text names cannot be pattern-detected — only logged under redacted keys                                                                   |
| I3  | Database dump / backup theft                        | B3, B7   | Field encryption for TINs/IDs/bank/financials (KMS-wrapped DEKs); CMK at rest; no public endpoints                                                                                                                                       | Names, emails, phones are plain in DB (masked in UI) — consider encryption if risk assessment requires                                         |
| I4  | Over-broad export                                   | B1       | Permission + maker–checker approval + single use + 24 h expiry + size cap + watermark + masked TIN + volume alert                                                                                                                        | —                                                                                                                                              |
| I5  | Super Admin browsing tenant data                    | B7       | No PII permissions; break-glass ≤ 2 h, reason, CRITICAL alert, read-only                                                                                                                                                                 | —                                                                                                                                              |
| I6  | XSS stealing data                                   | B1       | React escaping; strict nonce CSP with `strict-dynamic`; httpOnly cookies; no inline scripts                                                                                                                                              | —                                                                                                                                              |
| D1  | Request floods / expensive endpoints                | B1       | WAF rate rule; Redis limits per IP and per account; body limit 1 MB; files bypass the API; statement timeout 30 s                                                                                                                        | Billing runs (Phase 3) need job concurrency limits                                                                                             |
| D2  | Audit chain lock contention                         | B3       | Short transactions, audit inserts late                                                                                                                                                                                                   | Re-design if Phase 3 load requires (ADR-004)                                                                                                   |
| E1  | Self-escalation of roles                            | B3       | Role changes only via approval by a different user holding `user.approve_role_change`; RLS forbids self-grants; step-up                                                                                                                  | —                                                                                                                                              |
| E2  | Bypassing RLS through the app role                  | B3       | Runtime roles not owners, NOBYPASSRLS; settings transaction-local; `SECURITY DEFINER` functions have fixed `search_path`                                                                                                                 | Every new table needs policies + tests (PR checklist)                                                                                          |
| E3  | Compromised task escalates in AWS                   | B4, B7   | One least-privilege role per service; KMS key policy restricts the app KEK to API/worker; no ECS Exec; read-only root FS                                                                                                                 | —                                                                                                                                              |
| E4  | Test IdP or local KEK used in production            | B6       | `LocalKeyProvider` throws in production; env validation requires KMS in production; test IdP refuses `NODE_ENV=production` and is not built into images                                                                                  | —                                                                                                                                              |

## Abuse cases covered by automated tests

- Each role's denials (API: `authz.test.ts`; DB: `rls.test.ts`).
- Login CSRF, replayed state, open redirect, password-only and SMS sign-in (`auth.test.ts`, e2e).
- Maker self-approval; decision recorded in another user's name (DB and API).
- Audit row forgery and tampering detection (`audit.test.ts`).
- Ciphertext row/column swap (`field-cipher.test.ts`).
- EICAR, magic-byte mismatch, EXIF leakage (worker jobs tests).
- PII in logs (platform `redact.test.ts`, API `workflows.test.ts`).
