/**
 * The actogram: a double-plotted 24-hour raster, one row per day.
 *
 * Each row is 48 hours wide and the right half repeats as the next row's left
 * half. That is not decoration — it is the reason the chart is readable at
 * all. Singly plotted, an infant's sleep starts near the right edge of one row
 * and finishes near the left edge of the next, so the one thing a parent is
 * looking for (a single unbroken block, and whether it is drifting later) gets
 * cut in half on every line. Double plotting puts each night down intact, and
 * a drift shows up as a diagonal.
 *
 * Rows run oldest at the top, which is the chronobiology convention: time runs
 * down the page and forward across it.
 */

import { useId, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analytics as analyticsApi } from '../../lib/api';
import { Card, EmptyState, ErrorState, Skeleton } from '../../components';
import { formatMinuteOfDay, parseNightOf, plural } from '../../lib/format';
import { useResizeObserver } from '../../lib/scales';
import { countsAsSleep } from '../../lib/types';
import type { ActogramRow, RegularityResponse, SleepState } from '../../lib/types';
import './Actogram.css';

/** Eight weeks is the most that stays legible at a readable row height. */
const MAX_ROWS = 56;
const ROW_H = 9;
const ROW_GAP = 1;
const GUTTER = 46;
const PAD_R = 8;
const PAD_T = 6;
const AXIS_H = 18;
const DAY_MIN = 1440;
const SPAN_MIN = 2 * DAY_MIN;

export interface ActogramCardProps {
  childId: number | undefined;
  days: number;
  /** `children.target_bedtime` as minutes after local midnight, if set. */
  targetBedtimeMin: number | null;
}

export function ActogramCard({ childId, days, targetBedtimeMin }: ActogramCardProps) {
  const query = useQuery({
    queryKey: ['analytics', 'regularity', childId ?? null, days],
    queryFn: ({ signal }) => analyticsApi.regularity({ child_id: childId, days }, signal),
    staleTime: 5 * 60_000,
  });

  return (
    <Card
      title="Night by night"
      subtitle="Each line is 48 hours; the right half repeats on the next line, so a night is never cut in two."
      className="acto-card"
    >
      {query.isPending ? (
        <Skeleton height={320} shape="block" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} size="sm" />
      ) : (
        <Actogram data={query.data} targetBedtimeMin={targetBedtimeMin} />
      )}
    </Card>
  );
}

interface Bar {
  key: string;
  x: number;
  width: number;
  state: SleepState;
}

