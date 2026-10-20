import { Decimal as DecimalLib } from 'decimal.js';

/**
 * The single place where money rounding rules live.
 *
 * [CONFIRM with accountant] Rounding mode: ROUND_HALF_UP to the centavo is the common
 * Philippine practice for billing statements. Change it here only (see ADR-007).
 */
export const Decimal = DecimalLib.clone({ precision: 40, rounding: DecimalLib.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;
export type DecimalInput = Decimal | string | number;

export const MONEY_SCALE = 2;
export const RATE_SCALE = 6;
export const MONEY_ROUNDING = Decimal.ROUND_HALF_UP;

/** Round an amount to centavos using the central rounding rule. */
export function roundMoney(value: DecimalInput): Decimal {
  return new Decimal(value).toDecimalPlaces(MONEY_SCALE, MONEY_ROUNDING);
}

/** Round a rate (e.g. 0.12, 0.05) to the stored rate precision. */
export function roundRate(value: DecimalInput): Decimal {
  return new Decimal(value).toDecimalPlaces(RATE_SCALE, MONEY_ROUNDING);
}

/** Rejects JS floats with more precision than they can safely carry. */
export function toDecimal(value: DecimalInput): Decimal {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('Money values must be finite');
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('Pass non-integer money amounts as strings or Decimal, never floats');
    }
  }
  const d = new Decimal(value);
  if (!d.isFinite()) throw new RangeError('Money values must be finite');
  return d;
}
