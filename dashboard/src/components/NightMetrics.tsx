import { METRIC_DEFINITIONS } from '../lib/nightModel';
import type { MetricDefinition } from '../lib/nightModel';
import {
  EM_DASH,
  formatClock,
  formatCount,
  formatDuration,
  formatPercent,
} from '../lib/format';
import type { Night, Timezone } from '../lib/types';
import { InfoTip } from './InfoTip';
import './NightMetrics.css';

export interface NightMetricsProps {
  night: Night;
  timezone?: Timezone | null;
  className?: string;
}

interface RenderedMetric extends MetricDefinition {
  value: string;
  /** Shown under the value: context, not decoration. */
  note?: string | null;
}

/**
 * The eight numbers that describe a night.
 *
 * Every one of them is jargon — "WASO", "sleep onset latency", "efficiency"
 * are terms of art, and a parent reading this at 6am has not read a sleep
 * paper. So each carries its definition behind an info button rather than in
 * a caption nobody has room for on a 390px screen.
 */
export function NightMetrics({ night, timezone, className }: NightMetricsProps) {
  const metrics = METRIC_DEFINITIONS.map((definition) =>
    render(definition, night, timezone),
  );

  return (
    <dl className={['night-metrics', className ?? ''].filter(Boolean).join(' ')}>
      {metrics.map((metric) => (
        <div className="night-metrics__item" key={metric.key}>
          <dt className="night-metrics__label">
            <span>{metric.label}</span>
            <InfoTip term={metric.label} title={termTitle(metric)}>
              <p>{metric.definition}</p>
            </InfoTip>
          </dt>
          <dd className="night-metrics__value" data-numeric>
            {metric.value}
          </dd>
          {metric.note ? <dd className="night-metrics__note">{metric.note}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

function termTitle(metric: MetricDefinition): string {
  return metric.abbreviation ? `${metric.label} (${metric.abbreviation})` : metric.label;
}

function render(
  definition: MetricDefinition,
  night: Night,
  timezone?: Timezone | null,
): RenderedMetric {
  switch (definition.key) {
    case 'tib_min':
      return {
        ...definition,
        value: formatDuration(night.tib_min),
        note:
          night.bedtime_ms && night.out_of_bed_ms
            ? `${formatClock(night.bedtime_ms, { tz: timezone })} – ${formatClock(night.out_of_bed_ms, { tz: timezone })}`
            : null,
      };
    case 'tst_min':
      return {
        ...definition,
        value: formatDuration(night.tst_min),
        note:
          night.restless_min !== null && night.restless_min > 0
            ? `${formatDuration(night.restless_min)} of it restless`
            : null,
      };
    case 'sol_min':
      return { ...definition, value: formatDuration(night.sol_min) };
    case 'waso_min':
      return { ...definition, value: formatDuration(night.waso_min) };
    case 'awakenings':
      return {
        ...definition,
        value: formatCount(night.awakenings),
        note: night.cry_events > 0 ? `${night.cry_events} with crying` : null,
      };
    case 'longest_bout_min':
      return { ...definition, value: formatDuration(night.longest_bout_min) };
    case 'sleep_efficiency':
      return {
        ...definition,
        value: formatPercent(night.sleep_efficiency),
        note:
          night.sleep_efficiency === null
            ? null
            : night.sleep_efficiency >= 0.85
              ? 'settled'
              : 'a lot of time awake in bed',
      };
    case 'midpoint_ms':
    default:
      return {
        ...definition,
        value: night.midpoint_ms === null ? EM_DASH : formatClock(night.midpoint_ms, { tz: timezone }),
      };
  }
}
