/**
 * Weekly trends: four small multiples, one per headline metric.
 *
 * Weekly rather than nightly on purpose. Night-to-night variation in an
 * infant's sleep is enormous and almost entirely noise; a nightly line invites
 * a reader to explain every spike, and there is nothing to explain. A weekly
 * aggregate with a spread ribbon says the honest thing: here is the middle,
 * here is how wide the week was.
 *
 * The age-appropriate band behind each panel is drawn as a *stepped* region.
 * It has to be: the recommendation moves as the child grows, and a smooth
 * band would imply a precision the guideline does not have. Where the API
 * only knows today's band, the same renderer draws a single step across the
 * window — one code path, no special case.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analytics as analyticsApi } from '../../lib/api';
import { Card, EmptyState, ErrorState, Skeleton } from '../../components';
import {
  EM_DASH,
  formatDuration,
  formatMinuteOfDay,
  formatPercent,
  plural,
} from '../../lib/format';
import { extent, linearScale, niceDomain, timeScale, useResizeObserver } from '../../lib/scales';
import type { Scale } from '../../lib/scales';
import type { TargetBand, TrendPoint, TrendsResponse } from '../../lib/types';
import './WeeklyTrends.css';

const CHART_H = 150;
const MARGIN = { top: 10, right: 10, bottom: 20, left: 44 };

/**
 * Spread fields the contract does not promise. `TrendPoint` documents a value
 * and a rolling median only, so the ribbon is drawn from whichever pair of
 * quartile fields the service happens to send and skipped entirely when it
 * sends none.
 */
interface PointExtras {
  p25?: number | null;
  p75?: number | null;
  q1?: number | null;
  q3?: number | null;
  iqr_low?: number | null;
  iqr_high?: number | null;
  /** Per-bucket target band, when the service tracks it as the child grows. */
  target_low?: number | null;
  target_high?: number | null;
}

interface ResponseExtras {
  target_bands?: readonly {
    from_ms?: number;
    to_ms?: number;
    low?: number | null;
    high?: number | null;
  }[];
}

interface PanelSpec {
  metric: string;
  title: string;
  /** Axis and headline formatter. */
  format: (value: number | null | undefined) => string;
  /** A metric the service may simply not have. Absence is not an error. */
  optional?: boolean;
  hint?: string;
}

const PANELS: readonly PanelSpec[] = [
  { metric: 'tst_min', title: 'Total sleep', format: (value) => formatDuration(value) },
  {
    metric: 'sleep_efficiency',
    title: 'Sleep efficiency',
    format: (value) => formatPercent(value),
    hint: 'Share of time in bed actually asleep.',
  },
  {
    metric: 'waso_min',
    title: 'Awake overnight',
    format: (value) => formatDuration(value),
    hint: 'Time awake between falling asleep and the final wake.',
  },
  {
    metric: 'midpoint_min',
    title: 'Sleep midpoint',
    format: (value) => formatMinuteOfDay(value),
    optional: true,
    hint: 'The clock time halfway through the night.',
  },
];

export interface WeeklyTrendsProps {
  childId: number | undefined;
  days: number;
  /** From `/api/analytics/summary`. Applied to the panel it names. */
  targetBand: TargetBand | null;
}

