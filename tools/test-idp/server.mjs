// TEST-ONLY OpenID Provider used by local/CI end-to-end tests when Keycloak is not running.
// It speaks real OIDC (discovery, code + PKCE, signed ID tokens), so the API exercises its
// production login code path. It must never be deployed: it accepts any password and a
// fixed one-time code.
import http from 'node:http';
import Provider from 'oidc-provider';

const PORT = Number(process.env.TEST_IDP_PORT ?? 8180);
const ISSUER = process.env.TEST_IDP_ISSUER ?? `http://localhost:${PORT}`;
const WEB = process.env.PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000';
const TEST_OTP = '123456';

if (process.env.NODE_ENV === 'production') {
  throw new Error('The test IdP must never run in production');
}

const provider = new Provider(ISSUER, {
  clients: [
    {
      client_id: process.env.OIDC_CLIENT_ID ?? 'leasing-staff',
      client_secret: process.env.OIDC_CLIENT_SECRET ?? 'e2e-client-secret',
      redirect_uris: [`${WEB}/api/v1/auth/callback`],
      post_logout_redirect_uris: [`${WEB}/login?signedOut=1`],
      response_types: ['code'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'client_secret_basic',
    },
  ],
  pkce: { required: () => true },
  acrValues: ['mfa', 'pwd'],
  claims: { openid: ['sub'], email: ['email'], profile: ['name'] },
  features: { devInteractions: { enabled: false } },
  cookies: { keys: ['test-idp-cookie-key-not-secret'] },
  interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
  findAccount: async (_ctx, sub) => ({
    accountId: sub,
    claims: async () => ({ sub, email: sub, name: sub.split('@')[0].replace(/[._]/g, ' ') }),
  }),
  // First-party client: grant the requested scopes without a consent screen.
  loadExistingGrant: async (ctx) => {
    const existing = ctx.oidc.session.grantIdFor(ctx.oidc.client.clientId);
    if (existing) return ctx.oidc.provider.Grant.find(existing);
    const grant = new ctx.oidc.provider.Grant({
      clientId: ctx.oidc.client.clientId,
      accountId: ctx.oidc.session.accountId,
    });
    grant.addOIDCScope('openid email profile');
    grant.addOIDCClaims(['email', 'name']);
    await grant.save();
    return grant;
  },
});
provider.proxy = false;

const page = (
  uid,
  error = '',
) => `<!doctype html><meta charset="utf-8"><title>Test IdP sign-in</title>
<style>body{font-family:sans-serif;max-width:22rem;margin:4rem auto}label{display:block;margin:.6rem 0}input{width:100%;padding:.4rem}</style>
<h1>Test IdP</h1><p>TEST ONLY — not a real identity provider.</p>${error ? `<p role="alert" style="color:#b91c1c">${error}</p>` : ''}
<form method="post" action="/interaction/${uid}/login">
<label>Email <input name="login" autocomplete="username" required></label>
<label>Password <input name="password" type="password" required></label>
<label>Authenticator code <input name="otp" inputmode="numeric"></label>
<button type="submit">Sign in</button></form>`;

const readForm = (req) =>
  new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(new URLSearchParams(body)));
  });

const callback = provider.callback();
http
  .createServer(async (req, res) => {
    const m = /^\/interaction\/([^/]+)(\/login)?$/.exec(req.url.split('?')[0]);
    if (!m) return callback(req, res);
    try {
      const details = await provider.interactionDetails(req, res);
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page(details.uid));
      }
      const form = await readForm(req);
      const login = (form.get('login') ?? '').trim().toLowerCase();
      if (!login) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page(details.uid, 'Email is required'));
      }
      // With the code → MFA (acr=mfa, amr=pwd+otp); without → password only, which the API must reject.
      const mfa = form.get('otp') === TEST_OTP;
      await provider.interactionFinished(
        req,
        res,
        {
          login: {
            accountId: login,
            acr: mfa ? 'mfa' : 'pwd',
            amr: mfa ? ['pwd', 'otp'] : ['pwd'],
            remember: false,
          },
        },
        { mergeWithLastSubmission: false },
      );
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`interaction error: ${err.message}`);
    }
  })
  .listen(PORT, () => process.stdout.write(`test IdP listening on ${ISSUER}\n`));
