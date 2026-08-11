/**
 * One-tap logging for the things that happen every evening.
 *
 * "Dessert before bedtime", "TV before bedtime", "Lights off at 19:30" are the
 * examples the whole product is built around, so they cannot cost a form. A
 * yes/no tag is a single tap; a tag that carries a value opens one small
 * control and nothing else. Everything here writes exactly the same kind of
 * note the composer writes, so the analysis cannot tell the difference — which
 * is the point: the fast path and the careful path must produce one dataset.
 *
 * A chip is "on" when tonight has a note carrying that tag, which is the same
 * definition `POST /api/homekit/tag` uses. Flipping one off removes the tag,
 * and deletes the note only when it is one this control created — a note
 * somebody actually typed never disappears because of a mis-tap.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './Button';
import { Chip } from './Chip';
import { IconButton } from './IconButton';
import { CheckIcon, CloseIcon } from './Icons';
import { Skeleton } from './Skeleton';
import { describeError } from './ErrorState';
import { useToast } from './Toast';
import { notes as notesApi, tags as tagsApi } from '../lib/api';
import { minutesOfDay, minutesToTimeInput, timeInputToMinutes } from '../lib/localTime';
import {
  appliedTag,
  isBareTagNote,
  notesWithTag,
  quickNoteBody,
  sortTagsForPicker,
  tagLabel,
  tagValueDisplay,
  toTagInput,
  valueDisplay,
} from '../lib/notesModel';
import type { NightOf, NoteTagInput, TagWithStats, Timezone } from '../lib/types';
import './QuickTagRow.css';

/**
 * "Lights off at …" almost always means "at about now", so the time control
 * opens pre-filled rather than empty. Read outside the component: the clock is
 * not something a render may depend on.
 */
function currentMinuteOfDay(tz: Timezone | null | undefined): number {
  return minutesOfDay(Date.now(), tz);
}

export interface QuickTagRowProps {
  childId: number | undefined;
  /** The night a tap logs against. */
  nightOf: NightOf;
  timezone?: Timezone | null;
  /** How many chips to offer. Enough for one thumb-swipe, not a wall. */
  limit?: number;
  className?: string;
}

