/**
 * Minimal scale helpers for the hand-written SVG charts.
 *
 * This is deliberately not d3. The charts here need a linear map, a time map,
 * and tick generation; that is about a hundred lines, which is smaller than
 * the smallest useful subset of d3 and never fights us over margins,
 * transitions or DOM ownership.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefCallback } from 'react';

export type Domain = readonly [number, number];
export type Range = readonly [number, number];

export interface Scale {
  /** Map a domain value to a pixel position. */
  (value: number): number;
  /** Map a pixel position back to a domain value. */
  invert(pixels: number): number;
  readonly domain: Domain;
  readonly range: Range;
  /** Roughly `count` round numbers spanning the domain. */
  ticks(count?: number): number[];
  /** Pixels per domain unit. Negative for an inverted range (SVG y axes). */
  readonly step: number;
}

function makeScale(
  domain: Domain,
  range: Range,
  tickFn: (count: number) => number[],
  clamp = false,
): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  // A zero-width domain would divide by zero; pin everything to the range
  // start instead, which draws a flat line rather than a NaN-filled path.
  const span = d1 - d0;
  const factor = span === 0 ? 0 : (r1 - r0) / span;
  const low = Math.min(r0, r1);
  const high = Math.max(r0, r1);

  const map = (value: number): number => {
    const pixels = r0 + (value - d0) * factor;
    return clamp ? Math.min(high, Math.max(low, pixels)) : pixels;
  };

  return Object.assign(map, {
    invert: (pixels: number): number => (factor === 0 ? d0 : d0 + (pixels - r0) / factor),
    domain,
    range,
    ticks: (count = 5) => tickFn(count),
    step: factor,
  }) satisfies Scale;
}

export interface LinearScaleOptions {
  domain: Domain;
  range: Range;
  /** Keep outputs inside `range` for values outside `domain`. Default false. */
  clamp?: boolean;
  /** Round the domain outwards to tick boundaries first. Default false. */
  nice?: boolean;
}

/**
 * ```ts
 * const y = linearScale({ domain: [0, 100], range: [height, 0] });
 * y(50); // height / 2
 * ```
 */
export function linearScale(options: LinearScaleOptions): Scale {
  const { range, clamp = false, nice = false } = options;
  const domain = nice ? niceDomain(options.domain) : options.domain;
  return makeScale(domain, range, (count) => niceTicks(domain[0], domain[1], count), clamp);
}

/**
 * A linear scale over epoch milliseconds whose ticks land on round wall-clock
 * boundaries (every 15 min, every hour, every 3 hours…) in the given timezone
 * rather than on round millisecond counts.
 */
export function timeScale(options: {
  domain: Domain;
  range: Range;
  /** IANA zone the ticks should be round in. Defaults to the browser's. */
  timeZone?: string;
}): Scale {
  const { domain, range, timeZone } = options;
  return makeScale(domain, range, (count) => timeTicks(domain[0], domain[1], count, timeZone));
}

/**
 * A band scale for categorical axes (day of week, tag names).
 * Returns the left edge of each band; `bandwidth` is the drawable width.
 */
export interface BandScale {
  (index: number): number;
  readonly bandwidth: number;
  readonly count: number;
  readonly range: Range;
}

export function bandScale(options: {
  count: number;
  range: Range;
  /** Fraction of each slot left empty, 0..1. Default 0.2. */
  padding?: number;
}): BandScale {
  const { count, range, padding = 0.2 } = options;
  const [r0, r1] = range;
  const total = r1 - r0;
  const slot = count > 0 ? total / count : 0;
  const bandwidth = Math.max(0, slot * (1 - padding));
  const offset = (slot - bandwidth) / 2;

  return Object.assign((index: number) => r0 + slot * index + offset, {
    bandwidth,
    count,
    range,
  }) satisfies BandScale;
}

// ---------------------------------------------------------------------------
// Ticks
// ---------------------------------------------------------------------------

