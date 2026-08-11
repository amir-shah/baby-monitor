import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import './InfoTip.css';

export interface InfoTipProps {
  /** What the term means, in plain English. */
  children: ReactNode;
  /**
   * The term being explained. Used to build the button's accessible name
   * ("What does sleep efficiency mean?"), so it must be the words on screen.
   */
  term: string;
  /** Heading inside the bubble. Defaults to `term`. */
  title?: ReactNode;
  size?: number;
  className?: string;
}

/** Distance from the trigger to the bubble, and from the bubble to the edge. */
const GAP = 8;
const MARGIN = 8;
const MAX_WIDTH = 320;

/**
 * The little "i" beside a piece of jargon.
 *
 * A `title` attribute would be the cheap version and it is the wrong one: it
 * needs a mouse to hover, never appears on a phone, and is invisible to a
 * screen reader that is not in browse mode. This is a real disclosure — a
 * button that toggles a real element — so the definition is reachable by tap,
 * by click and by keyboard, and it stays open until dismissed rather than
 * vanishing when the pointer drifts.
 *
 * The bubble is portalled to the body and positioned from the trigger's
 * bounding box so it is never clipped by a card's `overflow`, and it is
 * clamped to the viewport so it stays fully on screen at 390px wide.
 */
export function InfoTip({ children, term, title, size = 16, className }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bubbleId = useId();

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;

    const anchor = trigger.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    const width = Math.min(box.width || MAX_WIDTH, viewportWidth - MARGIN * 2);
    let left = anchor.left + anchor.width / 2 - width / 2;
    left = Math.max(MARGIN, Math.min(left, viewportWidth - width - MARGIN));

    // Below the trigger unless that would run off the bottom, in which case
    // above it — the usual case on a phone, where the metric being explained
    // is often near the fold.
    const below = anchor.bottom + GAP;
    const fitsBelow = below + box.height <= viewportHeight - MARGIN;
    const top = fitsBelow ? below : Math.max(MARGIN, anchor.top - GAP - box.height);

    setStyle({ left: Math.round(left), top: Math.round(top), width: Math.round(width) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const bubble = bubbleRef.current;
    bubble?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (bubbleRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onReflow = (): void => place();

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, place]);

  return (
    <span className={['infotip', className ?? ''].filter(Boolean).join(' ')}>
      <button
        ref={triggerRef}
        type="button"
        className="infotip__trigger"
        aria-expanded={open}
        aria-controls={open ? bubbleId : undefined}
        aria-label={`What does “${term}” mean?`}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
          className="infotip__glyph"
        >
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="4.6" r="0.95" fill="currentColor" stroke="none" />
          <path
            d="M8 7v5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={bubbleRef}
              id={bubbleId}
              role="note"
              tabIndex={-1}
              className="infotip__bubble"
              style={{ maxWidth: MAX_WIDTH, ...style }}
            >
              <p className="infotip__title">{title ?? term}</p>
              <div className="infotip__body">{children}</div>
              <button
                type="button"
                className="infotip__dismiss"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                Got it
              </button>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
