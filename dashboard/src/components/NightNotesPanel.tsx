import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { notes as notesApi, tags as tagsApi } from '../lib/api';
import { formatClock, slugify, titleCase } from '../lib/format';
import type { Note, NoteTag, NoteTagInput, NightOf, Timezone } from '../lib/types';
import { Button } from './Button';
import { Chip } from './Chip';
import { EmptyState } from './EmptyState';
import { IconButton } from './IconButton';
import { PlusIcon, TagIcon, TrashIcon } from './Icons';
import { describeError } from './ErrorState';
import { useToast } from './Toast';
import './NightNotesPanel.css';

export interface NightNotesPanelProps {
  childId: number;
  nightOf: NightOf;
  notes: readonly Note[];
  timezone?: Timezone | null;
  /** Called after any successful write so the page can refetch the night. */
  onChanged: () => void;
  className?: string;
}

/**
 * The night's journal: what happened before bed, and what you want to remember
 * about it.
 *
 * Editing is inline rather than in a dialog. These notes are the *input* to
 * the whole factor analysis — "dessert before bed", "teething", "grandparents
 * visiting" is where the interesting correlations come from — so the cost of
 * adding one has to be as close to zero as the UI can make it. A dialog is
 * three taps and a context switch; a textarea already on the page is one.
 */
