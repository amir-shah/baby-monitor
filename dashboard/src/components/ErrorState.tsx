import type { ReactNode } from 'react';
import { ApiError, NetworkError } from '../lib/api';
import { Button } from './Button';
import { AlertIcon, OfflineIcon, RefreshIcon } from './Icons';
import './States.css';

export interface ErrorStateProps {
  /** The thrown value, straight from TanStack Query or a try/catch. */
  error?: unknown;
  /** Overrides the message derived from `error`. */
  title?: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Turns a thrown value into something a tired human can act on.
 *
 * "Could not reach the monitor" and "the monitor said no" are different
 * problems with different fixes, so they get different words and different
 * icons — never a bare "Error: Failed to fetch".
 */
export function ErrorState({
  error,
  title,
  description,
  onRetry,
  retryLabel = 'Try again',
  size = 'md',
  className,
}: ErrorStateProps) {
  const derived = describeError(error);

  return (
    <div
      className={['state-block', 'state-block--error', `state-block--${size}`, className ?? '']
        .filter(Boolean)
        .join(' ')}
      role="alert"
    >
      <span className="state-block__icon" aria-hidden="true">
        {derived.offline ? <OfflineIcon size={size === 'sm' ? 22 : 28} /> : <AlertIcon size={size === 'sm' ? 22 : 28} />}
      </span>
      <p className="state-block__title">{title ?? derived.title}</p>
      {(description ?? derived.description) ? (
        <p className="state-block__description">{description ?? derived.description}</p>
      ) : null}
      {onRetry ? (
        <div className="state-block__action">
          <Button variant="secondary" onClick={onRetry} iconStart={<RefreshIcon size={16} />}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

interface DescribedError {
  title: string;
  description: string | null;
  offline: boolean;
}

/** Also useful on its own, for a toast message. */
export function describeError(error: unknown): DescribedError {
  if (error instanceof NetworkError) {
    return {
      title: 'Could not reach the monitor',
      description: 'The Pi may be off, or this device may be off the network.',
      offline: true,
    };
  }

  if (error instanceof ApiError) {
    if (error.isUnauthorized) {
      return { title: 'Session expired', description: 'Sign in again to continue.', offline: false };
    }
    if (error.isNotFound) {
      return { title: 'Not found', description: error.message, offline: false };
    }
    if (error.isTransient) {
      return {
        title: 'The monitor had a problem',
        description: error.message,
        offline: false,
      };
    }
    return { title: error.message || 'Something went wrong', description: null, offline: false };
  }

  if (error instanceof Error && error.message) {
    return { title: 'Something went wrong', description: error.message, offline: false };
  }

  return { title: 'Something went wrong', description: null, offline: false };
}
