import { useId } from 'react';
import { scoreComponentViews, scoreStatus } from '../lib/nightModel';
import type { ScoreComponentView } from '../lib/nightModel';
import { formatPercent, formatScore } from '../lib/format';
import type { Night } from '../lib/types';
import { InfoTip } from './InfoTip';
import './NightQualityScore.css';

export interface NightQualityScoreProps {
  night: Night;
  /** `scoring.min_coverage` from `GET /api/config`, if the page has it. */
  minCoverage?: number;
  className?: string;
}

const DIAL_SIZE = 132;
const DIAL_STROKE = 12;
const DIAL_R = (DIAL_SIZE - DIAL_STROKE) / 2;
const DIAL_C = 2 * Math.PI * DIAL_R;

/**
 * The night's quality score: the total, the word band, and where it came from.
 *
 * Two decisions worth stating.
 *
 * **No decimals, ever.** A score of 78.4 implies the monitor can tell 78.4
 * from 78.6, and it cannot — the inputs are a microphone and a camera looking
 * at a dark room. Rounding to whole numbers, and leading with a *word*, keeps
 * the reader's attention on the band rather than on noise.
 *
 * **A missing score explains itself.** Under about four months there is no
 * night-time pattern to score, and a night the sensors half-missed cannot be
 * scored honestly. Both cases show the reason where the number would be,
 * because a silent blank reads as a bug.
 */
export function NightQualityScore({ night, minCoverage, className }: NightQualityScoreProps) {
  const status = scoreStatus(night, minCoverage === undefined ? {} : { minCoverage });
  const components = scoreComponentViews(night);
  const headingId = useId();

  if (status.kind === 'unavailable') {
    return (
      <div className={['quality', 'quality--unavailable', className ?? ''].filter(Boolean).join(' ')}>
        <p className="quality__unavailable-title">{status.title}</p>
        <p className="quality__unavailable-reason">{status.reason}</p>
        {night.coverage !== null ? (
          <p className="quality__coverage">
            Sensor coverage {formatPercent(night.coverage)} of the night.
          </p>
        ) : null}
      </div>
    );
  }

  const dashOffset = DIAL_C * (1 - status.value / 100);

  return (
    <div
      className={['quality', `quality--${status.band.tone}`, className ?? ''].filter(Boolean).join(' ')}
    >
      <div className="quality__dial">
        <svg
          width={DIAL_SIZE}
          height={DIAL_SIZE}
          viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
          role="img"
          aria-labelledby={headingId}
        >
          <title id={headingId}>
            {`Quality score ${status.value} out of 100 — ${status.band.name}`}
          </title>
          <circle
            className="quality__dial-track"
            cx={DIAL_SIZE / 2}
            cy={DIAL_SIZE / 2}
            r={DIAL_R}
            strokeWidth={DIAL_STROKE}
          />
          <circle
            className="quality__dial-value"
            cx={DIAL_SIZE / 2}
            cy={DIAL_SIZE / 2}
            r={DIAL_R}
            strokeWidth={DIAL_STROKE}
            strokeDasharray={DIAL_C}
            strokeDashoffset={dashOffset}
            /* Start at twelve o'clock and run clockwise. */
            transform={`rotate(-90 ${DIAL_SIZE / 2} ${DIAL_SIZE / 2})`}
          />
        </svg>
        <div className="quality__dial-centre" aria-hidden="true">
          <span className="quality__number" data-numeric>
            {formatScore(status.value)}
          </span>
          <span className="quality__band">{status.band.name}</span>
        </div>
      </div>

      <div className="quality__breakdown">
        <StackedBar components={components} total={status.value} />
        <ul className="quality__components">
          {components.map((component, index) => (
            <ComponentRow key={component.key} component={component} index={index} />
          ))}
        </ul>
        <p className="quality__scale">
          Excellent 90+ · Good 80–89 · Fair 65–79 · Poor under 65
        </p>
      </div>
    </div>
  );
}

/**
 * The stacked bar. Each slice is the component's *contribution* — its share of
 * the available weight times its own score — so the slices add up to the total
 * in the dial rather than to some unrelated 100%.
 *
 * Slices are told apart by a hatch angle as well as a tint, and every slice is
 * named in the list underneath, so nothing here depends on distinguishing four
 * shades of one hue.
 */
function StackedBar({
  components,
  total,
}: {
  components: readonly ScoreComponentView[];
  total: number;
}) {
  const scored = components.filter((component) => component.score !== null);
  if (scored.length === 0) return null;

  return (
    <div
      className="quality__bar"
      role="img"
      aria-label={`Score of ${total} made up of ${scored
        .map(
          (component) =>
            `${component.label} ${Math.round((component.score ?? 0) * component.share)} points`,
        )
        .join(', ')}`}
    >
      {scored.map((component, index) => {
        const contribution = (component.score ?? 0) * component.share;
        return (
          <span
            key={component.key}
            className={`quality__slice quality__slice--${index % 5}`}
            style={{ width: `${contribution}%` }}
          />
        );
      })}
      <span className="quality__slice quality__slice--rest" style={{ width: `${Math.max(0, 100 - total)}%` }} />
    </div>
  );
}

function ComponentRow({ component, index }: { component: ScoreComponentView; index: number }) {
  const dropped = component.score === null;
  return (
    <li className={dropped ? 'quality__component is-dropped' : 'quality__component'}>
      <span className={`quality__swatch quality__slice--${index % 5}`} aria-hidden="true" />
      <span className="quality__component-name">
        {component.label}
        <InfoTip term={component.label} size={14}>
          <p>{component.definition}</p>
          <p>
            {dropped
              ? 'Not measurable on this night, so it was left out and the other parts were reweighted.'
              : `Worth ${formatPercent(component.share)} of tonight's score.`}
          </p>
        </InfoTip>
      </span>
      <span className="quality__component-score" data-numeric>
        {dropped ? 'not measured' : formatScore(component.score)}
      </span>
      {dropped && component.reason ? (
        <span className="quality__component-reason">{component.reason}</span>
      ) : null}
    </li>
  );
}