export function NightNotesPanel({
  childId,
  nightOf,
  notes,
  timezone,
  onChanged,
  className,
}: NightNotesPanelProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const toast = useToast();

  // Suggestions for the tag field. A failure here is not worth surfacing —
  // the user can still type a slug, which the API will create on the fly.
  const tagList = useQuery({
    queryKey: ['tags', { with_stats: false }],
    queryFn: ({ signal }) => tagsApi.list({}, signal),
    staleTime: 5 * 60_000,
  });
  const suggestions = tagList.data?.items ?? [];

  const create = useMutation({
    mutationFn: (draft: NoteDraft) =>
      notesApi.create({
        child_id: childId,
        night_of: nightOf,
        body: draft.body,
        tags: draft.tags,
      }),
    onSuccess: () => {
      setComposing(false);
      onChanged();
      toast.success('Note added');
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const update = useMutation({
    mutationFn: ({ id, draft }: { id: number; draft: NoteDraft }) =>
      notesApi.update(id, { body: draft.body, tags: draft.tags }),
    onSuccess: () => {
      setEditingId(null);
      onChanged();
      toast.success('Note saved');
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const remove = useMutation({
    mutationFn: (id: number) => notesApi.remove(id),
    onSuccess: () => {
      setEditingId(null);
      onChanged();
      toast.success('Note deleted');
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  return (
    <div className={['night-notes', className ?? ''].filter(Boolean).join(' ')}>
      {notes.length === 0 && !composing ? (
        <EmptyState
          size="sm"
          icon={<TagIcon size={24} />}
          title="Nothing noted for this night"
          description="A line about the evening — a late nap, teething, a new room — is what the factor analysis has to work with later."
          action={
            <Button variant="primary" iconStart={<PlusIcon size={16} />} onClick={() => setComposing(true)}>
              Add a note
            </Button>
          }
        />
      ) : null}

      {notes.length > 0 ? (
        <ul className="night-notes__list">
          {notes.map((note) => (
            <li key={note.id} className="night-notes__item">
              {editingId === note.id ? (
                <NoteForm
                  initialBody={note.body}
                  initialTags={note.tags.map(toTagInput)}
                  suggestions={suggestions.map((tag) => tag.label)}
                  busy={update.isPending || remove.isPending}
                  submitLabel="Save"
                  onCancel={() => setEditingId(null)}
                  onSubmit={(draft) => update.mutate({ id: note.id, draft })}
                  onDelete={() => remove.mutate(note.id)}
                />
              ) : (
                <article className="night-notes__note">
                  <header className="night-notes__note-head">
                    {note.ts_ms ? (
                      <span className="night-notes__time" data-numeric>
                        {formatClock(note.ts_ms, { tz: timezone })}
                      </span>
                    ) : (
                      <span className="night-notes__time">All night</span>
                    )}
                    <span className="night-notes__source">{sourceLabel(note)}</span>
                    <span className="spacer" />
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(note.id)}>
                      Edit
                    </Button>
                  </header>
                  {note.body ? <p className="night-notes__body">{note.body}</p> : null}
                  {note.tags.length > 0 ? (
                    <div className="night-notes__tags">
                      {note.tags.map((tag) => (
                        <Chip key={tag.slug} value={tagValue(tag)}>
                          {tag.label || titleCase(tag.slug)}
                        </Chip>
                      ))}
                    </div>
                  ) : null}
                </article>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {composing ? (
        <NoteForm
          initialBody=""
          initialTags={[]}
          suggestions={suggestions.map((tag) => tag.label)}
          busy={create.isPending}
          submitLabel="Add note"
          onCancel={() => setComposing(false)}
          onSubmit={(draft) => create.mutate(draft)}
        />
      ) : notes.length > 0 ? (
        <Button variant="secondary" iconStart={<PlusIcon size={16} />} onClick={() => setComposing(true)}>
          Add another note
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

interface NoteDraft {
  body: string;
  tags: NoteTagInput[];
}

function NoteForm({
  initialBody,
  initialTags,
  suggestions,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  onDelete,
}: {
  initialBody: string;
  initialTags: NoteTagInput[];
  suggestions: readonly string[];
  busy: boolean;
  submitLabel: string;
  onSubmit: (draft: NoteDraft) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [tags, setTags] = useState<NoteTagInput[]>(initialTags);
  const [tagText, setTagText] = useState('');
  // Two of these forms can be open at once (editing one note while composing
  // another), so the ids have to be per-instance.
  const bodyId = useId();
  const tagId = useId();
  const optionsId = useId();

  const addTag = (): void => {
    const slug = slugify(tagText);
    if (!slug) return;
    setTags((current) => (current.some((tag) => tag.slug === slug) ? current : [...current, { slug }]));
    setTagText('');
  };

  return (
    <form
      className="night-notes__form"
      onSubmit={(event) => {
        event.preventDefault();
        // A tag typed but not committed is still a tag the user meant.
        const pending = slugify(tagText);
        const all =
          pending && !tags.some((tag) => tag.slug === pending) ? [...tags, { slug: pending }] : tags;
        onSubmit({ body: body.trim(), tags: all });
      }}
    >
      <label className="night-notes__label" htmlFor={bodyId}>
        Note
      </label>
      <textarea
        id={bodyId}
        className="night-notes__textarea"
        value={body}
        rows={3}
        placeholder="Ice cream after dinner, then two episodes…"
        onChange={(event) => setBody(event.target.value)}
      />

      <label className="night-notes__label" htmlFor={tagId}>
        Tags
      </label>
      <div className="night-notes__tag-input">
        <input
          id={tagId}
          className="night-notes__text"
          value={tagText}
          list={optionsId}
          placeholder="dessert before bed"
          autoComplete="off"
          onChange={(event) => setTagText(event.target.value)}
          onKeyDown={(event) => {
            // Enter commits the tag rather than submitting the form; a stray
            // Enter in a tag field should never post a half-written note.
            if (event.key !== 'Enter' && event.key !== ',') return;
            event.preventDefault();
            addTag();
          }}
        />
        <datalist id={optionsId}>
          {suggestions.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
        <Button variant="secondary" onClick={addTag} disabled={!slugify(tagText)}>
          Add tag
        </Button>
      </div>

      {tags.length > 0 ? (
        <div className="night-notes__tags">
          {tags.map((tag) => (
            <Chip
              key={tag.slug}
              removeLabel={titleCase(tag.slug)}
              onRemove={() => setTags((current) => current.filter((item) => item.slug !== tag.slug))}
            >
              {titleCase(tag.slug)}
            </Chip>
          ))}
        </div>
      ) : null}

      <div className="night-notes__form-actions">
        <Button type="submit" variant="primary" loading={busy}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <span className="spacer" />
        {onDelete ? (
          <IconButton
            label="Delete this note"
            variant="danger"
            icon={<TrashIcon size={18} />}
            onClick={onDelete}
            disabled={busy}
          />
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `PATCH /api/notes/{id}` replaces the whole tag set, so an edit has to send
 * the existing tags back — values and all, or a duration tag would silently
 * lose its 44 minutes on the next save.
 */
function toTagInput(tag: NoteTag): NoteTagInput {
  const input: NoteTagInput = { slug: tag.slug };
  if (tag.value_num !== undefined && tag.value_num !== null) input.value_num = tag.value_num;
  if (tag.value_min_local !== undefined && tag.value_min_local !== null) {
    input.value_min_local = tag.value_min_local;
  }
  if (tag.value_text !== undefined && tag.value_text !== null) input.value_text = tag.value_text;
  return input;
}

function tagValue(tag: NoteTag): string | undefined {
  if (tag.value_display) return tag.value_display;
  if (tag.value_num !== undefined && tag.value_num !== null) {
    return tag.value_type === 'duration' ? `${Math.round(tag.value_num)} min` : String(tag.value_num);
  }
  if (tag.value_text) return tag.value_text;
  return undefined;
}

const SOURCE_LABELS: Record<string, string> = {
  dashboard: 'Added here',
  homekit: 'From HomeKit',
  api: 'From the API',
  import: 'Imported',
  auto: 'Automatic',
};

function sourceLabel(note: Note): string {
  return SOURCE_LABELS[note.source] ?? titleCase(note.source);
}
