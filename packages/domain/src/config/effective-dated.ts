import { type LocalDate, compareDates } from '../time/local-date.js';

/**
 * Any value with an effective period. `effectiveTo` is exclusive and null means open-ended,
 * matching the `daterange(effective_from, effective_to, '[)')` constraint in Postgres.
 */
export interface EffectiveDated {
  effectiveFrom: LocalDate;
  effectiveTo: LocalDate | null;
}

export function isEffectiveOn(entry: EffectiveDated, asOf: LocalDate): boolean {
  return (
    compareDates(entry.effectiveFrom, asOf) <= 0 &&
    (entry.effectiveTo === null || compareDates(asOf, entry.effectiveTo) < 0)
  );
}

/**
 * Returns the single entry effective on `asOf`, or undefined if none is.
 * Throws if more than one entry applies — overlapping periods are a data error.
 */
export function resolveEffective<T extends EffectiveDated>(
  entries: readonly T[],
  asOf: LocalDate,
): T | undefined {
  const matches = entries.filter((e) => isEffectiveOn(e, asOf));
  if (matches.length > 1) {
    throw new EffectivePeriodOverlapError(`${matches.length} entries are effective on ${asOf}`);
  }
  return matches[0];
}

/** Like resolveEffective but throws when nothing applies, for values that must exist. */
export function requireEffective<T extends EffectiveDated>(
  entries: readonly T[],
  asOf: LocalDate,
  what: string,
): T {
  const found = resolveEffective(entries, asOf);
  if (!found) throw new MissingEffectiveValueError(`No ${what} is effective on ${asOf}`);
  return found;
}

/** Validates a set of periods for the same key: each well-formed, none overlapping. */
export function findOverlaps<T extends EffectiveDated>(entries: readonly T[]): Array<[T, T]> {
  for (const e of entries) {
    if (e.effectiveTo !== null && compareDates(e.effectiveTo, e.effectiveFrom) <= 0) {
      throw new RangeError(
        `effectiveTo (${e.effectiveTo}) must be after effectiveFrom (${e.effectiveFrom})`,
      );
    }
  }
  const sorted = [...entries].sort((a, b) => compareDates(a.effectiveFrom, b.effectiveFrom));
  const overlaps: Array<[T, T]> = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.effectiveTo === null || compareDates(b.effectiveFrom, a.effectiveTo) < 0) {
        overlaps.push([a, b]);
      }
    }
  }
  return overlaps;
}

export class EffectivePeriodOverlapError extends Error {
  override name = 'EffectivePeriodOverlapError';
}

export class MissingEffectiveValueError extends Error {
  override name = 'MissingEffectiveValueError';
}
