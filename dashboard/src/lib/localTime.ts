/**
 * Wall-clock <-> epoch conversion in the child's timezone.
 *
 * `src/lib/format.ts` goes one way — an instant to something readable. Writing
 * a note goes the other: the user types "19:30" and the API wants epoch
 * milliseconds. That conversion needs the zone's offset *at that instant*,
 * which is not a constant (DST) and is not the phone's offset (a parent
 * checking in from a hotel in another country still means the nursery's 19:30).
 *
 * Intl is the only timezone database in the browser, so the offset is
 * recovered by formatting an instant in the zone and reading the difference
 * back — the standard trick, and the reason everything here is written in
 * terms of {@link timezoneOffsetMs}.
 */

import type { EpochMs, NightOf, Timezone } from './types';
import { DEFAULT_DAY_BOUNDARY_HOUR, getDefaultTimezone, parseNightOf, shiftNightOf } from './format';

/** Broken-down local time, the way a form holds it. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(tz: Timezone): Intl.DateTimeFormat {
  let formatter = offsetFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    offsetFormatters.set(tz, formatter);
  }
  return formatter;
}

function partsOf(ms: EpochMs, tz: Timezone): WallClock & { second: number } {
  const parts = offsetFormatter(tz).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** Offset of `tz` from UTC at `ms`, in milliseconds. East of Greenwich is positive. */
export function timezoneOffsetMs(ms: EpochMs, tz?: Timezone | null): number {
  const zone = tz ?? getDefaultTimezone();
  const local = partsOf(ms, zone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  // `ms` may carry sub-second precision the formatter dropped.
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the given wall clock reads in `tz`.
 *
 * Solved by iteration rather than algebra: the offset depends on the answer.
 * Two rounds converge everywhere except inside a DST transition, where one of
 * the two possible instants is returned — which is the best any single answer
 * can do for a time that happens twice.
 */
export function epochFromWallClock(clock: WallClock, tz?: Timezone | null): EpochMs {
  const zone = tz ?? getDefaultTimezone();
  const naive = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  let guess = naive;
  for (let round = 0; round < 3; round++) {
    const next = naive - timezoneOffsetMs(guess, zone);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** Minutes after local midnight, 0..1439. */
export function minutesOfDay(ms: EpochMs, tz?: Timezone | null): number {
  const local = partsOf(ms, tz ?? getDefaultTimezone());
  return local.hour * 60 + local.minute;
}

/** `"HH:MM"` for an `<input type="time">`, in the child's zone. */
export function timeInputValue(ms: EpochMs | null | undefined, tz?: Timezone | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const local = partsOf(ms, tz ?? getDefaultTimezone());
  return `${pad2(local.hour)}:${pad2(local.minute)}`;
}

/** Minutes after midnight as `"HH:MM"`, wrapping a value outside one day. */
export function minutesToTimeInput(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  const withinDay = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(withinDay / 60))}:${pad2(withinDay % 60)}`;
}

/** `"19:30"` -> 1170. Returns null for anything that is not a valid time. */
export function timeInputToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface NightTimeOptions {
  tz?: Timezone | null;
  /** `children.day_boundary_hour`; 12 by default. */
  boundaryHour?: number;
}

/**
 * The instant a wall-clock time falls on, *within a given night*.
 *
 * This is the inverse of `format.nightOf`: anything earlier than the day
 * boundary belongs to the morning after the night began, so "00:20 on the
 * night of the 10th" is the 11th at 00:20 local — which is what a parent
 * writing down a 3am wake-up means, and what puts the note on the right
 * timeline.
 */
export function epochForNightTime(
  night: NightOf,
  minutesAfterMidnight: number,
  options: NightTimeOptions = {},
): EpochMs | null {
  const parsed = parseNightOf(night);
  if (!parsed) return null;
  const { tz, boundaryHour = DEFAULT_DAY_BOUNDARY_HOUR } = options;

  const minutes = Math.round(minutesAfterMidnight);
  const withinDay = ((minutes % 1440) + 1440) % 1440;
  const hour = Math.floor(withinDay / 60);

  // A value outside 0..1439 has already said which day it means (that is what
  // `value_min_local` does on a time tag); only a plain wall clock needs the
  // boundary rule applied to it.
  const explicitDays = Math.floor(minutes / 1440);
  const dayShift = explicitDays !== 0 ? explicitDays : hour < boundaryHour ? 1 : 0;

  const date = parseNightOf(shiftNightOf(night, dayShift));
  if (!date) return null;

  return epochFromWallClock(
    { year: date.year, month: date.month, day: date.day, hour, minute: withinDay % 60 },
    tz,
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
