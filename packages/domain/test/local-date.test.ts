import { describe, expect, it } from 'vitest';
import {
  ManualClock,
  addDays,
  addMonths,
  addYears,
  compareDates,
  daysBetween,
  daysInMonth,
  dueDateInMonth,
  endOfMonth,
  formatDisplayDate,
  isLeapYear,
  isLocalDate,
  localDate,
  manilaToday,
  maxDate,
  minDate,
  parseLocalDate,
  startOfMonth,
  systemClock,
  toManilaDate,
  toParts,
  type LocalDate,
} from '../src/index.js';

const d = (s: string) => parseLocalDate(s);

describe('calendar basics', () => {
  it.each([
    [2024, true],
    [2025, false],
    [1900, false],
    [2000, true],
    [2100, false],
  ])('isLeapYear(%i) = %s', (y, leap) => expect(isLeapYear(y)).toBe(leap));

  it.each([
    [2024, 2, 29],
    [2025, 2, 28],
    [2025, 4, 30],
    [2025, 12, 31],
  ])('daysInMonth(%i, %i) = %i', (y, m, n) => expect(daysInMonth(y, m)).toBe(n));

  it('rejects invalid months and dates', () => {
    expect(() => daysInMonth(2025, 13)).toThrow(RangeError);
    expect(() => localDate(2025, 2, 29)).toThrow(RangeError);
    expect(() => localDate(1800, 1, 1)).toThrow(RangeError);
    expect(() => parseLocalDate('2025-1-01')).toThrow(RangeError);
    expect(() => parseLocalDate('2025-02-30')).toThrow(RangeError);
  });

  it('isLocalDate guards', () => {
    expect(isLocalDate('2024-02-29')).toBe(true);
    expect(isLocalDate('2023-02-29')).toBe(false);
    expect(isLocalDate(20240229)).toBe(false);
  });

  it('toParts', () => {
    expect(toParts(d('2026-03-07'))).toEqual({ year: 2026, month: 3, day: 7 });
  });
});

describe('date arithmetic', () => {
  it.each([
    ['2024-02-28', 1, '2024-02-29'],
    ['2024-02-29', 1, '2024-03-01'],
    ['2025-12-31', 1, '2026-01-01'],
    ['2025-03-01', -1, '2025-02-28'],
  ])('addDays(%s, %i) = %s', (from, n, to) => expect(addDays(d(from), n)).toBe(to));

  it.each([
    // month-end clamping (lease starting on the 31st)
    ['2025-01-31', 1, '2025-02-28'],
    ['2024-01-31', 1, '2024-02-29'],
    ['2025-01-31', 3, '2025-04-30'],
    ['2025-08-31', -6, '2025-02-28'],
    ['2025-11-15', 2, '2026-01-15'],
    ['2026-01-15', -13, '2024-12-15'],
  ])('addMonths(%s, %i) = %s', (from, n, to) => expect(addMonths(d(from), n)).toBe(to));

  it.each([
    // leap-day anniversary falls back to Feb 28 in non-leap years
    ['2024-02-29', 1, '2025-02-28'],
    ['2024-02-29', 4, '2028-02-29'],
    ['2025-06-01', 3, '2028-06-01'],
  ])('addYears(%s, %i) = %s', (from, n, to) => expect(addYears(d(from), n)).toBe(to));

  it('rejects non-integer offsets', () => {
    expect(() => addDays(d('2025-01-01'), 1.5)).toThrow(RangeError);
    expect(() => addMonths(d('2025-01-01'), 0.5)).toThrow(RangeError);
  });

  it.each([
    ['2025-01-01', '2025-12-31', 364],
    ['2024-01-01', '2024-12-31', 365],
    ['2025-03-10', '2025-03-01', -9],
  ])('daysBetween(%s, %s) = %i', (a, b, n) => expect(daysBetween(d(a), d(b))).toBe(n));

  it('compares and picks min/max', () => {
    expect(compareDates(d('2025-01-01'), d('2025-01-02'))).toBe(-1);
    expect(compareDates(d('2025-01-02'), d('2025-01-01'))).toBe(1);
    expect(compareDates(d('2025-01-01'), d('2025-01-01'))).toBe(0);
    expect(minDate(d('2025-01-01'), d('2024-01-01'))).toBe('2024-01-01');
    expect(maxDate(d('2025-01-01'), d('2024-01-01'))).toBe('2025-01-01');
  });

  it.each([
    ['2024-02-10', '2024-02-01', '2024-02-29'],
    ['2025-02-10', '2025-02-01', '2025-02-28'],
    ['2025-12-31', '2025-12-01', '2025-12-31'],
  ])('month bounds of %s', (x, start, end) => {
    expect(startOfMonth(d(x))).toBe(start);
    expect(endOfMonth(d(x))).toBe(end);
  });
});

describe('dueDateInMonth (due day set per lease)', () => {
  it.each([
    [2025, 2, 31, '2025-02-28'],
    [2024, 2, 31, '2024-02-29'],
    [2025, 4, 31, '2025-04-30'],
    [2025, 4, 30, '2025-04-30'],
    [2025, 5, 31, '2025-05-31'],
    [2025, 5, 5, '2025-05-05'],
  ])('%i-%i due day %i → %s', (y, m, day, out) => expect(dueDateInMonth(y, m, day)).toBe(out));

  it.each([0, 32, 1.5])('rejects due day %s', (day) => {
    expect(() => dueDateInMonth(2025, 1, day)).toThrow(RangeError);
  });
});

describe('Asia/Manila business date', () => {
  it.each([
    // 15:59 UTC = 23:59 Manila → same day; 16:00 UTC = 00:00 next day in Manila
    ['2025-12-31T15:59:59Z', '2025-12-31'],
    ['2025-12-31T16:00:00Z', '2026-01-01'],
    ['2024-02-28T16:30:00Z', '2024-02-29'],
  ])('%s is %s in Manila', (iso, local) => {
    expect(toManilaDate(new Date(iso))).toBe(local);
  });

  it('manilaToday uses the injected clock', () => {
    const clock = new ManualClock('2026-01-31T15:00:00Z');
    expect(manilaToday(clock)).toBe('2026-01-31');
    clock.advanceMs(60 * 60 * 1000);
    expect(manilaToday(clock)).toBe('2026-02-01');
    clock.advanceDays(28);
    expect(manilaToday(clock)).toBe('2026-03-01');
    clock.set('2026-06-01T00:00:00Z');
    expect(manilaToday(clock)).toBe('2026-06-01');
  });

  it('systemClock returns the current time', () => {
    const before = Date.now();
    expect(systemClock.now().getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('formatDisplayDate (MMM DD, YYYY)', () => {
  it.each([
    ['2026-02-05', 'Feb 05, 2026'],
    ['2025-12-31', 'Dec 31, 2025'],
  ])('%s → %s', (x, out) => expect(formatDisplayDate(x as LocalDate)).toBe(out));
});
