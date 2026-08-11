/**
 * Outcome metrics, and how to say them out loud.
 *
 * Every number on this page is a difference in some metric's own unit, and the
 * unit is the whole meaning: "−18" is nonsense, "−18 min" is a fact. A
 * {@link MetricSpec} carries the four things the analytics views need in order
 * to render an honest sentence:
 *
 *   - how to print a level      ("9h 51m")
 *   - how to print a difference ("−18 min")
 *   - how to print a bare CI bound, unit hoisted out ("−41")
 *   - the words for a move down and a move up ("less total sleep")
 *
 * The wording matters as much as the arithmetic. Every phrase here is
 * descriptive — "less total sleep", never "worse sleep" and never anything
 * that implies the tag did it. {@link findCausalLanguage} in `factorModel.ts`
 * checks these strings at startup in dev.
 */

import {
  EM_DASH,
  formatCount,
  formatDuration,
  formatMinuteOfDay,
  formatNumber,
  formatPercent,
  formatScore,
  titleCase,
} from '../../lib/format';

/** U+2212, which lines up under a digit; a hyphen does not. */
const MINUS = '−';

export interface MetricSpec {
  /** The `metric=` query value. */
  key: string;
  /** Menu label: "Total sleep". */
  label: string;
  /** Noun inside a sentence: "total sleep". */
  noun: string;
  /** Unit printed after a difference: "min", "pts", "pp". May be empty. */
  unit: string;
  /** Which direction a parent would rather the number moved. */
  better: 'higher' | 'lower';
  /** A level, in full: "9h 51m", "87%", "72". */
  formatValue: (value: number | null | undefined) => string;
  /** A signed difference with its unit: "−18 min". */
  formatDiff: (value: number | null | undefined) => string;
  /** A signed difference with no unit, for a CI's two ends: "−41". */
  formatBound: (value: number | null | undefined) => string;
  /** An unsigned difference with its unit: "18 min". */
  formatMagnitude: (value: number | null | undefined) => string;
  /** Sentence fragment for a move down / up: "less total sleep". */
  phrase: (direction: 'down' | 'up') => string;
}

interface SpecInput {
  key: string;
  label: string;
  noun: string;
  unit: string;
  better: 'higher' | 'lower';
  /** Decimal places on a difference. Default 0. */
  digits?: number;
  /** Multiplier applied to a difference before printing. Efficiency: 100. */
  diffScale?: number;
  down: string;
  up: string;
  formatValue: (value: number | null | undefined) => string;
}

function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

function signedNumber(value: number, digits: number): string {
  // Round first, so a value of −0.4 at zero digits prints "±0" rather than
  // "−0" — a minus sign in front of nothing reads as a real decrease.
  const rounded = Number(value.toFixed(digits));
  const sign = rounded > 0 ? '+' : rounded < 0 ? MINUS : '±';
  return `${sign}${formatNumber(Math.abs(rounded), { digits })}`;
}

function makeSpec(input: SpecInput): MetricSpec {
  const digits = input.digits ?? 0;
  const scale = input.diffScale ?? 1;
  const suffix = input.unit ? ` ${input.unit}` : '';

  return {
    key: input.key,
    label: input.label,
    noun: input.noun,
    unit: input.unit,
    better: input.better,
    formatValue: input.formatValue,
    formatBound: (value) => (isMissing(value) ? EM_DASH : signedNumber(value * scale, digits)),
    formatDiff: (value) =>
      isMissing(value) ? EM_DASH : `${signedNumber(value * scale, digits)}${suffix}`,
    formatMagnitude: (value) =>
      isMissing(value)
        ? EM_DASH
        : `${formatNumber(Math.abs(Number((value * scale).toFixed(digits))), { digits })}${suffix}`,
    phrase: (direction) => (direction === 'down' ? input.down : input.up),
  };
}

/**
 * The metrics offered as the outcome of the factor analysis. Anything numeric
 * on a night rollup could go here; these are the ones a parent has a question
 * about.
 */
