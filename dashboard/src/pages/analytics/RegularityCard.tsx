/**
 * Sleep regularity: the SRI, and how tightly bedtime and wake cluster.
 *
 * The strip is drawn on a noon-anchored axis rather than a midnight one. On a
 * midnight axis a 19:30 bedtime and a 06:20 wake sit at opposite ends with the
 * night falling off both edges, which is exactly the wrap problem the actogram
 * solves by double plotting. Anchoring at noon puts the whole night in the
 * middle, in order.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analytics as analyticsApi } from '../../lib/api';
import { Card, EmptyState, ErrorState, Skeleton, Stat } from '../../components';
import { InfoTip } from '../../components/InfoTip';
import { EM_DASH, formatDuration, formatMinuteOfDay, plural } from '../../lib/format';
import { linearScale, useResizeObserver } from '../../lib/scales';
import type { Scale } from '../../lib/scales';
import type { RegularityResponse } from '../../lib/types';
import './RegularityCard.css';

const STRIP_H = 30;
const AXIS_H = 20;
const PAD_X = 8;
const DAY_MIN = 1440;
/** Clock minute the axis starts at. Noon, so a night reads left to right. */
const ANCHOR = 720;

export interface RegularityCardProps {
  childId: number | undefined;
  days: number;
}

export function RegularityCard({ childId, days }: RegularityCardProps) {
  const query = useQuery({
    queryKey: ['analytics', 'regularity', childId ?? null, days],
    queryFn: ({ signal }) => analyticsApi.regularity({ child_id: childId, days }, signal),
    staleTime: 5 * 60_000,
  });

  return (
    <Card
      title="How regular the rhythm is"
      subtitle="Timing, separately from duration. A child can get plenty of sleep on a wandering schedule, or very little on a fixed one."
      className="sri-card"
    >
      {query.isPending ? (
        <Skeleton height={220} shape="block" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} size="sm" />
      ) : (
        <RegularityBody data={query.data} />
      )}
    </Card>
  );
}

interface StripRow {
  key: string;
  label: string;
  mean: number;
  sd: number | null;
}