export function WeeklyTrends({ childId, days, targetBand }: WeeklyTrendsProps) {
  return (
    <Card
      title="Week by week"
      subtitle="Weekly middles with the spread of each week behind them. Night-to-night swings are mostly noise; weeks are where a change shows."
      className="trends-card"
    >
      <div className="trends">
        {PANELS.map((panel) => (
          <TrendPanel
            key={panel.metric}
            panel={panel}
            childId={childId}
            days={days}
            targetBand={targetBand && targetBand.metric === panel.metric ? targetBand : null}
          />
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One panel
// ---------------------------------------------------------------------------

function TrendPanel({
  panel,
  childId,
  days,
  targetBand,
}: {
  panel: PanelSpec;
  childId: number | undefined;
  days: number;
  targetBand: TargetBand | null;
}) {
  const query = useQuery({
    queryKey: ['analytics', 'trends', childId ?? null, days, panel.metric],
    queryFn: ({ signal }) =>
      analyticsApi.trends(
        { child_id: childId, days, metric: panel.metric, bucket: 'week' },
        signal,
      ),
    staleTime: 5 * 60_000,
    retry: panel.optional ? false : undefined,
  });

  const points = useMemo(
    () => (query.data?.points ?? []).filter((point) => Number.isFinite(point.ts_ms)),
    [query.data],
  );

  const latest = useMemo(() => {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      const value = points[index]?.value;
      if (value !== null && value !== undefined && Number.isFinite(value)) return value;
    }
    return null;
  }, [points]);

  // A metric the monitor does not compute is not a failure worth an alarm.
  if (query.isError && panel.optional) {
    return (
      <section className="trend">
        <TrendHeading panel={panel} latest={null} weeks={0} />
        <p className="trend__unavailable">This monitor does not report {panel.title.toLowerCase()}.</p>
      </section>
    );
  }

  return (
    <section className="trend">
      <TrendHeading panel={panel} latest={latest} weeks={points.length} />
      {query.isPending ? (
        <Skeleton height={CHART_H} shape="block" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} size="sm" />
      ) : points.length < 2 ? (
        <EmptyState
          title="Not enough weeks yet"
          description="Two full weeks are needed before a line means anything."
          size="sm"
        />
      ) : (
        <TrendChart
          panel={panel}
          points={points}
          response={query.data}
          targetBand={targetBand}
        />
      )}
    </section>
  );
}

function TrendHeading({
  panel,
  latest,
  weeks,
}: {
  panel: PanelSpec;
  latest: number | null;
  weeks: number;
}) {
  return (
    <header className="trend__head">
      <h3 className="trend__title">{panel.title}</h3>
      <p className="trend__latest" data-numeric>
        {latest === null ? EM_DASH : panel.format(latest)}
        <span className="trend__latest-caption">
          {weeks > 0 ? ` latest of ${weeks} ${plural(weeks, 'week')}` : ''}
        </span>
      </p>
      {panel.hint ? <p className="trend__hint">{panel.hint}</p> : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

interface BandStep {
  from: number;
  to: number;
  low: number;
  high: number;
}

function TrendChart({
  panel,
  points,
  response,
  targetBand,
}: {
  panel: PanelSpec;
  points: TrendPoint[];
  response: TrendsResponse | undefined;
  targetBand: TargetBand | null;
}) {
  const [ref, size] = useResizeObserver<HTMLDivElement>();
  const width = Math.max(0, size.width);
  const innerWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const innerHeight = CHART_H - MARGIN.top - MARGIN.bottom;

  const domainX = useMemo<[number, number]>(() => {
    const first = points[0]?.ts_ms ?? 0;
    const last = points[points.length - 1]?.ts_ms ?? first + 1;
    return first === last ? [first - 1, last + 1] : [first, last];
  }, [points]);

  const spreads = useMemo(() => points.map(readSpread), [points]);

  const steps = useMemo(
    () => buildBandSteps(points, response, targetBand, domainX),
    [points, response, targetBand, domainX],
  );

  /**
   * The data sets the scale; the target band may widen it, but only so far.
   *
   * A guideline band can sit a long way from where a particular child actually
   * is, and letting it drive the axis squashes the line into a flat smear at
   * the top of the panel — the reader loses the real signal to make room for a
   * reference. So the band may pull the axis out by at most one data span on
   * each side, and anything past that is drawn clipped instead.
   */
  const domainY = useMemo<[number, number]>(() => {
    const values: (number | null)[] = [];
    for (const point of points) {
      values.push(point.value ?? null, point.rolling_median ?? null);
    }
    for (const spread of spreads) values.push(spread.low, spread.high);

    const dataRange = extent(values, { pad: 0.08 });
    if (!dataRange) return [0, 1];

    let low = dataRange[0];
    let high = dataRange[1];
    if (steps.length > 0) {
      const span = Math.max(high - low, Math.abs(high) * 0.05, 1e-9);
      const bandLow = Math.min(...steps.map((step) => step.low));
      const bandHigh = Math.max(...steps.map((step) => step.high));
      low = Math.min(low, Math.max(bandLow, low - span));
      high = Math.max(high, Math.min(bandHigh, high + span));
    }

    const nice = niceDomain([low, high], 3);
    return [nice[0], nice[1]];
  }, [points, spreads, steps]);

  const x = useMemo<Scale>(
    () => timeScale({ domain: domainX, range: [MARGIN.left, MARGIN.left + innerWidth] }),
    [domainX, innerWidth],
  );
  const y = useMemo<Scale>(
    () => linearScale({ domain: domainY, range: [MARGIN.top + innerHeight, MARGIN.top] }),
    [domainY, innerHeight],
  );

  if (width === 0) {
    return (
      <div className="trend__plot" ref={ref}>
        <Skeleton height={CHART_H} shape="block" />
      </div>
    );
  }

  const yTicks = y.ticks(3);
  // Grid on every tick, a label on every other one when they would crowd.
  const labelStride = yTicks.length > 4 ? 2 : 1;
  const xTicks = x.ticks(width < 340 ? 2 : 3);

  const plotTop = MARGIN.top;
  const plotBottom = MARGIN.top + innerHeight;
  const clampY = (value: number): number => Math.min(plotBottom, Math.max(plotTop, value));
  const clampX = (value: number): number =>
    Math.min(MARGIN.left + innerWidth, Math.max(MARGIN.left, value));

  const linePoints = points.map((point) => ({
    x: x(point.ts_ms),
    y: point.value === null || point.value === undefined ? null : y(point.value),
    value: point.value ?? null,
    n: point.n ?? null,
    ts: point.ts_ms,
  }));

  const ribbon = ribbonPath(
    points.map((point, index) => ({
      x: x(point.ts_ms),
      low: spreads[index]?.low ?? null,
      high: spreads[index]?.high ?? null,
    })),
    y,
  );

  const linePath = strokePath(linePoints);
  const medianPath = hasDistinctMedian(points)
    ? strokePath(
        points.map((point) => ({
          x: x(point.ts_ms),
          y:
            point.rolling_median === null || point.rolling_median === undefined
              ? null
              : y(point.rolling_median),
        })),
      )
    : '';

  return (
    <div className="trend__plot" ref={ref}>
      <svg
        className="trend__svg"
        width={width}
        height={CHART_H}
        viewBox={`0 0 ${width} ${CHART_H}`}
        role="img"
        aria-label={`${panel.title}, weekly, from ${panel.format(points[0]?.value)} to ${panel.format(points[points.length - 1]?.value)}.`}
      >
        {/* Target band, behind everything, stepped. */}
        {steps.map((step) => {
          const x0 = clampX(x(step.from));
          const x1 = clampX(x(step.to));
          const yTop = clampY(y(step.high));
          const yBottom = clampY(y(step.low));
          if (x1 - x0 <= 0 || yBottom - yTop <= 0) return null;
          return (
            <rect
              key={`band-${step.from}`}
              className="trend__band"
              x={x0}
              y={yTop}
              width={x1 - x0}
              height={yBottom - yTop}
            />
          );
        })}
        {steps.length > 0 ? (
          <>
            <path className="trend__band-edge" d={stepEdge(steps, x, y, 'high', clampX, clampY)} />
            <path className="trend__band-edge" d={stepEdge(steps, x, y, 'low', clampX, clampY)} />
          </>
        ) : null}

        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line
              className="trend__grid"
              x1={MARGIN.left}
              y1={y(tick)}
              x2={MARGIN.left + innerWidth}
              y2={y(tick)}
            />
            {yTicks.indexOf(tick) % labelStride === 0 ? (
              <text className="trend__y-label" x={MARGIN.left - 6} y={y(tick) + 3} textAnchor="end">
                {panel.format(tick)}
              </text>
            ) : null}
          </g>
        ))}

        {ribbon ? <path className="trend__ribbon" d={ribbon} /> : null}

        {medianPath ? <path className="trend__median" d={medianPath} /> : null}
        {linePath ? <path className="trend__line" d={linePath} /> : null}

        {linePoints.map((point) =>
          point.y === null ? null : (
            <circle key={`dot-${point.ts}`} className="trend__dot" cx={point.x} cy={point.y} r={2.6}>
              <title>
                {`${panel.format(point.value)}${point.n === null ? '' : ` from ${point.n} ${plural(point.n, 'night')}`}`}
              </title>
            </circle>
          ),
        )}

        {xTicks.map((tick) => (
          <text
            key={`x-${tick}`}
            className="trend__x-label"
            x={x(tick)}
            y={CHART_H - 5}
            textAnchor="middle"
          >
            {shortDate(tick)}
          </text>
        ))}
      </svg>

      <p className="trend__key">
        {ribbon ? <span className="trend__key-item trend__key-item--ribbon">weekly spread</span> : null}
        {steps.length > 0 ? (
          <span className="trend__key-item trend__key-item--band">
            age-appropriate range{steps.length > 1 ? ', stepping as she grows' : ''}
          </span>
        ) : null}
        {medianPath ? (
          <span className="trend__key-item trend__key-item--median">rolling median</span>
        ) : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

interface Spread {
  low: number | null;
  high: number | null;
}

function readSpread(point: TrendPoint): Spread {
  const extras = point as TrendPoint & PointExtras;
  const low = firstFinite(extras.p25, extras.q1, extras.iqr_low);
  const high = firstFinite(extras.p75, extras.q3, extras.iqr_high);
  if (low === null || high === null) return { low: null, high: null };
  return low <= high ? { low, high } : { low: high, high: low };
}

function firstFinite(...values: (number | null | undefined)[]): number | null {
  for (const value of values) {
    if (value !== null && value !== undefined && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * The stepped target band.
 *
 * Preference order: a per-bucket band on each point, then a band array on the
 * response, then the single band from `/api/analytics/summary` stretched
 * across the window. Only the first two can actually step; the third collapses
 * to one step, which is honest — it is all the API knows.
 */
function buildBandSteps(
  points: TrendPoint[],
  response: TrendsResponse | undefined,
  targetBand: TargetBand | null,
  domainX: readonly [number, number],
): BandStep[] {
  const perPoint: BandStep[] = [];
  points.forEach((point, index) => {
    const extras = point as TrendPoint & PointExtras;
    const low = firstFinite(extras.target_low);
    const high = firstFinite(extras.target_high);
    if (low === null || high === null) return;
    const next = points[index + 1];
    const previous = points[index - 1];
    const halfBefore = previous ? (point.ts_ms - previous.ts_ms) / 2 : undefined;
    const halfAfter = next ? (next.ts_ms - point.ts_ms) / 2 : undefined;
    const before = halfBefore ?? halfAfter ?? 0;
    const after = halfAfter ?? halfBefore ?? 0;
    perPoint.push({
      from: point.ts_ms - before,
      to: point.ts_ms + after,
      low: Math.min(low, high),
      high: Math.max(low, high),
    });
  });
  if (perPoint.length > 0) return mergeSteps(perPoint);

  const declared = (response as (TrendsResponse & ResponseExtras) | undefined)?.target_bands ?? [];
  const fromResponse: BandStep[] = [];
  for (const band of declared) {
    const low = firstFinite(band.low);
    const high = firstFinite(band.high);
    const from = firstFinite(band.from_ms);
    const to = firstFinite(band.to_ms);
    if (low === null || high === null || from === null || to === null) continue;
    fromResponse.push({ from, to, low: Math.min(low, high), high: Math.max(low, high) });
  }
  if (fromResponse.length > 0) return mergeSteps(fromResponse);

  const low = firstFinite(targetBand?.low);
  const high = firstFinite(targetBand?.high);
  if (low === null || high === null) return [];
  return [{ from: domainX[0], to: domainX[1], low: Math.min(low, high), high: Math.max(low, high) }];
}

/** Collapse neighbouring steps with identical bounds, so the edge path is flat where the band is. */
function mergeSteps(steps: BandStep[]): BandStep[] {
  const sorted = [...steps].sort((a, b) => a.from - b.from);
  const merged: BandStep[] = [];
  for (const step of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.low === step.low && last.high === step.high && step.from <= last.to + 1) {
      last.to = Math.max(last.to, step.to);
      continue;
    }
    merged.push({ ...step });
  }
  return merged;
}

/** A stepped polyline along one edge of the band, clipped to the plot area. */
function stepEdge(
  steps: BandStep[],
  x: Scale,
  y: Scale,
  edge: 'low' | 'high',
  clampX: (value: number) => number,
  clampY: (value: number) => number,
): string {
  let path = '';
  steps.forEach((step, index) => {
    const value = clampY(y(step[edge]));
    const x0 = clampX(x(step.from));
    const x1 = clampX(x(step.to));
    path +=
      index === 0 ? `M${x0.toFixed(2)} ${value.toFixed(2)}` : `L${x0.toFixed(2)} ${value.toFixed(2)}`;
    path += `L${x1.toFixed(2)} ${value.toFixed(2)}`;
  });
  return path;
}

/** A polyline that breaks at gaps rather than bridging them. */
function strokePath(points: readonly { x: number; y: number | null }[]): string {
  let path = '';
  let pen = false;
  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y)) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : 'M'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    pen = true;
  }
  return path;
}

/** The spread ribbon, as one closed sub-path per unbroken run. */
function ribbonPath(
  points: readonly { x: number; low: number | null; high: number | null }[],
  y: Scale,
): string {
  let path = '';
  let run: { x: number; low: number; high: number }[] = [];

  const flush = (): void => {
    if (run.length < 2) {
      run = [];
      return;
    }
    const top = run.map((point) => `${point.x.toFixed(2)} ${y(point.high).toFixed(2)}`);
    const bottom = [...run]
      .reverse()
      .map((point) => `${point.x.toFixed(2)} ${y(point.low).toFixed(2)}`);
    path += `M${top.join('L')}L${bottom.join('L')}Z`;
    run = [];
  };

  for (const point of points) {
    if (point.low === null || point.high === null) {
      flush();
      continue;
    }
    run.push({ x: point.x, low: point.low, high: point.high });
  }
  flush();
  return path;
}

/**
 * Whether the rolling median is worth a second line. When the service sends a
 * median identical to the weekly value — which it does when the bucket is the
 * rolling window — drawing both is two lines saying one thing.
 */
function hasDistinctMedian(points: readonly TrendPoint[]): boolean {
  for (const point of points) {
    const median = point.rolling_median;
    if (median === null || median === undefined || !Number.isFinite(median)) continue;
    if (point.value === null || point.value === undefined) return true;
    if (Math.abs(point.value - median) > 1e-9) return true;
  }
  return false;
}

const dateFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function shortDate(ms: number): string {
  return dateFormatter.format(new Date(ms));
}
