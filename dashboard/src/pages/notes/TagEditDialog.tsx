/**
 * Create or edit a tag definition.
 *
 * The value type is the consequential field: it decides which control the
 * composer shows and, downstream, whether the correlation engine treats the
 * tag as a two-group comparison or a rank correlation. Changing it on a tag
 * with history is allowed — people do mean "actually, record the minutes" —
 * but it is called out, because the values already stored were written against
 * the old control.
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Modal, Select, describeError, useToast } from '../../components';
import { tags as tagsApi } from '../../lib/api';
import { slugify, tagCategoryLabel } from '../../lib/format';
import { VALUE_TYPE_HINTS, VALUE_TYPE_LABELS, tagLabel } from '../../lib/notesModel';
import { TAG_CATEGORIES, TAG_VALUE_TYPES } from '../../lib/types';
import type { ExpectedDirection, TagCategory, TagValueType, TagWithStats } from '../../lib/types';
import './TagEditDialog.css';

/**
 * A small fixed palette rather than a colour picker.
 *
 * Free choice produces tags nobody can read on one of the two themes. These
 * are the chart hues, which are already checked for contrast in both — and the
 * name is always rendered next to the swatch, because colour on its own never
 * carries meaning here.
 */
const SWATCHES: readonly { value: string | null; name: string }[] = [
  { value: null, name: 'No colour' },
  { value: '#7aa2f7', name: 'Periwinkle' },
  { value: '#5cc7ad', name: 'Sea green' },
  { value: '#e0b25c', name: 'Amber' },
  { value: '#ef9270', name: 'Coral' },
  { value: '#c78ce0', name: 'Lilac' },
  { value: '#6fb6d6', name: 'Sky' },
  { value: '#9aa4b8', name: 'Slate' },
];

export interface TagEditDialogProps {
  open: boolean;
  /** Omit to create a new tag. */
  tag?: TagWithStats | null;
  onClose: () => void;
  onSaved?: () => void;
}

interface Draft {
  slug: string;
  label: string;
  category: TagCategory;
  value_type: TagValueType;
  unit: string;
  color: string | null;
  expected_direction: ExpectedDirection | '';
}

export function TagEditDialog({ open, tag, onClose, onSaved }: TagEditDialogProps) {
  if (!open) return null;
  return <TagEditForm key={tag?.id ?? 'new'} tag={tag} onClose={onClose} onSaved={onSaved} />;
}

