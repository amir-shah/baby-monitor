/**
 * Pure derivations for the night detail view.
 *
 * Everything here is a function of the `NightDetail` payload and nothing else:
 * no React, no DOM, no fetching. That keeps the timeline component about
 * drawing and the page about wiring, and it means the awkward parts (what
 * counts as an awakening, which run of segments is "the longest stretch",
 * why a quality score is missing) can be reasoned about on their own.
 *
 * Where the API already computes a number we render *its* number — `awakenings`
 * and `longest_bout_min` come from the rollup. The derivations below exist
 * because the chart needs the *positions* those numbers were computed from,
 * which the rollup does not carry.
 */

import { countsAsSleep } from './types';
import type {
  EpochMs,
  Night,
  NightDetail,
  ScoreComponents,
  SeriesPoint,
  SleepSegment,
  SleepState,
  Timezone,
} from './types';
import { formatClock, formatDuration, formatPercent, sleepStateLabel } from './format';

// ---------------------------------------------------------------------------
// The time window the chart spans
// ---------------------------------------------------------------------------

export interface TimeWindow {
  start: EpochMs;
  end: EpochMs;
}

const MINUTE_MS = 60_000;

/**
 * The x domain: bedtime (or the first thing we know about) to out-of-bed (or
 * the last). Padded by a few minutes at each end so a marker sitting exactly
 * on an anchor is not clipped in half by the plot edge.
 *
 * Returns null when the night is so empty there is nothing to draw — an
 * in-progress night with no samples yet, or a rollup for a night the sensors
 * missed entirely.
 */
export function timelineWindow(night: NightDetail, padMinutes = 5): TimeWindow | null {
  const candidates: EpochMs[] = [];
  const push = (value: EpochMs | null | undefined): void => {
    if (typeof value === 'number' && Number.isFinite(value)) candidates.push(value);
  };

  push(night.bedtime_ms);
  push(night.sleep_onset_ms);
  push(night.final_wake_ms);
  push(night.out_of_bed_ms);
  for (const segment of night.segments) {
    push(segment.start_ms);
    push(segment.end_ms);
  }
  for (const event of night.events) {
    push(event.start_ms);
    push(event.end_ms);
  }
  const series = night.series;
  push(series[0]?.ts_ms);
  push(series[series.length - 1]?.ts_ms);

  if (candidates.length === 0) return null;

  let start = candidates[0] as EpochMs;
  let end = start;
  for (const value of candidates) {
    if (value < start) start = value;
    if (value > end) end = value;
  }
  // A single instant would be a zero-width domain; give it an hour to live in.
  if (end - start < 10 * MINUTE_MS) end = start + 60 * MINUTE_MS;

  const pad = padMinutes * MINUTE_MS;
  return { start: start - pad, end: end + pad };
}

// ---------------------------------------------------------------------------
// Runs and awakenings
// ---------------------------------------------------------------------------

export interface Span {
  start_ms: EpochMs;
  end_ms: EpochMs;
  /** Length in minutes. */
  minutes: number;
}

export interface Awakening extends Span {
  /** `awake` or `absent` — the two ways the child stops being in bed asleep. */
  state: SleepState;
  /** 1-based, in clock order, so a tooltip can say "3rd waking". */
  index: number;
}

function minutesBetween(start: EpochMs, end: EpochMs): number {
  return Math.max(0, end - start) / MINUTE_MS;
}

function sortedSegments(segments: readonly SleepSegment[]): SleepSegment[] {
  return [...segments].sort((a, b) => a.start_ms - b.start_ms);
}

/**
 * The wakings drawn as ticks on the hypnogram.
 *
 * A waking is an `awake` or `absent` segment that begins after sleep onset and
 * before the final wake — the same window WASO is measured over, so the ticks
 * and the WASO figure in the header describe the same events. Segments shorter
 * than `minMinutes` are dropped, mirroring `sleep.awakening_min_min` (default
 * 5): brief surfacing is scored as restlessness, not as waking up, and the
 * chart should not disagree with the tally beside it.
 */
export function deriveAwakenings(
  segments: readonly SleepSegment[],
  options: { sleepOnsetMs?: EpochMs | null; finalWakeMs?: EpochMs | null; minMinutes?: number } = {},
): Awakening[] {
  const { sleepOnsetMs, finalWakeMs, minMinutes = 5 } = options;
  const from = sleepOnsetMs ?? Number.NEGATIVE_INFINITY;
  const to = finalWakeMs ?? Number.POSITIVE_INFINITY;

  const result: Awakening[] = [];
  for (const segment of sortedSegments(segments)) {
    if (segment.state !== 'awake' && segment.state !== 'absent') continue;
    if (segment.start_ms < from || segment.start_ms >= to) continue;
    const minutes = minutesBetween(segment.start_ms, segment.end_ms);
    if (minutes < minMinutes) continue;
    result.push({
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      minutes,
      state: segment.state,
      index: result.length + 1,
    });
  }
  return result;
}

