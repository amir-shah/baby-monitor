/**
 * The note composer.
 *
 * This is the single most important control in the dashboard, because every
 * association the analytics page will ever report is computed from what gets
 * typed here. That sets the bar: **entering a note has to be faster than not
 * bothering.** A parent standing in a dark hallway at 19:40 with a toddler on
 * one hip will not open a settings page to declare a tag before recording that
 * there was ice cream — so:
 *
 *   - The body field is focusable and typeable the moment the page renders.
 *     Nothing is behind a dialog, a menu or a mode.
 *   - Tags are one tap. Typing a name that does not exist offers to create it
 *     right there; the API creates unknown slugs on the fly, and posting the
 *     tag definition first only exists so the *label* is what the user typed
 *     rather than a title-cased slug.
 *   - The value control is chosen by the tag's `value_type`, so a tag invented
 *     after this component was written still gets the right input.
 *   - Time and night default to "now" and "tonight" and are folded away. They
 *     are there for the 03:10 wake-up written down at breakfast, and they cost
 *     nothing when nobody touches them.
 *
 * The same component serves the Notes page (inline, always open) and the Live
 * page (inside {@link NoteComposerDialog}), so a note written at 3am and one
 * written over coffee produce identical records.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from './Button';
import { Chip } from './Chip';
import { IconButton } from './IconButton';
import { ChevronDownIcon, ClockIcon, CloseIcon, PlusIcon, TagIcon } from './Icons';
import { Select } from './Select';
import { Skeleton } from './Skeleton';
import { describeError } from './ErrorState';
import { useToast } from './Toast';
import { ApiError, notes as notesApi, tags as tagsApi } from '../lib/api';
import {
  DEFAULT_DAY_BOUNDARY_HOUR,
  formatClock,
  nightLabel,
  shiftNightOf,
  slugify,
  tagCategoryLabel,
} from '../lib/format';
import {
  epochForNightTime,
  minutesOfDay,
  minutesToTimeInput,
  timeInputToMinutes,
} from '../lib/localTime';
import { tagLabel, toTagInput, VALUE_TYPE_HINTS, VALUE_TYPE_LABELS } from '../lib/notesModel';
import { TAG_CATEGORIES, TAG_VALUE_TYPES } from '../lib/types';
import type {
  NightOf,
  Note,
  NoteTagInput,
  TagCategory,
  TagValueType,
  TagWithStats,
  Timezone,
} from '../lib/types';
import './NoteComposer.css';

/** How many tag chips are shown before the list folds. */
const VISIBLE_TAGS = 12;

export interface NoteComposerProps {
  /** Required to save. Without one the form explains why it cannot. */
  childId: number | undefined;
  /** The night a new note belongs to. Defaults to the current night. */
  nightOf: NightOf;
  /** Editing an existing note rather than writing a new one. */
  note?: Note | null;
  /** Tag slugs to start with — the chip that opened the composer, say. */
  initialTags?: readonly string[];
  timezone?: Timezone | null;
  /** `children.day_boundary_hour`, for placing a time inside the night. */
  boundaryHour?: number;
  onSaved?: (note: Note) => void;
  /** Shows a Cancel button. Omit for an always-open inline composer. */
  onCancel?: () => void;
  submitLabel?: string;
  autoFocus?: boolean;
  className?: string;
}

/** A tag the user has invented but that does not exist on the server yet. */
interface DraftTag {
  slug: string;
  label: string;
  category: TagCategory;
  value_type: TagValueType;
  unit: string | null;
}

/** Everything the composer needs to know about a tag, from wherever it came. */
interface TagDef {
  slug: string;
  label: string;
  category: TagCategory;
  value_type: TagValueType;
  unit: string | null;
  nights: number;
  builtin: boolean;
  isDraft: boolean;
}

type Selection = Record<string, NoteTagInput>;

/** When the thing being noted happened. */
type WhenMode = 'now' | 'at' | 'night';

