# ADR-002: Keycloak identity, BFF sessions, MFA enforced by the application

## Context

Staff need SSO with Google Workspace, mandatory MFA (passkeys preferred, TOTP fallback, no
SMS), short sessions and remote revocation. The future Residential Sales system must be able
to share the same identity provider with its own role set. External portal users arrive in
Phase 4.

## Decision

- **Keycloak 26**, self-hosted (ECS in production, compose locally), realm `pmo`, defined as
  code in `infra/keycloak/realm/pmo-realm.json`. One client per system (`leasing-staff` now,
  `residential-staff` reserved). Google Workspace is an identity-provider broker with a
  post-broker flow that still demands a second factor held in the realm.
  _Why not Auth0/Cognito:_ per-user pricing and data residency (Auth0); weaker passkey and
  admin features (Cognito). Self-hosting is more operational work, which we accept.
- **Keycloak authenticates; the application authorizes.** Roles and scopes are not Keycloak
  roles (ADR-003).
- **BFF pattern.** The API runs OIDC authorization code + PKCE as a confidential client.
  Login state and PKCE verifier live in Redis for 10 minutes. A `login_state` cookie
  (SameSite=Lax, scoped to the callback path) binds the flow to the browser, which defeats
  login CSRF. Tokens never reach the browser.
- **The MFA check is in our code**, not only in Keycloak configuration. The callback rejects
  any identity unless `acr` is an MFA level (`OIDC_MFA_ACR_VALUES`) or `amr` contains a
  second factor (otp/webauthn/hwk/…). SMS and password-only sign-ins are refused and audited
  (`MFA_REQUIRED`).
- **Sessions.**
  - The session is server-side in Redis, keyed by the SHA-256 of a 256-bit random cookie
    value.
  - The cookie is `__Host-sid`: httpOnly, Secure, SameSite=Strict, path `/`.
  - Idle timeout is 15 minutes (Redis TTL, refreshed on use). The absolute limit is
    12 hours, checked on every request.
  - The session id is rotated at login, which prevents session fixation.
  - `identity.user_session` mirrors sessions so users can list and revoke them, and the
    leaver process can revoke them all.
- **Step-up.** Sensitive routes (`@StepUp()`) require `auth_time` within 5 minutes; otherwise
  the API answers `STEP_UP_REQUIRED` and the UI re-runs login with `prompt=login&max_age=0`.
  Step-up routes: role-change requests, offboarding, break-glass, adding bank accounts and
  export downloads.
- **Fresh principal every request.** User status, grants and break-glass are re-read from
  the database on each request, so revocations apply immediately.
- **Pre-provisioning.** An admin or the seed creates `pending:<email>` users with roles. The
  first IdP login with that (verified) email claims the row. Only `pending:` rows can be
  claimed, so a linked account cannot be taken over by email (migration 0007).

## Consequences

- The realm file is the contract. CI does not boot Keycloak yet; the app-side contract (MFA
  enforcement and the real OIDC flow) is tested end-to-end against `tools/test-idp`.
- Back-channel logout from Keycloak is not consumed yet. Offboarding disables the Keycloak
  user and logs out IdP sessions through the admin API instead.