function RegularityBody({ data }: { data: RegularityResponse | undefined }) {
  const [ref, size] = useResizeObserver<HTMLDivElement>();
  const width = Math.max(0, size.width);

  const rows = useMemo<StripRow[]>(() => {
    if (!data) return [];
    const candidates: StripRow[] = [
      { key: 'bedtime', label: 'Bedtime', mean: data.bedtime_mean_min ?? NaN, sd: data.bedtime_sd_min },
      { key: 'midpoint', label: 'Midpoint', mean: data.midpoint_mean_min ?? NaN, sd: data.midpoint_sd_min },
      { key: 'waketime', label: 'Wake', mean: data.waketime_mean_min ?? NaN, sd: data.waketime_sd_min },
    ];
    return candidates.filter((row) => Number.isFinite(row.mean));
  }, [data]);

  const domain = useMemo<[number, number]>(() => {
    if (rows.length === 0) return [0, DAY_MIN];
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      const centre = anchored(row.mean);
      const spread = row.sd !== null && Number.isFinite(row.sd) ? Math.abs(row.sd) * 1.6 : 30;
      low = Math.min(low, centre - spread);
      high = Math.max(high, centre + spread);
    }
    const pad = Math.max(45, (high - low) * 0.15);
    return [Math.max(0, low - pad), Math.min(DAY_MIN, high + pad)];
  }, [rows]);

  const scale = useMemo<Scale>(
    () => linearScale({ domain, range: [PAD_X, Math.max(PAD_X + 1, width - PAD_X)], clamp: true }),
    [domain, width],
  );

  const ticks = useMemo(() => {
    const span = domain[1] - domain[0];
    const step = span > 600 ? 180 : span > 300 ? 120 : 60;
    const first = Math.ceil(domain[0] / step) * step;
    const out: number[] = [];
    for (let value = first; value <= domain[1]; value += step) out.push(value);
    return out;
  }, [domain]);

  const sri = data?.sri ?? null;

  return (
    <div className="sri" ref={ref}>
      <div className="sri__headline">
        <Stat
          label={
            <span className="sri__label">
              Sleep Regularity Index
              <InfoTip term="Sleep Regularity Index" title="Sleep Regularity Index">
                The chance that any two nights in this window were in the same state — asleep or
                awake — at the same clock time. 100 would be an identical schedule every night; 0
                would be no relationship at all. Most young children sit somewhere in the 60s to
                80s.
              </InfoTip>
            </span>
          }
          value={sri === null ? EM_DASH : Math.round(sri)}
          unit={sri === null ? undefined : ' / 100'}
          hint={sriWords(sri)}
          size="hero"
        />
        {data ? (
          <p className="sri__basis">
            From {data.nights_analysable} {plural(data.nights_analysable, 'night')}.
          </p>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No bedtimes to compare yet"
          description="Once a handful of nights have anchors, their spread is drawn here."
          size="sm"
        />
      ) : (
        <div className="sri__strip">
          <p className="sri__strip-title">Where each anchor usually lands</p>

          {width > 0 ? (
            <svg
              className="sri__axis"
              width={width}
              height={AXIS_H}
              viewBox={`0 0 ${width} ${AXIS_H}`}
              aria-hidden="true"
              focusable="false"
            >
              <line className="sri__axis-line" x1={PAD_X} y1={AXIS_H - 4} x2={width - PAD_X} y2={AXIS_H - 4} />
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    className="sri__axis-tick"
                    x1={scale(tick)}
                    y1={AXIS_H - 8}
                    x2={scale(tick)}
                    y2={AXIS_H - 4}
                  />
                  <text className="sri__axis-label" x={scale(tick)} y={AXIS_H - 12} textAnchor="middle">
                    {formatMinuteOfDay((tick + ANCHOR) % DAY_MIN, { showDayOffset: false })}
                  </text>
                </g>
              ))}
            </svg>
          ) : null}

          <ul className="sri__rows">
            {rows.map((row) => (
              <li key={row.key} className="sri-row">
                <div className="sri-row__head">
                  <span className="sri-row__label">{row.label}</span>
                  <span className="sri-row__value" data-numeric>
                    {formatMinuteOfDay(row.mean)}
                    <span className="sri-row__sd">
                      {row.sd === null || !Number.isFinite(row.sd)
                        ? ' spread unknown'
                        : ` typically ±${formatDuration(Math.abs(row.sd))}`}
                    </span>
                  </span>
                </div>
                {width > 0 ? <ConsistencyStrip row={row} scale={scale} width={width} /> : null}
              </li>
            ))}
          </ul>

          <p className="sri__footnote">
            The bar covers one standard deviation either side of the average, so roughly two nights
            in three landed inside it.
          </p>
        </div>
      )}
    </div>
  );
}

function ConsistencyStrip({ row, scale, width }: { row: StripRow; scale: Scale; width: number }) {
  const mid = STRIP_H / 2;
  const centre = scale(anchored(row.mean));
  const sd = row.sd !== null && Number.isFinite(row.sd) ? Math.abs(row.sd) : null;
  const low = sd === null ? null : scale(anchored(row.mean) - sd);
  const high = sd === null ? null : scale(anchored(row.mean) + sd);

  return (
    <svg
      className="sri-row__strip"
      width={width}
      height={STRIP_H}
      viewBox={`0 0 ${width} ${STRIP_H}`}
      aria-hidden="true"
      focusable="false"
    >
      <line className="sri-row__track" x1={PAD_X} y1={mid} x2={width - PAD_X} y2={mid} />
      {low !== null && high !== null ? (
        <rect
          className="sri-row__band"
          x={Math.min(low, high)}
          y={mid - 7}
          width={Math.max(2, Math.abs(high - low))}
          height={14}
          rx={3}
        />
      ) : null}
      <line className="sri-row__mean" x1={centre} y1={mid - 10} x2={centre} y2={mid + 10} />
    </svg>
  );
}

/** Clock minutes to minutes after noon, so a night does not wrap the axis. */
function anchored(clockMin: number): number {
  return (((clockMin - ANCHOR) % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

/**
 * Plain words for the index. Descriptive only — a steadier schedule is not
 * promised to do anything, and nothing here says it is.
 */
function sriWords(sri: number | null): string {
  if (sri === null || !Number.isFinite(sri)) return 'not enough nights to compute this yet';
  if (sri >= 80) return 'very steady from night to night';
  if (sri >= 65) return 'fairly steady from night to night';
  if (sri >= 50) return 'somewhat variable from night to night';
  return 'quite variable from night to night';
}
