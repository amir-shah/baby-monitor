import type { ReactNode } from 'react';
import './States.css';

export interface EmptyStateProps {
  title: ReactNode;
  /** Say what would put something here, not just that it is empty. */
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  /** `sm` for inside a card, `md` for a whole page. */
  size?: 'sm' | 'md';
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  size = 'md',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={['state-block', `state-block--${size}`, className ?? ''].filter(Boolean).join(' ')}
    >
      {icon ? (
        <span className="state-block__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="state-block__title">{title}</p>
      {description ? <p className="state-block__description">{description}</p> : null}
      {action ? <div className="state-block__action">{action}</div> : null}
    </div>
  );
}
