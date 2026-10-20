# Keycloak realm `pmo` (identity as code)

`realm/pmo-realm.json` is imported by `docker compose` (`start-dev --import-realm`) and is the
source of truth for the staff realm in every environment. It defines:

| Item             | Setting                                                                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients          | `leasing-staff` (this system, confidential BFF, PKCE S256, `minimum.acr.value=mfa`), `residential-staff` (reserved for the future Residential Sales system — same SSO, separate role set), `leasing-admin` (client-credentials service account for the leaver process: `manage-users`, `view-users`) |
| MFA              | Custom browser flow `browser-mfa`: password **or** Google, then **passkey/WebAuthn or TOTP** (level of authentication 2 = `acr: mfa`). No SMS OTP. TOTP enrolment is a default required action.                                                                                                      |
| Google Workspace | IdP broker `google` restricted to `GOOGLE_HOSTED_DOMAIN`; post-broker flow `post-broker-mfa` still requires a second factor held in this realm.                                                                                                                                                      |
| Passwords        | NIST 800-63B style: ≥ 12 chars, not username/email, breached-password blocklist, no forced rotation. Brute-force protection with progressive back-off (60 s increments, max 15 min).                                                                                                                 |
| Sessions         | SSO idle 15 min, max 12 h (matches the application's own session limits).                                                                                                                                                                                                                            |
| Events           | Login/credential events and admin events retained 90 days (also shipped by the platform log pipeline).                                                                                                                                                                                               |

**Authorization is not in Keycloak.** Roles and their property/tenant scopes live in the
application database (`identity.role_assignment`) so that every change is maker–checker
approved and audited (ADR-003). Keycloak answers only "who is this, and did they use MFA?".

## Placeholders

The import substitutes `${VAR}` from the container environment (see `infra/docker/compose.yml`):
`LEASING_CLIENT_SECRET`, `LEASING_ADMIN_CLIENT_SECRET`, `WEB_ORIGIN`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_HOSTED_DOMAIN`. In AWS these come from Secrets Manager.

## Breached-password list

`passwordBlacklist(breached-passwords.txt)` expects the file under
`/opt/keycloak/data/password-blacklists/` (mount a current HIBP-derived list in production;
the deployment pipeline downloads and mounts it).

## Local users

There are no seeded human users in the realm. Create local test users in the admin console
(http://localhost:8080, admin / `KEYCLOAK_ADMIN_PASSWORD`), sign in once (TOTP enrolment is
forced), then grant roles in the app database — e.g. `pnpm db:seed` maps the seed staff by
email. Production users arrive through Google Workspace.

## Validation status

This realm file was written against the Keycloak 26 import format but has **not yet been
booted in CI** (the build environment for Phase 1 had no Docker daemon). First action on a
machine with Docker: `pnpm infra:up`, then confirm in the admin console that the
`browser-mfa` flow is bound and that a password-only login is refused by the app with
`MFA_REQUIRED`. The application side of this contract (acr/amr enforcement) is covered by
automated tests against a real OIDC provider (`tools/test-idp`).
