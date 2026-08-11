import { useId } from 'react';
import type { ReactNode } from 'react';
import './Toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Hide the label visually but keep it for assistive tech. */
  hideLabel?: boolean;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Label position. `end` (default) reads better in a settings list. */
  labelPosition?: 'start' | 'end';
}

/**
 * A switch.
 *
 * Built on a real `<button role="switch">` rather than a styled checkbox:
 * `aria-checked` is what screen readers announce as "on"/"off", and a button
 * cannot be submitted with a form by accident. The knob also moves *and* the
 * track gains a check/cross glyph, so the state is not carried by fill alone.
 */
export function Toggle({
  checked,
  onChange,
  label,
  hideLabel = false,
  description,
  disabled = false,
  className,
  labelPosition = 'end',
}: ToggleProps) {
  const labelId = useId();
  const descriptionId = useId();

  return (
    <div
      className={['toggle', `toggle--label-${labelPosition}`, className ?? '']
        .filter(Boolean)
        .join(' ')}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        className="toggle__control"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle__track">
          <span className="toggle__glyph toggle__glyph--on" aria-hidden="true">
            ✓
          </span>
          <span className="toggle__glyph toggle__glyph--off" aria-hidden="true">
            ✕
          </span>
          <span className="toggle__knob" />
        </span>
      </button>

      <div className={hideLabel ? 'visually-hidden' : 'toggle__text'}>
        <span className="toggle__label" id={labelId}>
          {label}
        </span>
        {description ? (
          <span className="toggle__description" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </div>
    </div>
  );
}