/**
 * Maximal runs of sleep: `asleep` and `restless` back to back, allowing a gap
 * of up to `toleranceMs` between segments so a one-sample hole in the record
 * does not split a five-hour stretch into two.
 */
export function sleepRuns(segments: readonly SleepSegment[], toleranceMs = 60_000): Span[] {
  const runs: Span[] = [];
  let current: { start: EpochMs; end: EpochMs } | null = null;

  for (const segment of sortedSegments(segments)) {
    if (!countsAsSleep(segment.state)) {
      if (current) runs.push(toSpan(current));
      current = null;
      continue;
    }
    if (current && segment.start_ms - current.end <= toleranceMs) {
      current.end = Math.max(current.end, segment.end_ms);
    } else {
      if (current) runs.push(toSpan(current));
      current = { start: segment.start_ms, end: segment.end_ms };
    }
  }
  if (current) runs.push(toSpan(current));
  return runs;
}

function toSpan(run: { start: EpochMs; end: EpochMs }): Span {
  return { start_ms: run.start, end_ms: run.end, minutes: minutesBetween(run.start, run.end) };
}

/** The longest run of sleep, for the highlight on the band. */
export function longestSleepRun(segments: readonly SleepSegment[]): Span | null {
  let best: Span | null = null;
  for (const run of sleepRuns(segments)) {
    if (!best || run.minutes > best.minutes) best = run;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Series lanes
// ---------------------------------------------------------------------------

export interface LaneExtent {
  min: number;
  max: number;
}

/**
 * The dBFS window for the sound lane.
 *
 * Anchored on the noise floor rather than on the data: the interesting thing
 * about a night's audio is how far above the room's own hum it got, and a
 * domain fitted to the data alone makes a silent night look as dramatic as a
 * screaming one. Falls back to a fixed −70…−10 window when there is no floor.
 */
export function soundExtent(points: readonly SeriesPoint[]): LaneExtent {
  let floorSum = 0;
  let floorCount = 0;
  let peak = Number.NEGATIVE_INFINITY;
  let quietest = Number.POSITIVE_INFINITY;

  for (const point of points) {
    if (point.noise_floor_dbfs !== null && Number.isFinite(point.noise_floor_dbfs)) {
      floorSum += point.noise_floor_dbfs;
      floorCount += 1;
    }
    for (const value of [point.sound_dbfs, point.sound_peak_dbfs]) {
      if (value === null || !Number.isFinite(value)) continue;
      if (value > peak) peak = value;
      if (value < quietest) quietest = value;
    }
  }

  const floor = floorCount > 0 ? floorSum / floorCount : null;
  const low = Math.min(floor ?? -70, Number.isFinite(quietest) ? quietest : -70) - 3;
  const high = Math.max(Number.isFinite(peak) ? peak : -10, (floor ?? -70) + 20) + 2;
  return { min: Math.max(-100, low), max: Math.min(0, high) };
}

/** Motion is 0..1 but almost always sits under 0.1, so the lane is fitted. */
export function motionExtent(points: readonly SeriesPoint[]): LaneExtent {
  let peak = 0;
  for (const point of points) {
    if (point.motion !== null && Number.isFinite(point.motion) && point.motion > peak) {
      peak = point.motion;
    }
  }
  // A floor of 0.02 keeps a still night from magnifying sensor noise into a
  // mountain range.
  return { min: 0, max: Math.max(0.02, peak * 1.1) };
}

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

export type NightMetricKey =
  | 'tib_min'
  | 'tst_min'
  | 'sol_min'
  | 'waso_min'
  | 'awakenings'
  | 'longest_bout_min'
  | 'sleep_efficiency'
  | 'midpoint_ms';

export interface MetricDefinition {
  key: NightMetricKey;
  label: string;
  /** The jargon term, shown after the label where one exists. */
  abbreviation?: string;
  /** Plain English, for the info affordance. No clinical hedging. */
  definition: string;
}

/**
 * Every term on the metrics header, explained.
 *
 * These are jargon — "WASO" and "sleep onset latency" mean nothing to a parent
 * who has not read a sleep-medicine paper — so each one carries its definition
 * a tap away rather than assuming the reader will look it up.
 */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    key: 'tib_min',
    label: 'Time in bed',
    abbreviation: 'TIB',
    definition:
      'From being put down for the night to getting up in the morning, whether asleep or not.',
  },
  {
    key: 'tst_min',
    label: 'Total sleep',
    abbreviation: 'TST',
    definition: 'How much of the time in bed was actually spent asleep, added up across the night.',
  },
  {
    key: 'sol_min',
    label: 'Time to fall asleep',
    abbreviation: 'SOL',
    definition:
      'Sleep onset latency: the gap between being put down and first falling asleep. Ten to twenty minutes is typical; under five can mean an overtired child.',
  },
  {
    key: 'waso_min',
    label: 'Awake in the night',
    abbreviation: 'WASO',
    definition:
      'Wake after sleep onset: all the time spent awake between first falling asleep and the final wake, added together.',
  },
  {
    key: 'awakenings',
    label: 'Wakings',
    definition:
      'How many separate times they woke for more than five minutes. Briefer stirring is counted as restlessness instead.',
  },
  {
    key: 'longest_bout_min',
    label: 'Longest stretch',
    definition: 'The longest unbroken run of sleep — usually the number that decides how you feel.',
  },
  {
    key: 'sleep_efficiency',
    label: 'Sleep efficiency',
    definition:
      'Total sleep divided by time in bed. Above 85% is a settled night; a low figure means a lot of the night was spent in bed but awake.',
  },
  {
    key: 'midpoint_ms',
    label: 'Sleep midpoint',
    definition:
      'The clock time exactly halfway through the sleep period. Its consistency night to night matters more than the value itself.',
  },
];

