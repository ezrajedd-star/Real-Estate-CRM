import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@crm/db';
import { DbKeyStore, FieldCipher, LocalKeyProvider } from '../../src/index.js';

const appUrl = process.env.DATABASE_URL_APP ?? 'postgres://app_rw:rw_dev@localhost:5432/leasing';
const workerUrl =
  process.env.DATABASE_URL_WORKER ?? 'postgres://app_worker:worker_dev@localhost:5432/leasing';
const app = createDb(appUrl, { max: 2 });
const worker = createDb(workerUrl, { max: 2 });
const provider = new LocalKeyProvider(
  randomBytes(32).toString('base64'),
  `local:it-${randomBytes(4).toString('hex')}`,
  'test',
);

afterAll(async () => {
  await app.close();
  await worker.close();
});

describe('DbKeyStore with runtime roles', () => {
  // Purposes are global; use a unique one per run so tests don't depend on prior state.
  const purpose =
    `it_${[...randomBytes(6)].map((b) => String.fromCharCode(97 + (b % 26))).join('')}` as 'tin';
  const aad = { table: 't', column: 'c', rowId: 'r' };

  it('the API role creates version 1 on first use and round-trips', async () => {
    const cipher = new FieldCipher(provider, new DbKeyStore(app.db));
    const token = await cipher.encrypt(purpose, 'secret value', aad);
    expect(FieldCipher.versionOf(token).version).toBe(1);
    expect(await new FieldCipher(provider, new DbKeyStore(app.db)).decrypt(token, aad)).toBe(
      'secret value',
    );
  });

  it('the API role cannot rotate keys (worker only)', async () => {
    const cipher = new FieldCipher(provider, new DbKeyStore(app.db));
    await expect(cipher.rotate(purpose)).rejects.toThrow();
  });

  it('the worker rotates; old tokens still decrypt', async () => {
    const appCipher = new FieldCipher(provider, new DbKeyStore(app.db));
    const old = await appCipher.encrypt(purpose, 'before rotation', aad);
    const workerCipher = new FieldCipher(provider, new DbKeyStore(worker.db));
    expect(await workerCipher.rotate(purpose)).toBe(2);
    const fresh = new FieldCipher(provider, new DbKeyStore(app.db));
    expect(await fresh.decrypt(old, aad)).toBe('before rotation');
    expect(FieldCipher.versionOf(await fresh.encrypt(purpose, 'x', aad)).version).toBe(2);
  });
});
