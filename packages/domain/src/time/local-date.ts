/**
 * Business dates (billing dates, due dates, lease anniversaries) are calendar dates in
 * Asia/Manila, represented as ISO `YYYY-MM-DD` strings. They never carry a time or zone,
 * which avoids the classic "midnight UTC is yesterday in Manila" bugs.
 */
export type LocalDate = string & { readonly __brand: 'LocalDate' };

export const BUSINESS_TIME_ZONE = 'Asia/Manila';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) throw new RangeError(`Invalid month ${month}`);
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function localDate(year: number, month: number, day: number): LocalDate {
  if (!Number.isInteger(year) || year < 1900 || year > 9999)
    throw new RangeError(`Invalid year ${year}`);
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Invalid day ${day} for ${year}-${month}`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as LocalDate;
}

export function parseLocalDate(value: string): LocalDate {
  const m = ISO_DATE.exec(value);
  if (!m) throw new RangeError(`Not an ISO date (YYYY-MM-DD): ${value}`);
  return localDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function isLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string') return false;
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

export function toParts(date: LocalDate): DateParts {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { year: y, month: m, day: d };
}

/** Days since 1970-01-01 (proleptic Gregorian), for arithmetic. */
function toEpochDay(date: LocalDate): number {
  const { year, month, day } = toParts(date);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function fromEpochDay(epochDay: number): LocalDate {
  const d = new Date(epochDay * 86_400_000);
  return localDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) throw new RangeError('days must be an integer');
  return fromEpochDay(toEpochDay(date) + days);
}

/**
 * Add calendar months, clamping to the last day of the target month
 * (Jan 31 + 1 month = Feb 28/29). Used for anniversaries, terms and due dates.
 */
export function addMonths(date: LocalDate, months: number): LocalDate {
  if (!Number.isInteger(months)) throw new RangeError('months must be an integer');
  const { year, month, day } = toParts(date);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return localDate(y, m, Math.min(day, daysInMonth(y, m)));
}

export function addYears(date: LocalDate, years: number): LocalDate {
  return addMonths(date, years * 12);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

export function compareDates(a: LocalDate, b: LocalDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: LocalDate, b: LocalDate): LocalDate {
  return a <= b ? a : b;
}

export function maxDate(a: LocalDate, b: LocalDate): LocalDate {
  return a >= b ? a : b;
}

export function startOfMonth(date: LocalDate): LocalDate {
  const { year, month } = toParts(date);
  return localDate(year, month, 1);
}

export function endOfMonth(date: LocalDate): LocalDate {
  const { year, month } = toParts(date);
  return localDate(year, month, daysInMonth(year, month));
}

/**
 * The due date in a given month for a lease whose due day is `dueDay` (1-31). A due day
 * past the month's end falls on its last day, e.g. due day 31 in February → Feb 28/29.
 */
export function dueDateInMonth(year: number, month: number, dueDay: number): LocalDate {
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    throw new RangeError(`Due day must be 1-31, got ${dueDay}`);
  }
  return localDate(year, month, Math.min(dueDay, daysInMonth(year, month)));
}

/** The calendar date in Asia/Manila at the given instant. */
export function toManilaDate(instant: Date): LocalDate {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return parseLocalDate(fmt.format(instant));
}

/** UI display format required by the brief: `MMM DD, YYYY`, e.g. `Feb 05, 2026`. */
export function formatDisplayDate(date: LocalDate): string {
  const { year, month, day } = toParts(date);
  return `${MONTHS[month - 1]} ${String(day).padStart(2, '0')}, ${year}`;
}