export const METRIC_SPECS: readonly MetricSpec[] = [
  makeSpec({
    key: 'quality_score',
    label: 'Night score',
    noun: 'night score',
    unit: 'pts',
    better: 'higher',
    digits: 1,
    down: 'a lower night score',
    up: 'a higher night score',
    formatValue: formatScore,
  }),
  makeSpec({
    key: 'tst_min',
    label: 'Total sleep',
    noun: 'total sleep',
    unit: 'min',
    better: 'higher',
    down: 'less total sleep',
    up: 'more total sleep',
    formatValue: (value) => formatDuration(value),
  }),
  makeSpec({
    key: 'sleep_efficiency',
    label: 'Sleep efficiency',
    noun: 'sleep efficiency',
    unit: 'pp',
    better: 'higher',
    digits: 1,
    diffScale: 100,
    down: 'lower sleep efficiency',
    up: 'higher sleep efficiency',
    formatValue: (value) => formatPercent(value),
  }),
  makeSpec({
    key: 'waso_min',
    label: 'Awake overnight',
    noun: 'time awake overnight',
    unit: 'min',
    better: 'lower',
    down: 'less time awake overnight',
    up: 'more time awake overnight',
    formatValue: (value) => formatDuration(value),
  }),
  makeSpec({
    key: 'sol_min',
    label: 'Time to fall asleep',
    noun: 'time to fall asleep',
    unit: 'min',
    better: 'lower',
    down: 'less time to fall asleep',
    up: 'more time to fall asleep',
    formatValue: (value) => formatDuration(value),
  }),
  makeSpec({
    key: 'awakenings',
    label: 'Awakenings',
    noun: 'awakenings',
    unit: 'wakes',
    better: 'lower',
    digits: 1,
    down: 'fewer awakenings',
    up: 'more awakenings',
    formatValue: formatCount,
  }),
  makeSpec({
    key: 'longest_bout_min',
    label: 'Longest stretch',
    noun: 'the longest unbroken stretch',
    unit: 'min',
    better: 'higher',
    down: 'a shorter longest stretch',
    up: 'a longer longest stretch',
    formatValue: (value) => formatDuration(value),
  }),
];

const BY_KEY = new Map<string, MetricSpec>(METRIC_SPECS.map((spec) => [spec.key, spec]));

/**
 * Sleep midpoint. Kept out of {@link METRIC_SPECS} because it is a clock time
 * rather than a quantity, so "more" and "less" are the wrong words for it —
 * it is charted, never used as a factor outcome.
 */
export const MIDPOINT_SPEC: MetricSpec = makeSpec({
  key: 'midpoint_min',
  label: 'Sleep midpoint',
  noun: 'sleep midpoint',
  unit: 'min',
  better: 'higher',
  down: 'an earlier midpoint',
  up: 'a later midpoint',
  formatValue: (value) => formatMinuteOfDay(value),
});

/**
 * The spec for a metric key. An unknown key — a newer service, a hand-edited
 * URL — degrades to a generic numeric spec rather than throwing.
 */
export function metricSpec(key: string | null | undefined): MetricSpec {
  if (!key) return METRIC_SPECS[0] as MetricSpec;
  const known = BY_KEY.get(key);
  if (known) return known;
  const noun = titleCase(key).toLowerCase();
  return makeSpec({
    key,
    label: titleCase(key),
    noun,
    unit: '',
    better: 'higher',
    digits: 1,
    down: `a lower ${noun}`,
    up: `a higher ${noun}`,
    formatValue: (value) => formatNumber(value, { maxDigits: 1 }),
  });
}

export function isKnownMetric(key: string | null | undefined): boolean {
  return Boolean(key && BY_KEY.has(key));
}

/** Options for the outcome `<Select>`. */
export const METRIC_OPTIONS = METRIC_SPECS.map((spec) => ({ value: spec.key, label: spec.label }));
