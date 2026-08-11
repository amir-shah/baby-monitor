import { useId } from 'react';
import type { ElementType, HTMLAttributes, ReactNode } from 'react';
import './Card.css';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /**
   * Rendered as an `<h2>` inside the card header. Widened from the DOM
   * `title` attribute (a string tooltip) to arbitrary nodes.
   */
  title?: ReactNode;
  /** Sits under the title, quieter. */
  subtitle?: ReactNode;
  /** Right-hand side of the header: a filter, a menu, a timestamp. */
  actions?: ReactNode;
  /** Pinned to the bottom, separated by a rule. */
  footer?: ReactNode;
  /** Removes the body padding, for a chart or a table that bleeds to the edge. */
  flush?: boolean;
  /** `section` by default; use `article` for a self-contained item. */
  as?: ElementType;
  children?: ReactNode;
}

/**
 * The one container in the kit. A card with a `title` labels itself via
 * `aria-labelledby`, so a screen-reader user landmark-hopping through the page
 * hears "Tonight so far, region" rather than "region".
 */
export function Card({
  title,
  subtitle,
  actions,
  footer,
  flush = false,
  as,
  className,
  children,
  ...rest
}: CardProps) {
  const Tag = (as ?? 'section') as ElementType;
  const headingId = useId();
  const hasHeader = Boolean(title || subtitle || actions);

  return (
    <Tag
      className={['card', flush ? 'card--flush' : '', className ?? ''].filter(Boolean).join(' ')}
      aria-labelledby={title ? headingId : undefined}
      {...rest}
    >
      {hasHeader ? (
        <header className="card__header">
          <div className="card__heading">
            {title ? (
              <h2 className="card__title" id={headingId}>
                {title}
              </h2>
            ) : null}
            {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}

      <div className="card__body">{children}</div>

      {footer ? <footer className="card__footer">{footer}</footer> : null}
    </Tag>
  );
}
