import { Socket } from 'node:net';

export type ScanResult = { clean: true } | { clean: false; signature: string };

export interface MalwareScanner {
  scan(bytes: Buffer): Promise<ScanResult>;
}

const CHUNK = 64 * 1024;

/**
 * ClamAV daemon client using the INSTREAM protocol: `zINSTREAM\0`, then chunks prefixed
 * with a 4-byte big-endian length, terminated by a zero-length chunk. Reply is
 * `stream: OK\0` or `stream: <Signature> FOUND\0`. Anything else (including a timeout or a
 * size-limit error) is treated as a failure — never as clean.
 */
export class ClamdScanner implements MalwareScanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 60_000,
  ) {}

  scan(bytes: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      socket.setTimeout(this.timeoutMs);
      socket.on('timeout', () => socket.destroy(new Error('clamd timed out')));
      socket.on('error', reject);
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        try {
          resolve(parseReply(reply));
        } catch (err) {
          reject(err);
        }
      });
      socket.connect(this.port, this.host, () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const part = bytes.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.end(Buffer.alloc(4)); // zero-length terminator
      });
    });
  }
}

export function parseReply(reply: string): ScanResult {
  if (reply === 'stream: OK') return { clean: true };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { clean: false, signature: found[1]! };
  throw new Error(`Unexpected clamd reply: ${reply.slice(0, 120)}`);
}