// ---------------------------------------------------------------------------
// Quality score
// ---------------------------------------------------------------------------

export type ScoreBandName = 'Excellent' | 'Good' | 'Fair' | 'Poor';

export interface ScoreBand {
  name: ScoreBandName;
  /** Maps onto the Stat/Badge tones. */
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  /** Inclusive lower bound. */
  from: number;
}

export const SCORE_BANDS: readonly ScoreBand[] = [
  { name: 'Excellent', tone: 'good', from: 90 },
  { name: 'Good', tone: 'good', from: 80 },
  { name: 'Fair', tone: 'warn', from: 65 },
  { name: 'Poor', tone: 'bad', from: 0 },
];

/** The word band for a 0..100 score. Never a decimal, never a bare number. */
export function scoreBand(score: number | null | undefined): ScoreBand | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  const rounded = Math.round(score);
  for (const band of SCORE_BANDS) {
    if (rounded >= band.from) return band;
  }
  return SCORE_BANDS[SCORE_BANDS.length - 1] ?? null;
}

export const SCORE_COMPONENT_KEYS = [
  'duration',
  'efficiency',
  'continuity',
  'timing',
  'environment',
] as const;

export type ScoreComponentKey = (typeof SCORE_COMPONENT_KEYS)[number];

export interface ScoreComponentView {
  key: ScoreComponentKey;
  label: string;
  definition: string;
  /** 0..100, or null when the component was dropped. */
  score: number | null;
  /** Raw weight from the config, before renormalisation. */
  weight: number;
  /** Share of the *available* weight, 0..1 — what it actually counted for. */
  share: number;
  reason: string | null;
}

const COMPONENT_META: Record<ScoreComponentKey, { label: string; definition: string }> = {
  duration: {
    label: 'Duration',
    definition: 'Total sleep measured against the band that is typical for this age.',
  },
  efficiency: {
    label: 'Efficiency',
    definition: 'How much of the time in bed was spent asleep rather than awake.',
  },
  continuity: {
    label: 'Continuity',
    definition: 'How broken the night was: time awake, number of wakings, longest unbroken stretch.',
  },
  timing: {
    label: 'Timing',
    definition: 'How closely bedtime and the sleep midpoint matched other recent nights.',
  },
  environment: {
    label: 'Environment',
    definition: 'Temperature, humidity and noise in the room during the sleep period.',
  },
};

function readComponent(
  components: ScoreComponents | null | undefined,
  key: ScoreComponentKey,
): { score: number | null; weight: number; reason: string | null } | null {
  const raw = components?.[key];
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as { score?: unknown; weight?: unknown; reason?: unknown };
  const score =
    typeof entry.score === 'number' && Number.isFinite(entry.score) ? entry.score : null;
  const weight = typeof entry.weight === 'number' && Number.isFinite(entry.weight) ? entry.weight : 0;
  const reason = typeof entry.reason === 'string' && entry.reason ? entry.reason : null;
  return { score, weight, reason };
}

