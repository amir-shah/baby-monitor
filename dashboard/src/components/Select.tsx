import { forwardRef, useId } from 'react';
import type { ForwardedRef, ReactElement, ReactNode, SelectHTMLAttributes } from 'react';
import { ChevronDownIcon } from './Icons';
import './Select.css';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'children' | 'size'> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  label: ReactNode;
  /** Keeps the label for assistive tech but not on screen. */
  hideLabel?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  size?: 'sm' | 'md';
  block?: boolean;
}

/**
 * A native `<select>` in a styled shell.
 *
 * Deliberately not a custom listbox: the native control gets the iOS wheel
 * picker, Android's bottom sheet, hardware keyboard type-ahead and VoiceOver
 * support for free, none of which a div-based replacement matches.
 */
function SelectInner<T extends string = string>(
  {
    value,
    onValueChange,
    options,
    label,
    hideLabel = false,
    hint,
    error,
    size = 'md',
    block = false,
    className,
    id,
    ...rest
  }: SelectProps<T>,
  ref: ForwardedRef<HTMLSelectElement>,
): ReactElement {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const hintId = `${selectId}-hint`;
  const errorId = `${selectId}-error`;

  return (
    <div
      className={['field', block ? 'field--block' : '', className ?? ''].filter(Boolean).join(' ')}
    >
      <label className={hideLabel ? 'visually-hidden' : 'field__label'} htmlFor={selectId}>
        {label}
      </label>

      <div className={['select', `select--${size}`, error ? 'is-invalid' : ''].filter(Boolean).join(' ')}>
        <select
          ref={ref}
          id={selectId}
          className="select__control"
          value={value}
          onChange={(event) => onValueChange(event.target.value as T)}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined
          }
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="select__chevron" size={18} />
      </div>

      {error ? (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `forwardRef` erases the generic, so it is re-applied by assertion. This is
 * the standard workaround for a generic forwardRef component and is safe: the
 * implementation signature above is the one that gets type-checked.
 */
export const Select = forwardRef(SelectInner) as <T extends string = string>(
  props: SelectProps<T> & { ref?: ForwardedRef<HTMLSelectElement> },
) => ReactElement;
