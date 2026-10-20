import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { KeyProvider } from './key-provider.js';
import type { KeyStore } from './key-store.js';

/** Data classes encrypted at field level (brief §8.1). One DEK lineage per purpose. */
export const ENCRYPTION_PURPOSES = ['tin', 'gov_id', 'bank', 'financials', 'import'] as const;
export type EncryptionPurpose = (typeof ENCRYPTION_PURPOSES)[number];

/** Binds a ciphertext to where it is stored, so it cannot be copied to another row/column. */
export interface FieldAad {
  table: string;
  column: string;
  rowId: string;
}

export class DecryptionError extends Error {
  override name = 'DecryptionError';
}

const TOKEN_RE = /^v1\.([a-z_]+)\.(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const BLIND_INDEX_PURPOSE = 'blind_index';
const DEK_CACHE_MS = 10 * 60 * 1000;

/**
 * Envelope encryption for sensitive fields (ADR-005).
 *
 * Token format: `v1.<purpose>.<keyVersion>.<iv>.<ciphertext>.<tag>` (base64url parts).
 * AES-256-GCM; the AAD is `table/column/rowId`, so a ciphertext moved to another row or
 * column fails authentication. Unwrapped DEKs are cached in memory for 10 minutes.
 */
export class FieldCipher {
  private readonly cache = new Map<string, { key: Buffer; until: number }>();

  constructor(
    private readonly provider: KeyProvider,
    private readonly store: KeyStore,
    private readonly now: () => number = Date.now,
  ) {}

  async encrypt(purpose: EncryptionPurpose, plaintext: string, aad: FieldAad): Promise<string> {
    const { version, key } = await this.activeKey(purpose);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aadBytes(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', purpose, String(version), b64u(iv), b64u(ct), b64u(cipher.getAuthTag())].join(
      '.',
    );
  }

  async decrypt(token: string, aad: FieldAad): Promise<string> {
    const m = TOKEN_RE.exec(token);
    if (!m) throw new DecryptionError('Malformed ciphertext token');
    const [, purpose, version, iv, ct, tag] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const key = await this.keyFor(purpose, Number(version));
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(aadBytes(aad));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ct, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new DecryptionError('Ciphertext failed authentication (wrong row/column or tampered)');
    }
  }

  /** The key version a token was encrypted with, for rotation jobs. */
  static versionOf(token: string): { purpose: string; version: number } {
    const m = TOKEN_RE.exec(token);
    if (!m) throw new DecryptionError('Malformed ciphertext token');
    return { purpose: m[1]!, version: Number(m[2]) };
  }

  async isCurrent(token: string): Promise<boolean> {
    const { purpose, version } = FieldCipher.versionOf(token);
    const active = await this.store.active(purpose);
    return active?.version === version;
  }

  /**
   * Keyed HMAC blind index for equality search/dedupe on encrypted fields. Each field kind
   * gets its own HKDF-derived subkey, so equal values in different fields do not correlate.
   * The blind-index key is never rotated automatically: rotating it means re-indexing.
   */
  async blindIndex(field: string, normalizedValue: string): Promise<string> {
    const { key } = await this.activeKey(BLIND_INDEX_PURPOSE);
    const sub = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `bidx:${field}`, 32));
    return createHmac('sha256', sub).update(normalizedValue, 'utf8').digest('hex');
  }

  /** Creates the next key version for `purpose` and makes it the active one. */
  async rotate(purpose: EncryptionPurpose): Promise<number> {
    const current = await this.store.active(purpose);
    const next = (current?.version ?? 0) + 1;
    const dek = randomBytes(32);
    const wrapped = await this.provider.wrap(dek, { purpose, version: String(next) });
    if (current) await this.store.setStatus(purpose, current.version, 'DECRYPT_ONLY');
    await this.store.insert({
      purpose,
      version: next,
      kekId: this.provider.kekId,
      wrappedKey: wrapped,
      status: 'ACTIVE',
    });
    this.cache.set(`${purpose}:${next}`, { key: dek, until: this.now() + DEK_CACHE_MS });
    return next;
  }

  private async activeKey(purpose: string): Promise<{ version: number; key: Buffer }> {
    let active = await this.store.active(purpose);
    if (!active) {
      // First use: create version 1. A unique index makes concurrent creation safe.
      const dek = randomBytes(32);
      const wrapped = await this.provider.wrap(dek, { purpose, version: '1' });
      await this.store.insert({
        purpose,
        version: 1,
        kekId: this.provider.kekId,
        wrappedKey: wrapped,
        status: 'ACTIVE',
      });
      active = await this.store.active(purpose);
      if (!active) throw new Error(`Could not create key for ${purpose}`);
    }
    return { version: active.version, key: await this.keyFor(purpose, active.version) };
  }

  private async keyFor(purpose: string, version: number): Promise<Buffer> {
    const cacheKey = `${purpose}:${version}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.until > this.now()) return hit.key;
    const stored = await this.store.get(purpose, version);
    if (!stored || stored.status === 'RETIRED')
      throw new DecryptionError(`No usable key ${cacheKey}`);
    const key = await this.provider.unwrap(stored.kekId, stored.wrappedKey, {
      purpose,
      version: String(version),
    });
    this.cache.set(cacheKey, { key, until: this.now() + DEK_CACHE_MS });
    return key;
  }
}

function aadBytes(aad: FieldAad): Buffer {
  return Buffer.from(`${aad.table}/${aad.column}/${aad.rowId}`, 'utf8');
}

function b64u(b: Buffer): string {
  return b.toString('base64url');
}
