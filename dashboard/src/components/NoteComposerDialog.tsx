/**
 * The note composer, as a dialog.
 *
 * Shared rather than page-local because the same act — "write down what
 * happened tonight" — is reachable from the Live page at 3am and from the
 * Notes journal in the morning, and it must produce identical records either
 * way. It is the only place in the dashboard that writes `POST /api/notes`.
 *
 * Tags carry their value inline, because the value *is* the observation: a
 * "screen before bed" tag without the 44 minutes on it is not much of a
 * finding. Which input appears is driven by the tag's `value_type`, so a tag
 * created after this was written still gets the right control.
 */

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './Button';
import { Chip } from './Chip';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { describeError } from './ErrorState';
import { useToast } from './Toast';
import { notes as notesApi, tags as tagsApi } from '../lib/api';
import { formatMinuteOfDay, parseLocalTime, tagCategoryLabel } from '../lib/format';
import type { NightOf, Note, NoteTagInput, TagWithStats } from '../lib/types';
import './NoteComposerDialog.css';

export interface NoteComposerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Required to save. When absent the form explains why it cannot. */
  childId: number | undefined;
  /** The night the note belongs to. Derived server-side when omitted. */
  nightOf?: NightOf | undefined;
  /** Editing an existing note rather than writing a new one. */
  note?: Note | null;
  /** Tag slugs to start with, e.g. the chip that opened the dialog. */
  initialTags?: readonly string[];
  onSaved?: (note: Note) => void;
}

type Selection = Record<string, NoteTagInput>;

function selectionFromNote(note: Note | null | undefined, initial: readonly string[]): Selection {
  const selection: Selection = {};
  for (const slug of initial) selection[slug] = { slug };
  for (const tag of note?.tags ?? []) {
    selection[tag.slug] = {
      slug: tag.slug,
      value_num: tag.value_num ?? null,
      value_min_local: tag.value_min_local ?? null,
      value_text: tag.value_text ?? null,
    };
  }
  return selection;
}

