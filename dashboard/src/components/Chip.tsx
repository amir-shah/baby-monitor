import type { ReactNode } from 'react';
import { CloseIcon } from './Icons';
import './Chip.css';

export interface ChipProps {
  children: ReactNode;
  /** Value shown after the label, e.g. "44 min" on a duration tag. */
  value?: ReactNode;
  /** Makes the chip a toggle button rather than static text. */
  selected?: boolean;
  onClick?: () => void;
  /** Adds a remove affordance. Implies the chip is part of an editable set. */
  onRemove?: () => void;
  /** Used in the remove button's label: "Remove dessert before bed". */
  removeLabel?: string;
  icon?: ReactNode;
  className?: string;
  disabled?: boolean;
}

/**
 * A tag pill. Static by default; interactive when given `onClick` (a filter
 * toggle) or `onRemove` (an editable tag on a note).
 *
 * Selection is conveyed by a border and a check glyph as well as the fill, so
 * it reads correctly for someone who cannot see the fill colour.
 */
export function Chip({
  children,
  value,
  selected,
  onClick,
  onRemove,
  removeLabel,
  icon,
  className,
  disabled,
}: ChipProps) {
  const interactive = Boolean(onClick);
  const classes = ['chip', selected ? 'is-selected' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  const content = (
    <>
      {icon ? <span className="chip__icon">{icon}</span> : null}
      {selected && interactive ? (
        <span className="chip__check" aria-hidden="true">
          ✓
        </span>
      ) : null}
      <span className="chip__label">{children}</span>
      {value !== undefined && value !== null ? (
        <span className="chip__value" data-numeric>
          {value}
        </span>
      ) : null}
    </>
  );

  if (interactive) {
    return (
      <span className="chip-wrap">
        <button
          type="button"
          className={classes}
          aria-pressed={selected ?? false}
          onClick={onClick}
          disabled={disabled}
        >
          {content}
        </button>
        {onRemove ? <ChipRemove onRemove={onRemove} label={removeLabel} /> : null}
      </span>
    );
  }

  return (
    <span className={classes}>
      {content}
      {onRemove ? <ChipRemove onRemove={onRemove} label={removeLabel} inline /> : null}
    </span>
  );
}

function ChipRemove({
  onRemove,
  label,
  inline = false,
}: {
  onRemove: () => void;
  label?: string;
  inline?: boolean;
}) {
  return (
    <button
      type="button"
      className={inline ? 'chip__remove chip__remove--inline' : 'chip__remove'}
      onClick={onRemove}
      aria-label={label ? `Remove ${label}` : 'Remove'}
    >
      <CloseIcon size={13} />
    </button>
  );
}