export function NoteComposer({
  childId,
  nightOf,
  note,
  initialTags,
  timezone,
  boundaryHour = DEFAULT_DAY_BOUNDARY_HOUR,
  onSaved,
  onCancel,
  submitLabel,
  autoFocus = false,
  className,
}: NoteComposerProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const [body, setBody] = useState(() => note?.body ?? '');
  const [selected, setSelected] = useState<Selection>(() => initialSelection(note, initialTags));
  const [drafts, setDrafts] = useState<Record<string, DraftTag>>({});
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState(false);

  const [night, setNight] = useState<NightOf>(() => note?.night_of ?? nightOf);
  const [whenMode, setWhenMode] = useState<WhenMode>(() => {
    if (!note) return 'now';
    return note.ts_ms === null ? 'night' : 'at';
  });
  const [timeValue, setTimeValue] = useState(() =>
    note?.ts_ms ? minutesToTimeInput(minutesOfDay(note.ts_ms, timezone)) : '',
  );
  const [whenOpen, setWhenOpen] = useState(false);
  /** Left false while the user has not touched the time, so an edit that only
   *  changes the wording keeps the original timestamp to the millisecond. */
  const [timeTouched, setTimeTouched] = useState(false);

  // A new note follows the page's night as it rolls over at the day boundary;
  // an edit stays on the night it was written about.
  useEffect(() => {
    if (!note) setNight(nightOf);
  }, [nightOf, note]);

  useEffect(() => {
    if (autoFocus) bodyRef.current?.focus();
  }, [autoFocus]);

  const tagsQuery = useQuery({
    queryKey: ['tags', 'with-stats'],
    queryFn: ({ signal }) => tagsApi.list({ with_stats: true }, signal),
    staleTime: 60_000,
  });

  /**
   * Every tag the composer can offer: what the server knows, plus anything the
   * note already carries (an archived tag still has to render its own value),
   * plus tags invented in this session.
   */
  const defs = useMemo(() => {
    const map = new Map<string, TagDef>();
    for (const tag of tagsQuery.data?.items ?? []) {
      if (tag.archived) continue;
      map.set(tag.slug, {
        slug: tag.slug,
        label: tagLabel(tag),
        category: tag.category,
        value_type: tag.value_type,
        unit: tag.unit,
        nights: tag.nights_applied ?? 0,
        builtin: tag.builtin,
        isDraft: false,
      });
    }
    for (const tag of note?.tags ?? []) {
      if (map.has(tag.slug)) continue;
      map.set(tag.slug, {
        slug: tag.slug,
        label: tagLabel(tag),
        category: tag.category,
        value_type: tag.value_type,
        unit: null,
        nights: 0,
        builtin: false,
        isDraft: false,
      });
    }
    for (const draft of Object.values(drafts)) {
      map.set(draft.slug, { ...draft, nights: 0, builtin: false, isDraft: true });
    }
    return map;
  }, [tagsQuery.data, note, drafts]);

  const ordered = useMemo(() => {
    const all = [...defs.values()];
    const query = search.trim().toLowerCase();
    const matching = query
      ? all.filter(
          (def) =>
            def.label.toLowerCase().includes(query) ||
            def.slug.includes(slugify(query)) ||
            tagCategoryLabel(def.category).toLowerCase().includes(query),
        )
      : all;

    return matching.sort((a, b) => {
      // What is already on the note stays put, so a chip never moves out from
      // under a thumb heading for it.
      const chosen = Number(selected[b.slug] !== undefined) - Number(selected[a.slug] !== undefined);
      if (chosen !== 0) return chosen;
      if (a.isDraft !== b.isDraft) return a.isDraft ? -1 : 1;
      if (a.nights !== b.nights) return b.nights - a.nights;
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [defs, search, selected]);

  const visible = expanded || search.trim() ? ordered : ordered.slice(0, VISIBLE_TAGS);
  const hiddenCount = ordered.length - visible.length;

  /** Tags on the note that need a value control, in a stable order. */
  const valued = useMemo(
    () =>
      Object.keys(selected)
        .map((slug) => defs.get(slug))
        .filter((def): def is TagDef => def !== undefined && def.value_type !== 'bool')
        .sort((a, b) => a.label.localeCompare(b.label)),
    [selected, defs],
  );

  const pendingSlug = slugify(search);
  const canCreate =
    pendingSlug.length > 0 &&
    !defs.has(pendingSlug) &&
    !ordered.some((def) => def.label.toLowerCase() === search.trim().toLowerCase());

  // -- Actions --------------------------------------------------------------

  function toggle(slug: string): void {
    setSelected((current) => {
      const next = { ...current };
      if (next[slug]) delete next[slug];
      else next[slug] = { slug };
      return next;
    });
  }

  function setValue(slug: string, patch: Partial<NoteTagInput>): void {
    setSelected((current) => {
      const existing = current[slug];
      if (!existing) return current;
      return { ...current, [slug]: { ...existing, ...patch } };
    });
  }

  function createDraft(): void {
    if (!canCreate) return;
    const label = search.trim();
    const draft: DraftTag = {
      slug: pendingSlug,
      label,
      category: 'other',
      value_type: 'bool',
      unit: null,
    };
    setDrafts((current) => ({ ...current, [draft.slug]: draft }));
    setSelected((current) => ({ ...current, [draft.slug]: { slug: draft.slug } }));
    setSearch('');
  }

  function updateDraft(slug: string, patch: Partial<DraftTag>): void {
    setDrafts((current) => {
      const existing = current[slug];
      if (!existing) return current;
      return { ...current, [slug]: { ...existing, ...patch } };
    });
    // Changing the type invalidates whatever was typed into the old control.
    if (patch.value_type) {
      setSelected((current) => (current[slug] ? { ...current, [slug]: { slug } } : current));
    }
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    // Enter in the tag field must never post a half-written note.
    event.preventDefault();
    const first = ordered[0];
    if (canCreate) createDraft();
    else if (first) {
      toggle(first.slug);
      setSearch('');
    }
  }

  // -- Saving ---------------------------------------------------------------

  const save = useMutation({
    mutationFn: async (): Promise<Note> => {
      if (childId === undefined) throw new Error('No child is set up yet.');

      // Declare invented tags first, purely so they keep the label and value
      // type the user chose. If this fails the note still saves — the API
      // creates unknown slugs on the fly.
      for (const draft of Object.values(drafts)) {
        if (selected[draft.slug] === undefined) continue;
        try {
          await tagsApi.create({
            slug: draft.slug,
            label: draft.label,
            category: draft.category,
            value_type: draft.value_type,
            unit: draft.unit,
          });
        } catch (error) {
          // A slug that already exists is not a failure: the tag we wanted is
          // there, which is all the note needs.
          const conflict = error instanceof ApiError && (error.status === 409 || error.status === 400);
          if (!conflict) throw error;
        }
      }

      const tagList = Object.keys(selected).map((slug) =>
        cleanInput(defs.get(slug)?.value_type ?? 'bool', selected[slug] ?? { slug }),
      );
      const ts = resolveTimestamp();
      const trimmed = body.trim();

      if (note) {
        return notesApi.update(note.id, {
          body: trimmed,
          tags: tagList,
          night_of: night,
          ts_ms: ts,
        });
      }
      return notesApi.create({
        child_id: childId,
        night_of: night,
        ts_ms: ts,
        body: trimmed,
        tags: tagList,
      });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      if (!note) {
        setBody('');
        setSelected({});
        setDrafts({});
        setSearch('');
        setWhenMode('now');
        setTimeValue('');
        setTimeTouched(false);
        setWhenOpen(false);
        bodyRef.current?.focus();
      }
      toast.success(note ? 'Note updated.' : 'Note saved.');
      onSaved?.(saved);
    },
    onError: (error) => {
      const described = describeError(error);
      toast.error(described.description ?? described.title);
    },
  });

  function resolveTimestamp(): number | null {
    if (whenMode === 'night') return null;
    if (whenMode === 'now') return Date.now();
    if (!timeTouched && note?.ts_ms) return note.ts_ms;
    const minutes = timeInputToMinutes(timeValue);
    if (minutes === null) return note?.ts_ms ?? Date.now();
    return epochForNightTime(night, minutes, { tz: timezone, boundaryHour }) ?? Date.now();
  }

  const hasContent = body.trim().length > 0 || Object.keys(selected).length > 0;
  const canSave = hasContent && childId !== undefined && !save.isPending;

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!canSave) return;
    save.mutate();
  }

  // -- Render ---------------------------------------------------------------

  return (
    <form
      className={['composer', className ?? ''].filter(Boolean).join(' ')}
      onSubmit={onSubmit}
      aria-label={note ? 'Edit note' : 'Add a note'}
    >
      <div className="composer__field">
        <label className="field__label" htmlFor={`composer-body-${note?.id ?? 'new'}`}>
          What happened
        </label>
        <textarea
          ref={bodyRef}
          id={`composer-body-${note?.id ?? 'new'}`}
          className="input composer__body"
          rows={2}
          value={body}
          placeholder="Ice cream after dinner, then two episodes."
          onChange={(event) => setBody(event.target.value)}
        />
      </div>

      <fieldset className="composer__tags">
        <legend className="field__label">
          <TagIcon size={14} /> Tags
        </legend>
        <p className="field__hint composer__hint">
          Tags are what the analysis reads. Type a new name to invent one.
        </p>

        <div className="composer__search">
          <input
            type="text"
            className="input composer__search-input"
            value={search}
            placeholder="Search or add a tag"
            autoComplete="off"
            aria-label="Search tags, or type a new tag name"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          {search ? (
            <IconButton
              label="Clear tag search"
              icon={<CloseIcon size={16} />}
              size="sm"
              onClick={() => setSearch('')}
            />
          ) : null}
        </div>

        {tagsQuery.isPending ? (
          <div className="chip-wrap-group" aria-busy="true">
            <span className="visually-hidden">Loading tags</span>
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} width="7rem" height="2.25rem" shape="block" />
            ))}
          </div>
        ) : (
          <div className="chip-wrap-group">
            {canCreate ? (
              <Chip selected onClick={createDraft} icon={<PlusIcon size={14} />}>
                Add &ldquo;{search.trim()}&rdquo;
              </Chip>
            ) : null}

            {visible.map((def) => (
              <Chip
                key={def.slug}
                selected={selected[def.slug] !== undefined}
                onClick={() => toggle(def.slug)}
                value={def.isDraft ? 'new' : undefined}
              >
                {def.label}
              </Chip>
            ))}

            {hiddenCount > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                iconEnd={<ChevronDownIcon size={16} />}
                onClick={() => setExpanded(true)}
              >
                {hiddenCount} more
              </Button>
            ) : null}

            {ordered.length === 0 && !canCreate ? (
              <p className="field__hint">No tags match that.</p>
            ) : null}
          </div>
        )}
      </fieldset>

      {valued.length > 0 ? (
        <div className="composer__values">
          {valued.map((def) => (
            <TagValueField
              key={def.slug}
              def={def}
              value={selected[def.slug]}
              onChange={(patch) => setValue(def.slug, patch)}
              onTypeChange={
                def.isDraft ? (valueType) => updateDraft(def.slug, { value_type: valueType }) : undefined
              }
            />
          ))}
        </div>
      ) : null}

      {/* Draft tags that need no value still need somewhere to change their
          type from "yes / no" — otherwise inventing "lights off" gives you a
          switch when you wanted a clock. */}
      {Object.values(drafts)
        .filter((draft) => selected[draft.slug] !== undefined && draft.value_type === 'bool')
        .map((draft) => (
          <DraftTypeField key={draft.slug} draft={draft} onChange={updateDraft} />
        ))}

      <WhenControl
        open={whenOpen}
        onOpenChange={setWhenOpen}
        mode={whenMode}
        onModeChange={setWhenMode}
        timeValue={timeValue}
        onTimeChange={(value) => {
          setTimeValue(value);
          setTimeTouched(true);
          if (value) setWhenMode('at');
        }}
        night={night}
        onNightChange={setNight}
        timezone={timezone}
        existingTs={note?.ts_ms ?? null}
      />

      {childId === undefined ? (
        <p className="field__error">
          No child is set up yet, so there is nothing to attach this note to.
        </p>
      ) : null}

      <div className="composer__actions">
        <Button type="submit" variant="primary" disabled={!canSave} loading={save.isPending} loadingLabel="Saving">
          {submitLabel ?? (note ? 'Save changes' : 'Save note')}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={save.isPending}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Value controls
