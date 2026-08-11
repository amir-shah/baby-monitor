/**
 * Temperature and humidity against the configured comfort band.
 *
 * The band comes from `GET /api/config` -> `environment.comfort`, which is the
 * same band the environment subscore and the `temp_high`/`humidity_low` alerts
 * use — so a reading that looks out of band here is the same judgement the
 * service itself will act on, rather than a second opinion invented by the UI.
 *
 * Out of band is signalled three ways: the marker sits outside the outlined
 * band, an arrow points the direction, and the status is written out.
 */

import type { ReactNode } from 'react';
import { EM_DASH } from '../../lib/format';
import './ComfortGauge.css';

export interface ComfortBand {
  min: number | null;
  max: number | null;
}

export interface ComfortGaugeProps {
  label: string;
  value: number | null;
  /** Pre-formatted, e.g. "20.8 °C". */
  display: string;
  band: ComfortBand;
  /** Axis bounds. Wide enough that a real reading is never off the end. */
  domain: readonly [number, number];
  icon: ReactNode;
  /** Words for below-band and above-band, e.g. "Cool" / "Warm". */
  lowWord: string;
  highWord: string;
  /** Screen-reader unit name, e.g. "degrees Celsius". */
  unitName: string;
}

type Verdict = 'unknown' | 'low' | 'ok' | 'high' | 'no-band';

function judge(value: number | null, band: ComfortBand): Verdict {
  if (value === null) return 'unknown';
  if (band.min === null && band.max === null) return 'no-band';
  if (band.min !== null && value < band.min) return 'low';
  if (band.max !== null && value > band.max) return 'high';
  return 'ok';
}

function pct(value: number, domain: readonly [number, number]): number {
  const [low, high] = domain;
  if (high === low) return 0;
  return Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
}

export function ComfortGauge({
  label,
  value,
  display,
  band,
  domain,
  icon,
  lowWord,
  highWord,
  unitName,
}: ComfortGaugeProps) {
  const verdict = judge(value, band);

  const status =
    verdict === 'ok'
      ? 'Comfortable'
      : verdict === 'low'
        ? lowWord
        : verdict === 'high'
          ? highWord
          : verdict === 'no-band'
            ? 'No comfort band set'
            : 'No reading';

  const glyph = verdict === 'low' ? '↓' : verdict === 'high' ? '↑' : verdict === 'ok' ? '✓' : null;

  const bandStart = band.min === null ? 0 : pct(band.min, domain);
  const bandEnd = band.max === null ? 100 : pct(band.max, domain);
  const bandWidth = Math.max(0, bandEnd - bandStart);
  const markerPct = value === null ? null : pct(value, domain);

  const bandText =
    band.min !== null && band.max !== null
      ? `Comfort band ${band.min} to ${band.max} ${unitName}`
      : band.min !== null
        ? `Comfort band from ${band.min} ${unitName}`
        : band.max !== null
          ? `Comfort band up to ${band.max} ${unitName}`
          : 'No comfort band configured';

  const spoken = value === null ? 'no reading' : `${value} ${unitName}, ${status}`;

  return (
    <div className={`comfort comfort--${verdict}`}>
      <p className="comfort__label">
        <span className="comfort__icon" aria-hidden="true">
          {icon}
        </span>
        {label}
      </p>

      <p className="comfort__value" data-numeric>
        {value === null ? EM_DASH : display}
      </p>

      <p className="comfort__status">
        {glyph ? (
          <span className="comfort__glyph" aria-hidden="true">
            {glyph}
          </span>
        ) : null}
        {status}
      </p>

      <div
        className="comfort__track"
        role="img"
        aria-label={`${label}: ${spoken}. ${bandText}.`}
      >
        {verdict === 'no-band' ? null : (
          <span
            className="comfort__band"
            style={{ insetInlineStart: `${bandStart}%`, inlineSize: `${bandWidth}%` }}
          />
        )}
        {markerPct === null ? null : (
          <span className="comfort__marker" style={{ insetInlineStart: `${markerPct}%` }} />
        )}
      </div>

      <p className="comfort__range" aria-hidden="true">
        <span>{domain[0]}</span>
        <span>{domain[1]}</span>
      </p>
    </div>
  );
}