/**
 * The 1-2-5 ladder, the only sequence that reads as "round" at every scale.
 *
 * The thresholds are geometric means (√50, √10, √2) rather than the obvious
 * 5/2/1: they pick whichever rung is closest in *ratio* to the ideal spacing,
 * which is what stops `[0, 100]` at five ticks from snapping to a step of 50
 * and giving you three.
 */
const SQRT50 = Math.sqrt(50);
const SQRT10 = Math.sqrt(10);
const SQRT2 = Math.sqrt(2);

function tickStep(span: number, count: number): number {
  if (span === 0 || !Number.isFinite(span)) return 1;
  const rough = Math.abs(span) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const multiplier =
    normalised >= SQRT50 ? 10 : normalised >= SQRT10 ? 5 : normalised >= SQRT2 ? 2 : 1;
  return multiplier * magnitude;
}

/**
 * Round numbers covering `[min, max]`, inclusive of any that land on the
 * bounds. Handles a reversed or degenerate range without producing NaN.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const step = tickStep(high - low, count);
  if (step <= 0) return [low];

  const first = Math.ceil(low / step) * step;
  const ticks: number[] = [];
  // Guard against a pathological step producing an unbounded loop.
  for (let value = first, guard = 0; value <= high + step * 1e-9 && guard < 1000; guard += 1) {
    // Re-round each tick: repeated addition of e.g. 0.1 drifts.
    ticks.push(round(value, step));
    value = first + step * (guard + 1);
  }
  return ticks;
}

function round(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(Math.abs(step))) + 1);
  const factor = 10 ** Math.min(12, decimals);
  return Math.round(value * factor) / factor;
}

/** Expand a domain outwards to the nearest round numbers. */
export function niceDomain(domain: Domain, count = 5): Domain {
  const [d0, d1] = domain;
  if (!Number.isFinite(d0) || !Number.isFinite(d1) || d0 === d1) return domain;
  const reversed = d0 > d1;
  const low = reversed ? d1 : d0;
  const high = reversed ? d0 : d1;
  const step = tickStep(high - low, count);
  const niceLow = Math.floor(low / step) * step;
  const niceHigh = Math.ceil(high / step) * step;
  return reversed ? [niceHigh, niceLow] : [niceLow, niceHigh];
}

/** The domain of an array of values, ignoring nulls. Null if there are none. */
export function extent(
  values: readonly (number | null | undefined)[],
  options: { pad?: number; includeZero?: boolean } = {},
): Domain | null {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (low === Number.POSITIVE_INFINITY) return null;

  if (options.includeZero) {
    low = Math.min(low, 0);
    high = Math.max(high, 0);
  }
  if (low === high) {
    // A flat series still needs a drawable band.
    const nudge = Math.abs(low) > 0 ? Math.abs(low) * 0.1 : 1;
    return [low - nudge, high + nudge];
  }
  if (options.pad) {
    const padding = (high - low) * options.pad;
    return [low - padding, high + padding];
  }
  return [low, high];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Intervals a clock reads as round. */
const TIME_STEPS: readonly number[] = [
  MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
];

const offsetCache = new Map<string, Intl.DateTimeFormat>();

/**
 * The UTC offset in force at `ms` in `timeZone`, in milliseconds.
 *
 * Computed by formatting the instant as wall-clock fields and diffing against
 * the instant itself. Ticks are then aligned in "local milliseconds", which is
 * what makes an hourly tick land on :00 rather than on :00 plus whatever the
 * zone's offset happens to be. Across a DST change the offset shifts mid-axis
 * by design; a single offset taken at the domain start is close enough for a
 * one-night chart and keeps this cheap.
 */
export function timezoneOffsetMs(ms: number, timeZone?: string): number {
  if (!timeZone) return -new Date(ms).getTimezoneOffset() * MINUTE;
  let formatter = offsetCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    offsetCache.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(ms));
  const read = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  // Millisecond component is dropped by the formatter; add it back.
  return asUtc - (ms - (ms % 1000));
}

