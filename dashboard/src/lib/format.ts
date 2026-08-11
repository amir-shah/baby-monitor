/**
 * Formatting helpers.
 *
 * Two rules run through all of this:
 *
 *  1. **Null is normal.** A sensor can be offline, a night can be in progress,
 *     a metric can be uncomputable. Every formatter takes `number | null |
 *     undefined` and returns an em dash for absent data. Nothing here ever
 *     renders "NaN", "undefined" or "Invalid Date".
 *  2. **Local means the child's local.** A night is a local concept, so every
 *     wall-clock formatter takes an IANA timezone. Set the active child's
 *     timezone once with {@link setDefaultTimezone} and omit it thereafter.
 */

import type { EpochMs, NightOf, Severity, SleepState, TagCategory, Timezone } from './types';

/** What every formatter renders when it has nothing to render. */
export const EM_DASH = '—';

/** U+2212, which lines up with digits far better than a hyphen. */
const MINUS = '−';

/** Narrow no-break space, for "20.8 °C" style unit gaps. */
const NNBSP = ' ';

function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Timezone plumbing
// ---------------------------------------------------------------------------

let defaultTimezone: Timezone | undefined;

/**
 * Set the timezone used when a formatter is called without one — normally the
 * active child's `timezone`. Passing `null`/`undefined` reverts to the
 * browser's own zone.
 */
export function setDefaultTimezone(tz: Timezone | null | undefined): void {
  defaultTimezone = tz ?? undefined;
}

export function getDefaultTimezone(): Timezone {
  return defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function zone(tz?: Timezone | null): Timezone | undefined {
  return tz ?? defaultTimezone;
}

/**
 * `Intl.DateTimeFormat` construction is expensive enough to matter when a
 * timeline renders a few hundred tick labels, so the instances are cached.
 */
const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(options: Intl.DateTimeFormatOptions, locale?: string): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = dtfCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale ?? undefined, options);
    dtfCache.set(key, formatter);
  }
  return formatter;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Break an instant into wall-clock fields in a given zone. */