/**
 * The four (or five) sub-scores, in a shape the breakdown can render directly.
 *
 * A component with a null score was dropped on this night and the remaining
 * weights renormalised — that is what `share` reports, so the stacked bar adds
 * up to the total rather than to some fraction of it.
 */
export function scoreComponentViews(night: Night): ScoreComponentView[] {
  const present: {
    key: ScoreComponentKey;
    score: number | null;
    weight: number;
    reason: string | null;
  }[] = [];

  for (const key of SCORE_COMPONENT_KEYS) {
    const entry = readComponent(night.score_components, key);
    if (!entry) continue;
    // A zero-weight component is switched off in the config; showing it as a
    // 0% slice would read as a failure rather than as "not measured here".
    if (entry.weight === 0 && entry.score === null) continue;
    present.push({ key, ...entry });
  }

  const available = present.reduce(
    (total, entry) => total + (entry.score === null ? 0 : entry.weight),
    0,
  );

  return present.map((entry) => ({
    key: entry.key,
    label: COMPONENT_META[entry.key].label,
    definition: COMPONENT_META[entry.key].definition,
    score: entry.score,
    weight: entry.weight,
    share: entry.score === null || available <= 0 ? 0 : entry.weight / available,
    reason: entry.reason,
  }));
}

export type ScoreStatus =
  | { kind: 'score'; value: number; band: ScoreBand }
  | { kind: 'unavailable'; title: string; reason: string };

/**
 * Why there is no number, when there is no number.
 *
 * The server always explains itself: whenever `score_night` declines it puts
 * the reason in `score_components.suppressed_reason`, and that string is what
 * this shows. The branches below it are fallbacks for a night whose rollup was
 * never computed at all, and they read only facts the night row states
 * outright — `status`, `excluded`, `coverage` against the configured minimum.
 *
 * What they deliberately do NOT do is re-derive a rule the server owns. An
 * earlier version hardcoded "under 120 days is too young", which was both a
 * duplicate of the AASM band table in `sleep/metrics.py` and off by one against
 * it — the newborn band ends at 121 days. A client that reimplements a
 * threshold will drift from it, and the drift shows up as a night the
 * dashboard calls unscoreable and the analytics happily scores.
 */
export function scoreStatus(
  night: Night,
  options: { minCoverage?: number } = {},
): ScoreStatus {
  const { minCoverage = 0.6 } = options;

  if (night.quality_score !== null && Number.isFinite(night.quality_score)) {
    const band = scoreBand(night.quality_score);
    if (band) return { kind: 'score', value: Math.round(night.quality_score), band };
  }

  const explicit = explicitSuppressionReason(night.score_components);
  if (explicit) return { kind: 'unavailable', title: 'Not scored', reason: explicit };

  if (night.status === 'in_progress') {
    return {
      kind: 'unavailable',
      title: 'Night in progress',
      reason: 'The score is worked out once the night is over.',
    };
  }

  if (night.excluded) {
    return {
      kind: 'unavailable',
      title: 'Excluded',
      reason: night.exclude_reason
        ? `You excluded this night: ${night.exclude_reason}`
        : 'You excluded this night from the analytics.',
    };
  }

  if (night.coverage !== null && night.coverage < minCoverage) {
    return {
      kind: 'unavailable',
      title: 'Not enough coverage',
      reason: `The sensors were only reporting for ${formatPercent(night.coverage)} of this night, below the ${formatPercent(minCoverage)} needed to score it. Anything scored from this little data would be guesswork.`,
    };
  }

  if (night.status === 'partial') {
    return {
      kind: 'unavailable',
      title: 'Partial night',
      reason: 'Too much of this night is missing from the record to score it.',
    };
  }

  return {
    kind: 'unavailable',
    title: 'Not scored',
    reason: 'The monitor could not work out a score for this night.',
  };
}