// ---------------------------------------------------------------------------

/**
 * The value control for a non-bool tag, chosen by `value_type`.
 *
 * An unrecognised type degrades to a plain text field rather than silently
 * dropping whatever the user typed.
 */
function TagValueField({
  def,
  value,
  onChange,
  onTypeChange,
}: {
  def: TagDef;
  value: NoteTagInput | undefined;
  onChange: (patch: Partial<NoteTagInput>) => void;
  onTypeChange?: (valueType: TagValueType) => void;
}) {
  const id = `composer-value-${def.slug}`;

  return (
    <div className="composer__value">
      <label className="field__label" htmlFor={id}>
        {def.label}
        {def.value_type === 'duration' || def.value_type === 'number' ? (
          <span className="composer__unit"> ({def.unit ?? (def.value_type === 'duration' ? 'minutes' : 'number')})</span>
        ) : null}
      </label>

      {def.value_type === 'time' ? (
        <input
          id={id}
          className="input composer__value-input"
          type="time"
          value={minutesToTimeInput(value?.value_min_local)}
          onChange={(event) => onChange({ value_min_local: timeInputToMinutes(event.target.value) })}
        />
      ) : def.value_type === 'duration' || def.value_type === 'number' ? (
        <input
          id={id}
          className="input composer__value-input"
          type="number"
          inputMode="decimal"
          step="any"
          min={def.value_type === 'duration' ? 0 : undefined}
          value={value?.value_num ?? ''}
          onChange={(event) =>
            onChange({ value_num: event.target.value === '' ? null : Number(event.target.value) })
          }
        />
      ) : (
        <input
          id={id}
          className="input composer__value-input"
          type="text"
          value={value?.value_text ?? ''}
          onChange={(event) => onChange({ value_text: event.target.value || null })}
        />
      )}

      {onTypeChange ? (
        <Select
          className="composer__type"
          size="sm"
          label={`Kind of value for ${def.label}`}
          hideLabel
          value={def.value_type}
          onValueChange={onTypeChange}
          options={TAG_VALUE_TYPES.map((type) => ({ value: type, label: VALUE_TYPE_LABELS[type] }))}
        />
      ) : null}
    </div>
  );
}

