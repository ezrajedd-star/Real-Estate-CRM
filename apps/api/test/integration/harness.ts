import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import type { StaffRole, ScopeType } from '@crm/domain';
import { createLogger } from '@crm/platform';

// Test configuration — synthetic secrets only.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL_APP ??= 'postgres://app_rw:rw_dev@localhost:5432/leasing';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.OIDC_CLIENT_SECRET = 'test-secret';
process.env.IP_HASH_KEY = 'test-ip-hash-key-0123456789abcdef0123';
// Fixed synthetic test KEK (data keys persist in the test DB across runs).
process.env.LOCAL_KEK_BASE64 ??= Buffer.alloc(32, 7).toString('base64');
process.env.COOKIE_SECURE = 'false';
process.env.PUBLIC_WEB_ORIGIN = 'http://localhost:3000';
process.env.API_BASE_URL = 'http://localhost:3000/api/v1';
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_FORCE_PATH_STYLE = 'true';
process.env.S3_ACCESS_KEY_ID ??= 'minio';
process.env.S3_SECRET_ACCESS_KEY ??= 'minio-dev-secret';
process.env.S3_BUCKET ??= 'leasing-documents';

const MIGRATOR_URL =
  process.env.DATABASE_URL_MIGRATOR ??
  'postgres://app_migrator:migrator_dev@localhost:5432/leasing';

const { createAdapter, configureApp } = await import('../../src/bootstrap.js');
const { AppModule } = await import('../../src/app.module.js');
const { OidcProvider } = await import('../../src/modules/auth/oidc.provider.js');
const { LOGGER, CLOCK, REDIS } = await import('../../src/common/tokens.js');
const { ManualClock } = await import('@crm/domain');

export interface FakeIdentity {
  sub: string;
  email: string;
  name: string;
  amr?: string[];
  acr?: string | null;
  authTime?: Date;
}

/** Stands in for Keycloak: the `code` query parameter names which identity "logged in". */
export class FakeOidc {
  readonly identities = new Map<string, FakeIdentity>();
  async authorizationUrl(req: { state: string; stepUp: boolean }) {
    return new URL(`http://idp.test/auth?state=${req.state}&step_up=${req.stepUp ? 1 : 0}`);
  }
  async exchange(url: URL, checks: { state: string }) {
    if (url.searchParams.get('state') !== checks.state) throw new Error('state');
    const who = this.identities.get(url.searchParams.get('code') ?? '');
    if (!who) throw new Error('unknown code');
    return {
      sub: who.sub,
      email: who.email,
      name: who.name,
      acr: who.acr === undefined ? 'mfa' : who.acr,
      amr: who.amr ?? ['pwd', 'otp'],
      authTime: who.authTime ?? clock.now(),
      idToken: null,
    };
  }
  async endSessionUrl() {
    return null;
  }
}

export const logLines: string[] = [];
export const fakeOidc = new FakeOidc();
export const clock = new ManualClock(new Date());

export async function createTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OidcProvider)
    .useValue(fakeOidc)
    .overrideProvider(LOGGER)
    .useValue(
      createLogger(
        { name: 'api-test', level: 'debug' },
        new Writable({
          write(chunk, _e, cb) {
            const line = chunk.toString();
            logLines.push(line);
            if (process.env.PRINT_ERRORS && /"level":"(error|warn)"/.test(line))
              process.stderr.write(line);
            cb();
          },
        }),
      ),
    )
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createAdapter(), {
    logger: false,
  });
  await configureApp(app);
  await app.getHttpAdapter().getInstance().ready();
  // Fresh rate-limit windows for each test file (test Redis only).
  const redis = app.get<import('ioredis').Redis>(REDIS);
  const keys = await redis.keys('rl:*');
  if (keys.length) await redis.del(...keys);
  return app;
}

export async function ownerDb(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: MIGRATOR_URL });
  await c.connect();
  return c;
}

export const tag = () => randomBytes(4).toString('hex');
export const randomIp = () => `10.${[...randomBytes(3)].join('.')}`;

