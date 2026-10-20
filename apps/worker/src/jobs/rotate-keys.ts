import { and, eq, isNotNull, like, not } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  type Database,
  auditLog,
  bankAccount,
  company,
  importRow,
  kycProfile,
  person,
} from '@crm/db';
import { type EncryptionPurpose, FieldCipher, type KeyStore, type Logger } from '@crm/platform';
import { asSystem } from '../context.js';

export interface RotateDeps {
  db: Database;
  cipher: FieldCipher;
  store: KeyStore;
  log: Logger;
}

interface EncryptedColumn {
  table: PgTable;
  name: string; // AAD table name
  column: string; // AAD column name
  idCol: PgColumn;
  encCol: PgColumn;
}

/** Every encrypted column, by purpose. New encrypted columns must be registered here. */
export const ENCRYPTED_COLUMNS: Record<EncryptionPurpose, EncryptedColumn[]> = {
  tin: [
    {
      table: company,
      name: 'contacts.company',
      column: 'tin_enc',
      idCol: company.id,
      encCol: company.tinEnc,
    },
  ],
  gov_id: [
    {
      table: person,
      name: 'contacts.person',
      column: 'gov_id_enc',
      idCol: person.id,
      encCol: person.govIdEnc,
    },
  ],
  bank: [
    {
      table: bankAccount,
      name: 'contacts.bank_account',
      column: 'account_no_enc',
      idCol: bankAccount.id,
      encCol: bankAccount.accountNoEnc,
    },
  ],
  financials: [
    {
      table: kycProfile,
      name: 'contacts.kyc_profile',
      column: 'financials_enc',
      idCol: kycProfile.id,
      encCol: kycProfile.financialsEnc,
    },
  ],
  import: [
    {
      table: importRow,
      name: 'imports.import_row',
      column: 'data_enc',
      idCol: importRow.id,
      encCol: importRow.dataEnc,
    },
  ],
};

const BATCH = 500;

/**
 * Key rotation (ADR-005): create a new DEK version, re-encrypt every value still on an older
 * version, then retire the old versions. Safe to re-run: rows already on the active version
 * are skipped, and old keys stay DECRYPT_ONLY until no ciphertext references them.
 */
export async function rotateKeys(
  deps: RotateDeps,
  purpose: EncryptionPurpose,
): Promise<{ newVersion: number; reencrypted: number }> {
  const newVersion = await deps.cipher.rotate(purpose);
  const activePrefix = `v1.${purpose}.${newVersion}.`;
  let reencrypted = 0;

  for (const col of ENCRYPTED_COLUMNS[purpose]) {
    for (;;) {
      const done = await asSystem(deps.db, `rotate-${purpose}`, async (tx) => {
        const rows = (await tx
          .select({ id: col.idCol, enc: col.encCol })
          .from(col.table)
          .where(and(isNotNull(col.encCol), not(like(col.encCol, `${activePrefix}%`))))
          .limit(BATCH)) as Array<{ id: string; enc: string }>;
        for (const r of rows) {
          const aad = { table: col.name, column: col.column, rowId: r.id };
          const plain = await deps.cipher.decrypt(r.enc, aad);
          const fresh = await deps.cipher.encrypt(purpose, plain, aad);
          await tx
            .update(col.table)
            .set({ [keyOf(col)]: fresh } as never)
            .where(eq(col.idCol, r.id));
        }
        return rows.length;
      });
      reencrypted += done;
      if (done < BATCH) break;
    }
  }

  // Retire older versions only if nothing references them any more. A value written with
  // the previous version while this job ran keeps it DECRYPT_ONLY until the next run.
  const remaining = await countStale(deps.db, purpose, activePrefix);
  if (remaining > 0) {
    deps.log.warn(
      { purpose, remaining },
      'stale ciphertexts remain; old key versions kept DECRYPT_ONLY',
    );
    return { newVersion, reencrypted };
  }
  for (let v = 1; v < newVersion; v++) {
    const key = await deps.store.get(purpose, v);
    if (key && key.status !== 'RETIRED') await deps.store.setStatus(purpose, v, 'RETIRED');
  }
  await asSystem(deps.db, `rotate-${purpose}`, (tx) =>
    tx.insert(auditLog).values({
      action: 'crypto.key_rotated',
      subjectType: 'data_key',
      subjectId: purpose,
      details: { newVersion, reencrypted },
    }),
  );
  deps.log.info({ purpose, newVersion, reencrypted }, 'key rotation complete');
  return { newVersion, reencrypted };
}

async function countStale(
  db: Database,
  purpose: EncryptionPurpose,
  activePrefix: string,
): Promise<number> {
  let total = 0;
  for (const col of ENCRYPTED_COLUMNS[purpose]) {
    const rows = await asSystem(db, `rotate-${purpose}`, (tx) =>
      tx
        .select({ id: col.idCol })
        .from(col.table)
        .where(and(isNotNull(col.encCol), not(like(col.encCol, `${activePrefix}%`))))
        .limit(1),
    );
    total += rows.length;
  }
  return total;
}

/** The Drizzle property name of the encrypted column on its table. */
function keyOf(col: EncryptedColumn): string {
  const entry = Object.entries(col.table as unknown as Record<string, unknown>).find(
    ([, v]) => v === col.encCol,
  );
  if (!entry) throw new Error(`Column ${col.column} not found on ${col.name}`);
  return entry[0];
}
