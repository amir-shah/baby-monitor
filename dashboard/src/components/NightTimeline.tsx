import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import {
  deriveAwakenings,
  longestSleepRun,
  motionExtent,
  soundExtent,
  timelineSummary,
  timelineWindow,
} from '../lib/nightModel';
import type { Awakening, Span } from '../lib/nightModel';
import { linePath, linearScale, timeScale, useResizeObserver } from '../lib/scales';
import type { Scale } from '../lib/scales';
import { sleepStateClass } from '../lib/stateStyles';
import {
  EM_DASH,
  eventLabelText,
  formatClock,
  formatDbfs,
  formatDuration,
  formatMotion,
  formatPercent,
  sleepStateLabel,
} from '../lib/format';
import { effectiveLabel, isFalsePositive } from '../lib/types';
import type {
  BabyEvent,
  NightDetail,
  SeriesPoint,
  SleepSegment,
  SleepState,
  Timezone,
} from '../lib/types';
import { ClipPlayer } from './ClipPlayer';
import { EventLabelPicker } from './EventLabelPicker';
import { SeverityBadge } from './Badge';
import { IconButton } from './IconButton';
import { CloseIcon } from './Icons';
import './NightTimeline.css';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Room above the band for the sleep-onset flag and the awakening ticks. */
const TOP_H = 22;
const BAND_H = 54;
const SOUND_H = 42;
const MOTION_H = 26;
const LANE_GAP = 8;
const AXIS_H = 18;
const RAIL_H = 26;
const PAD_X = 10;

const BAND_Y = TOP_H;
const SOUND_Y = BAND_Y + BAND_H + LANE_GAP;
const MOTION_Y = SOUND_Y + SOUND_H + 4;
const AXIS_Y = MOTION_Y + MOTION_H;
const RAIL_Y = AXIS_Y + AXIS_H;
const CHART_H = RAIL_Y + RAIL_H;

/** Events closer together than this share one marker and one tap target. */
const CLUSTER_PX = 18;
const TAP_TARGET = 44;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NightTimelineProps {
  night: NightDetail;
  timezone?: Timezone | null;
  /**
   * Relabel an event from the tooltip. `''` marks a false positive, `null`
   * clears a previous correction. Omit to render the tooltip read-only.
   */
  onCorrectEvent?: (event: BabyEvent, correctedLabel: string | null) => void;
  /** Id of the event whose correction is in flight, for the busy state. */
  correctingEventId?: number | null;
  /**
   * Draw at a fixed pixel width instead of measuring the container. Only
   * needed where there is nothing to measure — a headless render, a print
   * layout — the responsive path is the default.
   */
  width?: number;
  className?: string;
}

interface EventCluster {
  key: string;
  x: number;
  events: BabyEvent[];
}

/**
 * The hypnogram.
 *
 * One shared x scale runs through every layer: the sleep band, the sound and
 * motion lanes underneath it, and the event rail below the axis. That is the
 * whole point of the chart — "she woke at 02:10" and "there was a spike of
 * noise at 02:09" only mean something together, and they only read as together
 * if they sit on the same axis.
 *
 * Three rules shaped the implementation:
 *
 *  - **Touch first.** Every event marker has a 44px hit target, markers that
 *    would overlap merge into one, and the details open in a panel below the
 *    chart rather than in a bubble that a thumb covers. Hover is an extra for
 *    people with a mouse, never the only way in.
 *  - **Never colour alone.** Each sleep state gets a distinct fill *pattern*
 *    as well as a hue, blocks wide enough carry their own name, and the legend
 *    shows both. The chart still reads in greyscale.
 *  - **Gaps are gaps.** A stretch with no telemetry breaks the sound and
 *    motion traces rather than being interpolated across. A dropout must not
 *    look like a quiet night.
 */
