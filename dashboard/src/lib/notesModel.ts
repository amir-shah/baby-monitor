/**
 * Pure derivations for the notes and tags layer.
 *
 * Notes are the only data in babymon a human types, and every association the
 * analytics page ever reports is computed from them. Two consequences shape
 * everything here:
 *
 *  1. **A tag's value is part of the observation.** "Screen before bed" with
 *     no minutes on it is a much weaker fact than "44 minutes", so a value
 *     must survive every round trip — including an edit, where
 *     `PATCH /api/notes/{id}` replaces the whole tag set and a dropped value
 *     is silently lost.
 *  2. **A tag is only useful once it has enough nights.** The correlation
 *     engine refuses to report on a tag applied to fewer than
 *     `analytics.min_nights_per_group` nights, so the UI has to say which
 *     tags are already earning their keep and which need more evidence —
 *     otherwise someone tags "teething" three times and wonders why nothing
 *     appears in the analysis.
 */

import { formatMinuteOfDay, formatNumber, titleCase } from './format';
import { isAnalysable } from './types';
import type { NightOf, Note, NoteTag, NoteTagInput, TagValueType, TagWithStats } from './types';

// ---------------------------------------------------------------------------
// Tag values
// ---------------------------------------------------------------------------

/**
 * A note's tag, as the write side wants it.
 *
 * Only the field matching the tag's `value_type` is carried; sending a
 * `value_num` on a time tag would be ignored at best and stored at worst.
 */
export function toTagInput(tag: NoteTag): NoteTagInput {
  const input: NoteTagInput = { slug: tag.slug };
  if (tag.value_num !== undefined && tag.value_num !== null) input.value_num = tag.value_num;
  if (tag.value_min_local !== undefined && tag.value_min_local !== null) {
    input.value_min_local = tag.value_min_local;
  }
  if (tag.value_text !== undefined && tag.value_text !== null) input.value_text = tag.value_text;
  return input;
}

/** True when the tag's own value control has been filled in. */
export function hasValue(input: NoteTagInput | undefined): boolean {
  if (!input) return false;
  return (
    (input.value_num !== undefined && input.value_num !== null) ||
    (input.value_min_local !== undefined && input.value_min_local !== null) ||
    (input.value_text !== undefined && input.value_text !== null && input.value_text !== '')
  );
}

/**
 * The value as a human reads it: "44 min", "19:30", "2".
 *
 * Prefers the server's own `value_display` when present so the dashboard and
 * the API never disagree about how a number is written.
 */
export function tagValueDisplay(tag: NoteTag, unit?: string | null): string | undefined {
  if (tag.value_display) return tag.value_display;
  return valueDisplay(tag.value_type, unit ?? null, {
    value_num: tag.value_num ?? null,
    value_min_local: tag.value_min_local ?? null,
    value_text: tag.value_text ?? null,
    slug: tag.slug,
  });
}

/** Same, from a pending write rather than a stored tag. */
export function valueDisplay(
  valueType: TagValueType,
  unit: string | null,
  input: NoteTagInput,
): string | undefined {
  switch (valueType) {
    case 'time':
      return input.value_min_local === undefined || input.value_min_local === null
        ? undefined
        : formatMinuteOfDay(input.value_min_local);
    case 'duration':
      return input.value_num === undefined || input.value_num === null
        ? undefined
        : `${formatNumber(input.value_num)} ${unit ?? 'min'}`;
    case 'number':
      return input.value_num === undefined || input.value_num === null
        ? undefined
        : unit
          ? `${formatNumber(input.value_num)} ${unit}`
          : formatNumber(input.value_num);
    case 'text':
      return input.value_text ?? undefined;
    case 'bool':
    default:
      return undefined;
  }
}

/** What the value control is asking for, in words. */
export const VALUE_TYPE_LABELS: Record<TagValueType, string> = {
  bool: 'Yes / no',
  number: 'A number',
  duration: 'A length of time',
  time: 'A time of day',
  text: 'Free text',
};

/** One line of help under the value-type selector. */
export const VALUE_TYPE_HINTS: Record<TagValueType, string> = {
  bool: 'It either happened or it did not — "dessert before bedtime".',
  number: 'Counts and scores. Compared against the night by correlation.',
  duration: 'Minutes — "44 minutes of screen time".',
  time: 'A clock time — "lights off at 19:30".',
  text: 'Kept for reading. Free text is never analysed.',
};

/** The label a tag shows, falling back to a readable form of its slug. */
export function tagLabel(tag: { label?: string | null; slug: string }): string {
  return tag.label?.trim() ? tag.label : titleCase(tag.slug);
}

// ---------------------------------------------------------------------------
// Which tags the analysis can actually use
// ---------------------------------------------------------------------------

/** Mirrors `analytics.min_nights_per_group`. */
export const DEFAULT_MIN_NIGHTS = 10;