export function QuickTagRow({
  childId,
  nightOf,
  timezone,
  limit = 8,
  className,
}: QuickTagRowProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  /** The tag whose value control is open, if any. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState<NoteTagInput | null>(null);

  const tagsQuery = useQuery({
    queryKey: ['tags', 'with-stats'],
    queryFn: ({ signal }) => tagsApi.list({ with_stats: true }, signal),
    staleTime: 60_000,
  });

  const notesQuery = useQuery({
    queryKey: ['notes', 'night', childId ?? null, nightOf],
    queryFn: ({ signal }) =>
      notesApi.list({ child_id: childId, night_of: nightOf, limit: 200 }, signal),
    staleTime: 15_000,
  });

  const nightNotes = useMemo(() => notesQuery.data?.items ?? [], [notesQuery.data]);

  const chips = useMemo(() => {
    const usable = (tagsQuery.data?.items ?? []).filter((tag) => !tag.archived);
    const applied = new Set<string>();
    for (const note of nightNotes) for (const tag of note.tags) applied.add(tag.slug);
    // Anything already logged tonight stays visible even if it is rarely used,
    // so turning it back off is always one tap away.
    const ranked = sortTagsForPicker(usable);
    const shown = ranked.slice(0, limit);
    for (const tag of ranked.slice(limit)) if (applied.has(tag.slug)) shown.push(tag);
    return shown;
  }, [tagsQuery.data, nightNotes, limit]);

  const busy = useMutation({
    mutationFn: async ({ tag, input }: { tag: TagWithStats; input: NoteTagInput | null }) => {
      if (childId === undefined) throw new Error('No child is set up yet.');
      const carriers = notesWithTag(nightNotes, tag.slug);

      if (input === null) {
        for (const note of carriers) {
          if (isBareTagNote(note, tag.slug, tagLabel(tag))) {
            await notesApi.remove(note.id);
          } else {
            await notesApi.update(note.id, {
              tags: note.tags.filter((entry) => entry.slug !== tag.slug).map(toTagInput),
            });
          }
        }
        return;
      }

      const display = valueDisplay(tag.value_type, tag.unit, input);
      const existing = carriers[0];
      if (existing) {
        // Already logged: change the value in place rather than adding a
        // second note that would double-count the night.
        const tags = existing.tags.map((entry) => (entry.slug === tag.slug ? input : toTagInput(entry)));
        const wasBare = isBareTagNote(existing, tag.slug, tagLabel(tag));
        await notesApi.update(existing.id, {
          tags,
          ...(wasBare ? { body: quickNoteBody(tagLabel(tag), display) } : {}),
        });
        return;
      }

      await notesApi.create({
        child_id: childId,
        night_of: nightOf,
        ts_ms: Date.now(),
        body: quickNoteBody(tagLabel(tag), display),
        tags: [input],
      });
    },
    onSuccess: (_result, { tag, input }) => {
      setEditing(null);
      setDraftValue(null);
      toast.toast(input === null ? `${tagLabel(tag)} removed.` : `${tagLabel(tag)} logged.`, {
        duration: 3_000,
      });
    },
    onError: (error) => {
      const described = describeError(error);
      toast.error(described.description ?? described.title);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
    },
  });

  function onChipClick(tag: TagWithStats): void {
    const current = appliedTag(nightNotes, tag.slug);

    if (tag.value_type === 'bool') {
      busy.mutate({ tag, input: current ? null : { slug: tag.slug } });
      return;
    }

    if (editing === tag.slug) {
      setEditing(null);
      setDraftValue(null);
      return;
    }

    setEditing(tag.slug);
    setDraftValue(
      current
        ? toTagInput(current)
        : tag.value_type === 'time'
          ? { slug: tag.slug, value_min_local: currentMinuteOfDay(timezone) }
          : { slug: tag.slug },
    );
  }

  if (tagsQuery.isPending) {
    return (
      <div className={['quick-tags', className ?? ''].filter(Boolean).join(' ')} aria-busy="true">
        <span className="visually-hidden">Loading quick tags</span>
        <div className="chip-row">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} width="7rem" height="2.25rem" shape="block" />
          ))}
        </div>
      </div>
    );
  }

  if (chips.length === 0) {
    return (
      <p className="quick-tags__empty">
        No one-tap tags yet. Anything you tag on a note turns up here.
      </p>
    );
  }

  const editingTag = chips.find((tag) => tag.slug === editing);

  return (
    <div className={['quick-tags', className ?? ''].filter(Boolean).join(' ')}>
      <div className="chip-row">
        {chips.map((tag) => {
          const current = appliedTag(nightNotes, tag.slug);
          const on = current !== undefined;
          return (
            <Chip
              key={tag.slug}
              selected={on}
              disabled={childId === undefined || busy.isPending}
              value={current ? tagValueDisplay(current, tag.unit) : undefined}
              onClick={() => onChipClick(tag)}
              onRemove={on && tag.value_type !== 'bool' ? () => busy.mutate({ tag, input: null }) : undefined}
              removeLabel={tagLabel(tag)}
            >
              {tagLabel(tag)}
            </Chip>
          );
        })}
      </div>

      {editingTag && draftValue ? (
        <ValueRow
          tag={editingTag}
          value={draftValue}
          onChange={setDraftValue}
          busy={busy.isPending}
          onCancel={() => {
            setEditing(null);
            setDraftValue(null);
          }}
          onSave={() => busy.mutate({ tag: editingTag, input: draftValue })}
        />
      ) : null}
    </div>
  );
}

/**
 * The one control a valued tag needs, shown under the row rather than in a
 * dialog — one tap to open, one to confirm.
 */
function ValueRow({
  tag,
  value,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  tag: TagWithStats;
  value: NoteTagInput;
  onChange: (value: NoteTagInput) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const id = `quick-value-${tag.slug}`;
  const unit = tag.unit ?? (tag.value_type === 'duration' ? 'min' : null);

  return (
    <div className="quick-tags__value" role="group" aria-label={`Value for ${tagLabel(tag)}`}>
      <label className="field__label" htmlFor={id}>
        {tagLabel(tag)}
        {unit ? <span className="quick-tags__unit"> ({unit})</span> : null}
      </label>

      {tag.value_type === 'time' ? (
        <input
          id={id}
          className="input quick-tags__input"
          type="time"
          autoFocus
          value={minutesToTimeInput(value.value_min_local)}
          onChange={(event) =>
            onChange({ ...value, value_min_local: timeInputToMinutes(event.target.value) })
          }
        />
      ) : tag.value_type === 'text' ? (
        <input
          id={id}
          className="input quick-tags__input"
          type="text"
          autoFocus
          value={value.value_text ?? ''}
          onChange={(event) => onChange({ ...value, value_text: event.target.value || null })}
        />
      ) : (
        <input
          id={id}
          className="input quick-tags__input"
          type="number"
          inputMode="decimal"
          step="any"
          min={tag.value_type === 'duration' ? 0 : undefined}
          autoFocus
          value={value.value_num ?? ''}
          onChange={(event) =>
            onChange({
              ...value,
              value_num: event.target.value === '' ? null : Number(event.target.value),
            })
          }
        />
      )}

      <Button variant="primary" size="sm" iconStart={<CheckIcon size={16} />} onClick={onSave} loading={busy}>
        Log it
      </Button>
      <IconButton label="Cancel" icon={<CloseIcon size={16} />} size="sm" onClick={onCancel} />
    </div>
  );
}
