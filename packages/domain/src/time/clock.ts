import { type LocalDate, toManilaDate } from './local-date.js';

/**
 * All code that needs "now" takes a Clock, so schedulers and the reminder engine can be
 * tested with a controllable clock instead of real time or sleeps.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock for tests: starts at `start` and only moves when told to. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | string) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(to: Date | string): void {
    this.current = new Date(to).getTime();
  }

  advanceMs(ms: number): void {
    this.current += ms;
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 86_400_000);
  }
}

export function manilaToday(clock: Clock): LocalDate {
  return toManilaDate(clock.now());
}