function explicitSuppressionReason(components: ScoreComponents | null | undefined): string | null {
  if (!components) return null;
  for (const key of ['suppressed_reason', 'reason', 'suppressed']) {
    const value = components[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// The screen-reader summary
// ---------------------------------------------------------------------------

/**
 * A prose description of the whole timeline.
 *
 * A hypnogram is a picture of a shape, and the shape *is* the information. A
 * screen-reader user gets the same information here as a sighted user gets
 * from the band: when the night started and ended, how it was broken up, and
 * where the wakings fell.
 */
export function timelineSummary(night: NightDetail, tz?: Timezone | null): string {
  const clock = (ms: EpochMs | null | undefined): string => formatClock(ms, { tz });
  const parts: string[] = [];

  if (night.bedtime_ms) {
    parts.push(`Put down at ${clock(night.bedtime_ms)}.`);
  }
  if (night.sleep_onset_ms) {
    const sol = night.sol_min === null ? null : formatDuration(night.sol_min);
    parts.push(
      sol
        ? `Asleep at ${clock(night.sleep_onset_ms)}, ${sol} after being put down.`
        : `Asleep at ${clock(night.sleep_onset_ms)}.`,
    );
  }
  if (night.tst_min !== null) {
    parts.push(`${formatDuration(night.tst_min)} of sleep in total.`);
  }

  const awakenings = deriveAwakenings(night.segments, {
    sleepOnsetMs: night.sleep_onset_ms,
    finalWakeMs: night.final_wake_ms,
  });
  if (awakenings.length === 0) {
    parts.push('No wakings of five minutes or more are marked.');
  } else {
    const listed = awakenings
      .slice(0, 8)
      .map((waking) => `${clock(waking.start_ms)} for ${formatDuration(waking.minutes)}`)
      .join('; ');
    // "Marked", not "there were": this counts the ticks drawn on the band,
    // which is a derivation from the segments. The tally in the header is the
    // server's own and is the number to quote.
    parts.push(
      `${awakenings.length} ${awakenings.length === 1 ? 'waking is' : 'wakings are'} marked: ${listed}${
        awakenings.length > 8 ? '; and more' : ''
      }.`,
    );
  }

  const longest = longestSleepRun(night.segments);
  if (longest) {
    parts.push(
      `Longest unbroken stretch ${formatDuration(longest.minutes)}, from ${clock(longest.start_ms)} to ${clock(longest.end_ms)}.`,
    );
  }

  if (night.final_wake_ms) parts.push(`Woke for the day at ${clock(night.final_wake_ms)}.`);
  if (night.out_of_bed_ms) parts.push(`Out of bed at ${clock(night.out_of_bed_ms)}.`);

  if (night.events.length > 0) {
    parts.push(`${night.events.length} events are listed after the chart.`);
  }

  return parts.join(' ');
}

/** "Asleep, 2h 14m, from 21:40" — the alt text for one segment. */
export function describeSegment(segment: SleepSegment, tz?: Timezone | null): string {
  return `${sleepStateLabel(segment.state)}, ${formatDuration(
    minutesBetween(segment.start_ms, segment.end_ms),
  )}, from ${formatClock(segment.start_ms, { tz })} to ${formatClock(segment.end_ms, { tz })}`;
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

export interface AnchorDefinition {
  key: 'bedtime_ms' | 'sleep_onset_ms' | 'final_wake_ms' | 'out_of_bed_ms';
  label: string;
  hint: string;
}

/** The four correctable anchors, in the order they happen. */
export const NIGHT_ANCHORS: readonly AnchorDefinition[] = [
  { key: 'bedtime_ms', label: 'Put down', hint: 'When they went into the cot for the night.' },
  { key: 'sleep_onset_ms', label: 'Fell asleep', hint: 'When they first actually went to sleep.' },
  { key: 'final_wake_ms', label: 'Final wake', hint: 'The last time they woke and stayed awake.' },
  { key: 'out_of_bed_ms', label: 'Out of bed', hint: 'When they were lifted out for the day.' },
];

/**
 * `<input type="datetime-local">` speaks wall-clock strings with no zone, so an
 * epoch has to be rendered into the *child's* local time rather than the
 * browser's — a phone that travelled to another timezone must still show the
 * night as it was lived.
 */
export function toLocalInputValue(ms: EpochMs | null | undefined, tz?: Timezone | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz ?? undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const date = `${read('year')}-${read('month')}-${read('day')}`;
  const time = `${read('hour')}:${read('minute')}`;
  return date && time.length === 5 ? `${date}T${time}` : '';
}

/**
 * The inverse. There is no `Date.parse` that takes an IANA zone, so this
 * guesses UTC, measures how far off the guess lands in the target zone, and
 * corrects — twice, because the first correction can step across a DST
 * boundary and change the offset out from under itself.
 */
export function fromLocalInputValue(value: string, tz?: Timezone | null): EpochMs | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const asUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  if (!tz) {
    // No zone: interpret in the browser's own, which is what a bare
    // `new Date(value)` would have done.
    return new Date(`${value}:00`).getTime() || null;
  }

  let guess = asUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = zoneOffsetMs(guess, tz);
    const corrected = asUtc - offset;
    if (corrected === guess) break;
    guess = corrected;
  }
  return Number.isFinite(guess) ? guess : null;
}

function zoneOffsetMs(ms: EpochMs, tz: Timezone): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  const local = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  return local - (ms - (ms % 1000));
}