export function NoteComposerDialog({
  open,
  onClose,
  childId,
  nightOf,
  note,
  initialTags,
  onSaved,
}: NoteComposerDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [body, setBody] = useState('');
  const [selected, setSelected] = useState<Selection>({});
  const [showAllTags, setShowAllTags] = useState(false);

  const initialKey = (initialTags ?? []).join(',');

  // Reset every time the dialog opens, so a cancelled note is not half-there
  // the next time someone reaches for it.
  useEffect(() => {
    if (!open) return;
    setBody(note?.body ?? '');
    setSelected(selectionFromNote(note, initialTags ?? []));
    setShowAllTags(false);
    // `initialTags` is usually a literal; compare by content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, note, initialKey]);

  const tagsQuery = useQuery({
    queryKey: ['tags'],
    queryFn: ({ signal }) => tagsApi.list({}, signal),
    staleTime: 5 * 60_000,
    enabled: open,
  });

  const available = useMemo(() => {
    const items = (tagsQuery.data?.items ?? []).filter((tag) => !tag.archived);
    // Built-ins first, then alphabetical: the common ones stay where a thumb
    // learned to expect them even as the list grows.
    return [...items].sort((a, b) => {
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [tagsQuery.data]);

  const visible = showAllTags ? available : available.slice(0, 10);
  const selectedTags = available.filter((tag) => selected[tag.slug] !== undefined);

  const save = useMutation({
    mutationFn: async (): Promise<Note> => {
      if (childId === undefined) throw new Error('No child is selected.');
      const tagList = Object.values(selected);
      if (note) {
        return notesApi.update(note.id, { body: body.trim(), tags: tagList });
      }
      return notesApi.create({
        child_id: childId,
        night_of: nightOf,
        ts_ms: Date.now(),
        body: body.trim(),
        tags: tagList,
      });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      toast.success(note ? 'Note updated.' : 'Note saved.');
      onSaved?.(saved);
      onClose();
    },
    onError: (error) => {
      const described = describeError(error);
      toast.error(described.description ?? described.title);
    },
  });

  function toggle(tag: TagWithStats) {
    setSelected((current) => {
      const next = { ...current };
      if (next[tag.slug]) delete next[tag.slug];
      else next[tag.slug] = { slug: tag.slug };
      return next;
    });
  }

  function setValue(slug: string, patch: Partial<NoteTagInput>) {
    setSelected((current) => {
      const existing = current[slug];
      if (!existing) return current;
      return { ...current, [slug]: { ...existing, ...patch } };
    });
  }

  const hasContent = body.trim().length > 0 || Object.keys(selected).length > 0;
  const canSave = hasContent && childId !== undefined && !save.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    save.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={note ? 'Edit note' : 'Add a note'}
      description="Anything worth remembering about tonight. Tags are what the analysis reads."
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={!canSave}
            loading={save.isPending}
            loadingLabel="Saving"
          >
            {note ? 'Save changes' : 'Save note'}
          </Button>
        </>
      }
    >
      <form className="composer" onSubmit={onSubmit}>
        <div className="field field--block">
          <label className="field__label" htmlFor="composer-body">
            What happened
          </label>
          <textarea
            id="composer-body"
            className="input"
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Late dinner, then two stories."
            autoFocus
          />
        </div>

        <fieldset className="composer__tags">
          <legend className="field__label">Tags</legend>

          {tagsQuery.isPending ? (
            <p className="composer__loading">
              <Spinner size={16} /> Loading tags…
            </p>
          ) : available.length === 0 ? (
            <p className="field__hint">
              No tags yet. Save a note and add tags from the Notes page.
            </p>
          ) : (
            <>
              <div className="chip-wrap-group">
                {visible.map((tag) => (
                  <Chip
                    key={tag.slug}
                    selected={selected[tag.slug] !== undefined}
                    onClick={() => toggle(tag)}
                  >
                    {tag.label}
                  </Chip>
                ))}
              </div>
              {available.length > visible.length ? (
                <Button variant="ghost" size="sm" onClick={() => setShowAllTags(true)}>
                  Show all {available.length} tags
                </Button>
              ) : null}
            </>
          )}
        </fieldset>

        {selectedTags
          .filter((tag) => tag.value_type !== 'bool')
          .map((tag) => (
            <TagValueField
              key={tag.slug}
              tag={tag}
              value={selected[tag.slug]}
              onChange={(patch) => setValue(tag.slug, patch)}
            />
          ))}

        {childId === undefined ? (
          <p className="field__error">
            No child is set up yet, so there is nothing to attach this note to.
          </p>
        ) : null}

        {/* Enter in the textarea should not submit, but Enter in a value input
            should — this keeps that working without a visible second button. */}
        <button type="submit" className="visually-hidden" tabIndex={-1} disabled={!canSave}>
          Save note
        </button>
      </form>
    </Modal>
  );
}

/**
 * The value control for a non-bool tag. Which one appears is decided by
 * `value_type`, so an unrecognised type degrades to a plain text field rather
 * than silently dropping the value.
 */
function TagValueField({
  tag,
  value,
  onChange,
}: {
  tag: TagWithStats;
  value: NoteTagInput | undefined;
  onChange: (patch: Partial<NoteTagInput>) => void;
}) {
  const id = `composer-tag-${tag.slug}`;

  if (tag.value_type === 'time') {
    const minutes = value?.value_min_local ?? null;
    return (
      <div className="field field--block">
        <label className="field__label" htmlFor={id}>
          {tag.label}
        </label>
        <input
          id={id}
          className="input"
          type="time"
          value={minutes === null ? '' : formatMinuteOfDay(minutes, { showDayOffset: false })}
          onChange={(event) =>
            onChange({ value_min_local: parseLocalTime(event.target.value) })
          }
        />
      </div>
    );
  }

  if (tag.value_type === 'number' || tag.value_type === 'duration') {
    const unit = tag.unit ?? (tag.value_type === 'duration' ? 'minutes' : null);
    return (
      <div className="field field--block">
        <label className="field__label" htmlFor={id}>
          {tag.label}
          {unit ? <span className="composer__unit"> ({unit})</span> : null}
        </label>
        <input
          id={id}
          className="input"
          type="number"
          inputMode="decimal"
          step="any"
          value={value?.value_num ?? ''}
          onChange={(event) =>
            onChange({ value_num: event.target.value === '' ? null : Number(event.target.value) })
          }
        />
      </div>
    );
  }

  return (
    <div className="field field--block">
      <label className="field__label" htmlFor={id}>
        {tag.label}
        <span className="composer__unit"> ({tagCategoryLabel(tag.category)})</span>
      </label>
      <input
        id={id}
        className="input"
        type="text"
        value={value?.value_text ?? ''}
        onChange={(event) => onChange({ value_text: event.target.value || null })}
      />
    </div>
  );
}
