import { and, desc, eq } from 'drizzle-orm';
import { type Database, dataKey } from '@crm/db';

export type KeyStatus = 'ACTIVE' | 'DECRYPT_ONLY' | 'RETIRED';

export interface StoredKey {
  purpose: string;
  version: number;
  kekId: string;
  wrappedKey: string;
  status: KeyStatus;
}

/** Persistence for wrapped DEKs (crypto.data_key). */
export interface KeyStore {
  active(purpose: string): Promise<StoredKey | undefined>;
  get(purpose: string, version: number): Promise<StoredKey | undefined>;
  insert(key: StoredKey): Promise<void>;
  setStatus(purpose: string, version: number, status: KeyStatus): Promise<void>;
}

/**
 * crypto.data_key is readable by both runtime roles without a request context (RLS policy
 * `runtime_reads`), so key lookups use a plain pooled connection.
 */
export class DbKeyStore implements KeyStore {
  constructor(private readonly db: Database) {}

  async active(purpose: string): Promise<StoredKey | undefined> {
    const rows = await this.db
      .select()
      .from(dataKey)
      .where(and(eq(dataKey.purpose, purpose), eq(dataKey.status, 'ACTIVE')))
      .limit(1);
    return rows[0];
  }

  async get(purpose: string, version: number): Promise<StoredKey | undefined> {
    const rows = await this.db
      .select()
      .from(dataKey)
      .where(and(eq(dataKey.purpose, purpose), eq(dataKey.version, version)))
      .limit(1);
    return rows[0];
  }

  async insert(key: StoredKey): Promise<void> {
    await this.db.insert(dataKey).values(key).onConflictDoNothing();
  }

  async setStatus(purpose: string, version: number, status: KeyStatus): Promise<void> {
    await this.db
      .update(dataKey)
      .set({ status })
      .where(and(eq(dataKey.purpose, purpose), eq(dataKey.version, version)));
  }

  async latestVersion(purpose: string): Promise<number> {
    const rows = await this.db
      .select({ version: dataKey.version })
      .from(dataKey)
      .where(eq(dataKey.purpose, purpose))
      .orderBy(desc(dataKey.version))
      .limit(1);
    return rows[0]?.version ?? 0;
  }
}

/** In-memory store for unit tests. */
export class MemoryKeyStore implements KeyStore {
  readonly keys: StoredKey[] = [];

  async active(purpose: string) {
    return this.keys.find((k) => k.purpose === purpose && k.status === 'ACTIVE');
  }
  async get(purpose: string, version: number) {
    return this.keys.find((k) => k.purpose === purpose && k.version === version);
  }
  async insert(key: StoredKey) {
    if (!this.keys.some((k) => k.purpose === key.purpose && k.version === key.version)) {
      this.keys.push({ ...key });
    }
  }
  async setStatus(purpose: string, version: number, status: KeyStatus) {
    const k = this.keys.find((x) => x.purpose === purpose && x.version === version);
    if (k) k.status = status;
  }
}
