/**
 * The forest plot.
 *
 * One row per tag: a point at the raw difference in the metric's own units, a
 * whisker across the 95% interval, a marker whose *area* is the number of
 * tagged nights, and a vertical line at zero running through every row. Rows
 * whose interval crosses zero are grey and hollow; only rows the API marks
 * significant are allowed a filled, coloured marker.
 *
 * Everything that could mislead has a counterweight in the markup rather than
 * in a footnote:
 *
 *   - the interval is in the headline, always, so no point estimate stands
 *     alone;
 *   - a row that could be chance says so in words, not only by being grey;
 *   - the number of comparisons is stated above the list, because a reader who
 *     does not know the denominator cannot discount the row they are reading;
 *   - tags below the minimum-n gate are moved out of the plot entirely and
 *     given a progress counter, since a difference computed from four nights
 *     is not a small finding, it is not a finding;
 *   - the association note sits above the rows and cannot be dismissed.
 *
 * The plot is decorative for assistive tech: every row's SVG is aria-hidden
 * because the sentence beneath it says the same thing in full.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analytics as analyticsApi } from '../../lib/api';
import { Card, EmptyState, ErrorState, Skeleton } from '../../components';
import { AlertIcon, MoonIcon, TagIcon } from '../../components/Icons';
import { InfoTip } from '../../components/InfoTip';
import { formatCountOf, formatPValue, plural } from '../../lib/format';
import { linearScale, useResizeObserver } from '../../lib/scales';
import type { Scale } from '../../lib/scales';
import {
  PHRASES,
  TIER_BLURB,
  TIER_GLYPH,
  TIER_LABEL,
  buildFactorRows,
  buildWaitingRows,
  coverageNote,
  forestDomain,
  methodNote,
  multiplicityNote,
} from './factorModel';
import type { EvidenceTier, FactorRow, WaitingRow } from './factorModel';
import { metricSpec } from './metrics';
import type { MetricSpec } from './metrics';
import './FactorForest.css';

/** Signed tick label for the −1..+1 correlation axis: "−0.4", "+0.4". */
function formatSignedRhoTick(value: number): string {
  const rounded = Number(value.toFixed(1));
  if (rounded === 0) return '0';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const STRIP_H = 26;
const AXIS_H = 24;
const PAD_X = 10;
/** Smallest and largest marker radius. Area, not radius, tracks n. */
const R_MIN = 3.5;
const R_MAX = 9;
const CAP_H = 7;

export interface FactorForestProps {
  childId: number | undefined;
  days: number;
  metricKey: string;
  /** `analytics.min_nights_per_group`. Drives the progress counters. */
  minN: number;
  /** `analytics.min_span_fraction`. */
  spanThreshold?: number;
  /** `analytics.fdr_q`, for the multiplicity note when the API omits alpha. */
  fdrQ?: number | null;
  /** The outcome picker, rendered in the card header. */
  controls?: ReactNode;
}

export function FactorForest({
  childId,
  days,
  metricKey,
  minN,
  spanThreshold,
  fdrQ,
  controls,
}: FactorForestProps) {
  const spec = useMemo(() => metricSpec(metricKey), [metricKey]);

  const query = useQuery({
    queryKey: ['analytics', 'factors', childId ?? null, days, metricKey, minN],
    queryFn: ({ signal }) =>
      analyticsApi.factors({ child_id: childId, days, metric: metricKey, min_n: minN }, signal),
    staleTime: 5 * 60_000,
  });

  const data = query.data;

  const built = useMemo(
    () => buildFactorRows(data, spec, spanThreshold === undefined ? {} : { spanThreshold }),
    [data, spec, spanThreshold],
  );

  const waiting = useMemo(() => buildWaitingRows(data?.insufficient, minN), [data, minN]);

  return (
    <Card
      title="What went with better and worse nights"
      subtitle={coverageNote(data) ?? `Tags applied over the last ${days} nights.`}
      actions={controls}
      className="forest-card"
    >
      <p className="forest__association" role="note">
        {PHRASES.association}
      </p>

      {query.isPending ? (
        <ForestSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} size="sm" />
      ) : (
        <ForestBody
          spec={spec}
          groups={built.groups}
          correlations={built.correlations}
          bestTier={built.bestTier}
          multiplicity={multiplicityNote(data, fdrQ)}
          downgrade={methodNote(data)}
          disclaimer={data?.disclaimer ?? null}
          waiting={waiting}
          minN={minN}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

interface ForestBodyProps {
  spec: MetricSpec;
  groups: FactorRow[];
  correlations: FactorRow[];
  bestTier: EvidenceTier | null;
  multiplicity: string | null;
  downgrade: string | null;
  disclaimer: string | null;
  waiting: WaitingRow[];
  minN: number;
}

function ForestBody({
  spec,
  groups,
  correlations,
  bestTier,
  multiplicity,
  downgrade,
  disclaimer,
  waiting,
  minN,
}: ForestBodyProps) {
  const [plotRef, size] = useResizeObserver<HTMLDivElement>();
  const width = Math.max(0, size.width);
  const hasRows = groups.length > 0 || correlations.length > 0;

  return (
    <div className="forest" ref={plotRef}>
      {multiplicity ? <p className="forest__multiplicity">{multiplicity}</p> : null}
      {downgrade ? <p className="forest__downgrade">{downgrade}</p> : null}

      {hasRows ? <TierLegend /> : null}

      {!hasRows ? (
        <div className="forest__empty">
          <EmptyState
            icon={<MoonIcon size={30} />}
            title={PHRASES.emptyTitle}
            description={PHRASES.emptyBody}
            size="sm"
          />
        </div>
      ) : (
        <>
          {bestTier === 'exploratory' ? (
            <div className="forest__quiet" role="note">
              <p className="forest__quiet-title">{PHRASES.quietTitle}</p>
              <p className="forest__quiet-body">{PHRASES.quietBody}</p>
            </div>
          ) : null}

          {groups.length > 0 ? (
            <ForestGroup
              rows={groups}
              width={width}
              lowCaption={spec.phrase('down')}
              highCaption={spec.phrase('up')}
              formatTick={(value) => spec.formatBound(value)}
              unit={spec.unit}
            />
          ) : null}

          {correlations.length > 0 ? (
            <section className="forest__section">
              <h3 className="forest__section-title">Tags with an amount</h3>
              <p className="forest__section-note">
                These carry a value rather than a yes or no, so they are compared as a rank
                correlation from −1 to +1 instead of a difference in minutes.
              </p>
              <ForestGroup
                rows={correlations}
                width={width}
                lowCaption={`more of the tag, ${spec.phrase('down')}`}
                highCaption={`more of the tag, ${spec.phrase('up')}`}
                formatTick={formatSignedRhoTick}
                unit=""
              />
            </section>
          ) : null}
        </>
      )}

      {waiting.length > 0 ? <WaitingSection rows={waiting} minN={minN} /> : null}

      {disclaimer ? <p className="forest__disclaimer">{disclaimer}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One axis and the rows under it
// ---------------------------------------------------------------------------

interface ForestGroupProps {
  rows: FactorRow[];
  width: number;
  lowCaption: string;
  highCaption: string;
  formatTick: (value: number) => string;
  unit: string;
}

function ForestGroup({ rows, width, lowCaption, highCaption, formatTick, unit }: ForestGroupProps) {
  const domain = useMemo(() => forestDomain(rows), [rows]);
  const maxN = useMemo(() => Math.max(1, ...rows.map((row) => row.markerN)), [rows]);

  const scale = useMemo(
    () => linearScale({ domain, range: [PAD_X, Math.max(PAD_X + 1, width - PAD_X)] }),
    [domain, width],
  );

  const ticks = useMemo(() => {
    if (width <= 0) return [] as number[];
    const count = width < 380 ? 3 : 5;
    return scale.ticks(count);
  }, [scale, width]);

  return (
    <div className="forest__group">
      {width > 0 ? (
        <ForestAxis scale={scale} width={width} ticks={ticks} formatTick={formatTick} />
      ) : null}

      <div className="forest__captions" aria-hidden="true">
        <span className="forest__caption">← {lowCaption}</span>
        {unit ? <span className="forest__caption forest__caption--unit">{unit}</span> : null}
        <span className="forest__caption forest__caption--end">{highCaption} →</span>
      </div>

      <ol className="forest__rows">
        {rows.map((row) => (
          <ForestRow key={row.key} row={row} scale={scale} width={width} maxN={maxN} ticks={ticks} />
        ))}
      </ol>
    </div>
  );
}

function ForestAxis({
  scale,
  width,
  ticks,
  formatTick,
}: {
  scale: Scale;
  width: number;
  ticks: number[];
  formatTick: (value: number) => string;
}) {
  const zero = scale(0);
  return (
    <svg
      className="forest__axis"
      width={width}
      height={AXIS_H}
      viewBox={`0 0 ${width} ${AXIS_H}`}
      aria-hidden="true"
      focusable="false"
    >
      <line className="forest__axis-line" x1={PAD_X} y1={AXIS_H - 5} x2={width - PAD_X} y2={AXIS_H - 5} />
      {ticks.map((tick) => {
        const x = scale(tick);
        const isZero = Math.abs(tick) < 1e-9;
        return (
          <g key={tick}>
            <line
              className={isZero ? 'forest__axis-tick is-zero' : 'forest__axis-tick'}
              x1={x}
              y1={AXIS_H - 9}
              x2={x}
              y2={AXIS_H - 5}
            />
            <text className="forest__axis-label" x={x} y={AXIS_H - 13} textAnchor="middle">
              {isZero ? '0' : formatTick(tick)}
            </text>
          </g>
        );
      })}
      <line className="forest__zero" x1={zero} y1={AXIS_H - 9} x2={zero} y2={AXIS_H} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// A row
// ---------------------------------------------------------------------------

function ForestRow({
  row,
  scale,
  width,
  maxN,
  ticks,
}: {
  row: FactorRow;
  scale: Scale;
  width: number;
  maxN: number;
  ticks: number[];
}) {
  const tone = row.coloured ? row.tone : 'muted';

  return (
    <li className="forest-row" data-tier={row.tier} data-tone={tone}>
      <div className="forest-row__head">
        <span className="forest-row__label">{row.label}</span>
        <TierBadge tier={row.tier} />
      </div>

      <div className="forest-row__strip">
        {width > 0 ? (
          <RowStrip row={row} scale={scale} width={width} maxN={maxN} ticks={ticks} />
        ) : null}
      </div>

      <div className="forest-row__text">
        <p className="forest-row__headline" data-numeric>
          {row.headline}
        </p>
        <p className="forest-row__sentence">
          {row.sentence}
          {row.caution ? <span className="forest-row__caution"> {row.caution}</span> : null}
        </p>
        {row.caveats.length > 0 ? (
          <ul className="forest-row__caveats">
            {row.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="forest-row__meta">
        <span className="forest-row__n" data-numeric>
          {row.kind === 'group'
            ? `${row.nWith ?? '—'} / ${row.nWithout ?? '—'}`
            : formatCountOf(row.nWith, 'night')}
        </span>
        <span className="forest-row__n-caption">
          {row.kind === 'group' ? 'nights with / without' : 'nights compared'}
        </span>
        <span className="forest-row__q" data-numeric>
          q {formatPValue(row.qValue)}
        </span>
      </div>

      {row.flags.length > 0 ? (
        <ul className="forest-row__flags">
          {row.flags.map((flag) => (
            <li key={flag.kind} className="forest-flag" data-flag={flag.kind}>
              <AlertIcon size={13} className="forest-flag__icon" />
              <span>{flag.label}</span>
              <InfoTip term={flag.label} title="Why this is flagged">
                {flag.detail}
              </InfoTip>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The strip: a zero line, faint gridlines matching the axis ticks, the
 * interval as a capped whisker, and the point as a disc whose area is the
 * night count. Grey rows get a hollow disc so the difference survives
 * greyscale and colour blindness.
 */
function RowStrip({
  row,
  scale,
  width,
  maxN,
  ticks,
}: {
  row: FactorRow;
  scale: Scale;
  width: number;
  maxN: number;
  ticks: number[];
}) {
  const mid = STRIP_H / 2;
  const zero = scale(0);
  const clamp = (value: number): number => Math.min(width - 2, Math.max(2, value));

  const point = row.point === null ? null : clamp(scale(row.point));
  const low = row.ci ? clamp(scale(row.ci[0])) : null;
  const high = row.ci ? clamp(scale(row.ci[1])) : null;
  const radius = R_MIN + (R_MAX - R_MIN) * Math.sqrt(Math.min(1, row.markerN / maxN));

  return (
    <svg
      className="forest-strip"
      width={width}
      height={STRIP_H}
      viewBox={`0 0 ${width} ${STRIP_H}`}
      aria-hidden="true"
      focusable="false"
    >
      {ticks.map((tick) =>
        Math.abs(tick) < 1e-9 ? null : (
          <line
            key={tick}
            className="forest-strip__grid"
            x1={scale(tick)}
            y1={2}
            x2={scale(tick)}
            y2={STRIP_H - 2}
          />
        ),
      )}

      <line className="forest-strip__zero" x1={zero} y1={0} x2={zero} y2={STRIP_H} />

      {low !== null && high !== null ? (
        <>
          <line className="forest-strip__whisker" x1={low} y1={mid} x2={high} y2={mid} />
          <line
            className="forest-strip__cap"
            x1={low}
            y1={mid - CAP_H / 2}
            x2={low}
            y2={mid + CAP_H / 2}
          />
          <line
            className="forest-strip__cap"
            x1={high}
            y1={mid - CAP_H / 2}
            x2={high}
            y2={mid + CAP_H / 2}
          />
        </>
      ) : null}

      {point !== null ? (
        row.coloured ? (
          <circle className="forest-strip__point" cx={point} cy={mid} r={radius} />
        ) : (
          <circle className="forest-strip__point is-hollow" cx={point} cy={mid} r={radius} />
        )
      ) : null}
    </svg>
  );
}

function TierBadge({ tier }: { tier: EvidenceTier }) {
  return (
    <span className="tier" data-tier={tier} title={TIER_BLURB[tier]}>
      <span className="tier__glyph" aria-hidden="true">
        {TIER_GLYPH[tier]}
      </span>
      {TIER_LABEL[tier]}
    </span>
  );
}

function TierLegend() {
  const tiers: EvidenceTier[] = ['exploratory', 'suggestive', 'notable'];
  return (
    <dl className="tier-legend">
      {tiers.map((tier) => (
        <div key={tier} className="tier-legend__item">
          <dt>
            <TierBadge tier={tier} />
          </dt>
          <dd>{TIER_BLURB[tier]}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Below the gate
// ---------------------------------------------------------------------------

function WaitingSection({ rows, minN }: { rows: WaitingRow[]; minN: number }) {
  return (
    <section className="forest__section waiting">
      <h3 className="forest__section-title">
        Not enough nights yet
        <InfoTip term="Not enough nights yet" title="Why these are held back">
          Below about {minN} nights on each side, the only differences a comparison can detect are
          ones large enough to have been obvious anyway — and the few that clear the bar come back
          exaggerated. So these tags get a counter instead of a number.
        </InfoTip>
      </h3>
      <p className="forest__section-note">
        {rows.length} {plural(rows.length, 'tag')} still counting up. Nothing is wrong with them.
      </p>
      <ul className="waiting__list">
        {rows.map((row) => (
          <li key={row.key} className="waiting__item">
            <span className="waiting__icon" aria-hidden="true">
              <TagIcon size={14} />
            </span>
            <span className="waiting__label">{row.label}</span>
            <span className="waiting__progress">
              <span
                className="waiting__bar"
                style={{ width: `${Math.round(row.fraction * 100)}%` }}
                aria-hidden="true"
              />
            </span>
            <span className="waiting__count">{row.progressText}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ForestSkeleton() {
  return (
    <div className="forest__skeleton" aria-busy="true" aria-label="Loading the comparison">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="forest__skeleton-row">
          <Skeleton width="40%" />
          <Skeleton height={STRIP_H} shape="block" />
          <Skeleton width="70%" />
        </div>
      ))}
    </div>
  );
}