export function NightTimeline({
  night,
  timezone,
  onCorrectEvent,
  correctingEventId,
  width: fixedWidth,
  className,
}: NightTimelineProps) {
  const [containerRef, size] = useResizeObserver<HTMLDivElement>();
  const [selected, setSelected] = useState<EventCluster | null>(null);
  const [hovered, setHovered] = useState<EventCluster | null>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const summaryId = useId();
  const titleId = useId();

  const hoverCapable = useHoverCapable();
  const width = Math.max(0, fixedWidth ?? size.width);
  const window_ = useMemo(() => timelineWindow(night), [night]);

  const x = useMemo<Scale | null>(() => {
    if (!window_ || width <= PAD_X * 2 + 20) return null;
    return timeScale({
      domain: [window_.start, window_.end],
      range: [PAD_X, width - PAD_X],
      timeZone: timezone ?? undefined,
    });
  }, [window_, width, timezone]);

  const clusters = useMemo<EventCluster[]>(
    () => (x ? clusterEvents(night.events, x) : []),
    [night.events, x],
  );

  // A cluster held in state goes stale when the night refetches; re-resolve it
  // against the fresh event objects so the panel shows the corrected label
  // immediately rather than the copy captured at click time.
  const selectedLive = useMemo<EventCluster | null>(() => {
    if (!selected) return null;
    const match = clusters.find((cluster) => cluster.key === selected.key);
    return match ?? null;
  }, [selected, clusters]);

  const selectedKey = selectedLive?.key ?? null;
  useEffect(() => {
    if (selectedKey) detailsRef.current?.focus();
  }, [selectedKey]);

  const summary = useMemo(() => timelineSummary(night, timezone), [night, timezone]);

  return (
    <figure className={['night-timeline', className ?? ''].filter(Boolean).join(' ')}>
      <figcaption className="visually-hidden" id={summaryId}>
        <span id={titleId}>Sleep timeline for this night.</span> {summary}
      </figcaption>

      {/* One copy of the pattern definitions for the whole figure. Duplicating
          them per <svg> would duplicate their ids, and `url(#…)` resolves
          against the document, not the nearest SVG root. */}
      <svg className="night-timeline__defs" width="0" height="0" aria-hidden="true" focusable="false">
        <StatePatternDefs />
      </svg>

      <div className="night-timeline__plot" ref={containerRef}>
        {x && window_ ? (
          <>
            <svg
              className="night-timeline__svg"
              width={width}
              height={CHART_H}
              viewBox={`0 0 ${width} ${CHART_H}`}
              role="img"
              aria-labelledby={`${titleId} ${summaryId}`}
            >
              <GridAndAxis x={x} width={width} timezone={timezone} />
              <SoundLane points={night.series} x={x} />
              <MotionLane points={night.series} x={x} />
              <SleepBand segments={night.segments} x={x} timezone={timezone} />
              <OnsetMarker night={night} x={x} timezone={timezone} />
              <AwakeningTicks night={night} x={x} />
              <LongestBoutHighlight run={longestSleepRun(night.segments)} x={x} />
              <EventRail
                clusters={clusters}
                selectedKey={selectedLive?.key ?? null}
                hoveredKey={hovered?.key ?? null}
              />
            </svg>

            <div className="night-timeline__hits" style={{ height: CHART_H }}>
              {clusters.map((cluster) => (
                <button
                  key={cluster.key}
                  type="button"
                  className={[
                    'night-timeline__hit',
                    selectedLive?.key === cluster.key ? 'is-selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    left: Math.round(cluster.x - TAP_TARGET / 2),
                    top: RAIL_Y + RAIL_H - TAP_TARGET,
                    width: TAP_TARGET,
                    height: TAP_TARGET,
                  }}
                  aria-pressed={selectedLive?.key === cluster.key}
                  aria-label={clusterLabel(cluster, timezone)}
                  onClick={() =>
                    setSelected((current) => (current?.key === cluster.key ? null : cluster))
                  }
                  onMouseEnter={hoverCapable ? () => setHovered(cluster) : undefined}
                  onMouseLeave={hoverCapable ? () => setHovered(null) : undefined}
                  onFocus={() => setHovered(cluster)}
                  onBlur={() => setHovered(null)}
                />
              ))}

              {hovered && hovered.key !== selectedLive?.key ? (
                <HoverBubble cluster={hovered} width={width} timezone={timezone} />
              ) : null}
            </div>
          </>
        ) : (
          <div className="night-timeline__placeholder" style={{ height: CHART_H }} aria-hidden="true" />
        )}
      </div>

      <StateLegend segments={night.segments} />

      {selectedLive ? (
        <div
          className="night-timeline__details"
          ref={detailsRef}
          tabIndex={-1}
          role="group"
          aria-label={`Details for ${clusterLabel(selectedLive, timezone)}`}
        >
          <div className="night-timeline__details-head">
            <p className="night-timeline__details-title">
              {selectedLive.events.length === 1
                ? formatClock(selectedLive.events[0]?.start_ms, { tz: timezone })
                : `${selectedLive.events.length} events around ${formatClock(selectedLive.events[0]?.start_ms, { tz: timezone })}`}
            </p>
            <IconButton
              label="Close event details"
              icon={<CloseIcon size={18} />}
              size="sm"
              onClick={() => setSelected(null)}
            />
          </div>
          <ul className="night-timeline__event-list">
            {selectedLive.events.map((event) => (
              <li key={event.id}>
                <EventDetail
                  event={event}
                  timezone={timezone}
                  onCorrectEvent={onCorrectEvent}
                  busy={correctingEventId === event.id}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : night.events.length > 0 ? (
        <p className="night-timeline__hint">
          Tap a marker under the timeline for the time, what the monitor thought it heard, and the
          clip.
        </p>
      ) : null}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

/**
 * One `<pattern>` per sleep state. The stripes are painted in the *surface*
 * colour, so they read as the background cut out of a solid block — which
 * keeps a single set of patterns working in both themes without recolouring.
 */
function StatePatternDefs() {
  return (
    <defs>
      <pattern id="bm-pat-restless" width="7" height="7" patternUnits="userSpaceOnUse">
        <path d="M-1 6 L6 -1 M2 9 L9 2" className="night-timeline__cut" strokeWidth="2.4" />
      </pattern>
      <pattern id="bm-pat-settling" width="6" height="6" patternUnits="userSpaceOnUse">
        <path d="M-1 1 L1 -1 M-1 7 L7 -1 M5 7 L7 5" className="night-timeline__cut" strokeWidth="1.4" />
      </pattern>
      <pattern id="bm-pat-awake" width="6" height="6" patternUnits="userSpaceOnUse">
        <path d="M1.5 -1 L1.5 7" className="night-timeline__cut" strokeWidth="2.6" />
      </pattern>
      <pattern id="bm-pat-absent" width="8" height="8" patternUnits="userSpaceOnUse">
        <circle cx="2" cy="2" r="1.3" className="night-timeline__cut-fill" />
        <circle cx="6" cy="6" r="1.3" className="night-timeline__cut-fill" />
      </pattern>
      <pattern id="bm-pat-unknown" width="7" height="7" patternUnits="userSpaceOnUse">
        <path d="M-1 6 L6 -1 M-1 1 L8 10" className="night-timeline__cut" strokeWidth="1.2" />
        <path d="M-1 -1 L8 8" className="night-timeline__cut" strokeWidth="1.2" />
      </pattern>
    </defs>
  );
}

const STATE_PATTERN: Record<SleepState, string | null> = {
  asleep: null,
  restless: 'bm-pat-restless',
  settling: 'bm-pat-settling',
  awake: 'bm-pat-awake',
  absent: 'bm-pat-absent',
  unknown: 'bm-pat-unknown',
};

function GridAndAxis({
  x,
  width,
  timezone,
}: {
  x: Scale;
  width: number;
  timezone?: Timezone | null;
}) {
  const ticks = x.ticks(Math.max(3, Math.floor(width / 78)));
  return (
    <g className="night-timeline__axis">
      {ticks.map((tick) => {
        const px = x(tick);
        // Nudge the first and last labels inwards so they are not half cut off.
        const anchor = px < 24 ? 'start' : px > width - 24 ? 'end' : 'middle';
        const labelX = anchor === 'start' ? PAD_X : anchor === 'end' ? width - PAD_X : px;
        return (
          <g key={tick}>
            <line
              className="night-timeline__grid"
              x1={px}
              x2={px}
              y1={BAND_Y}
              y2={MOTION_Y + MOTION_H}
            />
            <text className="night-timeline__tick" x={labelX} y={AXIS_Y + 12} textAnchor={anchor}>
              {formatClock(tick, { tz: timezone })}
            </text>
          </g>
        );
      })}
      <line
        className="night-timeline__axis-line"
        x1={PAD_X}
        x2={width - PAD_X}
        y1={MOTION_Y + MOTION_H}
        y2={MOTION_Y + MOTION_H}
      />
    </g>
  );
}

function SleepBand({
  segments,
  x,
  timezone,
}: {
  segments: readonly SleepSegment[];
  x: Scale;
  timezone?: Timezone | null;
}) {
  return (
    <g className="night-timeline__band">
      <rect
        className="night-timeline__band-bg"
        x={PAD_X}
        y={BAND_Y}
        width={Math.max(0, x.range[1] - PAD_X)}
        height={BAND_H}
        rx={6}
      />
      {segments.map((segment) => {
        const left = x(segment.start_ms);
        const right = x(segment.end_ms);
        const w = Math.max(1, right - left);
        const pattern = STATE_PATTERN[segment.state];
        const label = sleepStateLabel(segment.state);
        return (
          <g key={segment.id} className={sleepStateClass(segment.state)}>
            <title>
              {`${label}, ${formatDuration((segment.end_ms - segment.start_ms) / 60000)}, ${formatClock(segment.start_ms, { tz: timezone })}–${formatClock(segment.end_ms, { tz: timezone })}`}
            </title>
            <rect className="night-timeline__segment" x={left} y={BAND_Y} width={w} height={BAND_H} />
            {pattern ? (
              <rect
                x={left}
                y={BAND_Y}
                width={w}
                height={BAND_H}
                fill={`url(#${pattern})`}
                stroke="none"
              />
            ) : null}
            {w >= 54 ? (
              <text
                className="night-timeline__segment-label"
                x={left + w / 2}
                y={BAND_Y + BAND_H / 2 + 4}
                textAnchor="middle"
              >
                {label}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

function OnsetMarker({
  night,
  x,
  timezone,
}: {
  night: NightDetail;
  x: Scale;
  timezone?: Timezone | null;
}) {
  const bedtime = night.bedtime_ms;
  const onset = night.sleep_onset_ms;
  if (onset === null) return null;

  const onsetX = x(onset);
  const bracketFrom = bedtime === null ? null : x(bedtime);
  const showLabel = bracketFrom !== null && onsetX - bracketFrom >= 46;

  return (
    <g className="night-timeline__onset">
      {bracketFrom !== null ? (
        <>
          <path
            className="night-timeline__bracket"
            d={`M${bracketFrom} ${BAND_Y - 5} L${bracketFrom} ${BAND_Y - 11} L${onsetX} ${BAND_Y - 11} L${onsetX} ${BAND_Y - 5}`}
          />
          {showLabel ? (
            <text
              className="night-timeline__bracket-label"
              x={(bracketFrom + onsetX) / 2}
              y={BAND_Y - 14}
              textAnchor="middle"
            >
              {formatDuration(night.sol_min)} to sleep
            </text>
          ) : null}
        </>
      ) : null}
      <line
        className="night-timeline__onset-line"
        x1={onsetX}
        x2={onsetX}
        y1={BAND_Y - 5}
        y2={BAND_Y + BAND_H}
      />
      <circle className="night-timeline__onset-dot" cx={onsetX} cy={BAND_Y - 5} r={3.5} />
      <title>{`Fell asleep at ${formatClock(onset, { tz: timezone })}`}</title>
    </g>
  );
}

function AwakeningTicks({ night, x }: { night: NightDetail; x: Scale }) {
  const awakenings: Awakening[] = deriveAwakenings(night.segments, {
    sleepOnsetMs: night.sleep_onset_ms,
    finalWakeMs: night.final_wake_ms,
  });
  if (awakenings.length === 0) return null;

  // Height encodes duration on a square-root scale: linear would let one
  // 90-minute waking flatten every five-minute one into the baseline.
  const longest = awakenings.reduce((max, item) => Math.max(max, item.minutes), 0);
  const height = (minutes: number): number =>
    4 + (Math.sqrt(Math.max(0, minutes)) / Math.sqrt(Math.max(longest, 1))) * 13;

  return (
    <g className="night-timeline__wakings">
      {awakenings.map((waking) => {
        const px = x(waking.start_ms);
        const h = height(waking.minutes);
        return (
          <g key={`${waking.start_ms}-${waking.index}`}>
            <title>{`Waking ${waking.index}, ${formatDuration(waking.minutes)}`}</title>
            <line
              className="night-timeline__waking"
              x1={px}
              x2={px}
              y1={BAND_Y}
              y2={BAND_Y - h}
              strokeWidth={Math.min(4, 2 + waking.minutes / 40)}
            />
          </g>
        );
      })}
    </g>
  );
}

function LongestBoutHighlight({ run, x }: { run: Span | null; x: Scale }) {
  if (!run) return null;
  const left = x(run.start_ms);
  const width = Math.max(2, x(run.end_ms) - left);
  if (width < 12) return null;

  return (
    <g className="night-timeline__longest">
      <title>{`Longest unbroken sleep, ${formatDuration(run.minutes)}`}</title>
      <rect
        className="night-timeline__longest-outline"
        x={left}
        y={BAND_Y - 1.5}
        width={width}
        height={BAND_H + 3}
        rx={6}
      />
      {width >= 90 ? (
        <text
          className="night-timeline__longest-label"
          x={left + width / 2}
          y={BAND_Y + BAND_H + 11}
          textAnchor="middle"
        >
          longest {formatDuration(run.minutes)}
        </text>
      ) : null}
    </g>
  );
}

function SoundLane({ points, x }: { points: readonly SeriesPoint[]; x: Scale }) {
  const extent = soundExtent(points);
  const y = linearScale({
    domain: [extent.min, extent.max],
    range: [SOUND_Y + SOUND_H, SOUND_Y],
    clamp: true,
  });
  const baseline = SOUND_Y + SOUND_H;

  const area = areaPath(
    points.map((point) => ({ x: x(point.ts_ms), y: point.sound_dbfs === null ? null : y(point.sound_dbfs) })),
    baseline,
  );
  const floor = linePath(
    points.map((point) => ({
      x: x(point.ts_ms),
      y: point.noise_floor_dbfs === null ? null : y(point.noise_floor_dbfs),
    })),
  );

  return (
    <g className="night-timeline__lane night-timeline__lane--sound">
      <rect
        className="night-timeline__lane-bg"
        x={PAD_X}
        y={SOUND_Y}
        width={Math.max(0, x.range[1] - PAD_X)}
        height={SOUND_H}
        rx={4}
      />
      {area ? <path className="night-timeline__sound-area" d={area} /> : null}
      {floor ? <path className="night-timeline__sound-floor" d={floor} /> : null}
      <text className="night-timeline__lane-label" x={PAD_X + 4} y={SOUND_Y + 11}>
        Sound
      </text>
      <text
        className="night-timeline__lane-scale"
        x={x.range[1] - 4}
        y={SOUND_Y + 11}
        textAnchor="end"
      >
        {formatDbfs(extent.max, { digits: 0, short: true })}
      </text>
      {floor ? (
        <text
          className="night-timeline__lane-scale"
          x={x.range[1] - 4}
          y={SOUND_Y + SOUND_H - 4}
          textAnchor="end"
        >
          noise floor
        </text>
      ) : null}
    </g>
  );
}

function MotionLane({ points, x }: { points: readonly SeriesPoint[]; x: Scale }) {
  const extent = motionExtent(points);
  const y = linearScale({
    domain: [extent.min, extent.max],
    range: [MOTION_Y + MOTION_H, MOTION_Y],
    clamp: true,
  });
  const area = areaPath(
    points.map((point) => ({ x: x(point.ts_ms), y: point.motion === null ? null : y(point.motion) })),
    MOTION_Y + MOTION_H,
  );

  return (
    <g className="night-timeline__lane night-timeline__lane--motion">
      <rect
        className="night-timeline__lane-bg"
        x={PAD_X}
        y={MOTION_Y}
        width={Math.max(0, x.range[1] - PAD_X)}
        height={MOTION_H}
        rx={4}
      />
      {area ? <path className="night-timeline__motion-area" d={area} /> : null}
      <text className="night-timeline__lane-label" x={PAD_X + 4} y={MOTION_Y + 10}>
        Motion
      </text>
    </g>
  );
}

function EventRail({
  clusters,
  selectedKey,
  hoveredKey,
}: {
  clusters: readonly EventCluster[];
  selectedKey: string | null;
  hoveredKey: string | null;
}) {
  return (
    <g className="night-timeline__rail">
      {clusters.map((cluster) => {
        const first = cluster.events[0];
        if (!first) return null;
        const active = cluster.key === selectedKey || cluster.key === hoveredKey;
        const severity = highestSeverity(cluster.events);
        const cy = RAIL_Y + 11;
        return (
          <g
            key={cluster.key}
            className={[
              'night-timeline__marker',
              `severity-${severity}`,
              active ? 'is-active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <line
              className="night-timeline__marker-stem"
              x1={cluster.x}
              x2={cluster.x}
              y1={RAIL_Y}
              y2={active ? BAND_Y : MOTION_Y + MOTION_H}
            />
            <EventGlyph kind={first.kind} x={cluster.x} y={cy} />
            {cluster.events.length > 1 ? (
              // Set as a superscript beside the glyph rather than under it:
              // below the rail is outside the viewBox and gets clipped.
              <text
                className="night-timeline__marker-count"
                x={cluster.x + 8}
                y={cy - 4}
                textAnchor="start"
              >
                {cluster.events.length}
              </text>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

/**
 * Shape carries the event kind, severity carries the colour. Two channels, so
 * an alert is still distinguishable from a note without either one.
 */
function EventGlyph({ kind, x, y }: { kind: BabyEvent['kind']; x: number; y: number }): ReactElement {
  const r = 5.5;
  switch (kind) {
    case 'audio':
      return <circle className="night-timeline__glyph" cx={x} cy={y} r={r} />;
    case 'motion':
      return (
        <path
          className="night-timeline__glyph"
          d={`M${x} ${y - r - 0.5} L${x + r + 0.5} ${y} L${x} ${y + r + 0.5} L${x - r - 0.5} ${y} Z`}
        />
      );
    case 'sleep':
      return (
        <rect className="night-timeline__glyph" x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1.5} />
      );
    case 'manual':
      return (
        <path
          className="night-timeline__glyph"
          d={`M${x} ${y - r - 1} L${x + r + 1} ${y + r} L${x - r - 1} ${y + r} Z`}
        />
      );
    case 'environment':
      return (
        <rect className="night-timeline__glyph" x={x - r - 1} y={y - 3} width={r * 2 + 2} height={6} rx={3} />
      );
    case 'system':
    default:
      return (
        <path
          className="night-timeline__glyph night-timeline__glyph--hollow"
          d={`M${x - r} ${y} L${x + r} ${y} M${x} ${y - r} L${x} ${y + r}`}
        />
      );
  }
}

// ---------------------------------------------------------------------------
// Tooltip and details
// ---------------------------------------------------------------------------

function HoverBubble({
  cluster,
  width,
  timezone,
}: {
  cluster: EventCluster;
  width: number;
  timezone?: Timezone | null;
}) {
  const BUBBLE = 190;
  const half = BUBBLE / 2;
  const left = Math.max(4, Math.min(cluster.x - half, width - BUBBLE - 4));
  const first = cluster.events[0];
  if (!first) return null;

  return (
    <div
      className="night-timeline__bubble"
      style={{ left, width: BUBBLE, bottom: RAIL_H + 6 }}
      aria-hidden="true"
    >
      <span className="night-timeline__bubble-time">
        {formatClock(first.start_ms, { tz: timezone })}
      </span>
      <span className="night-timeline__bubble-label">
        {cluster.events.length > 1
          ? `${cluster.events.length} events`
          : eventLabelText(effectiveLabel(first))}
      </span>
      {cluster.events.length === 1 && first.confidence !== null ? (
        <span className="night-timeline__bubble-meta">
          {formatPercent(first.confidence)} confident
        </span>
      ) : null}
    </div>
  );
}

function EventDetail({
  event,
  timezone,
  onCorrectEvent,
  busy,
}: {
  event: BabyEvent;
  timezone?: Timezone | null;
  onCorrectEvent?: (event: BabyEvent, correctedLabel: string | null) => void;
  busy?: boolean;
}) {
  const label = effectiveLabel(event);
  return (
    <article className="night-event">
      <header className="night-event__head">
        <span className="night-event__time" data-numeric>
          {formatClock(event.start_ms, { tz: timezone, seconds: true })}
        </span>
        <span className={isFalsePositive(event) ? 'night-event__label is-void' : 'night-event__label'}>
          {isFalsePositive(event) ? 'Not a real event' : eventLabelText(label)}
        </span>
        <SeverityBadge severity={event.severity} />
      </header>

      <dl className="night-event__facts">
        <div>
          <dt>Lasted</dt>
          <dd>{event.duration_s === null ? 'still open' : formatDuration(event.duration_s / 60)}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{event.confidence === null ? EM_DASH : formatPercent(event.confidence)}</dd>
        </div>
        {event.peak_dbfs !== null ? (
          <div>
            <dt>Peak</dt>
            <dd>{formatDbfs(event.peak_dbfs, { short: true })}</dd>
          </div>
        ) : null}
        {event.motion_peak !== null ? (
          <div>
            <dt>Motion</dt>
            <dd>{formatMotion(event.motion_peak)}</dd>
          </div>
        ) : null}
      </dl>

      {event.corrected_label !== null && event.corrected_label !== '' ? (
        <p className="night-event__corrected">
          You relabelled this from “{eventLabelText(event.label)}”.
        </p>
      ) : null}

      <ClipPlayer
        clips={event.media}
        label={`${eventLabelText(label)} at ${formatClock(event.start_ms, { tz: timezone })}`}
      />

      {onCorrectEvent ? (
        <EventLabelPicker
          event={event}
          busy={busy ?? false}
          onCorrect={(corrected) => onCorrectEvent(event, corrected)}
        />
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

const LEGEND_ORDER: readonly SleepState[] = ['asleep', 'restless', 'settling', 'awake', 'absent', 'unknown'];

function StateLegend({ segments }: { segments: readonly SleepSegment[] }) {
  const present = new Set(segments.map((segment) => segment.state));
  const states = LEGEND_ORDER.filter((state) => present.has(state));
  if (states.length === 0) return null;

  return (
    <ul className="night-timeline__legend">
      {states.map((state) => (
        <li key={state} className={`night-timeline__legend-item ${sleepStateClass(state)}`}>
          <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true" focusable="false">
            <rect className="night-timeline__segment" x="0" y="0" width="18" height="12" rx="2" />
            {STATE_PATTERN[state] ? (
              <rect x="0" y="0" width="18" height="12" rx="2" fill={`url(#${STATE_PATTERN[state]})`} stroke="none" />
            ) : null}
          </svg>
          {sleepStateLabel(state)}
        </li>
      ))}
      <li className="night-timeline__legend-item night-timeline__legend-item--outline">
        <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true" focusable="false">
          <rect
            className="night-timeline__longest-outline"
            x="1"
            y="1"
            width="16"
            height="10"
            rx="2"
          />
        </svg>
        Longest stretch
      </li>
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * An SVG area `d` that breaks at nulls. `linePath` in lib/scales does the
 * stroke version; an area additionally has to close each run down to the
 * baseline, otherwise a gap fills across itself.
 */
function areaPath(points: readonly { x: number; y: number | null }[], baseline: number): string {
  let path = '';
  let run: { x: number; y: number }[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const first = run[0] as { x: number; y: number };
    const last = run[run.length - 1] as { x: number; y: number };
    path += `M${first.x.toFixed(2)} ${baseline.toFixed(2)}`;
    for (const point of run) path += `L${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    path += `L${last.x.toFixed(2)} ${baseline.toFixed(2)}Z`;
    run = [];
  };

  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y) || !Number.isFinite(point.x)) {
      flush();
      continue;
    }
    run.push({ x: point.x, y: point.y });
  }
  flush();
  return path;
}

function clusterEvents(events: readonly BabyEvent[], x: Scale): EventCluster[] {
  const sorted = [...events].sort((a, b) => a.start_ms - b.start_ms);
  const clusters: EventCluster[] = [];

  for (const event of sorted) {
    const px = x(event.start_ms);
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(px - last.x) <= CLUSTER_PX) {
      last.events.push(event);
      // Anchor on the first event of the cluster rather than drifting the
      // marker rightwards as members are added.
      continue;
    }
    clusters.push({ key: `c${event.id}`, x: px, events: [event] });
  }
  return clusters;
}

function highestSeverity(events: readonly BabyEvent[]): BabyEvent['severity'] {
  let best: BabyEvent['severity'] = 'info';
  for (const event of events) {
    if (event.severity === 'alert') return 'alert';
    if (event.severity === 'notice') best = 'notice';
  }
  return best;
}

function clusterLabel(cluster: EventCluster, timezone?: Timezone | null): string {
  const first = cluster.events[0];
  if (!first) return 'Event';
  const time = formatClock(first.start_ms, { tz: timezone });
  if (cluster.events.length === 1) {
    const confidence =
      first.confidence === null ? '' : `, ${formatPercent(first.confidence)} confident`;
    return `${eventLabelText(effectiveLabel(first))} at ${time}${confidence}`;
  }
  return `${cluster.events.length} events around ${time}: ${cluster.events
    .map((event) => eventLabelText(effectiveLabel(event)))
    .join(', ')}`;
}

const HOVER_QUERY = '(hover: hover) and (pointer: fine)';

/** Resolved once and cached: `matchMedia` is not free and this never varies. */
let hoverMedia: MediaQueryList | null | undefined;

function getHoverMedia(): MediaQueryList | null {
  if (hoverMedia === undefined) {
    hoverMedia =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(HOVER_QUERY)
        : null;
  }
  return hoverMedia;
}

function subscribeHover(onChange: () => void): () => void {
  const media = getHoverMedia();
  if (!media) return () => {};
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function readHover(): boolean {
  return getHoverMedia()?.matches ?? false;
}

/**
 * Whether the primary pointer can hover. A phone reports `hover: none`, and a
 * hover bubble there is a tooltip that appears under the thumb that summoned
 * it and then refuses to leave.
 *
 * `useSyncExternalStore` rather than an effect: the media query is exactly the
 * external store this API exists for, and it gets the value right on the very
 * first render instead of flashing the wrong branch.
 */
function useHoverCapable(): boolean {
  return useSyncExternalStore(subscribeHover, readHover, () => false);
}

