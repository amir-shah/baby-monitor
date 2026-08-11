import type { CSSProperties } from 'react';
import './Skeleton.css';

export interface SkeletonProps {
  /** Any CSS length. Default `100%`. */
  width?: string | number;
  /** Any CSS length. Default `1em`, i.e. one line of text. */
  height?: string | number;
  /** `text` rounds like a line, `block` like a card, `circle` for an avatar. */
  shape?: 'text' | 'block' | 'circle';
  className?: string;
}

/**
 * A loading placeholder.
 *
 * Always `aria-hidden`: the *container* should carry `aria-busy` and a single
 * "Loading" announcement. A dozen skeletons each announcing themselves is
 * noise, especially on a page that refreshes every fifteen seconds.
 */
export function Skeleton({ width = '100%', height, shape = 'text', className }: SkeletonProps) {
  const style: CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: height === undefined ? undefined : typeof height === 'number' ? `${height}px` : height,
  };
  return (
    <span
      className={['skeleton', `skeleton--${shape}`, className ?? ''].filter(Boolean).join(' ')}
      style={style}
      aria-hidden="true"
    />
  );
}

/** A few lines of placeholder text, tapering like a real paragraph. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={['skeleton-text', className ?? ''].filter(Boolean).join(' ')} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} width={index === lines - 1 ? '60%' : '100%'} />
      ))}
    </span>
  );
}
