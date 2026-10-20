import { Inject, Injectable } from '@nestjs/common';
import * as oidc from 'openid-client';
import { ENV, type Env } from '../../config/env.js';

export interface OidcIdentity {
  sub: string;
  email: string;
  name: string;
  acr: string | null;
  amr: string[];
  authTime: Date;
  idToken: string | null;
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
  /** Force fresh authentication with MFA (step-up for sensitive actions). */
  stepUp: boolean;
}

/** Abstraction over the IdP so tests can substitute a fake without any prod backdoor. */
export abstract class OidcProvider {
  abstract authorizationUrl(req: AuthorizationRequest): Promise<URL>;
  abstract exchange(
    callbackUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string; maxAge?: number },
  ): Promise<OidcIdentity>;
  abstract endSessionUrl(idToken: string | null, postLogoutRedirect: string): Promise<URL | null>;
}

/**
 * Keycloak via OIDC authorization code + PKCE, confidential client (ADR-002). We always
 * request the MFA level of assurance; step-up adds `prompt=login` and `max_age=0`.
 */
@Injectable()
export class KeycloakOidcProvider extends OidcProvider {
  private config?: Promise<oidc.Configuration>;

  constructor(@Inject(ENV) private readonly env: Env) {
    super();
  }

  private configuration(): Promise<oidc.Configuration> {
    this.config ??= oidc
      .discovery(
        new URL(this.env.OIDC_ISSUER),
        this.env.OIDC_CLIENT_ID,
        this.env.OIDC_CLIENT_SECRET,
        undefined,
        {
          // Local Keycloak runs on plain HTTP; production issuers must be HTTPS.
          execute: this.env.NODE_ENV === 'production' ? [] : [oidc.allowInsecureRequests],
        },
      )
      .catch((err: unknown) => {
        this.config = undefined;
        throw err;
      });
    return this.config;
  }

  private redirectUri(): string {
    return `${this.env.API_BASE_URL}/auth/callback`;
  }

  async authorizationUrl(req: AuthorizationRequest): Promise<URL> {
    const params: Record<string, string> = {
      redirect_uri: this.redirectUri(),
      scope: 'openid email profile',
      response_type: 'code',
      state: req.state,
      nonce: req.nonce,
      code_challenge: req.codeChallenge,
      code_challenge_method: 'S256',
      acr_values: this.env.OIDC_MFA_ACR_VALUES[0] ?? 'mfa',
    };
    if (req.stepUp) {
      params.prompt = 'login';
      params.max_age = '0';
    }
    return oidc.buildAuthorizationUrl(await this.configuration(), params);
  }

  async exchange(
    callbackUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string; maxAge?: number },
  ): Promise<OidcIdentity> {
    const tokens = await oidc.authorizationCodeGrant(await this.configuration(), callbackUrl, {
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      pkceCodeVerifier: checks.codeVerifier,
      idTokenExpected: true,
      maxAge: checks.maxAge,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('No ID token');
    const email = typeof claims.email === 'string' ? claims.email : '';
    const name = typeof claims.name === 'string' ? claims.name : email;
    const amr = Array.isArray(claims.amr)
      ? claims.amr.filter((x): x is string => typeof x === 'string')
      : [];
    const authTime =
      typeof claims.auth_time === 'number' ? new Date(claims.auth_time * 1000) : new Date();
    return {
      sub: claims.sub,
      email,
      name,
      acr: typeof claims.acr === 'string' ? claims.acr : null,
      amr,
      authTime,
      idToken: tokens.id_token ?? null,
    };
  }

  async endSessionUrl(idToken: string | null, postLogoutRedirect: string): Promise<URL | null> {
    const config = await this.configuration();
    if (!config.serverMetadata().end_session_endpoint) return null;
    return oidc.buildEndSessionUrl(config, {
      post_logout_redirect_uri: postLogoutRedirect,
      ...(idToken ? { id_token_hint: idToken } : { client_id: this.env.OIDC_CLIENT_ID }),
    });
  }
}

const MFA_AMR = new Set(['otp', 'totp', 'hwk', 'swk', 'webauthn', 'mfa', 'mca']);

/** Staff must have authenticated with a second factor (brief §7.4). */
export function isMultiFactor(
  identity: Pick<OidcIdentity, 'acr' | 'amr'>,
  mfaAcrValues: readonly string[],
): boolean {
  if (identity.acr && mfaAcrValues.includes(identity.acr)) return true;
  return identity.amr.some((m) => MFA_AMR.has(m.toLowerCase()));
}
