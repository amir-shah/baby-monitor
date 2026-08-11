import { useState } from 'react';
import { eventLabelText } from '../lib/format';
import { effectiveLabel, isFalsePositive } from '../lib/types';
import type { BabyEvent, EventKind } from '../lib/types';
import './EventLabelPicker.css';

export interface EventLabelPickerProps {
  event: BabyEvent;
  /**
   * `''` marks a false positive, `null` clears a previous correction, anything
   * else is the corrected label. Maps straight onto `PATCH /api/events/{id}`
   * `{corrected_label}`.
   */
  onCorrect: (correctedLabel: string | null) => void;
  busy?: boolean;
  /** Collapse the label list behind a "Wrong?" button, for a dense table row. */
  collapsible?: boolean;
  className?: string;
}

/**
 * The labels offered per kind. Not the whole `EventLabel` vocabulary — a list
 * of thirty is a list nobody reads at 3am. These are the corrections that
 * actually get made: what the detector confuses with what.
 */
const SUGGESTIONS: Record<EventKind, readonly string[]> = {
  audio: ['cry', 'fuss', 'whimper', 'scream', 'talk', 'cough', 'snore', 'laugh', 'door', 'noise'],
  motion: ['motion', 'restless', 'still'],
  sleep: ['awakening', 'back_to_sleep', 'sleep_onset', 'final_wake', 'out_of_bed', 'returned_to_bed'],
  environment: ['temp_high', 'temp_low', 'humidity_high', 'humidity_low'],
  manual: ['checked_in', 'fed', 'diaper', 'medicine', 'note'],
  system: [],
};

/**
 * One-tap correction of an event's label.
 *
 * This is the feedback loop that makes the detector better, so it is a row of
 * buttons rather than a menu inside a dialog: every correction a parent is
 * willing to make is one they made because it cost them a single tap.
 *
 * "Not a real event" is separated from the labels and sends `corrected_label:
 * ""`, which is what the tuning report counts as a false positive. Undo sends
 * `null`, returning the event to whatever the detector said.
 */
export function EventLabelPicker({
  event,
  onCorrect,
  busy = false,
  collapsible = false,
  className,
}: EventLabelPickerProps) {
  const [expanded, setExpanded] = useState(!collapsible);
  const corrected = event.corrected_label !== null;
  const current = effectiveLabel(event);
  const voided = isFalsePositive(event);

  const options = SUGGESTIONS[event.kind] ?? [];
  // Keep the detector's own label in the list even when it is not a usual
  // suspect for this kind, so "actually it was right" is one tap too.
  const labels = options.includes(event.label) ? options : [event.label, ...options];

  if (collapsible && !expanded) {
    return (
      <div className={['label-picker', 'label-picker--collapsed', className ?? ''].filter(Boolean).join(' ')}>
        {corrected ? (
          <button type="button" className="label-picker__undo" onClick={() => onCorrect(null)} disabled={busy}>
            Undo correction
          </button>
        ) : (
          <button
            type="button"
            className="label-picker__open"
            onClick={() => setExpanded(true)}
            aria-label={`Correct the label for ${eventLabelText(current)}`}
          >
            Wrong?
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className={['label-picker', className ?? ''].filter(Boolean).join(' ')}
      aria-busy={busy || undefined}
    >
      <p className="label-picker__prompt" id={`lp-${event.id}`}>
        {corrected ? 'You corrected this to:' : 'Was this right?'}
      </p>

      <div className="label-picker__row" role="group" aria-labelledby={`lp-${event.id}`}>
        <button
          type="button"
          className={voided ? 'label-picker__void is-active' : 'label-picker__void'}
          aria-pressed={voided}
          disabled={busy}
          onClick={() => onCorrect(voided ? null : '')}
        >
          <span aria-hidden="true">✕</span> Not an event
        </button>

        {labels.map((label) => {
          const active = !voided && current === label;
          return (
            <button
              key={label}
              type="button"
              className={active ? 'label-picker__label is-active' : 'label-picker__label'}
              aria-pressed={active}
              disabled={busy}
              onClick={() => onCorrect(active && corrected ? null : label)}
            >
              {active ? <span aria-hidden="true">✓ </span> : null}
              {eventLabelText(label)}
            </button>
          );
        })}

        {corrected ? (
          <button type="button" className="label-picker__undo" onClick={() => onCorrect(null)} disabled={busy}>
            Undo
          </button>
        ) : null}
      </div>
    </div>
  );
}