function localParts(ms: EpochMs, tz?: Timezone): LocalParts {
  const parts = dtf(
    {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
    'en-GB',
  ).formatToParts(new Date(ms));

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
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

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

export interface DurationOptions {
  /**
   * `"hm"`  -> "9h 51m" (default)
   * `"hms"` -> "9h 51m 12s"
   * `"long"`-> "9 hours 51 min"
   * `"compact"` -> "9:51"
   */
  style?: 'hm' | 'hms' | 'long' | 'compact';
  /** Render a zero duration as "0m" rather than an em dash. Default true. */
  zeroAsValue?: boolean;
}

/**
 * Format a duration given in **minutes** — the unit every `_min` field uses.
 *
 * ```
 * formatDuration(591)    // "9h 51m"
 * formatDuration(51)     // "51m"
 * formatDuration(-12)    // "−12m"   (a negative latency is a data bug worth seeing)
 * formatDuration(null)   // "—"
 * ```
 */
export function formatDuration(
  minutes: number | null | undefined,
  options: DurationOptions = {},
): string {
  if (isMissing(minutes)) return EM_DASH;
  const { style = 'hm', zeroAsValue = true } = options;
  if (minutes === 0 && !zeroAsValue) return EM_DASH;

  const negative = minutes < 0;
  const totalSeconds = Math.round(Math.abs(minutes) * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const sign = negative ? MINUS : '';

  switch (style) {
    case 'compact':
      return `${sign}${hours}:${String(mins).padStart(2, '0')}`;
    case 'hms': {
      const chunks: string[] = [];
      if (hours) chunks.push(`${hours}h`);
      if (mins || hours) chunks.push(`${mins}m`);
      chunks.push(`${secs}s`);
      return sign + chunks.join(' ');
    }
    case 'long': {
      if (hours && mins) return `${sign}${hours} ${plural(hours, 'hour')} ${mins} min`;
      if (hours) return `${sign}${hours} ${plural(hours, 'hour')}`;
      return `${sign}${mins} min`;
    }
    case 'hm':
    default:
      if (hours && mins) return `${sign}${hours}h ${mins}m`;
      if (hours) return `${sign}${hours}h`;
      return `${sign}${mins}m`;
  }
}

/** Same, for the `_s` fields. */
export function formatDurationSeconds(
  seconds: number | null | undefined,
  options: DurationOptions = {},
): string {
  if (isMissing(seconds)) return EM_DASH;
  // Under a minute, minutes-rounding would throw the value away.
  if (Math.abs(seconds) < 60 && options.style !== 'compact') {
    const rounded = Math.abs(seconds) < 10 ? round(seconds, 1) : Math.round(seconds);
    return `${formatNumber(rounded)}s`;
  }
  return formatDuration(seconds / 60, options);
}

/** Uptime and other long spans: "3d 4h", "4h 12m", "6m". */
export function formatUptime(seconds: number | null | undefined): string {
  if (isMissing(seconds)) return EM_DASH;
  const total = Math.floor(Math.abs(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  if (mins) return `${mins}m`;
  return `${total}s`;
}

// ---------------------------------------------------------------------------
// Clock times and dates
// ---------------------------------------------------------------------------

export interface ClockOptions {
  tz?: Timezone | null;
  /** Include seconds. Default false. */
  seconds?: boolean;
  /**
   * 24-hour or 12-hour. Default follows the browser locale, which is what an
   * exhausted parent expects to see.
   */
  hour12?: boolean;
  locale?: string;
}

/** "19:30" / "7:30 PM" from epoch milliseconds. */
export function formatClock(ms: EpochMs | null | undefined, options: ClockOptions = {}): string {
  if (isMissing(ms)) return EM_DASH;
  const { tz, seconds = false, hour12, locale } = options;
  return dtf(
    {
      timeZone: zone(tz),
      hour: 'numeric',
      minute: '2-digit',
      ...(seconds ? { second: '2-digit' } : {}),
      ...(hour12 === undefined ? {} : { hour12 }),
    },
    locale,
  ).format(new Date(ms));
}

/** "Fri 8 Aug, 19:30" — a timestamp a human reads once, not scans. */
export function formatDateTime(
  ms: EpochMs | null | undefined,
  options: ClockOptions & { year?: boolean } = {},
): string {
  if (isMissing(ms)) return EM_DASH;
  const { tz, year, locale } = options;
  const day = formatDayLabel(ms, { tz, year: year ?? false, locale });
  return `${day}, ${formatClock(ms, options)}`;
}

/** "Fri 8 Aug" (or "Fri 8 Aug 2025") for an instant. */
export function formatDayLabel(
  ms: EpochMs | null | undefined,
  options: { tz?: Timezone | null; year?: boolean; locale?: string } = {},
): string {
  if (isMissing(ms)) return EM_DASH;
  return dayLabelFromParts(localParts(ms, zone(options.tz)), options);
}

function dayLabelFromParts(
  parts: LocalParts,
  options: { year?: boolean; locale?: string } = {},
): string {
  // Formatted as UTC on a synthetic instant so the weekday and month names
  // come from Intl without a second timezone conversion muddling the date.
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day, 12);
  const bits = dtf(
    {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(options.year ? { year: 'numeric' } : {}),
    },
    options.locale ?? 'en-GB',
  ).formatToParts(new Date(utc));

  return bits
    .filter((part) => part.type !== 'literal')
    .map((part) => part.value)
    .join(' ');
}

/**
 * Minutes after local midnight -> "19:30". This is the unit `value_min_local`
 * uses on time-valued tags, and it may exceed 1440 or go negative for times
 * either side of midnight ("00:20" the next morning is 1460).
 */
export function formatMinuteOfDay(
  minutes: number | null | undefined,
  options: { hour12?: boolean; showDayOffset?: boolean } = {},
): string {
  if (isMissing(minutes)) return EM_DASH;
  const rounded = Math.round(minutes);
  const dayOffset = Math.floor(rounded / 1440);
  const withinDay = ((rounded % 1440) + 1440) % 1440;
  const hours = Math.floor(withinDay / 60);
  const mins = withinDay % 60;

  let text: string;
  if (options.hour12) {
    const suffix = hours < 12 ? 'AM' : 'PM';
    const display = hours % 12 === 0 ? 12 : hours % 12;
    text = `${display}:${String(mins).padStart(2, '0')} ${suffix}`;
  } else {
    text = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  }

  if (options.showDayOffset !== false && dayOffset !== 0) {
    text += dayOffset > 0 ? ` +${dayOffset}` : ` ${MINUS}${Math.abs(dayOffset)}`;
  }
  return text;
}

/** A `"HH:MM"` config value (`target_bedtime`) back to minutes after midnight. */
export function parseLocalTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

// ---------------------------------------------------------------------------
// night_of
// ---------------------------------------------------------------------------

/** The default `children.day_boundary_hour`. */
export const DEFAULT_DAY_BOUNDARY_HOUR = 12;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateKey(year: number, month: number, day: number): NightOf {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Shift a `"YYYY-MM-DD"` by whole days. Calendar arithmetic, no DST involved. */
export function shiftNightOf(nightOf: NightOf, days: number): NightOf {
  const parsed = parseNightOf(nightOf);
  if (!parsed) return nightOf;
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return dateKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

export function parseNightOf(
  nightOf: NightOf | null | undefined,
): { year: number; month: number; day: number } | null {
  if (!nightOf) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nightOf);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * The `night_of` an instant belongs to — the mirror of
 * `babymon.timeutil.night_of`. Everything before `boundaryHour` local time
 * still belongs to the previous evening's night.
 */
export function nightOf(
  ms: EpochMs = Date.now(),
  options: { tz?: Timezone | null; boundaryHour?: number } = {},
): NightOf {
  const { tz, boundaryHour = DEFAULT_DAY_BOUNDARY_HOUR } = options;
  const parts = localParts(ms, zone(tz));
  const key = dateKey(parts.year, parts.month, parts.day);
  return parts.hour < boundaryHour ? shiftNightOf(key, -1) : key;
}

/**
 * A `night_of` as a human would say it.
 *
 * ```
 * nightLabel('2026-08-10')  // "Tonight"     (if that is the current night)
 * nightLabel('2026-08-09')  // "Last night"
 * nightLabel('2026-08-08')  // "Fri 8 Aug"
 * nightLabel('2025-11-02')  // "Sun 2 Nov 2025"
 * ```
 */
export function nightLabel(
  night: NightOf | null | undefined,
  options: { now?: EpochMs; tz?: Timezone | null; boundaryHour?: number; locale?: string } = {},
): string {
  const parsed = parseNightOf(night);
  if (!night || !parsed) return EM_DASH;

  const { now = Date.now(), tz, boundaryHour, locale } = options;
  const current = nightOf(now, { tz, boundaryHour });
  if (night === current) return 'Tonight';
  if (night === shiftNightOf(current, -1)) return 'Last night';

  const thisYear = parseNightOf(current)?.year;
  return dayLabelFromParts(
    { year: parsed.year, month: parsed.month, day: parsed.day, hour: 12, minute: 0, second: 0 },
    { year: parsed.year !== thisYear, locale },
  );
}

/** Longer form for a page heading: "Night of Fri 8 Aug 2025". */
export function nightHeading(
  night: NightOf | null | undefined,
  options: { now?: EpochMs; tz?: Timezone | null; boundaryHour?: number } = {},
): string {
  const label = nightLabel(night, options);
  if (label === EM_DASH) return EM_DASH;
  if (label === 'Tonight' || label === 'Last night') return label;
  return `Night of ${label}`;
}

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();

function rtf(style: Intl.RelativeTimeFormatStyle, locale?: string): Intl.RelativeTimeFormat {
  const key = `${locale ?? ''}|${style}`;
  let formatter = rtfCache.get(key);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale ?? undefined, { numeric: 'auto', style });
    rtfCache.set(key, formatter);
  }
  return formatter;
}

/**
 * "just now", "4 min ago", "in 2 hours". Anything inside `nowWithinMs`
 * (default 45 s) reads as "just now" rather than flickering second by second.
 */
export function formatRelative(
  ms: EpochMs | null | undefined,
  options: {
    now?: EpochMs;
    style?: Intl.RelativeTimeFormatStyle;
    locale?: string;
    nowWithinMs?: number;
  } = {},
): string {
  if (isMissing(ms)) return EM_DASH;
  const { now = Date.now(), style = 'narrow', locale, nowWithinMs = 45_000 } = options;
  const delta = ms - now;
  if (Math.abs(delta) < nowWithinMs) return 'just now';

  for (const entry of RELATIVE_UNITS) {
    const [unit, size] = entry;
    if (Math.abs(delta) >= size) {
      return rtf(style, locale).format(Math.round(delta / size), unit);
    }
  }
  return 'just now';
}

/** "for 1h 12m" — how long the current state has been running. */
export function formatSince(
  sinceMs: EpochMs | null | undefined,
  options: { now?: EpochMs } = {},
): string {
  if (isMissing(sinceMs)) return EM_DASH;
  const now = options.now ?? Date.now();
  return formatDuration(Math.max(0, now - sinceMs) / 60_000);
}

// ---------------------------------------------------------------------------
// Numbers, levels and units
// ---------------------------------------------------------------------------

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const nfCache = new Map<string, Intl.NumberFormat>();

function nf(options: Intl.NumberFormatOptions, locale?: string): Intl.NumberFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = nfCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale ?? undefined, options);
    nfCache.set(key, formatter);
  }
  return formatter;
}

/** A plain number with sensible digits, or an em dash. */
export function formatNumber(
  value: number | null | undefined,
  options: { digits?: number; maxDigits?: number; locale?: string } = {},
): string {
  if (isMissing(value)) return EM_DASH;
  const { digits, maxDigits, locale } = options;
  const text = nf(
    digits === undefined
      ? { maximumFractionDigits: maxDigits ?? 1 }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits },
    locale,
  ).format(value);
  // Most locales emit U+002D; swap in a true minus so a negative number lines
  // up with the hand-built ones elsewhere in this module.
  return text.replace(/^-/, MINUS);
}

