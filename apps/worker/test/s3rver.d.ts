// Minimal typings for the s3rver test server (no upstream types).
declare module 's3rver' {
  import type { AddressInfo } from 'node:net';
  interface S3rverOptions {
    port?: number;
    address?: string;
    silent?: boolean;
    directory?: string;
    configureBuckets?: Array<{ name: string }>;
  }
  export default class S3rver {
    constructor(options: S3rverOptions);
    run(): Promise<AddressInfo>;
    close(): Promise<void>;
  }
}
