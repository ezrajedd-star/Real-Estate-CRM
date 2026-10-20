# ADR-007: Money, rounding and business dates

## Context

Billing, penalties, VAT, withholding and commissions (Phases 2–3) must be exact and
reproducible. Leases are in PHP with dates in Asia/Manila.

## Decision

- **Storage.** Money is `NUMERIC(14,2)` and rates are `NUMERIC(9,6)`. Floats are never used,
  in the database or in code.
- **Code.** `Money` (`packages/domain/src/money/money.ts`) wraps a dedicated `decimal.js`
  clone. Inputs are strings or Decimals; non-integer JS numbers are rejected.
  `allocate(ratios)` splits amounts so the parts always sum exactly.
- **Rounding.** All rounding lives in `packages/domain/src/money/rounding.ts`: **ROUND_HALF_UP
  to the centavo [CONFIRM with accountant]**. Intermediate maths uses Decimal at 40 digits,
  rounded once at the end.
- **Dates.** Instants are `timestamptz`. Business dates (due dates, anniversaries) are `date`
  in Asia/Manila, handled as `LocalDate` strings with integer arithmetic (`addMonths` clamps
  to month end; leap days fall back to Feb 28). `dueDateInMonth` clamps a due day of 31.
  `toManilaDate()` converts instants. Display is `MMM DD, YYYY`.
- **Time in code.** Code that needs "now" takes a `Clock`, and tests use `ManualClock`. There
  are no real sleeps in tests.

## Consequences

- Every money rule in later phases gets table-driven tests on the same primitives (leap
  years, month-end, partial and over-payments, mid-term amendments).
- Changing the rounding mode is a one-line change plus the test table, once the accountant
  confirms it.
