import { useId, useState } from 'react';
import { NIGHT_ANCHORS, fromLocalInputValue, toLocalInputValue } from '../lib/nightModel';
import type { Night, NightPatch, Timezone } from '../lib/types';
import { Button } from './Button';
import { Modal } from './Modal';
import { Toggle } from './Toggle';
import './NightAdjustDialog.css';

export interface NightAdjustDialogProps {
  open: boolean;
  onClose: () => void;
  night: Night;
  timezone?: Timezone | null;
  /** Only the fields that actually changed are passed. */
  onSave: (patch: NightPatch) => void;
  busy?: boolean;
}

/** Reasons people actually give. Free text is still accepted. */
const EXCLUDE_REASONS = [
  'Illness',
  'Travel',
  'Teething',
  'Guests staying',
  'Slept elsewhere',
  'Monitor moved',
  'Testing the setup',
];

type AnchorKey = (typeof NIGHT_ANCHORS)[number]['key'];

/**
 * Manual correction of the night: the four anchors, and whether the night
 * counts towards the analytics at all.
 *
 * Both halves exist because the detector is inferring from a microphone and a
 * camera, and sometimes it is simply wrong — it hears the door at 22:40 and
 * calls it bedtime, or the child slept in the car and none of tonight means
 * anything. Left uncorrected, one bad night quietly poisons every average and
 * every correlation drawn from it, so the fix has to be reachable from the
 * night you are looking at rather than buried in a settings screen.
 */
export function NightAdjustDialog(props: NightAdjustDialogProps) {
  // Unmounting while closed is what resets the form: a cancelled edit must not
  // still be sitting in the fields next time, and a background recompute must
  // not fight what is being typed. Fresh mount, fresh `useState` initialisers,
  // no reset effect to get wrong.
  if (!props.open) return null;
  return <AdjustForm {...props} />;
}

function AdjustForm({
  onClose,
  night,
  timezone,
  onSave,
  busy = false,
}: NightAdjustDialogProps) {
  const fieldId = useId();
  const reasonsId = useId();
  const [anchors, setAnchors] = useState<Record<AnchorKey, string>>(() => readAnchors(night, timezone));
  const [excluded, setExcluded] = useState(night.excluded);
  const [reason, setReason] = useState(night.exclude_reason ?? '');

  const submit = (): void => {
    const patch: NightPatch = {};

    for (const anchor of NIGHT_ANCHORS) {
      const before = toLocalInputValue(night[anchor.key], timezone);
      const after = anchors[anchor.key];
      if (before === after) continue;
      patch[anchor.key] = after === '' ? null : fromLocalInputValue(after, timezone);
    }

    if (excluded !== night.excluded) patch.excluded = excluded;
    const trimmed = reason.trim();
    if (excluded && trimmed !== (night.exclude_reason ?? '')) {
      patch.exclude_reason = trimmed || null;
    }
    if (!excluded && night.excluded) patch.exclude_reason = null;

    onSave(patch);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Correct this night"
      description="Saving triggers a recompute that keeps whatever you set here."
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            Save and recompute
          </Button>
        </>
      }
    >
      <div className="night-adjust">
        <fieldset className="night-adjust__group">
          <legend className="night-adjust__legend">The four anchors</legend>
          <p className="night-adjust__hint">
            Times are in the child&rsquo;s own timezone. Clear a field to hand it back to the
            detector.
          </p>
          {NIGHT_ANCHORS.map((anchor) => (
            <div className="night-adjust__field" key={anchor.key}>
              <label className="night-adjust__label" htmlFor={`${fieldId}-${anchor.key}`}>
                {anchor.label}
                <span className="night-adjust__label-hint">{anchor.hint}</span>
              </label>
              <input
                id={`${fieldId}-${anchor.key}`}
                className="night-adjust__input"
                type="datetime-local"
                value={anchors[anchor.key]}
                onChange={(event) =>
                  setAnchors((current) => ({ ...current, [anchor.key]: event.target.value }))
                }
              />
            </div>
          ))}
        </fieldset>

        <fieldset className="night-adjust__group">
          <legend className="night-adjust__legend">Analytics</legend>
          <Toggle
            checked={excluded}
            onChange={setExcluded}
            label="Leave this night out of the analytics"
            description="It stays in the record and you can still look at it; it just stops skewing the averages, the trends and the factor analysis."
          />
          {excluded ? (
            <div className="night-adjust__field">
              <label className="night-adjust__label" htmlFor={`${fieldId}-reason`}>
                Why
                <span className="night-adjust__label-hint">
                  Worth writing down — in six months this is the only record of what was unusual.
                </span>
              </label>
              <input
                id={`${fieldId}-reason`}
                className="night-adjust__input"
                type="text"
                value={reason}
                list={reasonsId}
                placeholder="Illness"
                onChange={(event) => setReason(event.target.value)}
              />
              <datalist id={reasonsId}>
                {EXCLUDE_REASONS.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </div>
          ) : null}
        </fieldset>
      </div>
    </Modal>
  );
}

function readAnchors(night: Night, timezone?: Timezone | null): Record<AnchorKey, string> {
  return {
    bedtime_ms: toLocalInputValue(night.bedtime_ms, timezone),
    sleep_onset_ms: toLocalInputValue(night.sleep_onset_ms, timezone),
    final_wake_ms: toLocalInputValue(night.final_wake_ms, timezone),
    out_of_bed_ms: toLocalInputValue(night.out_of_bed_ms, timezone),
  };
}
