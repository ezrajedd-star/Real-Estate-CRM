/**
 * Display masking for sensitive fields. Masked values are what every role sees by default;
 * the clear value is only returned by an audited "reveal" with a stated reason.
 */

const MASK = '•';

/** Keep only the last `visible` characters, preserving separators for readability. */
export function maskTail(value: string, visible = 4): string {
  const chars = [...value];
  const alnumIdx = chars.map((c, i) => (/[A-Za-z0-9]/.test(c) ? i : -1)).filter((i) => i >= 0);
  const keep = new Set(alnumIdx.slice(Math.max(0, alnumIdx.length - visible)));
  return chars.map((c, i) => (/[A-Za-z0-9]/.test(c) && !keep.has(i) ? MASK : c)).join('');
}

/** Philippine TIN, e.g. `123-456-789-000` → `•••-•••-•••-000`. */
export function maskTin(tin: string): string {
  return maskTail(tin, 3);
}

/** Bank account: show the last 4 digits only. */
export function maskBankAccount(account: string): string {
  return maskTail(account, 4);
}

export function maskGovernmentId(id: string): string {
  return maskTail(id, 4);
}

/** `juan.delacruz@example.com` → `j•••••••••••@example.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return MASK.repeat(Math.max(3, email.length));
  return `${email[0]}${MASK.repeat(Math.max(3, at - 1))}${email.slice(at)}`;
}

/** `+63 917 123 4567` → `+•• ••• ••• 4567`. */
export function maskPhone(phone: string): string {
  return maskTail(phone, 4);
}

/** Normalises a TIN for blind indexing and dedupe: digits only, branch code padded to 000. */
export function normalizeTin(tin: string): string {
  const digits = tin.replace(/\D/g, '');
  if (digits.length !== 9 && digits.length !== 12 && digits.length !== 14) {
    throw new RangeError('A TIN has 9 digits plus an optional 3- or 5-digit branch code');
  }
  return digits.length === 9 ? `${digits}000` : digits;
}

export function formatTin(tin: string): string {
  const d = normalizeTin(tin);
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)}-${d.slice(9)}`;
}
