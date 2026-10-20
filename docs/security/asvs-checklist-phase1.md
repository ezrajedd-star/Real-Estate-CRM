# OWASP ASVS 4.0.3 — Phase 1 checklist (items touched)

Target: Level 2 overall; Level 3 for authentication, financial data and audit logging.
Status: ✅ implemented and tested · 🟡 implemented, not yet verified in a real environment ·
⏳ open (owner/phase noted).

## V1 Architecture

| Item                                                   | Status | Evidence                                                               |
| ------------------------------------------------------ | ------ | ---------------------------------------------------------------------- |
| 1.1.2 Threat model for design changes                  | ✅     | `docs/security/threat-model.md`, PR checklist                          |
| 1.2.2 Communications between components authenticated  | ✅     | DB per-role credentials; Redis AUTH; KMS IAM; OIDC confidential client |
| 1.4.1 Trusted enforcement points for access control    | ✅     | Policy layer + Postgres RLS (ADR-003)                                  |
| 1.6.1 Explicit policy for cryptographic key management | ✅     | ADR-005                                                                |
| 1.14.6 No unsupported/insecure client-side tech        | ✅     | No tokens in the browser; BFF                                          |

## V2 Authentication (L3 target)

| Item                                                       | Status | Evidence                                                                                            |
| ---------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| 2.1.1 Passwords ≥ 12 characters                            | 🟡     | Keycloak `passwordPolicy` (realm file; boot not yet tested in CI)                                   |
| 2.1.7 Breached-password check                              | 🟡     | `passwordBlacklist` + mounted list (production list to supply)                                      |
| 2.1.10 No periodic rotation / composition rules            | 🟡     | Realm policy                                                                                        |
| 2.2.1 Anti-automation for credential attacks               | ✅/🟡  | App rate limits on auth routes + failed-login alert (tested); Keycloak brute-force back-off (realm) |
| 2.2.4 / 2.2.5 Phishing-resistant / multi-factor for admins | 🟡     | WebAuthn preferred, TOTP fallback; app refuses non-MFA logins (tested e2e)                          |
| 2.7.x No SMS OTP for staff                                 | ✅     | `isMultiFactor` ignores `sms`; test `staff without MFA cannot sign in`                              |
| 2.8.x TOTP                                                 | 🟡     | Keycloak OTP policy (no code reuse)                                                                 |

## V3 Session management (L3 target)

| Item                                             | Status | Evidence                                                                           |
| ------------------------------------------------ | ------ | ---------------------------------------------------------------------------------- |
| 3.2.1 New session token on authentication        | ✅     | Session rotated at login                                                           |
| 3.2.2 ≥ 64 bits of entropy                       | ✅     | 256-bit cookie value                                                               |
| 3.3.1 / 3.3.2 Logout and absolute/idle timeouts  | ✅     | 15 min idle (Redis TTL), 12 h absolute; tests                                      |
| 3.3.3 Option to end all other sessions           | ✅     | `/auth/sessions` list/revoke; leaver revokes all                                   |
| 3.3.4 Users can view and log out active sessions | ✅     | Account page                                                                       |
| 3.4.1–3.4.5 Cookie attributes                    | ✅     | `__Host-sid`: httpOnly, Secure, SameSite=Strict, path `/`                          |
| 3.7.1 Re-authentication for sensitive actions    | ✅     | `@StepUp()` (role changes, offboarding, break-glass, bank accounts, exports); test |

## V4 Access control

| Item                                            | Status | Evidence                                                                                  |
| ----------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| 4.1.1 Enforced at a trusted service layer       | ✅     | Guards + services; RLS                                                                    |
| 4.1.3 Least privilege                           | ✅     | Role catalogue; Super Admin has no PII                                                    |
| 4.2.1 IDOR protection                           | ✅     | 404 for out-of-scope; per-role denial tests                                               |
| 4.2.2 Anti-CSRF                                 | ✅     | Synchronizer token + Origin check + SameSite=Strict; tests                                |
| 4.3.1 MFA for administrative interfaces         | 🟡     | Keycloak admin console behind IP allowlist; app admin actions need MFA sessions + step-up |
| 4.3.2 No directory browsing / metadata exposure | ✅     | API only JSON; OpenAPI behind auth                                                        |

## V5 Validation, sanitisation, encoding

| Item                                                 | Status | Evidence                                   |
| ---------------------------------------------------- | ------ | ------------------------------------------ |
| 5.1.3 Input validation (allowlist) on all inputs     | ✅     | Zod on every body/query; UUID route params |
| 5.1.5 URL redirects to allowlisted destinations only | ✅     | `returnTo` relative-path regex; test       |
| 5.2.x Output encoding / XSS                          | ✅     | React; strict CSP with nonce               |
| 5.3.4 Parameterised queries                          | ✅     | Drizzle / parameterised `pg`               |
| 5.3.x CSV/formula injection in exports               | ✅     | `csvCell` prefixes `= + - @`               |

