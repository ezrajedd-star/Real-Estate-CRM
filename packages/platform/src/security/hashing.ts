import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * IP addresses are personal data. Store/log only a keyed hash, which still lets security
 * monitoring correlate repeated failures from one address without keeping the address.
 */
export function hashIp(ip: string, key: string): string {
  return createHmac('sha256', key).update(ip.trim().toLowerCase()).digest('hex').slice(0, 32);
}

/** Session ids are stored hashed, so a database leak does not yield usable sessions. */
export function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
