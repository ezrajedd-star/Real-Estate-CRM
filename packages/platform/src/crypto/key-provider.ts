import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';

/**
 * Wraps and unwraps data-encryption keys (DEKs) with a key-encryption key (KEK) that never
 * leaves the provider. Production uses AWS KMS; dev/test use a local KEK from env (ADR-005).
 */
export interface KeyProvider {
  /** Identifier of the KEK used for new wraps (KMS key ARN or local key id). */
  readonly kekId: string;
  wrap(dek: Buffer, context: Record<string, string>): Promise<string>;
  unwrap(kekId: string, wrapped: string, context: Record<string, string>): Promise<Buffer>;
}

/**
 * AES-256-GCM key wrap with a KEK held in process memory. Never for production.
 * The key id is a fingerprint of the KEK, so data keys wrapped under a different KEK fail
 * with a clear "Unknown KEK" instead of an opaque authentication error.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly kek: Buffer;
  readonly kekId: string;

  constructor(kekBase64: string, env: string | undefined = process.env.NODE_ENV) {
    if (env === 'production') {
      throw new Error('LocalKeyProvider must not be used in production; configure AWS KMS');
    }
    this.kek = Buffer.from(kekBase64, 'base64');
    if (this.kek.length !== 32) throw new Error('Local KEK must be 32 bytes (base64-encoded)');
    this.kekId = `local:${createHash('sha256').update(this.kek).digest('hex').slice(0, 12)}`;
  }

  async wrap(dek: Buffer, context: Record<string, string>): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    cipher.setAAD(Buffer.from(canonicalContext(context)));
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  async unwrap(kekId: string, wrapped: string, context: Record<string, string>): Promise<Buffer> {
    if (kekId !== this.kekId) throw new Error(`Unknown KEK ${kekId}`);
    const buf = Buffer.from(wrapped, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.kek, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(canonicalContext(context)));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  }
}

/** AWS KMS: the KEK stays inside KMS; every unwrap is a logged, IAM-authorised KMS call. */
export class AwsKmsKeyProvider implements KeyProvider {
  constructor(
    readonly kekId: string,
    private readonly client: KMSClient = new KMSClient({}),
  ) {}

  async wrap(dek: Buffer, context: Record<string, string>): Promise<string> {
    const out = await this.client.send(
      new EncryptCommand({ KeyId: this.kekId, Plaintext: dek, EncryptionContext: context }),
    );
    if (!out.CiphertextBlob) throw new Error('KMS returned no ciphertext');
    return Buffer.from(out.CiphertextBlob).toString('base64');
  }

  async unwrap(kekId: string, wrapped: string, context: Record<string, string>): Promise<Buffer> {
    const out = await this.client.send(
      new DecryptCommand({
        KeyId: kekId,
        CiphertextBlob: Buffer.from(wrapped, 'base64'),
        EncryptionContext: context,
      }),
    );
    if (!out.Plaintext) throw new Error('KMS returned no plaintext');
    return Buffer.from(out.Plaintext);
  }
}

function canonicalContext(context: Record<string, string>): string {
  return Object.keys(context)
    .sort()
    .map((k) => `${k}=${context[k]}`)
    .join('&');
}

export function keyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider {
  if (env.KMS_KEY_ID) return new AwsKmsKeyProvider(env.KMS_KEY_ID);
  if (env.LOCAL_KEK_BASE64) return new LocalKeyProvider(env.LOCAL_KEK_BASE64, env.NODE_ENV);
  throw new Error('Configure KMS_KEY_ID (production) or LOCAL_KEK_BASE64 (dev/test)');
}