/** An integer count: "3", "0", "—" for null. */
export function formatCount(value: number | null | undefined): string {
  if (isMissing(value)) return EM_DASH;
  return String(Math.round(value));
}

/** "+3", "−3", "±0" — for deltas against a previous window. */
export function formatDelta(
  value: number | null | undefined,
  options: { digits?: number; unit?: string } = {},
): string {
  if (isMissing(value)) return EM_DASH;
  const { digits = 0, unit = '' } = options;
  const magnitude = formatNumber(Math.abs(value), { digits });
  const sign = value > 0 ? '+' : value < 0 ? MINUS : '±';
  return `${sign}${magnitude}${unit}`;
}

/** A delta expressed in minutes: "+18m", "−4m". */
export function formatDeltaDuration(value: number | null | undefined): string {
  if (isMissing(value)) return EM_DASH;
  if (Math.round(value) === 0) return '±0m';
  const sign = value > 0 ? '+' : MINUS;
  return sign + formatDuration(Math.abs(value));
}

/**
 * dBFS: full-scale digital audio, so always negative. "−54.2 dBFS".
 * Pass `{ short: true }` for "−54.2 dB" in tight spaces.
 */
export function formatDbfs(
  value: number | null | undefined,
  options: { digits?: number; short?: boolean } = {},
): string {
  if (isMissing(value)) return EM_DASH;
  const { digits = 1, short = false } = options;
  const magnitude = formatNumber(Math.abs(value), { digits });
  const sign = value < 0 ? MINUS : '';
  return `${sign}${magnitude}${NNBSP}${short ? 'dB' : 'dBFS'}`;
}

