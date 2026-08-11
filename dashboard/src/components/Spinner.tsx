import './Spinner.css';

export interface SpinnerProps {
  /** Pixel diameter. Default 18. */
  size?: number;
  /**
   * Announce the spinner to assistive tech with this label. Omit when the
   * spinner sits inside something that already has a busy state (a Button
   * with `loading`, a Card with `aria-busy`), so it is not announced twice.
   */
  label?: string;
  className?: string;
}

/**
 * An indeterminate progress ring.
 *
 * With `prefers-reduced-motion` the ring stops spinning and pulses its
 * opacity instead — still clearly "something is happening", without the
 * rotation that triggers vestibular discomfort.
 */
export function Spinner({ size = 18, label, className }: SpinnerProps) {
  return (
    <span
      className={['spinner', className ?? ''].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} focusable="false" aria-hidden="true">
        <circle className="spinner__track" cx="12" cy="12" r="9" />
        <circle className="spinner__head" cx="12" cy="12" r="9" />
      </svg>
      {label ? <span className="visually-hidden">{label}</span> : null}
    </span>
  );
}
