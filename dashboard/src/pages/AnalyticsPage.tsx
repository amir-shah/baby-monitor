/**
 * Analytics.
 *
 * This is the page where the product is most able to mislead someone, so the
 * order is deliberate: what happened lately, then what went with it (hedged
 * heavily), then the shape of the record itself. The uncertainty lives in the
 * components rather than in a disclaimer at the bottom that nobody reads —
 * every comparison carries its interval, the number of comparisons is stated,
 * and tags without enough nights are held back rather than shown small.
 *
 * Window and outcome live in the query string, so a particular view is a link.
 */

import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { analytics as analyticsApi } from '../lib/api';
import { Select } from '../components';
import { setDefaultTimezone, parseLocalTime, plural } from '../lib/format';
import { ActogramCard } from './analytics/Actogram';
import { FactorForest } from './analytics/FactorForest';
import { PatternsCard } from './analytics/PatternsCard';
import { RegularityCard } from './analytics/RegularityCard';
import { SUMMARY_DAYS, SummaryHeader } from './analytics/SummaryHeader';
import { WeeklyTrends } from './analytics/WeeklyTrends';
import { METRIC_OPTIONS, isKnownMetric } from './analytics/metrics';
import './AnalyticsPage.css';
import { useChildren, pickActiveChild } from '../hooks/useChildren';
import { useConfig } from '../hooks/useConfig';

/** Windows worth offering. Anything under a month cannot support a comparison. */
const WINDOW_CHOICES = [30, 60, 90, 180, 365] as const;

const FALLBACK_MIN_N = 10;
const FALLBACK_SPAN_FRACTION = 0.4;

export function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // -- Which child ----------------------------------------------------------

  const childrenQuery = useChildren();

  const childParam = Number(searchParams.get('child'));
  const child = useMemo(() => {
    const items = childrenQuery.data?.items ?? [];
    if (Number.isFinite(childParam) && childParam > 0) {
      const named = items.find((candidate) => candidate.id === childParam);
      if (named) return named;
    }
    return pickActiveChild(items);
  }, [childrenQuery.data, childParam]);

  // Every clock label on this page is the nursery's clock, not the phone's.
  useEffect(() => {
    setDefaultTimezone(child?.timezone ?? null);
  }, [child?.timezone]);

  // -- Config: the gates the analysis was run under -------------------------

  const configQuery = useConfig();

  const analyticsConfig = configQuery.data?.config.analytics;
  const minN = analyticsConfig?.min_nights_per_group ?? FALLBACK_MIN_N;
  const spanThreshold = readSpanFraction(analyticsConfig) ?? FALLBACK_SPAN_FRACTION;
  const defaultDays = analyticsConfig?.default_window_days ?? 180;
  const defaultMetric = analyticsConfig?.default_metric ?? 'quality_score';

  // -- Window and outcome ---------------------------------------------------

  const requestedDays = Number(searchParams.get('days'));
  const days =
    Number.isFinite(requestedDays) && requestedDays >= 7 && requestedDays <= 1095
      ? Math.round(requestedDays)
      : defaultDays;

  const requestedMetric = searchParams.get('metric');
  const metricKey = isKnownMetric(requestedMetric)
    ? (requestedMetric as string)
    : isKnownMetric(defaultMetric)
      ? defaultMetric
      : 'quality_score';

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const windowOptions = useMemo(() => {
    const values = new Set<number>([...WINDOW_CHOICES, days]);
    return [...values]
      .sort((a, b) => a - b)
      .map((value) => ({
        value: String(value),
        label: `${value} ${plural(value, 'night')}`,
      }));
  }, [days]);

  // -- Headline summary -----------------------------------------------------

  const childId = child?.id;

  const summaryQuery = useQuery({
    queryKey: ['analytics', 'summary', childId ?? null, SUMMARY_DAYS],
    queryFn: ({ signal }) =>
      analyticsApi.summary({ child_id: childId, days: SUMMARY_DAYS }, signal),
    staleTime: 5 * 60_000,
  });

  const targetBedtimeMin = parseLocalTime(child?.target_bedtime ?? null);

  return (
    <div className="analytics-page">
      <div className="analytics-page__controls">
        <Select
          label="Window"
          value={String(days)}
          onValueChange={(value) => setParam('days', value)}
          options={windowOptions}
          size="sm"
        />
        <p className="analytics-page__controls-note">
          The window applies to everything below except the headline row, which always compares the
          last {SUMMARY_DAYS} nights with the {SUMMARY_DAYS} before them.
        </p>
      </div>

      <SummaryHeader
        summary={summaryQuery.data}
        isPending={summaryQuery.isPending}
        error={summaryQuery.error}
        onRetry={() => void summaryQuery.refetch()}
      />

      <FactorForest
        childId={childId}
        days={days}
        metricKey={metricKey}
        minN={minN}
        spanThreshold={spanThreshold}
        fdrQ={analyticsConfig?.fdr_q ?? null}
        controls={
          <Select
            label="Compared against"
            value={metricKey}
            onValueChange={(value) => setParam('metric', value)}
            options={METRIC_OPTIONS}
            size="sm"
          />
        }
      />

      <WeeklyTrends
        childId={childId}
        days={days}
        targetBand={summaryQuery.data?.target_band ?? null}
      />

      <ActogramCard childId={childId} days={days} targetBedtimeMin={targetBedtimeMin} />

      <RegularityCard childId={childId} days={days} />

      <PatternsCard childId={childId} days={days} metricKey={metricKey} />

      <p className="analytics-page__export">
        Prefer to check the arithmetic yourself?{' '}
        <a href={analyticsApi.exportUrl({ child_id: childId, days, format: 'csv' })} download>
          Download the per-night matrix as CSV
        </a>
        . It is the same table every number on this page came from.
      </p>
    </div>
  );
}

/**
 * `analytics.min_span_fraction` is in the config file but not in the typed
 * subset of `/api/config`, so it is read defensively rather than by widening
 * a shared type.
 */
function readSpanFraction(config: unknown): number | null {
  if (typeof config !== 'object' || config === null) return null;
  const value = (config as { min_span_fraction?: unknown }).min_span_fraction;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
