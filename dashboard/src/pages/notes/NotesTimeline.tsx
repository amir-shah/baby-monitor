/**
 * The journal: every note, newest first, grouped by the night it belongs to.
 *
 * Grouped by night rather than by calendar day because a night is the unit
 * everything else in babymon is measured in — a note written at 00:20 sits
 * with the evening it is about, not on its own at the top of the next day.
 * Each heading links to that night's detail page, which is the whole point of
 * keeping the journal: the note and the hypnogram explain each other.
 */

import { Link } from 'react-router-dom';
import { Card, Chip, EmptyState, IconButton, NotesIcon, TrashIcon } from '../../components';
import { NoteComposer } from '../../components/NoteComposer';
import { formatClock, formatRelative, nightLabel, titleCase } from '../../lib/format';
import { groupNotesByNight, tagLabel, tagValueDisplay } from '../../lib/notesModel';
import type { Note, TagWithStats, Timezone } from '../../lib/types';
import './NotesTimeline.css';

export interface NotesTimelineProps {
  notes: readonly Note[];
  childId: number | undefined;
  timezone?: Timezone | null;
  boundaryHour?: number;
  /** Tag definitions, so a chip can show its unit. */
  tagsBySlug: Map<string, TagWithStats>;
  /** The note currently open for editing, if any. */
  editingId: number | null;
  onEdit: (id: number | null) => void;
  onDelete: (note: Note) => void;
  /** Clicking a tag chip adds it to the filter. */
  onFilterTag?: (slug: string) => void;
  /** Slugs currently being filtered on, so the chips can show it. */
  activeTags?: ReadonlySet<string>;
}

const SOURCE_LABELS: Record<string, string> = {
  dashboard: 'Written here',
  homekit: 'From HomeKit',
  api: 'From the API',
  import: 'Imported',
  auto: 'Recorded automatically',
};

export function NotesTimeline({
  notes,
  childId,
  timezone,
  boundaryHour,
  tagsBySlug,
  editingId,
  onEdit,
  onDelete,
  onFilterTag,
  activeTags,
}: NotesTimelineProps) {
  const groups = groupNotesByNight(notes);
  // "Tonight" and "Last night" are relative to the child's own day boundary,
  // not the default noon, or a household that rolls over at 4am reads dates
  // where it expects words.
  const labelOf = (night: string): string =>
    nightLabel(night, { tz: timezone, boundaryHour });

  if (groups.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<NotesIcon size={26} />}
          title="Nothing here yet"
          description="Notes you write — and anything logged from a HomeKit switch or a shortcut — show up here, grouped by night."
        />
      </Card>
    );
  }

  return (
    <div className="timeline">
      {groups.map((group) => (
        <section className="timeline__group" key={group.nightOf} aria-label={labelOf(group.nightOf)}>
          <header className="timeline__heading">
            <h3 className="timeline__night">
              <Link to={`/night/${group.nightOf}`}>{labelOf(group.nightOf)}</Link>
            </h3>
            <span className="timeline__date" data-numeric>
              {group.nightOf}
            </span>
            <span className="timeline__count">
              {group.notes.length} {group.notes.length === 1 ? 'note' : 'notes'}
            </span>
          </header>

          <ul className="timeline__list">
            {group.notes.map((note) => (
              <li className="timeline__item" key={note.id}>
                {editingId === note.id ? (
                  <div className="timeline__editor">
                    <NoteComposer
                      childId={childId}
                      nightOf={note.night_of}
                      note={note}
                      timezone={timezone}
                      boundaryHour={boundaryHour}
                      onCancel={() => onEdit(null)}
                      onSaved={() => onEdit(null)}
                      autoFocus
                    />
                  </div>
                ) : (
                  <article className="note">
                    <div className="note__gutter" aria-hidden="true">
                      <span className="note__dot" />
                    </div>

                    <div className="note__main">
                      <header className="note__head">
                        {note.ts_ms ? (
                          <time className="note__time" dateTime={new Date(note.ts_ms).toISOString()}>
                            {formatClock(note.ts_ms, { tz: timezone })}
                          </time>
                        ) : (
                          <span className="note__time note__time--all">All night</span>
                        )}
                        <span className="note__source">{SOURCE_LABELS[note.source] ?? titleCase(note.source)}</span>
                        <span className="spacer" />
                        <div className="note__tools">
                          <button type="button" className="note__edit" onClick={() => onEdit(note.id)}>
                            Edit
                          </button>
                          <IconButton
                            label={`Delete the note from ${
                              note.ts_ms ? formatClock(note.ts_ms, { tz: timezone }) : labelOf(note.night_of)
                            }`}
                            icon={<TrashIcon size={17} />}
                            size="sm"
                            onClick={() => onDelete(note)}
                          />
                        </div>
                      </header>

                      {note.body ? <p className="note__body">{note.body}</p> : null}

                      {note.tags.length > 0 ? (
                        <div className="note__tags">
                          {note.tags.map((tag) => {
                            const definition = tagsBySlug.get(tag.slug);
                            const label = tagLabel({ label: tag.label, slug: tag.slug });
                            return onFilterTag ? (
                              <Chip
                                key={tag.slug}
                                selected={activeTags?.has(tag.slug) ?? false}
                                value={tagValueDisplay(tag, definition?.unit)}
                                onClick={() => onFilterTag(tag.slug)}
                              >
                                {label}
                              </Chip>
                            ) : (
                              <Chip key={tag.slug} value={tagValueDisplay(tag, definition?.unit)}>
                                {label}
                              </Chip>
                            );
                          })}
                        </div>
                      ) : null}

                      {note.updated_ms > note.created_ms ? (
                        <p className="note__edited">Edited {formatRelative(note.updated_ms)}</p>
                      ) : null}
                    </div>
                  </article>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