/** Type chooser for a freshly invented tag that currently needs no value. */
function DraftTypeField({
  draft,
  onChange,
}: {
  draft: DraftTag;
  onChange: (slug: string, patch: Partial<DraftTag>) => void;
}) {
  return (
    <div className="composer__draft">
      <Select
        size="sm"
        label={`What kind of thing is “${draft.label}”?`}
        value={draft.value_type}
        onValueChange={(valueType) => onChange(draft.slug, { value_type: valueType })}
        options={TAG_VALUE_TYPES.map((type) => ({ value: type, label: VALUE_TYPE_LABELS[type] }))}
        hint={VALUE_TYPE_HINTS[draft.value_type]}
      />
      <Select
        size="sm"
        label="Category"
        value={draft.category}
        onValueChange={(category) => onChange(draft.slug, { category })}
        options={TAG_CATEGORIES.map((category) => ({
          value: category,
          label: tagCategoryLabel(category),
        }))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------

/**
 * Timestamp and night.
 *
 * Folded away by default and summarised in one line, because the answer is
 * "tonight, now" for almost every note ever written and a form that asks the
 * question out loud is a form people stop filling in.
 */
function WhenControl({
  open,
  onOpenChange,
  mode,
  onModeChange,
  timeValue,
  onTimeChange,
  night,
  onNightChange,
  timezone,
  existingTs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: WhenMode;
  onModeChange: (mode: WhenMode) => void;
  timeValue: string;
  onTimeChange: (value: string) => void;
  night: NightOf;
  onNightChange: (night: NightOf) => void;
  timezone?: Timezone | null;
  existingTs: number | null;
}) {
  const summary =
    mode === 'night'
      ? 'the night as a whole'
      : mode === 'now'
        ? 'now'
        : timeValue || (existingTs ? formatClock(existingTs, { tz: timezone }) : 'a time');

  return (
    <div className="composer__when">
      <button
        type="button"
        className="composer__when-toggle"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <ClockIcon size={15} />
        <span>
          {nightLabel(night)} · {summary}
        </span>
        <ChevronDownIcon size={16} className={open ? 'composer__caret is-open' : 'composer__caret'} />
      </button>

      {open ? (
        <div className="composer__when-body">
          <fieldset className="composer__when-mode">
            <legend className="field__label">When</legend>
            <div className="composer__radio-row">
              {(
                [
                  ['now', 'Just now'],
                  ['at', 'At a time'],
                  ['night', 'All night'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="composer__radio">
                  <input
                    type="radio"
                    name={`composer-when-${night}`}
                    value={value}
                    checked={mode === value}
                    onChange={() => onModeChange(value)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {mode === 'at' ? (
            <div className="composer__field">
              <label className="field__label" htmlFor={`composer-time-${night}`}>
                Time
              </label>
              <input
                id={`composer-time-${night}`}
                className="input composer__value-input"
                type="time"
                value={timeValue}
                onChange={(event) => onTimeChange(event.target.value)}
              />
              <p className="field__hint">
                A time before midday belongs to the morning after this night began.
              </p>
            </div>
          ) : null}

          <div className="composer__field">
            <label className="field__label" htmlFor={`composer-night-${night}`}>
              Night
            </label>
            <div className="composer__night-row">
              <IconButton
                label="Previous night"
                icon={<span aria-hidden="true">‹</span>}
                onClick={() => onNightChange(shiftNightOf(night, -1))}
              />
              <input
                id={`composer-night-${night}`}
                className="input composer__night-input"
                type="date"
                value={night}
                onChange={(event) => {
                  if (event.target.value) onNightChange(event.target.value);
                }}
              />
              <IconButton
                label="Next night"
                icon={<span aria-hidden="true">›</span>}
                onClick={() => onNightChange(shiftNightOf(night, 1))}
              />
            </div>
            <p className="field__hint">{nightLabel(night)}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initialSelection(note: Note | null | undefined, initial: readonly string[] = []): Selection {
  const selection: Selection = {};
  for (const slug of initial) selection[slug] = { slug };
  for (const tag of note?.tags ?? []) selection[tag.slug] = toTagInput(tag);
  return selection;
}

/**
 * Send only the value field that matches the tag's type.
 *
 * A `value_num` left over from before the user changed a draft tag's type
 * would otherwise ride along and be stored against a control that no longer
 * exists.
 */
function cleanInput(valueType: TagValueType, input: NoteTagInput): NoteTagInput {
  const base: NoteTagInput = { slug: input.slug };
  switch (valueType) {
    case 'number':
    case 'duration':
      if (input.value_num !== undefined && input.value_num !== null && Number.isFinite(input.value_num)) {
        base.value_num = input.value_num;
      }
      return base;
    case 'time':
      if (input.value_min_local !== undefined && input.value_min_local !== null) {
        base.value_min_local = input.value_min_local;
      }
      return base;
    case 'text':
      if (input.value_text) base.value_text = input.value_text;
      return base;
    case 'bool':
    default:
      return base;
  }
}
