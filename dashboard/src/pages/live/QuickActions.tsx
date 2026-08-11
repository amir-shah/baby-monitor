/**
 * The two things worth doing from a phone at 3am: write down what just
 * happened, and flip the switches for the things that were true about today.
 *
 * The chips are the same tag vocabulary the HomeKit switches and the analysis
 * use, and they behave the same way: a chip that is on means tonight has a
 * note carrying that tag. Turning one off removes the tag again — deleting the
 * note only when it is one this control created (a bare tag note whose body is
 * just the tag's own label). A note somebody actually typed never gets thrown
 * away by a mis-tap on a chip; it just loses the tag.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Chip, describeError, Skeleton, useToast } from '../../components';
import { PlusIcon, TagIcon } from '../../components/Icons';
import { NoteComposerDialog } from '../../components/NoteComposerDialog';
import { notes as notesApi, tags as tagsApi } from '../../lib/api';
import type { StreamSubscribe } from '../../hooks/useEventStream';
import type { NightOf, Note, NoteTag, NoteTagInput, TagWithStats } from '../../lib/types';
import './QuickActions.css';

/** Enough to be useful on one thumb-swipe; the rest live in the composer. */
const MAX_CHIPS = 8;

export interface QuickActionsProps {
  childId: number | undefined;
  nightOf: NightOf;
  subscribe: StreamSubscribe;
}

function toInput(tag: NoteTag): NoteTagInput {
  return {
    slug: tag.slug,
    value_num: tag.value_num ?? null,
    value_min_local: tag.value_min_local ?? null,
    value_text: tag.value_text ?? null,
  };
}

export function QuickActions({ childId, nightOf, subscribe }: QuickActionsProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [composerOpen, setComposerOpen] = useState(false);
  /** Slugs mid-flight, so a chip responds to the tap rather than to the round trip. */
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});

  const notesKey = useMemo(
    () => ['notes', 'tonight', childId ?? null, nightOf] as const,
    [childId, nightOf],
  );

  const tagsQuery = useQuery({
    queryKey: ['tags'],
    queryFn: ({ signal }) => tagsApi.list({}, signal),
    staleTime: 5 * 60_000,
  });

  const notesQuery = useQuery({
    queryKey: notesKey,
    queryFn: ({ signal }) =>
      notesApi.list({ child_id: childId, night_of: nightOf, limit: 100 }, signal),
    staleTime: 15_000,
  });

  // A note created from HomeKit, a shortcut or another tab shows up here too.
  useEffect(() => {
    return subscribe('note', () => {
      void queryClient.invalidateQueries({ queryKey: ['notes'] });
    });
  }, [subscribe, queryClient]);

  const chips = useMemo(() => {
    const items = (tagsQuery.data?.items ?? []).filter(
      (tag) => !tag.archived && tag.value_type === 'bool',
    );
    return [...items]
      .sort((a, b) => {
        if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
        // Then by how often it actually gets used, when the server tells us.
        const used = (b.nights_applied ?? 0) - (a.nights_applied ?? 0);
        return used !== 0 ? used : a.label.localeCompare(b.label);
      })
      .slice(0, MAX_CHIPS);
  }, [tagsQuery.data]);

  const tonightsNotes = useMemo(() => notesQuery.data?.items ?? [], [notesQuery.data]);

  const appliedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const note of tonightsNotes) {
      for (const tag of note.tags) set.add(tag.slug);
    }
    return set;
  }, [tonightsNotes]);

  const isOn = useCallback(
    (slug: string) => optimistic[slug] ?? appliedSlugs.has(slug),
    [optimistic, appliedSlugs],
  );

  const toggle = useMutation({
    mutationFn: async ({ tag, on }: { tag: TagWithStats; on: boolean }) => {
      if (childId === undefined) throw new Error('No child is selected.');

      if (on) {
        // The body doubles as the note's own text in the journal, so a tag
        // switch reads as a sentence rather than a blank row.
        await notesApi.create({
          child_id: childId,
          night_of: nightOf,
          ts_ms: Date.now(),
          body: tag.label,
          tags: [{ slug: tag.slug }],
        });
        return;
      }

      const carriers = tonightsNotes.filter((note) =>
        note.tags.some((entry) => entry.slug === tag.slug),
      );
      for (const note of carriers) {
        const remaining = note.tags.filter((entry) => entry.slug !== tag.slug);
        if (remaining.length === 0 && note.body.trim() === tag.label) {
          await notesApi.remove(note.id);
        } else {
          await notesApi.update(note.id, { tags: remaining.map(toInput) });
        }
      }
    },
    onMutate: ({ tag, on }) => {
      setOptimistic((current) => ({ ...current, [tag.slug]: on }));
    },
    onError: (error, { tag }) => {
      setOptimistic((current) => {
        const next = { ...current };
        delete next[tag.slug];
        return next;
      });
      const described = describeError(error);
      toast.error(described.description ?? described.title);
    },
    onSuccess: (_data, { tag, on }) => {
      toast.toast(on ? `${tag.label} added to tonight.` : `${tag.label} removed.`, {
        duration: 3_000,
      });
    },
    onSettled: (_data, _error, { tag }) => {
      void queryClient
        .invalidateQueries({ queryKey: ['notes'] })
        .finally(() =>
          setOptimistic((current) => {
            const next = { ...current };
            delete next[tag.slug];
            return next;
          }),
        );
    },
  });

  const onSaved = useCallback(
    (note: Note) => {
      void note;
      void queryClient.invalidateQueries({ queryKey: notesKey });
    },
    [queryClient, notesKey],
  );

  return (
    <div className="quick">
      <Button
        variant="primary"
        size="lg"
        block
        iconStart={<PlusIcon size={18} />}
        onClick={() => setComposerOpen(true)}
        disabled={childId === undefined}
      >
        Add a note
      </Button>

      <div className="quick__tags">
        <p className="quick__heading">
          <TagIcon size={15} />
          Tonight&rsquo;s tags
        </p>

        {tagsQuery.isPending ? (
          <div className="chip-row" aria-busy="true">
            <span className="visually-hidden">Loading tags</span>
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} width="6.5rem" height="2.25rem" shape="block" />
            ))}
          </div>
        ) : chips.length === 0 ? (
          <p className="quick__hint">
            No one-tap tags yet. Anything you tag in a note becomes one.
          </p>
        ) : (
          <div className="chip-row">
            {chips.map((tag) => (
              <Chip
                key={tag.slug}
                selected={isOn(tag.slug)}
                disabled={childId === undefined || toggle.isPending}
                onClick={() => toggle.mutate({ tag, on: !isOn(tag.slug) })}
              >
                {tag.label}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <NoteComposerDialog
        open={composerOpen}
        onClose={() => setComposerOpen(false)}
        childId={childId}
        nightOf={nightOf}
        onSaved={onSaved}
      />
    </div>
  );
}