function Actogram({
  data,
  targetBedtimeMin,
}: {
  data: RegularityResponse | undefined;
  targetBedtimeMin: number | null;
}) {
  const [ref, size] = useResizeObserver<HTMLDivElement>();
  const patternId = useId();
  const width = Math.max(0, size.width);

  const rows = useMemo(() => {
    const all = [...(data?.actogram ?? [])].sort((a, b) => a.night_of.localeCompare(b.night_of));
    return all.slice(Math.max(0, all.length - MAX_ROWS));
  }, [data]);

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No nights to draw yet"
        description="Once a few nights have been rolled up they appear here, one line each."
        size="sm"
      />
    );
  }

  const innerWidth = Math.max(1, width - GUTTER - PAD_R);
  const perMinute = innerWidth / SPAN_MIN;
  const x = (minutes: number): number => GUTTER + minutes * perMinute;
  const height = PAD_T + rows.length * (ROW_H + ROW_GAP) + AXIS_H;

  /** The clock time at the left edge. Usually noon. */
  const baseOffset = rows[0]?.offset_min ?? 720;

  const hourStep = innerWidth < 300 ? 12 : 6;
  const gridMinutes: number[] = [];
  for (let minute = 0; minute <= SPAN_MIN; minute += hourStep * 60) gridMinutes.push(minute);

  /** Where a given clock time falls, twice, across the 48 h row. */
  const clockPositions = (clockMin: number): number[] => {
    const first = ((clockMin - baseOffset) % DAY_MIN + DAY_MIN) % DAY_MIN;
    return [first, first + DAY_MIN];
  };

  const midnights = clockPositions(0);
  const bedtimes = targetBedtimeMin === null ? [] : clockPositions(targetBedtimeMin);

  const label = `Sleep for the last ${rows.length} ${plural(rows.length, 'night')}, drawn as a double-plotted 48-hour raster with the oldest night at the top.`;

  return (
    <figure className="acto" ref={ref}>
      <div className="acto__plot">
        {width > 0 ? (
          <svg
            className="acto__svg"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={label}
          >
            <defs>
              {/* Restless is a second, non-colour channel: a hatch, so the two
                  kinds of bar are still different in greyscale. */}
              <pattern
                id={patternId}
                width="4"
                height="4"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line className="acto__hatch" x1="0" y1="0" x2="0" y2="4" />
              </pattern>
            </defs>

            {gridMinutes.map((minute) => (
              <line
                key={`grid-${minute}`}
                className="acto__grid"
                x1={x(minute)}
                y1={PAD_T}
                x2={x(minute)}
                y2={height - AXIS_H}
              />
            ))}

            {midnights.map((minute) => (
              <line
                key={`midnight-${minute}`}
                className="acto__midnight"
                x1={x(minute)}
                y1={PAD_T}
                x2={x(minute)}
                y2={height - AXIS_H}
              />
            ))}

            {bedtimes.map((minute) => (
              <line
                key={`bedtime-${minute}`}
                className="acto__target"
                x1={x(minute)}
                y1={PAD_T}
                x2={x(minute)}
                y2={height - AXIS_H}
              />
            ))}

            {rows.map((row, index) => {
              const y = PAD_T + index * (ROW_H + ROW_GAP);
              const bars = rowBars(row, rows[index + 1]);
              const dateLabel = gutterLabel(row.night_of);
              return (
                <g key={row.night_of}>
                  <rect
                    className="acto__row-bg"
                    x={GUTTER}
                    y={y}
                    width={innerWidth}
                    height={ROW_H}
                  />
                  {dateLabel ? (
                    <text className="acto__date" x={GUTTER - 6} y={y + ROW_H - 1} textAnchor="end">
                      {dateLabel}
                    </text>
                  ) : null}
                  {bars.map((bar) => (
                    <rect
                      key={bar.key}
                      className={
                        bar.state === 'restless' ? 'acto__bar acto__bar--restless' : 'acto__bar'
                      }
                      x={x(bar.x)}
                      y={y}
                      width={Math.max(0.75, bar.width * perMinute)}
                      height={ROW_H}
                      fill={bar.state === 'restless' ? `url(#${patternId})` : undefined}
                    />
                  ))}
                </g>
              );
            })}

            <line
              className="acto__axis-line"
              x1={GUTTER}
              y1={height - AXIS_H}
              x2={width - PAD_R}
              y2={height - AXIS_H}
            />
            {gridMinutes.map((minute) =>
              minute === SPAN_MIN && innerWidth < 420 ? null : (
                <text
                  key={`tick-${minute}`}
                  className="acto__tick"
                  x={x(minute)}
                  y={height - 5}
                  textAnchor={minute === 0 ? 'start' : minute === SPAN_MIN ? 'end' : 'middle'}
                >
                  {formatMinuteOfDay((baseOffset + minute) % DAY_MIN, { showDayOffset: false })}
                </text>
              ),
            )}
          </svg>
        ) : (
          <Skeleton height={240} shape="block" />
        )}
      </div>

      <figcaption className="acto__legend">
        <span className="acto__key">
          <span className="acto__swatch acto__swatch--asleep" aria-hidden="true" />
          Asleep
        </span>
        <span className="acto__key">
          <span className="acto__swatch acto__swatch--restless" aria-hidden="true" />
          Restless
        </span>
        {targetBedtimeMin === null ? null : (
          <span className="acto__key">
            <span className="acto__swatch acto__swatch--target" aria-hidden="true" />
            Target bedtime {formatMinuteOfDay(targetBedtimeMin)}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * The bars for one line: this night's spans on the left half, the following
 * night's on the right. The two rows are aligned by their own `offset_min`
 * rather than assuming both start at noon, so a child whose day boundary was
 * changed part-way through the record still lines up.
 */
function rowBars(row: ActogramRow, next: ActogramRow | undefined): Bar[] {
  const bars: Bar[] = [];

  const push = (prefix: string, spans: ActogramRow['spans'], shift: number): void => {
    spans.forEach((span, index) => {
      if (!countsAsSleep(span.state)) return;
      const start = Math.max(0, span.start_min + shift);
      const end = Math.min(SPAN_MIN, span.end_min + shift);
      if (!(end > start)) return;
      bars.push({
        key: `${prefix}-${index}`,
        x: start,
        width: end - start,
        state: span.state,
      });
    });
  };

  push('a', row.spans, 0);
  if (next) push('b', next.spans, DAY_MIN + (next.offset_min - row.offset_min));

  return bars;
}

const gutterFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
});

/**
 * A date in the left gutter, on Mondays only. Labelling every row would be
 * unreadable at nine pixels a line, and a weekly rhythm is exactly the thing
 * the eye is being asked to look for.
 */
function gutterLabel(nightOf: string): string | null {
  const parsed = parseNightOf(nightOf);
  if (!parsed) return null;
  const utc = Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12);
  if (new Date(utc).getUTCDay() !== 1) return null;
  return gutterFormatter.format(new Date(utc));
}
