/**
 * The note composer, as a dialog.
 *
 * A thin wrapper: all of the behaviour lives in {@link NoteComposer}, so a
 * note written from the Live page at 3am and one written on the Notes page
 * over coffee produce byte-identical records. The dialog exists because the
 * Live page has no room for an always-open form and, on a phone, a bottom
 * sheet is where a thumb already is.
 *
 * The form is keyed by what it is editing, so the composer is a fresh mount
 * every time the dialog opens: cancelling a note leaves nothing behind, and
 * the next person to reach for it gets an empty form rather than yesterday's
 * half-written thought.
 */

import { Modal } from './Modal';
import { NoteComposer } from './NoteComposer';
import { nightOf as currentNightOf } from '../lib/format';
import type { NightOf, Note, Timezone } from '../lib/types';

export interface NoteComposerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Required to save. When absent the form explains why it cannot. */
  childId: number | undefined;
  /** The night the note belongs to. Defaults to the current night. */
  nightOf?: NightOf | undefined;
  /** Editing an existing note rather than writing a new one. */
  note?: Note | null;
  /** Tag slugs to start with, e.g. the chip that opened the dialog. */
  initialTags?: readonly string[];
  timezone?: Timezone | null;
  boundaryHour?: number;
  onSaved?: (note: Note) => void;
}

export function NoteComposerDialog({
  open,
  onClose,
  childId,
  nightOf,
  note,
  initialTags,
  timezone,
  boundaryHour,
  onSaved,
}: NoteComposerDialogProps) {
  if (!open) return null;

  const night = nightOf ?? currentNightOf(Date.now(), { tz: timezone, boundaryHour });
  const key = `${note?.id ?? 'new'}|${night}|${(initialTags ?? []).join(',')}`;

  return (
    <Modal
      open
      onClose={onClose}
      title={note ? 'Edit note' : 'Add a note'}
      description="Anything worth remembering about tonight. Tags are what the analysis reads."
      closeOnBackdrop={false}
    >
      <NoteComposer
        key={key}
        childId={childId}
        nightOf={night}
        note={note}
        initialTags={initialTags}
        timezone={timezone}
        boundaryHour={boundaryHour}
        autoFocus
        onCancel={onClose}
        onSaved={(saved) => {
          onSaved?.(saved);
          onClose();
        }}
      />
    </Modal>
  );
}
