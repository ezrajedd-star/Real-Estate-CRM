import { describe, expect, it } from 'vitest';
import {
  formatTin,
  maskBankAccount,
  maskEmail,
  maskGovernmentId,
  maskPhone,
  maskTail,
  maskTin,
  normalizeTin,
} from '../src/index.js';

describe('masking', () => {
  it.each([
    [maskTin, '123-456-789-000', '•••-•••-•••-000'],
    [maskBankAccount, '0012-3456-7890', '••••-••••-7890'],
    [maskGovernmentId, 'N01-23-456789', '•••-••-••6789'],
    [maskPhone, '+63 917 123 4567', '+•• ••• ••• 4567'],
    [maskEmail, 'juan.delacruz@example.com', 'j••••••••••••@example.com'],
    [maskEmail, 'a@b.ph', 'a•••@b.ph'],
    [maskEmail, 'not-an-email', '••••••••••••'],
  ])('%o(%s) = %s', (fn, input, out) => {
    expect(fn(input)).toBe(out);
  });

  it('never reveals more than the tail', () => {
    expect(maskTail('AB', 4)).toBe('AB');
    expect(maskTail('ABCDEFGH', 2)).toBe('••••••GH');
  });
});

describe('TIN normalisation', () => {
  it.each([
    ['123-456-789', '123456789000'],
    ['123 456 789 001', '123456789001'],
    ['123-456-789-00000', '12345678900000'],
  ])('%s → %s', (input, out) => expect(normalizeTin(input)).toBe(out));

  it.each(['12345', '1234567890', ''])('rejects %j', (v) => {
    expect(() => normalizeTin(v)).toThrow(RangeError);
  });

  it('formats', () => {
    expect(formatTin('123456789')).toBe('123-456-789-000');
  });
});
