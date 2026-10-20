import { describe, expect, it } from 'vitest';
import { Decimal, Money, roundMoney, roundRate, toDecimal } from '../src/index.js';

describe('roundMoney (central rounding rule: HALF_UP to centavo)', () => {
  it.each([
    ['1.005', '1.01'],
    ['1.004', '1.00'],
    ['-1.005', '-1.01'],
    ['2.675', '2.68'], // a classic float trap: 2.675 is 2.67499… as a double
    ['0.125', '0.13'],
    ['1234567.995', '1234568.00'],
    ['0', '0.00'],
  ])('%s → %s', (input, expected) => {
    expect(roundMoney(input).toFixed(2)).toBe(expected);
  });

  it('rounds rates to 6 places', () => {
    expect(roundRate('0.1234565').toString()).toBe('0.123457');
  });
});

describe('toDecimal', () => {
  it('accepts strings, Decimals and safe integers', () => {
    expect(toDecimal('10.50').toString()).toBe('10.5');
    expect(toDecimal(new Decimal('3')).toString()).toBe('3');
    expect(toDecimal(100).toString()).toBe('100');
  });
  it.each([0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects float/non-finite %s', (v) => {
    expect(() => toDecimal(v)).toThrow();
  });
  it('rejects non-finite strings', () => {
    expect(() => toDecimal('Infinity')).toThrow(RangeError);
  });
});

describe('Money arithmetic', () => {
  it.each([
    ['0.10', '0.20', '0.30'],
    ['100000.00', '0.01', '100000.01'],
    ['-5.00', '5.00', '0.00'],
  ])('%s + %s = %s (no float drift)', (a, b, sum) => {
    expect(Money.of(a).add(Money.of(b)).toString()).toBe(sum);
  });

  it('subtracts and negates', () => {
    expect(Money.of('10.00').subtract(Money.of('12.50')).toString()).toBe('-2.50');
    expect(Money.of('3.21').negate().toString()).toBe('-3.21');
  });

  it.each([
    // base rent per sqm × GLA
    ['850.00', '125.5', '106675.00'],
    // VAT 12 %
    ['106675.00', '0.12', '12801.00'],
    // EWT 5 % on a centavo-heavy amount
    ['33333.33', '0.05', '1666.67'],
    // pro-rata 17/31 of a month
    ['50000.00', new Decimal(17).dividedBy(31), '27419.35'],
  ])('%s × %s = %s', (amount, factor, expected) => {
    expect(Money.of(amount).multiply(factor).toString()).toBe(expected);
  });

  it('sums a list', () => {
    expect(Money.sum([Money.of('1.11'), Money.of('2.22'), Money.of('3.33')]).toString()).toBe(
      '6.66',
    );
    expect(Money.sum([]).toString()).toBe('0.00');
  });

  it('compares', () => {
    const a = Money.of('1.00');
    const b = Money.of('2.00');
    expect(a.lessThan(b)).toBe(true);
    expect(b.greaterThan(a)).toBe(true);
    expect(a.compare(Money.of('1'))).toBe(0);
    expect(a.equals(Money.of('1.00'))).toBe(true);
    expect(a.min(b)).toBe(a);
    expect(a.max(b)).toBe(b);
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.of('-0.01').isNegative()).toBe(true);
    expect(Money.of('0.01').isPositive()).toBe(true);
    expect(Money.zero().isNegative()).toBe(false);
  });

  it('serialises to two decimals', () => {
    expect(JSON.stringify({ a: Money.of('5') })).toBe('{"a":"5.00"}');
    expect(Money.of('7.5').toDecimal().toString()).toBe('7.5');
  });
});

describe('Money.fromDb', () => {
  it('parses NUMERIC(14,2)', () => {
    expect(Money.fromDb('999999999999.99').toString()).toBe('999999999999.99');
    expect(Money.fromDb('-12.3').toString()).toBe('-12.30');
  });
  it.each(['1.234', 'abc', '1e5', '9999999999999.00', ''])('rejects %j', (v) => {
    expect(() => Money.fromDb(v)).toThrow(RangeError);
  });
});

describe('Money.format', () => {
  it.each([
    ['0', '₱0.00'],
    ['1234567.89', '₱1,234,567.89'],
    ['-50', '-₱50.00'],
    ['999', '₱999.00'],
  ])('%s → %s', (v, out) => {
    expect(Money.of(v).format()).toBe(out);
  });
});

describe('Money.allocate (parts always sum to the whole)', () => {
  it.each([
    { total: '100.00', ratios: [1, 1, 1], expected: ['33.34', '33.33', '33.33'] },
    { total: '0.05', ratios: [1, 1], expected: ['0.03', '0.02'] },
    { total: '1000.00', ratios: [50, 30, 20], expected: ['500.00', '300.00', '200.00'] },
    { total: '10.00', ratios: [0, 1], expected: ['0.00', '10.00'] },
    { total: '0.01', ratios: [1, 1, 1], expected: ['0.01', '0.00', '0.00'] },
    { total: '-100.00', ratios: [1, 1, 1], expected: ['-33.33', '-33.33', '-33.34'] },
  ])('$total split $ratios', ({ total, ratios, expected }) => {
    const parts = Money.of(total).allocate(ratios);
    expect(parts.map(String)).toEqual(expected);
    expect(Money.sum(parts).toString()).toBe(Money.of(total).toString());
  });

  it('rejects bad ratios', () => {
    expect(() => Money.of('1').allocate([])).toThrow(RangeError);
    expect(() => Money.of('1').allocate([0, 0])).toThrow(RangeError);
    expect(() => Money.of('1').allocate([-1, 2])).toThrow(RangeError);
  });
});

describe('currency guard', () => {
  it('refuses to mix currencies', () => {
    const fake = Money.of('1', 'USD' as 'PHP');
    expect(() => Money.of('1').add(fake)).toThrow(TypeError);
    expect(() => Money.of('1').compare(fake)).toThrow(TypeError);
  });
});
