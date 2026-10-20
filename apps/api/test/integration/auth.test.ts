import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agent, clock, createTestApp, fakeOidc, login, ownerDb, staff, tag } from './harness.js';

let app: NestFastifyApplication;
let db: pg.Client;

beforeAll(async () => {
  app = await createTestApp();
  db = await ownerDb();
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe('authentication', () => {
  it('every route is private by default', async () => {
    for (const url of [
      '/api/v1/auth/me',
      '/api/v1/companies',
      '/api/v1/users',
      '/api/v1/openapi.json',
      '/api/v1/approvals',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('health endpoints are public and reveal nothing else', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('login sets an httpOnly, SameSite=Strict session cookie and returns an HTML hop', async () => {
    const t = tag();
    fakeOidc.identities.set(`kc-${t}`, { sub: `kc-${t}`, email: `${t}@example.test`, name: 'A' });
    const start = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/login?returnTo=/companies',
    });
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const stateCookie = String(start.headers['set-cookie']).match(/login_state=([^;]+)/)![1];
    const cb = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=kc-${t}&state=${state}`,
      headers: { cookie: `login_state=${stateCookie}` },
    });
    expect(cb.statusCode).toBe(200);
    expect(cb.headers['content-type']).toMatch(/text\/html/);
    expect(cb.body).toContain('url=/companies');
    const sid = ([] as string[])
      .concat(cb.headers['set-cookie'] as string[])
      .find((c) => c.startsWith('sid='))!;
    expect(sid).toMatch(/HttpOnly/i);
    expect(sid).toMatch(/SameSite=Strict/i);
  });

  it('rejects an open-redirect returnTo', async () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      const start = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/login?returnTo=${encodeURIComponent(bad)}`,
      });
      expect(start.statusCode).toBe(302);
      const state = new URL(String(start.headers.location)).searchParams.get('state')!;
      const t = tag();
      fakeOidc.identities.set(t, { sub: `kc-${t}`, email: `${t}@example.test`, name: 'A' });
      const stateCookie = String(start.headers['set-cookie']).match(/login_state=([^;]+)/)![1];
      const cb = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/callback?code=${t}&state=${state}`,
        headers: { cookie: `login_state=${stateCookie}` },
      });
      expect(cb.body).toContain('url=/"');
    }
  });

  it('rejects a callback whose state does not match the browser cookie (login CSRF)', async () => {
    const t = tag();
    fakeOidc.identities.set(t, { sub: `kc-${t}`, email: `${t}@example.test`, name: 'A' });
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const cb = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/callback?code=${t}&state=${state}`,
      headers: { cookie: 'login_state=someone-elses' },
    });
    expect(cb.statusCode).toBe(400);
    expect(cb.headers['set-cookie']?.toString() ?? '').not.toMatch(/sid=/);
  });

  it('a state can be used only once (replay)', async () => {
    const t = tag();
    fakeOidc.identities.set(t, { sub: `kc-${t}`, email: `${t}@example.test`, name: 'A' });
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/login' });
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;
    const stateCookie = String(start.headers['set-cookie']).match(/login_state=([^;]+)/)![1];
    const url = `/api/v1/auth/callback?code=${t}&state=${state}`;
    const first = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: `login_state=${stateCookie}` },
    });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: `login_state=${stateCookie}` },
    });
    expect(again.statusCode).toBe(400);
  });

  it('staff without MFA cannot sign in (no SMS/password-only)', async () => {
    const t = tag();
    await expect(
      login(app, {
        sub: `kc-${t}`,
        email: `${t}@example.test`,
        name: 'No MFA',
        amr: ['pwd'],
        acr: '1',
      }),
    ).rejects.toThrow(/403/);
    await expect(
      login(app, {
        sub: `kc-${t}b`,
        email: `${t}b@example.test`,
        name: 'SMS',
        amr: ['pwd', 'sms'],
        acr: null,
      }),
    ).rejects.toThrow(/403/);
    const audit = await db.query(
      `SELECT details FROM audit.audit_log WHERE action = 'auth.login' AND outcome = 'FAILURE' ORDER BY seq DESC LIMIT 1`,
    );
    expect(audit.rows[0].details.reason).toBe('MFA_REQUIRED');
  });

  it('a suspended or departed user cannot sign in', async () => {
    const a = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    await db.query(`UPDATE identity.app_user SET status = 'SUSPENDED' WHERE id = $1`, [a.userId]);
    expect((await a.get('/auth/me')).status).toBe(401); // existing session dies immediately
    const sub = (
      await db.query(
        `SELECT keycloak_sub, email, display_name FROM identity.app_user WHERE id = $1`,
        [a.userId],
      )
    ).rows[0];
    await expect(
      login(app, { sub: sub.keycloak_sub, email: sub.email, name: sub.display_name }),
    ).rejects.toThrow(/403/);
  });

  it('a forged or unknown session cookie is rejected', async () => {
    const forged = agent(app, 'A'.repeat(43), 'x', 'nobody');
    expect((await forged.get('/auth/me')).status).toBe(401);
    expect((await agent(app, 'not-even-the-right-shape', 'x', 'n').get('/auth/me')).status).toBe(
      401,
    );
  });

  it('logout destroys the server-side session', async () => {
    const a = await staff(app, db, [{ role: 'EXECUTIVE' }]);
    expect((await a.get('/auth/me')).status).toBe(200);
    expect((await a.post('/auth/logout')).status).toBe(200);
    expect((await a.get('/auth/me')).status).toBe(401);
  });

  it('sessions expire at the absolute limit (12h) regardless of activity', async () => {
    const a = await staff(app, db, [{ role: 'EXECUTIVE' }]);
    const saved = clock.now();
    clock.advanceMs(12 * 3600 * 1000 + 1000);
    try {
      expect((await a.get('/auth/me')).status).toBe(401);
    } finally {
      clock.set(saved);
    }
  });

  it('users can list and revoke their own sessions', async () => {
    const t = tag();
    const who = { sub: `kc-${t}`, email: `${t}@example.test`, name: 'Two Devices' };
    await db.query(`SELECT identity.upsert_login($1, $2, $3)`, [who.sub, who.email, who.name]);
    const laptop = await login(app, who);
    const phone = await login(app, who);
    const list = await laptop.get('/auth/sessions');
    expect(list.body).toHaveLength(2);
    const other = list.body.find((s: { current: boolean }) => !s.current);
    expect((await laptop.delete(`/auth/sessions/${other.id}`)).status).toBe(204);
    expect((await phone.get('/auth/me')).status).toBe(401);
    expect((await laptop.get('/auth/me')).status).toBe(200);
  });
});

