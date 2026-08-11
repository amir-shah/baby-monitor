import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Fill the container. Sensible for the primary action on a phone. */
  block?: boolean;
  /** Swaps the label for a spinner and disables the button. */
  loading?: boolean;
  /** Announced while `loading`. Default "Working". */
  loadingLabel?: string;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    block = false,
    loading = false,
    loadingLabel = 'Working',
    iconStart,
    iconEnd,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const classes = [
    'btn',
    `btn--${variant}`,
    `btn--${size}`,
    block ? 'btn--block' : '',
    loading ? 'is-loading' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <>
          <Spinner size={size === 'lg' ? 20 : 16} />
          <span className="visually-hidden">{loadingLabel}</span>
          {/* Kept in flow so the button does not change width mid-click. */}
          <span className="btn__label btn__label--hidden" aria-hidden="true">
            {children}
          </span>
        </>
      ) : (
        <>
          {iconStart ? <span className="btn__icon">{iconStart}</span> : null}
          {children ? <span className="btn__label">{children}</span> : null}
          {iconEnd ? <span className="btn__icon">{iconEnd}</span> : null}
        </>
      )}
    </button>
  );
});