export interface Agent {
  userId: string;
  cookie: string;
  csrf: string;
  get(url: string): Promise<Response>;
  post(url: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  put(url: string, body?: unknown): Promise<Response>;
  patch(url: string, body?: unknown): Promise<Response>;
  delete(url: string): Promise<Response>;
}

export interface Response {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
}

function cookieFrom(setCookie: string | string[] | undefined, name: string): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit?.split(';')[0]?.slice(name.length + 1);
}

/** Runs the full login flow (login → IdP → callback) and returns an authenticated agent. */
export async function login(app: NestFastifyApplication, who: FakeIdentity): Promise<Agent> {
  fakeOidc.identities.set(who.sub, who);
  // Each simulated browser gets its own IP so the per-IP auth rate limit does not interfere.
  const remoteAddress = randomIp();
  const start = await app.inject({ method: 'GET', url: '/api/v1/auth/login', remoteAddress });
  if (start.statusCode !== 302) throw new Error(`login start failed: ${start.statusCode}`);
  const state = new URL(String(start.headers.location)).searchParams.get('state')!;
  const stateCookie = cookieFrom(start.headers['set-cookie'], 'login_state')!;
  const cb = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/callback?code=${encodeURIComponent(who.sub)}&state=${state}`,
    headers: { cookie: `login_state=${stateCookie}` },
    remoteAddress,
  });
  const sid = cookieFrom(cb.headers['set-cookie'], 'sid');
  if (!sid)
    throw Object.assign(new Error(`login failed: ${cb.statusCode} ${cb.body.slice(0, 200)}`), {
      response: cb,
    });
  const me = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { cookie: `sid=${sid}` },
  });
  const meBody = me.json();
  return agent(app, sid, meBody.csrfToken, meBody.id);
}

export function agent(
  app: NestFastifyApplication,
  sid: string,
  csrf: string,
  userId: string,
): Agent {
  const send = async (
    method: string,
    url: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> => {
    const res = await app.inject({
      method: method as 'GET',
      url: `/api/v1${url}`,
      headers: {
        cookie: `sid=${sid}`,
        ...(method !== 'GET' && { 'x-csrf-token': csrf, origin: 'http://localhost:3000' }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...extra,
      },
      ...(body !== undefined && { payload: JSON.stringify(body) }),
    });
    let parsed: unknown;
    try {
      parsed = res.body ? JSON.parse(res.body) : undefined;
    } catch {
      parsed = undefined;
    }
    return {
      status: res.statusCode,
      body: parsed,
      headers: res.headers as Response['headers'],
      text: res.body,
    };
  };
  return {
    userId,
    cookie: sid,
    csrf,
    get: (u) => send('GET', u),
    post: (u, b, h) => send('POST', u, b ?? {}, h),
    put: (u, b) => send('PUT', u, b ?? {}),
    patch: (u, b) => send('PATCH', u, b ?? {}),
    delete: (u) => send('DELETE', u),
  };
}

/** Creates a staff user with the given grants (directly in the DB) and logs them in. */
export async function staff(
  app: NestFastifyApplication,
  db: pg.Client,
  grants: Array<{ role: StaffRole; scopeType?: ScopeType; scopeId?: string | null }>,
  extra: Partial<FakeIdentity> = {},
): Promise<Agent> {
  const t = tag();
  const who: FakeIdentity = {
    sub: `kc-${t}`,
    email: `staff-${t}@example.test`,
    name: `Staff ${t}`,
    ...extra,
  };
  const res = await db.query<{ user_id: string }>(
    `SELECT user_id FROM identity.upsert_login($1, $2, $3)`,
    [who.sub, who.email, who.name],
  );
  const userId = res.rows[0]!.user_id;
  for (const g of grants) {
    await db.query(
      `INSERT INTO identity.role_assignment (user_id, role, scope_type, scope_id) VALUES ($1, $2, $3, $4)`,
      [userId, g.role, g.scopeType ?? 'GLOBAL', g.scopeId ?? null],
    );
  }
  return login(app, who);
}

export async function createProperty(db: pg.Client): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO properties.property (code, name) VALUES ($1, 'Test Property') RETURNING id`,
    [`T-${tag().toUpperCase()}`],
  );
  return r.rows[0]!.id;
}

/** A valid-looking synthetic TIN that is unique per call. */
export function randomTin(): string {
  const d = () => String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${d()}-${d()}-${d()}-000`;
}