/**
 * Tick instants that fall on round wall-clock boundaries between `min` and
 * `max` (epoch ms).
 */
export function timeTicks(min: number, max: number, count = 6, timeZone?: string): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const span = high - low;

  const target = span / Math.max(1, count);
  let step = TIME_STEPS[TIME_STEPS.length - 1] ?? HOUR;
  for (const candidate of TIME_STEPS) {
    if (candidate >= target) {
      step = candidate;
      break;
    }
  }
  // Beyond a day, fall back to whole days rather than inventing months.
  if (target > DAY) step = Math.ceil(target / DAY) * DAY;

  const offset = timezoneOffsetMs(low, timeZone);
  const firstLocal = Math.ceil((low + offset) / step) * step;

  const ticks: number[] = [];
  for (let local = firstLocal; local - offset <= high && ticks.length < 500; local += step) {
    ticks.push(local - offset);
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Responsive SVG
// ---------------------------------------------------------------------------

export interface Size {
  width: number;
  height: number;
}

/**
 * Measure an element so an SVG can be drawn at its real pixel size instead of
 * guessing with `viewBox` gymnastics.
 *
 * ```tsx
 * const [ref, { width }] = useResizeObserver<HTMLDivElement>();
 * return <div ref={ref}>{width > 0 && <Chart width={width} />}</div>;
 * ```
 *
 * The ref is a callback ref, so it fires on mount, on unmount, and when the
 * node is swapped — none of which a plain `useRef` + `useEffect` catches
 * reliably. Width and height are rounded to whole pixels so a sub-pixel
 * reflow does not trigger a render loop.
 */
export function useResizeObserver<T extends Element = HTMLDivElement>(
  initial: Size = { width: 0, height: 0 },
): [RefCallback<T>, Size] {
  const [size, setSize] = useState<Size>(initial);
  const observerRef = useRef<ResizeObserver | null>(null);
  const nodeRef = useRef<T | null>(null);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  const ref = useCallback<RefCallback<T>>((node) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    nodeRef.current = node;
    if (!node) return;

    if (typeof ResizeObserver === 'undefined') {
      const rect = node.getBoundingClientRect();
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const box = entry.contentRect;
      const next = { width: Math.round(box.width), height: Math.round(box.height) };
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    });
    observer.observe(node);
    observerRef.current = observer;

    const rect = node.getBoundingClientRect();
    setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
  }, []);

  return [ref, size];
}

/** Standard chart margins. Charts may override any side. */
export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_MARGIN: Margin = { top: 8, right: 8, bottom: 22, left: 36 };

/** Inner plotting box for a chart of a given outer size. */
export function plotArea(
  size: Size,
  margin: Partial<Margin> = {},
): { x: number; y: number; width: number; height: number; margin: Margin } {
  const merged: Margin = { ...DEFAULT_MARGIN, ...margin };
  return {
    x: merged.left,
    y: merged.top,
    width: Math.max(0, size.width - merged.left - merged.right),
    height: Math.max(0, size.height - merged.top - merged.bottom),
    margin: merged,
  };
}

/**
 * An SVG path `d` for a polyline that breaks at nulls, so a gap in the
 * telemetry renders as a gap rather than a straight line across the outage.
 */
export function linePath(
  points: readonly { x: number; y: number | null }[],
  options: { round?: number } = {},
): string {
  const digits = options.round ?? 2;
  const fix = (value: number): string => value.toFixed(digits);
  let path = '';
  let penDown = false;
  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y) || !Number.isFinite(point.x)) {
      penDown = false;
      continue;
    }
    path += `${penDown ? 'L' : 'M'}${fix(point.x)} ${fix(point.y)}`;
    penDown = true;
  }
  return path;
}

/** Convenience for `useMemo`-ing a plot area against a measured size. */
export function usePlotArea(size: Size, margin?: Partial<Margin>) {
  const key = JSON.stringify(margin ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => plotArea(size, margin), [size.width, size.height, key]);
}