function TagEditForm({ tag, onClose, onSaved }: Omit<TagEditDialogProps, 'open'>) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const editing = Boolean(tag);

  const [draft, setDraft] = useState<Draft>(() => ({
    slug: tag?.slug ?? '',
    label: tag ? tagLabel(tag) : '',
    category: tag?.category ?? 'other',
    value_type: tag?.value_type ?? 'bool',
    unit: tag?.unit ?? '',
    color: tag?.color ?? null,
    expected_direction: tag?.expected_direction ?? '',
  }));
  /** Left false until the slug is typed into, so it keeps tracking the label. */
  const [slugTouched, setSlugTouched] = useState(editing);

  const effectiveSlug = slugTouched ? slugify(draft.slug) : slugify(draft.label);
  const typeChanged = editing && tag !== undefined && tag !== null && tag.value_type !== draft.value_type;
  const nightsLogged = tag?.nights_applied ?? 0;

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        label: draft.label.trim() || effectiveSlug,
        category: draft.category,
        value_type: draft.value_type,
        unit: draft.unit.trim() || null,
        color: draft.color,
        expected_direction: draft.expected_direction === '' ? null : draft.expected_direction,
      };
      if (tag) return tagsApi.update(tag.id, { ...body, slug: effectiveSlug });
      return tagsApi.create({ ...body, slug: effectiveSlug });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tags'] });
      toast.success(editing ? 'Tag updated.' : 'Tag created.');
      onSaved?.();
      onClose();
    },
    onError: (error) => {
      const described = describeError(error);
      toast.error(described.description ?? described.title);
    },
  });

  const canSave = effectiveSlug.length > 0 && !save.isPending;

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    if (canSave) save.mutate();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit “${tagLabel({ label: draft.label, slug: effectiveSlug })}”` : 'New tag'}
      description={
        editing
          ? 'Renaming is safe: every night this tag was applied to keeps it.'
          : 'A tag is a factor the analysis can test against your nights.'
      }
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={!canSave}
            loading={save.isPending}
            loadingLabel="Saving"
          >
            {editing ? 'Save changes' : 'Create tag'}
          </Button>
        </>
      }
    >
      <form className="tag-form" onSubmit={onSubmit}>
        <div className="field field--block">
          <label className="field__label" htmlFor="tag-label">
            Name
          </label>
          <input
            id="tag-label"
            className="input"
            type="text"
            value={draft.label}
            autoFocus
            placeholder="Dessert before bedtime"
            onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          />
        </div>

        <div className="field field--block">
          <label className="field__label" htmlFor="tag-slug">
            Slug
          </label>
          <input
            id="tag-slug"
            className="input tag-form__slug"
            type="text"
            value={slugTouched ? draft.slug : effectiveSlug}
            onChange={(event) => {
              setSlugTouched(true);
              setDraft((current) => ({ ...current, slug: event.target.value }));
            }}
          />
          <p className="field__hint">
            The stable identifier a HomeKit switch or a shortcut posts. It follows the name until you
            change it.
          </p>
        </div>

        <Select
          block
          label="Kind of value"
          value={draft.value_type}
          onValueChange={(value_type) => setDraft((current) => ({ ...current, value_type }))}
          options={TAG_VALUE_TYPES.map((type) => ({ value: type, label: VALUE_TYPE_LABELS[type] }))}
          hint={VALUE_TYPE_HINTS[draft.value_type]}
        />

        {typeChanged && nightsLogged > 0 ? (
          <p className="field__error">
            {nightsLogged} {nightsLogged === 1 ? 'night has' : 'nights have'} already been logged with
            the old kind of value. Those entries keep what they hold, so the analysis may see a mix
            until they are edited.
          </p>
        ) : null}

        {draft.value_type === 'number' || draft.value_type === 'duration' ? (
          <div className="field field--block">
            <label className="field__label" htmlFor="tag-unit">
              Unit
            </label>
            <input
              id="tag-unit"
              className="input"
              type="text"
              value={draft.unit}
              placeholder={draft.value_type === 'duration' ? 'min' : 'e.g. cups'}
              onChange={(event) => setDraft((current) => ({ ...current, unit: event.target.value }))}
            />
          </div>
        ) : null}

        <Select
          block
          label="Category"
          value={draft.category}
          onValueChange={(category) => setDraft((current) => ({ ...current, category }))}
          options={TAG_CATEGORIES.map((category) => ({
            value: category,
            label: tagCategoryLabel(category),
          }))}
        />

        <Select
          block
          label="What you expect it to do"
          value={draft.expected_direction}
          onValueChange={(value) =>
            setDraft((current) => ({ ...current, expected_direction: value as ExpectedDirection | '' }))
          }
          options={[
            { value: '', label: 'No expectation' },
            { value: 'worse', label: 'Expect worse sleep' },
            { value: 'better', label: 'Expect better sleep' },
          ]}
          hint="Only used to order the analysis. It never touches the statistics."
        />

        <fieldset className="tag-form__colors">
          <legend className="field__label">Colour</legend>
          <div className="tag-form__swatches">
            {SWATCHES.map((swatch) => {
              const selected = (draft.color ?? null) === swatch.value;
              return (
                <label
                  key={swatch.name}
                  className={selected ? 'tag-form__swatch is-selected' : 'tag-form__swatch'}
                >
                  <input
                    type="radio"
                    name="tag-color"
                    className="visually-hidden"
                    checked={selected}
                    onChange={() => setDraft((current) => ({ ...current, color: swatch.value }))}
                  />
                  <span
                    className="tag-form__chip"
                    style={swatch.value ? { background: swatch.value } : undefined}
                    aria-hidden="true"
                  >
                    {swatch.value ? (selected ? '✓' : '') : '—'}
                  </span>
                  <span className="tag-form__swatch-name">{swatch.name}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <button type="submit" className="visually-hidden" tabIndex={-1} disabled={!canSave}>
          Save
        </button>
      </form>
    </Modal>
  );
}
