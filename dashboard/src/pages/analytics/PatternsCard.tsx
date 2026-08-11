/**
 * Two smaller patterns from `/api/analytics/patterns`: when awakenings happen
 * on the clock, and how each weekday compares with the window's own average.
 *
 * Both are descriptive summaries with no inference attached — no interval, no
 * q-value, so no claim. The copy says "averaged" and nothing stronger, and the
 * weekday panel prints n beside every bar so a Tuesday built from three nights
 * cannot be mistaken for a finding.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analytics as analyticsApi } from '../../lib/api';
import { Card, EmptyState, ErrorState, Skeleton } from '../../components';
import { formatCount, formatMinuteOfDay, plural } from '../../lib/format';
import { bandScale, linearScale, useResizeObserver } from '../../lib/scales';
import type { DayOfWeekEffect, HistogramBin } from '../../lib/types';
import { metricSpec } from './metrics';
import './PatternsCard.css';

const HIST_H = 130;
const HIST_TOP = 8;
const HIST_AXIS = 18;
const DAY_MIN = 1440;
/** Clock minute the histogram starts at, matching the actogram. */
const ANCHOR = 720;

export interface PatternsCardProps {
  childId: number | undefined;
  days: number;
  metricKey: string;
}

export function PatternsCard({ childId, days, metricKey }: PatternsCardProps) {
  const spec = useMemo(() => metricSpec(metricKey), [metricKey]);

  const query = useQuery({
    queryKey: ['analytics', 'patterns', childId ?? null, days, metricKey],
    queryFn: ({ signal }) =>
      analyticsApi.patterns({ child_id: childId, days, metric: metricKey }, signal),
    staleTime: 5 * 60_000,
  });

  const histogram = query.data?.awakening_clock_histogram ?? [];
  const dow = query.data?.day_of_week ?? [];

  return (
    <Card
      title="When and which day"
      subtitle="Descriptive summaries of the same window. No intervals here, so nothing on this card is a finding."
      className="patterns-card"
    >
      {query.isPending ? (
        <Skeleton height={220} shape="block" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} size="sm" />
      ) : histogram.length === 0 && dow.length === 0 ? (
        <EmptyState
          title="Nothing to summarise yet"
          description="These fill in once there are a few weeks of nights in the window."
          size="sm"
        />
      ) : (
        <div className="patterns">
          {histogram.length > 0 ? <ClockHistogram bins={histogram} /> : null}
          {dow.length > 0 ? (
            <WeekdayPanel rows={dow} format={(value) => spec.formatDiff(value)} label={spec.label} />
          ) : null}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Awakenings by clock time
// ---------------------------------------------------------------------------

function ClockHistogram({ bins }: { bins: HistogramBin[] }) {
  const [ref, size] = useResizeObserver<HTMLDivElement>();
  const width = Math.max(0, size.width);

  // Rotated to start at noon so a night runs left to right in one piece,
  // rather than being split across the two ends of a midnight axis.
  const ordered = useMemo(
    () => [...bins].sort((a, b) => anchored(a.from) - anchored(b.from)),
    [bins],
  );

  const maxCount = useMemo(
    () => Math.max(1, ...ordered.map((bin) => (Number.isFinite(bin.count) ? bin.count : 0))),
    [ordered],
  );

  const total = useMemo(
    () => ordered.reduce((sum, bin) => sum + (Number.isFinite(bin.count) ? bin.count : 0), 0),
    [ordered],
  );

  const band = useMemo(
    () => bandScale({ count: ordered.length, range: [0, Math.max(1, width)], padding: 0.25 }),
    [ordered.length, width],
  );

  const y = useMemo(
    () => linearScale({ domain: [0, maxCount], range: [HIST_H - HIST_AXIS, HIST_TOP] }),
    [maxCount],
  );

  const labelEvery = Math.max(1, Math.ceil(ordered.length / (width < 340 ? 4 : 7)));

  return (
    <section className="pattern">
      <h3 className="pattern__title">When she wakes</h3>
      <p className="pattern__note">
        {total} {plural(total, 'awakening')} over this window, by clock time.
      </p>
      <div className="pattern__plot" ref={ref}>
        {width > 0 ? (
          <svg
            className="pattern__svg"
            width={width}
            height={HIST_H}
            viewBox={`0 0 ${width} ${HIST_H}`}
            role="img"
            aria-label="Awakenings by clock time, from noon around to noon."
          >
            <line
              className="pattern__axis"
              x1={0}
              y1={HIST_H - HIST_AXIS}
              x2={width}
              y2={HIST_H - HIST_AXIS}
            />
            {ordered.map((bin, index) => {
              const count = Number.isFinite(bin.count) ? bin.count : 0;
              const top = y(count);
              const height = Math.max(count > 0 ? 1.5 : 0, HIST_H - HIST_AXIS - top);
              return (
                <g key={`${bin.from}-${index}`}>
                  <rect
                    className="pattern__bar"
                    x={band(index)}
                    y={top}
                    width={band.bandwidth}
                    height={height}
                    rx={1.5}
                  >
                    <title>
                      {`${formatMinuteOfDay(bin.from, { showDayOffset: false })} – ${formatMinuteOfDay(bin.to, { showDayOffset: false })}: ${formatCount(count)}`}
                    </title>
                  </rect>
                  {index % labelEvery === 0 ? (
                    <text
                      className="pattern__tick"
                      x={band(index) + band.bandwidth / 2}
                      y={HIST_H - 5}
                      textAnchor="middle"
                    >
                      {formatMinuteOfDay(bin.from, { showDayOffset: false })}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : (
          <Skeleton height={HIST_H} shape="block" />
        )}
      </div>
    </section>
  );
}

function anchored(clockMin: number): number {
  return (((clockMin - ANCHOR) % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

// ---------------------------------------------------------------------------
// Day of week
// ---------------------------------------------------------------------------

function WeekdayPanel({
  rows,
  format,
  label,
}: {
  rows: DayOfWeekEffect[];
  format: (value: number) => string;
  label: string;
}) {
  const ordered = useMemo(() => [...rows].sort((a, b) => a.dow - b.dow), [rows]);
  const reach = useMemo(
    () =>
      Math.max(
        1e-9,
        ...ordered.map((row) =>
          row.diff_from_overall === null || !Number.isFinite(row.diff_from_overall)
            ? 0
            : Math.abs(row.diff_from_overall),
        ),
      ),
    [ordered],
  );

  return (
    <section className="pattern">
      <h3 className="pattern__title">By day of the week</h3>
      <p className="pattern__note">
        {label} on each weekday, against this window&rsquo;s own average. Small counts move a long
        way on their own, so the number of nights is beside each bar.
      </p>
      <ul className="weekday">
        {ordered.map((row) => {
          const diff = row.diff_from_overall;
          const usable = diff !== null && Number.isFinite(diff) ? diff : null;
          const fraction = usable === null ? 0 : Math.min(1, Math.abs(usable) / reach);
          const side = usable === null ? 'none' : usable >= 0 ? 'up' : 'down';
          return (
            <li key={row.dow} className="weekday__row">
              <span className="weekday__label">{row.label}</span>
              <span className="weekday__track" aria-hidden="true">
                <span className="weekday__centre" />
                {usable === null ? null : (
                  <span
                    className="weekday__bar"
                    data-side={side}
                    style={{ width: `${(fraction * 50).toFixed(1)}%` }}
                  />
                )}
              </span>
              <span className="weekday__value" data-numeric>
                {usable === null ? '—' : format(usable)}
              </span>
              <span className="weekday__n">
                {row.n} {plural(row.n, 'night')}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
