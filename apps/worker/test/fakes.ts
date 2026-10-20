import { mkdtempSync } from 'node:fs';
import { type AddressInfo, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';

/** The standard EICAR antivirus test string (harmless by design). */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * A minimal clamd speaking the real INSTREAM wire protocol: reads length-prefixed chunks
 * until a zero-length chunk and replies FOUND for the EICAR signature.
 */
export async function startFakeClamd(
  opts: { reply?: string; port?: number } = {},
): Promise<{ port: number; server: Server; requests: number }> {
  const state = { requests: 0 };
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let headerSeen = false;
    const body: Buffer[] = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!headerSeen) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        if (buf.subarray(0, nul).toString() !== 'zINSTREAM') return sock.end('UNKNOWN COMMAND\0');
        buf = buf.subarray(nul + 1);
        headerSeen = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          state.requests++;
          const content = Buffer.concat(body).toString('latin1');
          return sock.end(
            opts.reply ??
              (content.includes(EICAR) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0'),
          );
        }
        if (buf.length < 4 + len) return;
        body.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    server,
    get requests() {
      return state.requests;
    },
  };
}

/** S3-compatible server for tests (production uses AWS S3 / MinIO in docker compose). */
export async function startS3(
  buckets: string[],
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const server = new S3rver({
    port: 0,
    address: '127.0.0.1',
    silent: true,
    directory: mkdtempSync(join(tmpdir(), 's3rver-')),
    configureBuckets: buckets.map((name) => ({ name })),
  });
  const info = (await server.run()) as AddressInfo;
  return { endpoint: `http://127.0.0.1:${info.port}`, close: () => server.close() };
}