## V6 Stored cryptography (L3 for financial data)

| Item                                                         | Status | Evidence                                                                         |
| ------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------- |
| 6.1.1 / 6.1.3 Regulated and financial data encrypted at rest | ✅     | Envelope encryption: TIN, government IDs, bank accounts, financials, import rows |
| 6.2.1 Fail securely                                          | ✅     | AES-GCM authentication errors → `DecryptionError`                                |
| 6.2.2 Proven algorithms                                      | ✅     | AES-256-GCM, HMAC-SHA256, HKDF, SHA-256                                          |
| 6.4.1 / 6.4.2 Key management, keys isolated                  | ✅     | KMS KEK; wrapped DEKs; rotation job                                              |

## V7 Errors and logging (L3 target)

| Item                                         | Status | Evidence                                                                                               |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| 7.1.1 / 7.1.2 No credentials or PII in logs  | ✅     | Redaction layer + leak tests (platform and API)                                                        |
| 7.1.3 Security events logged                 | ✅     | Logins/failures, denials, reveals, downloads, exports, approvals, role and config changes, break-glass |
| 7.3.1 / 7.3.3 Log integrity and protection   | ✅     | Append-only + hash chain + Object Lock archive; tamper test                                            |
| 7.3.x Cross-region copy of the audit archive | ⏳     | Open item (needs an Object-Lock destination) — Phase 2 infra                                           |
| 7.4.1 Generic error message with an id       | ✅     | Error envelope with `requestId`; no stack traces (test)                                                |

## V8 Data protection

| Item                                          | Status | Evidence                                                            |
| --------------------------------------------- | ------ | ------------------------------------------------------------------- |
| 8.1.1 No sensitive data in caches             | ✅     | `cache-control: no-store` on every API response                     |
| 8.2.x Client-side storage                     | ✅     | No PII in localStorage; revealed values are in memory for 60 s only |
| 8.3.1 Sensitive data not in URLs              | ✅     | Person search via POST body; URLs logged without query strings      |
| 8.3.4 Sensitive data identified and protected | ✅     | Masking by default; reveal with reason                              |
| 8.3.x Bulk export controls                    | ✅     | Approval, single use, expiry, cap, watermark, alert; test           |

## V9 Communications

| Item                                            | Status  | Evidence                                                                           |
| ----------------------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| 9.1.1–9.1.3 TLS 1.2+ for all client connections | 🟡      | ALB TLS policy; HSTS (Terraform/API headers)                                       |
| 9.2.2 TLS to back ends                          | 🟡 / ⏳ | RDS force_ssl, Redis TLS; ALB→task HTTP inside the VPC (accepted, `.checkov.yaml`) |

## V10–V12 Malicious code, business logic, files

| Item                                       | Status | Evidence                                                                     |
| ------------------------------------------ | ------ | ---------------------------------------------------------------------------- |
| 10.3.2 Dependency integrity                | ✅     | Pinned versions, lockfile, Renovate with 14-day minimum age, pnpm audit, OSV |
| 11.1.x Business logic limits               | ✅     | Maker–checker (DB-enforced); rate limits                                     |
| 12.1.1 File size limits                    | ✅     | Per-type limits; signed Content-Length                                       |
| 12.2.1 Content matches the declared type   | ✅     | Magic-byte check; test                                                       |
| 12.4.1 Files outside the web root, private | ✅     | Private S3; presigned ≤ 5 min                                                |
| 12.4.2 Malware scanning                    | ✅     | ClamAV INSTREAM, fail closed; EICAR test                                     |
| 12.5.x Files served as attachments         | ✅     | `Content-Disposition: attachment`                                            |

## V13–V14 API and configuration

| Item                                        | Status | Evidence                                                                                      |
| ------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| 13.1.x API authentication; schema-described | ✅     | OpenAPI 3.1 from the same Zod schemas                                                         |
| 14.2.1 Up-to-date components                | ✅     | Renovate, CI scans, Trivy                                                                     |
| 14.3.2 No debug output in production        | ✅     | Error filter; Nest logger off                                                                 |
| 14.4.x Security headers                     | ✅     | Helmet (API) + middleware (web): CSP, HSTS, nosniff, XFO, Referrer, Permissions policy; tests |
| 14.5.3 CORS allowlist                       | ✅     | Only `PUBLIC_WEB_ORIGIN`; test                                                                |

## Open items carried into Phase 2

1. Boot the Keycloak realm in CI and add an e2e run against it (in addition to `tools/test-idp`).
2. Production breached-password list and passkey enrolment rollout.
3. Cross-region replication of the audit archive.
4. Decide on end-to-end TLS ALB → tasks.
5. Third-party penetration test before go-live (arranged by the business).
