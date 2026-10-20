import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from '@crm/platform';
import { LOGGER } from '../../common/tokens.js';
import { ENV, type Env } from '../../config/env.js';

/**
 * Minimal Keycloak Admin REST client (service-account / client-credentials). Used by the
 * leaver process to disable the account and end all IdP sessions, so a leaver cannot sign
 * in to this or any other system sharing the realm (e.g. the future Residential system).
 */
@Injectable()
export class KeycloakAdminClient {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!(this.env.KEYCLOAK_ADMIN_CLIENT_ID && this.env.KEYCLOAK_ADMIN_CLIENT_SECRET);
  }

  /** Disables the user and logs out all their IdP sessions. Returns false if not configured. */
  async disableAndLogout(keycloakSub: string): Promise<boolean> {
    if (!this.configured) return false;
    const { base, realm } = this.realmParts();
    const token = await this.token();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const userUrl = `${base}/admin/realms/${realm}/users/${encodeURIComponent(keycloakSub)}`;
    const disable = await fetch(userUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    if (!disable.ok) throw new Error(`Keycloak disable failed: HTTP ${disable.status}`);
    const logout = await fetch(`${userUrl}/logout`, { method: 'POST', headers });
    if (!logout.ok) this.log.warn({ status: logout.status }, 'keycloak logout of leaver failed');
    return true;
  }

  private realmParts(): { base: string; realm: string } {
    const m = /^(.*)\/realms\/([^/]+)\/?$/.exec(this.env.OIDC_ISSUER);
    if (!m) throw new Error('OIDC_ISSUER is not a Keycloak realm URL');
    return { base: m[1]!, realm: m[2]! };
  }

  private async token(): Promise<string> {
    const res = await fetch(`${this.env.OIDC_ISSUER}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.env.KEYCLOAK_ADMIN_CLIENT_ID!,
        client_secret: this.env.KEYCLOAK_ADMIN_CLIENT_SECRET!,
      }),
    });
    if (!res.ok) throw new Error(`Keycloak token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new Error('Keycloak returned no access token');
    return body.access_token;
  }
}
