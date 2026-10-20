import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';

export const UPLOAD_URL_TTL_SECONDS = 300;
export const DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * Private object storage (S3 / MinIO). Objects are never public: uploads and downloads use
 * short-lived presigned URLs issued only after an authorization check (ADR-006).
 */
@Injectable()
export class StorageService {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.bucket = env.S3_BUCKET;
    this.client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }

  static quarantineKey(documentId: string): string {
    return `quarantine/${documentId}`;
  }

  static cleanKey(documentId: string): string {
    return `clean/${documentId}`;
  }

  presignUpload(key: string, contentType: string, sizeBytes: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
      }),
      {
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
  }

  presignDownload(key: string, filename: string, contentType: string): Promise<string> {
    const safeName = filename.replace(/[^A-Za-z0-9._ -]/g, '_');
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
        ResponseContentType: contentType,
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );
  }

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: out.ContentLength ?? 0 };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async getBuffer(key: string): Promise<Buffer> {
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await out.Body?.transformToByteArray();
    if (!bytes) throw new Error('Empty object');
    return Buffer.from(bytes);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(this.env.S3_SSE_KMS_KEY_ID
          ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.env.S3_SSE_KMS_KEY_ID } // gitleaks:allow (env reference)
          : {}),
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
