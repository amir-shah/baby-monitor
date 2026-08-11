import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './IconButton.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /**
   * Required. An icon-only control has no text, so this is the *only* thing a
   * screen reader has to go on — and it doubles as the tooltip.
   */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'solid' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Renders the pressed state of a toggle button. */
  pressed?: boolean;
  /** Suppress the native tooltip when the surrounding UI already explains it. */
  hideTitle?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    variant = 'ghost',
    size = 'md',
    pressed,
    hideTitle = false,
    className,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={['icon-btn', `icon-btn--${variant}`, `icon-btn--${size}`, className ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
      aria-pressed={pressed}
      title={hideTitle ? undefined : label}
      {...rest}
    >
      {icon}
    </button>
  );
});
