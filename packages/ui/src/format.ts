import { Decimal, Money, formatDisplayDate, isLocalDate, toManilaDate } from '@crm/domain';

/** `MMM DD, YYYY` in Asia/Manila for both business dates and timestamps. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  if (typeof value === 'string' && isLocalDate(value)) return formatDisplayDate(value);
  return formatDisplayDate(toManilaDate(new Date(value)));
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  const time = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  return `${formatDate(d)} ${time}`;
}

/** `₱1,234,567.89` — always via Money, never floats. */
export function formatPeso(amount: string | null | undefined): string {
  return amount ? Money.fromDb(amount).format() : '—';
}

export function formatRate(rate: string | null | undefined): string {
  if (!rate) return '—';
  const pct = new Decimal(rate).times(100);
  return `${pct.isInteger() ? pct.toFixed(0) : pct.toFixed(2)}%`;
}
