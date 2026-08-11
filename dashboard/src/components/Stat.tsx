import type { CSSProperties, ReactNode } from 'react';
import './Stat.css';

export type StatTone = 'neutral' | 'good' | 'warn' | 'bad';
export type StatSize = 'sm' | 'md' | 'lg' | 'hero';

export interface StatProps {
  label: ReactNode;
  /** Pre-formatted. Pass an em dash (never "NaN") for missing data. */
  value: ReactNode;
  /** Trailing unit, set smaller and quieter than the value. */
  unit?: ReactNode;
  /** A delta or comparison, under the value. */
  hint?: ReactNode;
  /**
   * Direction of the hint. Rendered as an arrow glyph as well as a colour, so
   * the meaning survives a greyscale screen or a colour-blind reader.
   */
  trend?: 'up' | 'down' | 'flat' | null;
  tone?: StatTone;
  size?: StatSize;
  icon?: ReactNode;
  className?: string;
}

const TREND_GLYPH: Record<'up' | 'down' | 'flat', string> = {
  up: '↑',
  down: '↓',
  flat: '→',
};

const TREND_WORD: Record<'up' | 'down' | 'flat', string> = {
  up: 'up',
  down: 'down',
  flat: 'unchanged',
};

/**
 * One number with its label. The building block of the live page and the
 * night summary.
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  trend = null,
  tone = 'neutral',
  size = 'md',
  icon,
  className,
}: StatProps) {
  return (
    <div
      className={['stat', `stat--${tone}`, `stat--${size}`, className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <div className="stat__label">
        {icon ? <span className="stat__icon">{icon}</span> : null}
        <span>{label}</span>
      </div>
      <p className="stat__value" data-numeric>
        {value}
        {unit ? <span className="stat__unit">{unit}</span> : null}
      </p>
      {hint ? (
        <p className="stat__hint">
          {trend ? (
            <>
              <span aria-hidden="true" className="stat__trend">
                {TREND_GLYPH[trend]}
              </span>
              <span className="visually-hidden">{TREND_WORD[trend]}, </span>
            </>
          ) : null}
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface StatGridProps {
  children: ReactNode;
  /** Minimum column width before the grid wraps. Default 8rem. */
  min?: string;
  className?: string;
}

/** Auto-fitting grid of Stats. Two-up at 390px, more as the screen allows. */
export function StatGrid({ children, min = '8rem', className }: StatGridProps) {
  return (
    <div
      className={['stat-grid', className ?? ''].filter(Boolean).join(' ')}
      style={{ '--stat-min': min } as CSSProperties}
    >
      {children}
    </div>
  );
}
