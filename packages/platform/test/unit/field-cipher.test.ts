import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, FieldCipher, LocalKeyProvider, MemoryKeyStore } from '../../src/index.js';

const kek = randomBytes(32).toString('base64');
const aad = {
  table: 'contacts.company',
  column: 'tin_enc',
  rowId: '018f0000-0000-7000-8000-000000000001',
};

function setup() {
  const store = new MemoryKeyStore();
  const provider = new LocalKeyProvider(kek, 'local:test', 'test');
  return { store, provider, cipher: new FieldCipher(provider, store) };
}

describe('FieldCipher', () => {
  it('round-trips and never stores plaintext', async () => {
    const { cipher, store } = setup();
    const token = await cipher.encrypt('tin', '123-456-789-000', aad);
    expect(token).toMatch(/^v1\.tin\.1\./);
    expect(token).not.toContain('123');
    expect(await cipher.decrypt(token, aad)).toBe('123-456-789-000');
    expect(JSON.stringify(store.keys)).not.toContain('123-456');
  });

  it('uses a fresh IV each time', async () => {
    const { cipher } = setup();
    const a = await cipher.encrypt('tin', 'same', aad);
    const b = await cipher.encrypt('tin', 'same', aad);
    expect(a).not.toBe(b);
  });

  it.each([
    ['another row', { ...aad, rowId: '018f0000-0000-7000-8000-000000000002' }],
    ['another column', { ...aad, column: 'gov_id_enc' }],
    ['another table', { ...aad, table: 'contacts.person' }],
  ])('rejects a ciphertext copied to %s (AAD binding)', async (_l, other) => {
    const { cipher } = setup();
    const token = await cipher.encrypt('tin', '123456789000', aad);
    await expect(cipher.decrypt(token, other)).rejects.toThrow(DecryptionError);
  });

  it('rejects tampered or malformed tokens', async () => {
    const { cipher } = setup();
    const token = await cipher.encrypt('bank', '0012345678', aad);
    const parts = token.split('.');
    parts[4] = Buffer.from('tampered!').toString('base64url');
    await expect(cipher.decrypt(parts.join('.'), aad)).rejects.toThrow(DecryptionError);
    await expect(cipher.decrypt('not-a-token', aad)).rejects.toThrow(DecryptionError);
    expect(() => FieldCipher.versionOf('nope')).toThrow(DecryptionError);
  });

  it('rotates keys: old ciphertexts still decrypt, new ones use the new version', async () => {
    const { cipher, store } = setup();
    const old = await cipher.encrypt('gov_id', 'P1234567A', aad);
    expect(await cipher.isCurrent(old)).toBe(true);
    expect(await cipher.rotate('gov_id')).toBe(2);
    expect(await cipher.isCurrent(old)).toBe(false);
    expect(await cipher.decrypt(old, aad)).toBe('P1234567A');
    const fresh = await cipher.encrypt('gov_id', 'P1234567A', aad);
    expect(FieldCipher.versionOf(fresh)).toEqual({ purpose: 'gov_id', version: 2 });
    expect(store.keys.filter((k) => k.purpose === 'gov_id').map((k) => k.status)).toEqual([
      'DECRYPT_ONLY',
      'ACTIVE',
    ]);
  });

  it('refuses retired keys', async () => {
    const { cipher, store, provider } = setup();
    const token = await cipher.encrypt('tin', 'x', aad);
    await store.setStatus('tin', 1, 'RETIRED');
    // A fresh cipher has no cached key, so it must consult the store.
    const fresh = new FieldCipher(provider, store);
    await expect(fresh.decrypt(token, aad)).rejects.toThrow(/No usable key/);
  });

  it('caches unwrapped keys for 10 minutes', async () => {
    let t = 0;
    const store = new MemoryKeyStore();
    let unwraps = 0;
    const provider = new LocalKeyProvider(kek, 'local:test', 'test');
    const counting = {
      kekId: provider.kekId,
      wrap: provider.wrap.bind(provider),
      unwrap: async (...a: Parameters<typeof provider.unwrap>) => {
        unwraps++;
        return provider.unwrap(...a);
      },
    };
    const seed = new FieldCipher(provider, store);
    const token = await seed.encrypt('tin', 'x', aad);
    const cipher = new FieldCipher(counting, store, () => t);
    await cipher.decrypt(token, aad);
    await cipher.decrypt(token, aad);
    expect(unwraps).toBe(1);
    t += 11 * 60 * 1000;
    await cipher.decrypt(token, aad);
    expect(unwraps).toBe(2);
  });
});

describe('blind index', () => {
  it('is deterministic per field and differs across fields', async () => {
    const { cipher } = setup();
    const a = await cipher.blindIndex('company.tin', '123456789000');
    expect(await cipher.blindIndex('company.tin', '123456789000')).toBe(a);
    expect(await cipher.blindIndex('company.tin', '123456789001')).not.toBe(a);
    expect(await cipher.blindIndex('person.gov_id', '123456789000')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on the secret key (not a plain hash)', async () => {
    const one = setup();
    const two = setup();
    expect(await one.cipher.blindIndex('company.tin', 'v')).not.toBe(
      await two.cipher.blindIndex('company.tin', 'v'),
    );
  });
});

describe('LocalKeyProvider', () => {
  it('refuses to run in production', () => {
    expect(() => new LocalKeyProvider(kek, 'local:x', 'production')).toThrow(/production/);
  });
  it('requires a 32-byte KEK', () => {
    expect(() => new LocalKeyProvider(randomBytes(16).toString('base64'), 'x', 'test')).toThrow(
      /32 bytes/,
    );
  });
  it('binds wrapped keys to their context and KEK id', async () => {
    const p = new LocalKeyProvider(kek, 'local:test', 'test');
    const wrapped = await p.wrap(Buffer.alloc(32, 7), { purpose: 'tin', version: '1' });
    await expect(
      p.unwrap('local:test', wrapped, { purpose: 'bank', version: '1' }),
    ).rejects.toThrow();
    await expect(
      p.unwrap('local:other', wrapped, { purpose: 'tin', version: '1' }),
    ).rejects.toThrow(/Unknown KEK/);
    expect(await p.unwrap('local:test', wrapped, { version: '1', purpose: 'tin' })).toEqual(
      Buffer.alloc(32, 7),
    );
  });
});
