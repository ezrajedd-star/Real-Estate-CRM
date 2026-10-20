import { afterAll, describe, expect, it } from 'vitest';
import { ClamdScanner, parseReply } from '../../src/scanning/clamd.js';
import { EICAR, startFakeClamd } from '../fakes.js';

const servers: Array<{ close: () => void }> = [];
afterAll(() => servers.forEach((s) => s.close()));

describe('parseReply', () => {
  it.each([
    ['stream: OK', { clean: true }],
    ['stream: Eicar-Test-Signature FOUND', { clean: false, signature: 'Eicar-Test-Signature' }],
    ['stream: Win.Trojan.Agent-123 FOUND', { clean: false, signature: 'Win.Trojan.Agent-123' }],
  ])('%s', (reply, out) => expect(parseReply(reply)).toEqual(out));

  it.each(['INSTREAM size limit exceeded. ERROR', '', 'stream: OKAY'])(
    'treats %j as an error, never as clean',
    (reply) => {
      expect(() => parseReply(reply)).toThrow(/Unexpected clamd reply/);
    },
  );
});

describe('ClamdScanner over the INSTREAM protocol', () => {
  it('reports clean files clean and EICAR as infected (incl. multi-chunk payloads)', async () => {
    const clamd = await startFakeClamd();
    servers.push(clamd.server);
    const scanner = new ClamdScanner('127.0.0.1', clamd.port);
    expect(await scanner.scan(Buffer.from('%PDF-1.7 hello'))).toEqual({ clean: true });
    expect(await scanner.scan(Buffer.from(EICAR))).toEqual({
      clean: false,
      signature: 'Eicar-Test-Signature',
    });
    const big = Buffer.concat([Buffer.alloc(200 * 1024, 0x41), Buffer.from(EICAR)]);
    expect(await scanner.scan(big)).toMatchObject({ clean: false });
    expect(clamd.requests).toBe(3);
  });

  it('fails closed on daemon errors and connection failures', async () => {
    const clamd = await startFakeClamd({ reply: 'INSTREAM size limit exceeded. ERROR\0' });
    servers.push(clamd.server);
    await expect(
      new ClamdScanner('127.0.0.1', clamd.port).scan(Buffer.from('x')),
    ).rejects.toThrow();
    await expect(new ClamdScanner('127.0.0.1', 1).scan(Buffer.from('x'))).rejects.toThrow();
  });
});
