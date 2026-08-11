/**
 * The one thing this page exists to answer: is the baby asleep, and for how
 * long.
 *
 * Everything about it is sized for a phone held at arm's length in the dark by
 * someone who is not fully awake — one word, one number, no abbreviations that
 * need decoding, and a shape that differs per state so it is recognisable
 * before it is read.
 */

import { SleepStateBadge } from '../../components';
import { formatClock, formatDuration, formatRelative, sleepStateLabel } from '../../lib/format';
import { sleepStateClass, sleepStateDash } from '../../lib/stateStyles';
import type { EpochMs, SleepState } from '../../lib/types';
import './SleepStateHero.css';

export interface SleepStateHeroProps {
  state: SleepState | undefined;
  /** `live.state_since_ms`. */
  sinceMs: EpochMs | null;
  /** `live.asleep_for_min`, only set while the state counts as sleep. */
  asleepForMin: number | null;
  /** Ticking clock. */
  now: number;
  /** When the state we are showing arrived. */
  receivedAt: EpochMs | null;
  /** True when the push channel is not delivering. */
  stale: boolean;
}

/** How each state reads in a full sentence, for the assistive-tech summary. */
const STATE_SENTENCE: Record<SleepState, string> = {
  asleep: 'Asleep',
  restless: 'Asleep but restless',
  settling: 'Settling down',
  awake: 'Awake in the cot',
  absent: 'Not in the cot',
  unknown: 'Not sure yet',
};

export function SleepStateHero({
  state,
  sinceMs,
  asleepForMin,
  now,
  receivedAt,
  stale,
}: SleepStateHeroProps) {
  const resolved: SleepState = state ?? 'unknown';
  const elapsedMin = sinceMs === null ? null : Math.max(0, now - sinceMs) / 60_000;
  const duration = formatDuration(elapsedMin, { style: 'hm' });

  // `asleep_for_min` is cumulative sleep this session, which is not the same
  // as time in the current state — a two-minute stir resets the state clock
  // but not the sleep total. Both are worth showing when they differ.
  const showTotal =
    asleepForMin !== null && elapsedMin !== null && Math.abs(asleepForMin - elapsedMin) > 2;

  return (
    <div className={['hero', sleepStateClass(resolved)].join(' ')}>
      <StateRing state={resolved} />

      <div className="hero__text">
        <p className="hero__state">{sleepStateLabel(resolved)}</p>

        <p className="hero__duration" data-numeric>
          {sinceMs === null ? (
            <span className="hero__unknown">Duration unknown</span>
          ) : (
            <>
              for <strong>{duration}</strong>
              <span className="hero__since"> · since {formatClock(sinceMs)}</span>
            </>
          )}
        </p>

        {showTotal ? (
          <p className="hero__total">
            {formatDuration(asleepForMin)} asleep in total this session
          </p>
        ) : null}

        <p className={stale ? 'hero__meta hero__meta--stale' : 'hero__meta'}>
          {receivedAt === null
            ? 'Waiting for the first reading…'
            : `Updated ${formatRelative(receivedAt, { now })}`}
          {stale ? ' · reconnecting' : null}
        </p>
      </div>

      {/* One clean sentence for a screen reader, instead of it stitching
          together the badge, the duration and the timestamp. */}
      <p className="visually-hidden" role="status">
        {STATE_SENTENCE[resolved]}
        {sinceMs === null ? '.' : ` for ${duration}, since ${formatClock(sinceMs)}.`}
      </p>

      <div className="hero__badge">
        <SleepStateBadge state={resolved} size="sm" />
      </div>
    </div>
  );
}

/**
 * A ring drawn with the state's own dash pattern.
 *
 * This is the non-colour channel: asleep is a solid ring, restless is coarsely
 * broken, settling finely stippled, awake widely gapped, absent nearly empty.
 * The pattern comes from `stateStyles` rather than a CSS variable because
 * Safari will not resolve `var()` inside a `stroke-dasharray` presentation
 * attribute.
 */
function StateRing({ state }: { state: SleepState }) {
  const dash = sleepStateDash(state);
  const radius = 30;
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      className="hero__ring"
      viewBox="0 0 72 72"
      width="72"
      height="72"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="hero__ring-track" cx="36" cy="36" r={radius} strokeWidth="5" />
      <circle
        className="hero__ring-arc"
        cx="36"
        cy="36"
        r={radius}
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={dash === undefined ? `${circumference}` : dash}
        transform="rotate(-90 36 36)"
      />
      {state === 'asleep' ? (
        <circle className="hero__ring-core" cx="36" cy="36" r="9" />
      ) : state === 'absent' ? null : (
        <circle
          className="hero__ring-core hero__ring-core--hollow"
          cx="36"
          cy="36"
          r="9"
          strokeWidth="3"
          strokeDasharray={dash}
        />
      )}
    </svg>
  );
}
