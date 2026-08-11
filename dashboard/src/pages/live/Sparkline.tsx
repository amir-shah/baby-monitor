/**
 * The rolling sound sparkline.
 *
 * Hand-drawn SVG, no chart library: two polylines and a dot. `linePath` breaks
 * the stroke at nulls, so a gap in the telemetry shows as a gap rather than a
 * confident straight line across an outage — which on a baby monitor is a
 * meaningful distinction.
 */

import { useMemo } from 'react';
import { extent, linePath, linearScale, useResizeObserver } from '../../lib/scales';
import { formatDbfs } from '../../lib/format';
import type { SoundPoint } from './useLiveState';
import './Sparkline.css';

export interface SparklineProps {
  points: readonly SoundPoint[];
  /** Right edge of the x axis. */
  now: number;
  /** How far back the left edge sits. */
  windowMs: number;
  height?: number;
}

/** Used before any data has been seen, so the box does not jump on first tick. */
const FALLBACK_DOMAIN: readonly [number, number] = [-70, -20];

export function Sparkline({ points, now, windowMs, height = 56 }: SparklineProps) {
  const [ref, size] = useResizeObserver<HTMLDivElement>();
  const width = size.width;

  const geometry = useMemo(() => {
    if (width <= 0) return null;

    const from = now - windowMs;
    const visible = points.filter((point) => point.ts >= from - windowMs * 0.05);
    if (visible.length < 2) return null;

    const values = visible.flatMap((point) => [point.dbfs, point.floor]);
    const domain = extent(values, { pad: 0.15 }) ?? FALLBACK_DOMAIN;

    const x = linearScale({ domain: [from, now], range: [0, width], clamp: true });
    const y = linearScale({ domain, range: [height - 2, 2], clamp: true });

    const level = visible.map((point) => ({ x: x(point.ts), y: point.dbfs === null ? null : y(point.dbfs) }));
    const floor = visible.map((point) => ({ x: x(point.ts), y: point.floor === null ? null : y(point.floor) }));

    const last = visible.at(-1);
    const head =
      last && last.dbfs !== null ? { x: x(last.ts), y: y(last.dbfs), value: last.dbfs } : null;

    return {
      levelPath: linePath(level),
      floorPath: linePath(floor),
      head,
      domain,
    };
  }, [points, now, windowMs, width, height]);

  const minutes = Math.round(windowMs / 60_000);

  return (
    <div className="spark" ref={ref}>
      {geometry === null ? (
        <div className="spark__empty" style={{ height }}>
          <span>Collecting…</span>
        </div>
      ) : (
        <>
          <svg
            className="spark__svg"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Sound over the last ${minutes} minutes, between ${formatDbfs(
              geometry.domain[0],
            )} and ${formatDbfs(geometry.domain[1])}. The dashed line is the adaptive noise floor.`}
            focusable="false"
          >
            {/* The floor first, so the level draws over it. */}
            <path className="spark__floor" d={geometry.floorPath} strokeDasharray="3 3" />
            <path className="spark__level" d={geometry.levelPath} />
            {geometry.head ? (
              <circle className="spark__head" cx={geometry.head.x} cy={geometry.head.y} r="2.75" />
            ) : null}
          </svg>

          <p className="spark__axis" aria-hidden="true">
            <span>{minutes} min ago</span>
            <span className="spark__legend">
              <span className="spark__key spark__key--level" /> level
              <span className="spark__key spark__key--floor" /> floor
            </span>
            <span>now</span>
          </p>
        </>
      )}
    </div>
  );
}
