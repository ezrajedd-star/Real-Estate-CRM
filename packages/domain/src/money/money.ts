import { Decimal, type DecimalInput, MONEY_SCALE, roundMoney, toDecimal } from './rounding.js';

export type Currency = 'PHP';

/**
 * Immutable PHP money value. Always held at centavo precision; every arithmetic result is
 * rounded through `roundMoney`. Use `Decimal` directly for intermediate rate maths, then
 * convert once with `Money.of(...)` so rounding happens in one place.
 */
export class Money {
  private constructor(
    private readonly amount: Decimal,
    readonly currency: Currency = 'PHP',
  ) {}

  static of(value: DecimalInput, currency: Currency = 'PHP'): Money {
    return new Money(roundMoney(toDecimal(value)), currency);
  }

  static zero(currency: Currency = 'PHP'): Money {
    return new Money(new Decimal(0), currency);
  }

  /** Parse a NUMERIC(14,2) value as returned by Postgres. */
  static fromDb(value: string): Money {
    if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(value)) {
      throw new RangeError(`Not a NUMERIC(14,2) value: ${value}`);
    }
    return Money.of(value);
  }

  static sum(values: readonly Money[]): Money {
    return values.reduce((acc, m) => acc.add(m), Money.zero());
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amount.minus(other.amount), this.currency);
  }

  /** Multiply by a factor such as a rate, an area in sqm, or a pro-rata fraction. */
  multiply(factor: DecimalInput): Money {
    return Money.of(this.amount.times(toDecimal(factor)), this.currency);
  }

  negate(): Money {
    return Money.of(this.amount.negated(), this.currency);
  }

  /**
   * Split into parts proportional to `ratios`, so the parts always sum exactly to this
   * amount. Leftover centavos go to the parts with the largest remainders (ties: earliest).
   */
  allocate(ratios: readonly DecimalInput[]): Money[] {
    if (ratios.length === 0) throw new RangeError('allocate needs at least one ratio');
    const rs = ratios.map(toDecimal);
    if (rs.some((r) => r.isNegative())) throw new RangeError('Ratios must be non-negative');
    const total = rs.reduce((a, r) => a.plus(r), new Decimal(0));
    if (total.isZero()) throw new RangeError('Ratios must not all be zero');

    const centavos = this.amount.times(100);
    const raw = rs.map((r) => centavos.times(r).dividedBy(total));
    const floors = raw.map((v) => v.toDecimalPlaces(0, Decimal.ROUND_FLOOR));
    let remainder = centavos.minus(floors.reduce((a, f) => a.plus(f), new Decimal(0))).toNumber();
    const order = raw
      .map((v, i) => ({ i, frac: v.minus(floors[i]!) }))
      .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
    const result = [...floors];
    for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) {
      const idx = order[k]!.i;
      result[idx] = result[idx]!.plus(1);
    }
    return result.map((c) => Money.of(c.dividedBy(100), this.currency));
  }

  isZero(): boolean {
    return this.amount.isZero();
  }
  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }
  isPositive(): boolean {
    return this.amount.isPositive() && !this.amount.isZero();
  }
  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }
  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount) as -1 | 0 | 1;
  }
  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }
  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }
  min(other: Money): Money {
    return this.lessThan(other) ? this : other;
  }
  max(other: Money): Money {
    return this.greaterThan(other) ? this : other;
  }

  toDecimal(): Decimal {
    return this.amount;
  }

  /** Canonical string with exactly two decimals, suitable for NUMERIC(14,2). */
  toString(): string {
    return this.amount.toFixed(MONEY_SCALE);
  }

  toJSON(): string {
    return this.toString();
  }

  /** Display format, e.g. `₱1,234,567.89` or `-₱50.00`. */
  format(): string {
    const fixed = this.amount.abs().toFixed(MONEY_SCALE);
    const [int, frac] = fixed.split('.') as [string, string];
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${this.isNegative() ? '-' : ''}₱${grouped}.${frac}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new TypeError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