/** A difference in decibels, which may legitimately be positive: "+3.8 dB". */
export function formatDb(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return EM_DASH;
  const sign = value > 0 ? '+' : value < 0 ? MINUS : '';
  return `${sign}${formatNumber(Math.abs(value), { digits })}${NNBSP}dB`;
}

/**
 * A 0..1 fraction as a percentage: `formatPercent(0.871)` -> "87%".
 * Use `{ scale: 100 }` for a value that already arrives as 0..100.
 */
export function formatPercent(
  value: number | null | undefined,
  options: { digits?: number; scale?: 1 | 100 } = {},
): string {
  if (isMissing(value)) return EM_DASH;
  const { digits = 0, scale = 1 } = options;
  const pct = scale === 100 ? value : value * 100;
  return `${formatNumber(pct, { digits })}%`;
}

/** The 0..100 quality score, shown without a unit. */
export function formatScore(value: number | null | undefined): string {
  if (isMissing(value)) return EM_DASH;
  return String(Math.round(value));
}

/** "20.8 °C" */
export function formatTemperature(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return EM_DASH;
  return `${formatNumber(value, { digits })}${NNBSP}°C`;
}

/** "47%" — humidity arrives as 0..100, not 0..1. */
export function formatHumidity(value: number | null | undefined, digits = 0): string {
  if (isMissing(value)) return EM_DASH;
  return `${formatNumber(value, { digits })}%`;
}

/** Motion score, 0..1, rendered as a percentage of frame change. */
export function formatMotion(value: number | null | undefined): string {
  if (isMissing(value)) return EM_DASH;
  if (value > 0 && value < 0.001) return '<0.1%';
  return formatPercent(value, { digits: 1 });
}

/** A p- or q-value: "0.003", "<0.001", "0.42". */
export function formatPValue(value: number | null | undefined): string {
  if (isMissing(value)) return EM_DASH;
  if (value < 0.001) return '<0.001';
  if (value < 0.01) return formatNumber(value, { digits: 3 });
  return formatNumber(value, { digits: 2 });
}

/** "1.2 MB". Base-10 units, because that is what disks are sold in. */
export function formatBytes(value: number | null | undefined, digits = 1): string {
  if (isMissing(value)) return EM_DASH;
  const units = ['B', 'kB', 'MB', 'GB', 'TB'] as const;
  let magnitude = Math.abs(value);
  let index = 0;
  while (magnitude >= 1000 && index < units.length - 1) {
    magnitude /= 1000;
    index += 1;
  }
  const unit = units[index] ?? 'B';
  const sign = value < 0 ? MINUS : '';
  return `${sign}${formatNumber(magnitude, { digits: index === 0 ? 0 : digits })}${NNBSP}${unit}`;
}