export type TagReadinessState =
  | 'ready' /* enough nights: it appears in the factor analysis */
  | 'close' /* within a few nights of the gate */
  | 'sparse' /* logged, but nowhere near enough yet */
  | 'unused' /* never applied */
  | 'display-only'; /* text tags are never analysed */

export interface TagReadiness {
  state: TagReadinessState;
  nights: number;
  /** Nights still needed before the analysis will report on it. */
  needed: number;
  /** One short sentence for the UI. */
  summary: string;
}

/**
 * Whether a tag has enough nights behind it to appear in the factor analysis.
 *
 * The gate is the API's, not the dashboard's: `min_nights_per_group` from
 * `GET /api/config`. Showing the same number here is what keeps "why isn't my
 * tag in the analysis?" from being a mystery.
 */
export function tagReadiness(tag: TagWithStats, minNights = DEFAULT_MIN_NIGHTS): TagReadiness {
  const nights = tag.nights_applied ?? 0;

  if (!isAnalysable(tag.value_type)) {
    return {
      state: 'display-only',
      nights,
      needed: 0,
      summary: 'Free text — kept for reading, never analysed.',
    };
  }
  if (nights === 0) {
    return {
      state: 'unused',
      nights,
      needed: minNights,
      summary: `Not used yet. Needs ${minNights} nights before it can be analysed.`,
    };
  }
  if (nights >= minNights) {
    return {
      state: 'ready',
      nights,
      needed: 0,
      summary: `${nights} nights logged — enough to analyse.`,
    };
  }

  const needed = minNights - nights;
  return {
    state: needed <= 3 ? 'close' : 'sparse',
    nights,
    needed,
    summary: `${nights} of ${minNights} nights — ${needed} more before it can be analysed.`,
  };
}

/** Sort for a picker: what you reach for most, first. */
export function sortTagsForPicker(tags: readonly TagWithStats[]): TagWithStats[] {
  return [...tags].sort((a, b) => {
    const used = (b.nights_applied ?? 0) - (a.nights_applied ?? 0);
    if (used !== 0) return used;
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return tagLabel(a).localeCompare(tagLabel(b));
  });
}

/** Sort for the manager: grouped by category, alphabetical within it. */
export function sortTagsForManager(tags: readonly TagWithStats[]): TagWithStats[] {
  return [...tags].sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return tagLabel(a).localeCompare(tagLabel(b));
  });
}

// ---------------------------------------------------------------------------
// Grouping the journal
// ---------------------------------------------------------------------------

export interface NightGroup {
  nightOf: NightOf;
  notes: Note[];
}

/**
 * Group notes into nights, newest night first and newest note first within it.
 *
 * A note with no timestamp is about the night as a whole, so it sorts above
 * the moments inside that night rather than being dropped to the bottom.
 */
export function groupNotesByNight(notes: readonly Note[]): NightGroup[] {
  const groups = new Map<NightOf, Note[]>();
  for (const note of notes) {
    const bucket = groups.get(note.night_of);
    if (bucket) bucket.push(note);
    else groups.set(note.night_of, [note]);
  }

  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([nightOf, items]) => ({
      nightOf,
      notes: items.sort((a, b) => {
        if (a.ts_ms === null && b.ts_ms === null) return b.created_ms - a.created_ms;
        if (a.ts_ms === null) return -1;
        if (b.ts_ms === null) return 1;
        return b.ts_ms - a.ts_ms;
      }),
    }));
}

/** Every distinct tag slug across a set of notes, with how often it appears. */
export function tagFrequency(notes: readonly Note[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) counts.set(tag.slug, (counts.get(tag.slug) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// One-tap logging
// ---------------------------------------------------------------------------

/**
 * The body a one-tap chip writes.
 *
 * A tag note with an empty body reads as a blank row in the journal, so the
 * chip writes the sentence it stands for. Keeping the shape predictable is
 * also what lets {@link isBareTagNote} recognise its own work later.
 */
export function quickNoteBody(label: string, display: string | undefined): string {
  return display ? `${label}: ${display}` : label;
}

/**
 * Whether a note is one a chip created and nothing else — safe to delete when
 * the chip is switched back off.
 *
 * A note somebody actually typed must never be thrown away by a mis-tap; it
 * just loses the tag.
 */
export function isBareTagNote(note: Note, tagSlug: string, label: string): boolean {
  const remaining = note.tags.filter((tag) => tag.slug !== tagSlug);
  if (remaining.length > 0) return false;
  const body = note.body.trim();
  return body === '' || body === label || body.startsWith(`${label}:`);
}

/** Notes in a night carrying a given tag. */
export function notesWithTag(notes: readonly Note[], slug: string): Note[] {
  return notes.filter((note) => note.tags.some((tag) => tag.slug === slug));
}

/** The applied instance of a tag on a night, if any. */
export function appliedTag(notes: readonly Note[], slug: string): NoteTag | undefined {
  for (const note of notes) {
    const found = note.tags.find((tag) => tag.slug === slug);
    if (found) return found;
  }
  return undefined;
}
