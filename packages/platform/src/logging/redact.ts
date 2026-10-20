/**
 * PII redaction layer (brief §8.1: no PII in logs, URLs, error trackers). Every log line
 * and every error report passes through `redact`. Two defences:
 *   1. key denylist  — values under sensitive keys are replaced wholesale;
 *   2. value scrubbers — PII-shaped substrings inside any string are masked, which catches
 *      PII that slips into free text (error messages, SQL errors echoing a value, URLs).
 */

export const REDACTED = '[REDACTED]';

// Matched against the key's tokens (camelCase / snake_case / kebab-case split), so `tin`
// matches `tin` and `companyTin` but not `setting`.
const SENSITIVE_TOKENS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'session',
  'apikey',
  'otp',
  'totp',
  'tin',
  'email',
  'phone',
  'mobile',
  'birthdate',
  'birthday',
  'address',
  'financials',
  'iban',
  'signature',
  'enc',
  'bidx',
  'plaintext',
]);
const SENSITIVE_PAIRS = [
  ['gov', 'id'],
  ['account', 'no'],
  ['account', 'number'],
  ['full', 'name'],
  ['private', 'key'],
  ['api', 'key'],
  ['bank', 'account'],
];

// Keys that look sensitive by the rules above but carry no PII.
const SAFE_KEYS = new Set(['tin_last3', 'tinLast3', 'tokenType', 'ip_hash', 'ipHash']);

function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SCRUBBERS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
  // Philippine TIN: 9 digits + optional 3/5-digit branch, with or without dashes/spaces
  [/\b\d{3}[- ]?\d{3}[- ]?\d{3}(?:[- ]?\d{3,5})?\b/g, '[NUMBER]'],
  // PH mobile/landline: +63 9xx xxx xxxx, 09xxxxxxxxx, (02) 8xxx xxxx
  [/(?:\+?63|0)[\s-]?\(?\d{1,3}\)?[\s-]?\d{3,4}[\s-]?\d{4}\b/g, '[PHONE]'],
  // Any other long digit run (bank accounts, card numbers, IDs)
  [/\b\d[\d -]{8,}\d\b/g, '[NUMBER]'],
  // Bearer tokens / JWTs
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]'],
];

export function scrubString(value: string): string {
  let out = value;
  for (const [re, replacement] of SCRUBBERS) out = out.replace(re, replacement);
  return out;
}

export function isSensitiveKey(key: string): boolean {
  if (SAFE_KEYS.has(key)) return false;
  const tokens = keyTokens(key);
  if (tokens.some((t) => SENSITIVE_TOKENS.has(t))) return true;
  return SENSITIVE_PAIRS.some(([a, b]) => tokens.some((t, i) => t === a && tokens[i + 1] === b));
}

/** Deep-redacts any value. Never mutates the input. Handles cycles and Errors. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      type: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
      ...(value.cause !== undefined ? { cause: redact(value.cause, seen) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}]`;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) && v !== null && v !== undefined ? REDACTED : redact(v, seen);
  }
  return out;
}

/** Strips query strings and scrubs path segments before a URL is logged. */
export function redactUrl(url: string): string {
  const path = url.split('?')[0] ?? '';
  return scrubString(path);
}