describe('CSRF and origin checks', () => {
  it('state-changing requests need the CSRF token', async () => {
    const a = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const noToken = await app.inject({
      method: 'POST',
      url: '/api/v1/companies',
      headers: { cookie: `sid=${a.cookie}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ legalName: 'Csrf Test Inc', registrationType: 'SEC' }),
    });
    expect(noToken.statusCode).toBe(403);
    const wrongToken = await a.post(
      '/companies',
      { legalName: 'Csrf Test Inc', registrationType: 'SEC' },
      { 'x-csrf-token': 'wrong' },
    );
    expect(wrongToken.status).toBe(403);
  });

  it('rejects cross-origin requests even with a valid token', async () => {
    const a = await staff(app, db, [{ role: 'LEASING_HEAD' }]);
    const res = await a.post(
      '/companies',
      { legalName: 'Origin Test Inc', registrationType: 'SEC' },
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
  });
});

describe('security headers', () => {
  it('sets HSTS, CSP, no-store and nosniff', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/live' });
    expect(res.headers['strict-transport-security']).toMatch(/max-age=63072000/);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('CORS only allows the web origin', async () => {
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/companies',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const bad = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/companies',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('errors never include stack traces', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toMatch(/at .*\.(ts|js):\d+/);
    expect(res.json().error.requestId).toBeTruthy();
  });
});
