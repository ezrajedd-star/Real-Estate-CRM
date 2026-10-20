import { describe, expect, it } from 'vitest';
import {
  EffectivePeriodOverlapError,
  MissingEffectiveValueError,
  findOverlaps,
  isEffectiveOn,
  parseLocalDate,
  requireEffective,
  resolveEffective,
} from '../src/index.js';

const d = parseLocalDate;
const vat = [
  { rate: '0.10', effectiveFrom: d('2020-01-01'), effectiveTo: d('2024-01-01') },
  { rate: '0.12', effectiveFrom: d('2024-01-01'), effectiveTo: null },
];

describe('isEffectiveOn ([from, to) semantics)', () => {
  it.each([
    ['2019-12-31', false],
    ['2020-01-01', true],
    ['2023-12-31', true],
    ['2024-01-01', false], // effectiveTo is exclusive
  ])('first VAT row on %s → %s', (asOf, out) => {
    expect(isEffectiveOn(vat[0]!, d(asOf))).toBe(out);
  });

  it('open-ended rows apply forever', () => {
    expect(isEffectiveOn(vat[1]!, d('2099-01-01'))).toBe(true);
  });
});

describe('resolveEffective', () => {
  it.each([
    ['2021-06-30', '0.10'],
    ['2024-01-01', '0.12'],
    ['2030-01-01', '0.12'],
  ])('on %s picks %s', (asOf, rate) => {
    expect(resolveEffective(vat, d(asOf))?.rate).toBe(rate);
  });

  it('returns undefined before any row starts', () => {
    expect(resolveEffective(vat, d('2010-01-01'))).toBeUndefined();
  });

  it('throws on overlapping rows', () => {
    const bad = [...vat, { rate: '0.15', effectiveFrom: d('2025-01-01'), effectiveTo: null }];
    expect(() => resolveEffective(bad, d('2025-06-01'))).toThrow(EffectivePeriodOverlapError);
  });

  it('requireEffective throws when missing', () => {
    expect(() => requireEffective(vat, d('2010-01-01'), 'VAT rate')).toThrow(
      MissingEffectiveValueError,
    );
    expect(requireEffective(vat, d('2025-01-01'), 'VAT rate').rate).toBe('0.12');
  });
});

describe('findOverlaps', () => {
  it('accepts adjacent periods', () => {
    expect(findOverlaps(vat)).toEqual([]);
  });

  it('detects overlaps, including with open-ended rows', () => {
    const rows = [
      { id: 'a', effectiveFrom: d('2020-01-01'), effectiveTo: null },
      { id: 'b', effectiveFrom: d('2022-01-01'), effectiveTo: d('2023-01-01') },
    ];
    expect(findOverlaps(rows).map(([x, y]) => [x.id, y.id])).toEqual([['a', 'b']]);
  });

  it('rejects empty or inverted periods', () => {
    expect(() =>
      findOverlaps([{ effectiveFrom: d('2024-01-01'), effectiveTo: d('2024-01-01') }]),
    ).toThrow(RangeError);
  });
});
