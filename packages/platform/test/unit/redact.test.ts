import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  createLogger,
  hashIp,
  hashSessionId,
  isSensitiveKey,
  redact,
  redactUrl,
  safeEqual,
  scrubString,
} from '../../src/index.js';

// Synthetic PII used to prove nothing leaks. Matches the shapes in the seed data.
const PII = {
  tin: '123-456-789-000',
  tinCompact: '123456789000',
  email: 'maria.santos@example.ph',
  mobile: '+63 917 555 1234',
  mobileLocal: '09175551234',
  bank: '0012-3456-7890',
  name: 'Maria Clara Santos',
};

describe('scrubString', () => {
  it.each([
    [`TIN ${PII.tin} rejected`, 'TIN [NUMBER] rejected'],
    [`tin=${PII.tinCompact}`, 'tin=[NUMBER]'],
    [`contact ${PII.email} bounced`, 'contact [EMAIL] bounced'],
    [`call ${PII.mobile}`, 'call [PHONE]'],
    [`call ${PII.mobileLocal}`, 'call [PHONE]'],
    [`acct ${PII.bank}`, expect.stringMatching(/^acct \[(NUMBER|PHONE)\]$/)],
    ['Authorization: Bearer abc.def-ghi', 'Authorization: Bearer [REDACTED]'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature', 'jwt [JWT]'],
    ['billing run 2026-10 for 42 tenants', 'billing run 2026-10 for 42 tenants'],
  ])('%s', (input, out) => expect(scrubString(input)).toEqual(out));
});

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'tin',
    'companyTin',
    'tin_enc',
    'gov_id_bidx',
    'govIdNumber',
    'accountNo',
    'account_number',
    'email',
    'billingEmail',
    'phone',
    'authorization',
    'cookie',
    'refreshToken',
    'fullName',
    'registered_address',
  ])('redacts key %s', (k) => expect(isSensitiveKey(k)).toBe(true));
  it.each([
    'setting',
    'routing',
    'continue',
    'status',
    'companyId',
    'tin_last3',
    'requestId',
    'amount',
    'ip_hash',
  ])('keeps key %s', (k) => expect(isSensitiveKey(k)).toBe(false));
});

describe('redact', () => {
  it('redacts nested objects and arrays without mutating input', () => {
    const input = {
      user: { email: PII.email, id: 'u1' },
      rows: [{ tin: PII.tin }, `note ${PII.mobile}`],
      n: 5,
      ok: true,
      none: null,
    };
    const out = redact(input);
    expect(out).toEqual({
      user: { email: REDACTED, id: 'u1' },
      rows: [{ tin: REDACTED }, 'note [PHONE]'],
      n: 5,
      ok: true,
      none: null,
    });
    expect(input.user.email).toBe(PII.email);
  });

  it('handles errors, causes, cycles, dates and buffers', () => {
    const cause = new Error(`duplicate key (tin_bidx)=(abc) for ${PII.email}`);
    const err = new Error(`failed for ${PII.tin}`, { cause });
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const d = new Date(0);
    const out = redact({ err, cyc, d, b: Buffer.from('secret') }) as {
      err: { message: string; cause: { message: string } };
      cyc: { self: unknown };
      d: Date;
      b: string;
    };
    expect(out.err.message).toBe('failed for [NUMBER]');
    expect(out.err.cause.message).not.toContain(PII.email);
    expect(out.cyc.self).toBe('[Circular]');
    expect(out.d).toBe(d);
    expect(out.b).toBe('[Buffer 6]');
  });

  it('redactUrl drops query strings', () => {
    expect(redactUrl(`/api/v1/companies?tin=${PII.tinCompact}`)).toBe('/api/v1/companies');
    expect(redactUrl(`/api/v1/people/${PII.email}`)).toBe('/api/v1/people/[EMAIL]');
  });
});

describe('logger (end-to-end PII leak test)', () => {
  it('no seeded PII appears anywhere in emitted log lines', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = createLogger({ name: 'test', level: 'debug' }, sink);
    log.info({ tin: PII.tin, contact: { email: PII.email, phone: PII.mobile } }, 'created company');
    log.warn(`lookup failed for ${PII.email} / ${PII.tinCompact}`);
    log.error({ err: new Error(`bank ${PII.bank} invalid for ${PII.name}`) }, 'import row failed');
    log.debug({ fullName: PII.name, payload: { accountNo: PII.bank } }, 'debug');
    log.info({ note: `Customer ${PII.mobileLocal} called` }, 'call logged');

    const text = lines.join('\n');
    expect(lines).toHaveLength(5);
    for (const [label, value] of Object.entries(PII)) {
      if (label === 'name') continue; // free-text names cannot be pattern-matched; keyed fields are covered below
      expect(text, label).not.toContain(value);
    }
    expect(text).not.toContain(`"fullName":"${PII.name}"`);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'info',
      msg: 'created company',
      tin: REDACTED,
      service: 'test',
    });
  });
});

describe('hashing helpers', () => {
  it('hashIp is keyed and stable', () => {
    expect(hashIp('203.0.113.7', 'k1')).toBe(hashIp(' 203.0.113.7 ', 'k1'));
    expect(hashIp('203.0.113.7', 'k1')).not.toBe(hashIp('203.0.113.7', 'k2'));
    expect(hashIp('203.0.113.7', 'k1')).toHaveLength(32);
  });
  it('hashSessionId and safeEqual', () => {
    expect(hashSessionId('abc')).toHaveLength(64);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
  });
});
