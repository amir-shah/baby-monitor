import type { ReactNode } from 'react';
import { sleepStateClass } from '../lib/stateStyles';
import { severityLabel, sleepStateLabel } from '../lib/format';
import type { Severity, SleepState } from '../lib/types';
import './Badge.css';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  /** Adds a leading dot. Decoration only — the text still says everything. */
  dot?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
}

/** A small, non-interactive status label. */
export function Badge({ children, tone = 'neutral', dot = false, size = 'md', className, title }: BadgeProps) {
  return (
    <span
      className={['badge', `badge--${tone}`, `badge--${size}`, className ?? '']
        .filter(Boolean)
        .join(' ')}
      title={title}
    >
      {dot ? <span className="badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export interface SleepStateBadgeProps {
  state: SleepState | null | undefined;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * The sleep state, as a badge.
 *
 * Colour is never the only signal: the state's *name* is always rendered, and
 * the leading marker uses the state's dash pattern so it differs by shape too.
 */
export function SleepStateBadge({ state, size = 'md', className }: SleepStateBadgeProps) {
  const resolved: SleepState = state ?? 'unknown';
  return (
    <span
      className={['badge', 'badge--state', `badge--${size}`, sleepStateClass(resolved), className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <StateMarker state={resolved} />
      {sleepStateLabel(resolved)}
    </span>
  );
}

/**
 * The per-state marker: a filled disc for asleep, and progressively more
 * broken rings as the child surfaces. Distinguishable without colour.
 */
function StateMarker({ state }: { state: SleepState }) {
  const dash: Record<SleepState, string | undefined> = {
    asleep: undefined,
    restless: '3 2',
    settling: '1 1.6',
    awake: '5 2.2',
    absent: '0.6 2.2',
    unknown: '1.6 1.6 0.6 1.6',
  };
  return (
    <svg
      className="badge__marker"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
    >
      {state === 'asleep' ? (
        <circle cx="6" cy="6" r="4" fill="currentColor" stroke="none" />
      ) : (
        <circle
          cx="6"
          cy="6"
          r="4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={dash[state]}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export interface SeverityBadgeProps {
  severity: Severity | null | undefined;
  size?: 'sm' | 'md';
  className?: string;
}

/** Event severity. Again: shape plus word, not colour alone. */
export function SeverityBadge({ severity, size = 'sm', className }: SeverityBadgeProps) {
  const resolved: Severity = severity ?? 'info';
  const glyph = resolved === 'alert' ? '▲' : resolved === 'notice' ? '◆' : '•';
  return (
    <span
      className={['badge', 'badge--severity', `badge--${size}`, `severity-${resolved}`, className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <span className="badge__glyph" aria-hidden="true">
        {glyph}
      </span>
      {severityLabel(resolved)}
    </span>
  );
}