/** "[−16.2, −5.1]" for a confidence interval. */
export function formatInterval(
  interval: readonly [number, number] | null | undefined,
  format: (value: number) => string = (value) => formatNumber(value, { digits: 1 }),
): string {
  if (!interval) return EM_DASH;
  const [low, high] = interval;
  if (isMissing(low) || isMissing(high)) return EM_DASH;
  return `[${format(low)}, ${format(high)}]`;
}

/** Naive English pluralisation, adequate for "hour"/"night"/"awakening". */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return Math.abs(count) === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** "3 nights", "1 night", "no nights". */
export function formatCountOf(
  count: number | null | undefined,
  singular: string,
  pluralForm?: string,
): string {
  if (isMissing(count)) return EM_DASH;
  const rounded = Math.round(count);
  if (rounded === 0) return `no ${pluralForm ?? `${singular}s`}`;
  return `${rounded} ${plural(rounded, singular, pluralForm)}`;
}

// ---------------------------------------------------------------------------
// Vocabulary labels
// ---------------------------------------------------------------------------

const SLEEP_STATE_LABELS: Record<SleepState, string> = {
  asleep: 'Asleep',
  restless: 'Restless',
  settling: 'Settling',
  awake: 'Awake',
  absent: 'Out of room',
  unknown: 'Unknown',
};

/** Human label for a sleep state. State is never conveyed by colour alone. */
export function sleepStateLabel(state: SleepState | null | undefined): string {
  if (!state) return SLEEP_STATE_LABELS.unknown;
  return SLEEP_STATE_LABELS[state] ?? titleCase(state);
}

const SEVERITY_LABELS: Record<Severity, string> = {
  info: 'Info',
  notice: 'Notice',
  alert: 'Alert',
};

export function severityLabel(severity: Severity | null | undefined): string {
  if (!severity) return EM_DASH;
  return SEVERITY_LABELS[severity] ?? titleCase(severity);
}

const TAG_CATEGORY_LABELS: Record<TagCategory, string> = {
  food: 'Food',
  screen: 'Screen',
  activity: 'Activity',
  environment: 'Environment',
  routine: 'Routine',
  health: 'Health',
  care: 'Care',
  other: 'Other',
};

export function tagCategoryLabel(category: TagCategory | null | undefined): string {
  if (!category) return TAG_CATEGORY_LABELS.other;
  return TAG_CATEGORY_LABELS[category] ?? titleCase(category);
}

/**
 * Human label for an event label. Falls back to title-casing the slug, so a
 * label added by a newer service still reads sensibly.
 */
const EVENT_LABEL_TEXT: Record<string, string> = {
  cry: 'Cry',
  fuss: 'Fussing',
  whimper: 'Whimper',
  scream: 'Scream',
  talk: 'Talking',
  cough: 'Cough',
  sneeze: 'Sneeze',
  snore: 'Snoring',
  laugh: 'Laughing',
  door: 'Door',
  noise: 'Noise',
  motion: 'Movement',
  restless: 'Restless',
  still: 'Still',
  bedtime: 'Bedtime',
  sleep_onset: 'Fell asleep',
  awakening: 'Woke up',
  back_to_sleep: 'Back to sleep',
  final_wake: 'Final wake',
  out_of_bed: 'Out of bed',
  returned_to_bed: 'Back to bed',
  temp_high: 'Too warm',
  temp_low: 'Too cool',
  humidity_high: 'Humid',
  humidity_low: 'Dry',
  started: 'Monitor started',
  stopped: 'Monitor stopped',
  camera_error: 'Camera error',
  mic_error: 'Microphone error',
  sensor_error: 'Sensor error',
  hksv_recording: 'HomeKit recording',
  checked_in: 'Checked in',
  fed: 'Fed',
  diaper: 'Nappy change',
  medicine: 'Medicine',
  note: 'Note',
  unknown: 'Unknown',
};

export function eventLabelText(label: string | null | undefined): string {
  if (!label) return 'Not an event';
  return EVENT_LABEL_TEXT[label] ?? titleCase(label);
}

/** "dessert-before-bed" / "sleep_onset" -> "Dessert before bed". */
export function titleCase(value: string): string {
  const spaced = value.replace(/[-_]+/g, ' ').trim();
  if (!spaced) return value;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "Dessert Before Bedtime" -> "dessert-before-bedtime". */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
