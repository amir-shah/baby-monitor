/**
 * The headline row: four numbers and how each has moved against the window
 * immediately before this one.
 *
 * A delta is only shown when the API sends one. It never gets computed here
 * from two windows of different sizes, and a percentage change is never shown
 * for a metric where the absolute change is the meaningful quantity — "sleep
 * is up 4%" hides whether that is two minutes or half an hour.
 */

import { Card, ErrorState, Skeleton, Stat, StatGrid } from '../../components';
import { EM_DASH, plural } from '../../lib/format';
import type { AnalyticsSummary, MetricDelta } from '../../lib/types';
import { metricSpec } from './metrics';
import './SummaryHeader.css';

/** Short window on purpose: a delta over half a year is not news. */
export const SUMMARY_DAYS = 14;

const HEADLINE_METRICS = ['tst_min', 'sleep_efficiency', 'waso_min', 'quality_score'] as const;

export interface SummaryHeaderProps {
  summary: AnalyticsSummary | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
}

export function SummaryHeader({ summary, isPending, error, onRetry }: SummaryHeaderProps) {
  return (
    <Card
      title={`The last ${SUMMARY_DAYS} nights`}
      subtitle={
        summary
          ? `${summary.nights_analysable} of ${summary.nights_total} ${plural(summary.nights_total, 'night')} could be analysed. Changes are against the ${SUMMARY_DAYS} nights before these.`
          : `Compared with the ${SUMMARY_DAYS} nights before.`
      }
      className="summary-card"
    >
      {isPending ? (
        <StatGrid min="9rem">
          {HEADLINE_METRICS.map((key) => (
            <Skeleton key={key} height={64} shape="block" />
          ))}
        </StatGrid>
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} size="sm" />
      ) : (
        <StatGrid min="9rem">
          {HEADLINE_METRICS.map((key) => (
            <SummaryStat key={key} metricKey={key} entry={summary?.metrics?.[key]} />
          ))}
        </StatGrid>
      )}
    </Card>
  );
}

function SummaryStat({
  metricKey,
  entry,
}: {
  metricKey: string;
  entry: MetricDelta | undefined;
}) {
  const spec = metricSpec(metricKey);
  const value = entry?.value ?? null;
  const raw = entry?.delta ?? null;
  const delta = raw !== null && Number.isFinite(raw) ? raw : null;

  // `formatDiff` renders "±0" once the change rounds away at the metric's own
  // precision, which is the right definition of "unchanged" for the arrow too.
  const diffText = delta === null ? null : spec.formatDiff(delta);
  const direction: 'up' | 'down' | 'flat' =
    diffText === null || diffText.startsWith('±') ? 'flat' : delta !== null && delta > 0 ? 'up' : 'down';

  const better = entry?.better ?? spec.better;
  const tone =
    direction === 'flat'
      ? 'neutral'
      : (direction === 'up') === (better === 'higher')
        ? 'good'
        : 'bad';

  return (
    <Stat
      label={spec.label}
      value={value === null ? EM_DASH : spec.formatValue(value)}
      hint={diffText === null ? 'no earlier window to compare' : `${diffText} vs before`}
      trend={diffText === null ? null : direction}
      tone={tone}
      size="md"
    />
  );
}
