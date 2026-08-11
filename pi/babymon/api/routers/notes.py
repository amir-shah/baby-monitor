"""Notes and tags: the human half of the dataset.

Everything the analytics layer can say about *why* a night went the way it did
comes from here, which puts an unusual constraint on the write path: it has to
be quicker than not bothering. A parent standing in a dark hallway at 19:40
will not open a settings page to declare a new tag before recording that there
was ice cream. So ``POST /api/notes`` creates unknown tag slugs on the fly when
``api.notes.autocreate_tags`` is on, inferring the value type from whichever
value field was sent, and the HomeKit switches and Shortcuts can post
``{"slug": "dessert-before-bed"}`` cold.

The cost of that is a tag list that accumulates near-duplicates, which is why
``DELETE /api/tags/{id}`` archives rather than destroys: the tag stops being
offered, and every night it was ever applied to keeps its history.

Notes are soft-deleted for the same reason. A deleted note that silently
removed a tag from six months of nights would change the answer to "does
dessert matter?" without anyone noticing.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query

from ...bus import Topic
from ...models import Child, Note
from ...storage.repo import Repos
from ...timeutil import night_of as night_of_for
from ...timeutil import now_ms
from ..deps import (
    ChildDep,
    ConfigDep,
    IdempotencyKey,
    PageDep,
    ReposDep,
    RuntimeDep,
    child_or_default,
)
from ..errors import BadRequest, Conflict, NotFound
from ..schemas import (
    NoteCreate,
    NoteOut,
    NoteUpdate,
    TagCreate,
    TagOut,
    TagUpdate,
)

router = APIRouter(tags=["notes"])


def resolve_night(child: Child, night_of: str | None, ts_ms: int | None) -> str:
    """The night a note belongs to: explicit, else derived from its timestamp.

    Derived rather than "today" because a note written at 00:20 about bedtime
    belongs to the night that started the previous evening, and the day
    boundary is what encodes that.
    """
    if night_of:
        return night_of
    return night_of_for(ts_ms if ts_ms is not None else now_ms(),
                        child.timezone, child.day_boundary_hour)


def _publish(runtime: Any, note: Note, child: Child, action: str) -> NoteOut:
    out = NoteOut.from_model(note, child.timezone)
    runtime.bus.publish(Topic.NOTE, {"action": action, "note": out.model_dump()},
                        child_id=child.id)
    return out


# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------


@router.get("/notes", response_model=dict)
def list_notes(
    child: ChildDep,
    repos: ReposDep,
    page: PageDep,
    night_of: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    night_from: Annotated[str | None, Query(alias="from", pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    night_to: Annotated[str | None, Query(alias="to", pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    tag: Annotated[str | None, Query(max_length=64)] = None,
    q: Annotated[str | None, Query(max_length=200, description="Substring of the body.")] = None,
    include_deleted: Annotated[bool, Query()] = False,
) -> dict[str, Any]:
    notes, total = repos.notes.list(
        child_id=child.id,
        night_of=night_of,
        night_from=night_from,
        night_to=night_to,
        tag=tag,
        search=q,
        include_deleted=include_deleted,
        limit=page.limit,
        offset=page.offset,
    )
    tz = child.timezone
    return page.envelope([NoteOut.from_model(n, tz) for n in notes], total)


@router.post("/notes", response_model=NoteOut, status_code=201)
def create_note(
    payload: NoteCreate,
    repos: ReposDep,
    config: ConfigDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> NoteOut:
    child = child_or_default(repos, payload.child_id)
    night = resolve_night(child, payload.night_of, payload.ts_ms)
    try:
        note = repos.notes.create(
            child_id=child.id,
            night_of=night,
            body=payload.body,
            ts_ms=payload.ts_ms,
            source=payload.source,
            tags=[t.to_spec() for t in payload.tags],
            autocreate_tags=config.api.notes.autocreate_tags,
        )
    except KeyError as exc:
        raise BadRequest(
            f"Unknown tag {exc.args[0] if exc.args else ''}. Create it first, or turn on "
            "api.notes.autocreate_tags.",
            code="unknown_tag",
        ) from exc
    return _publish(runtime, note, child, "created")


@router.get("/notes/{note_id}", response_model=NoteOut)
def get_note(note_id: int, repos: ReposDep) -> NoteOut:
    note = _require_note(repos, note_id)
    child = repos.children.get(note.child_id)
    return NoteOut.from_model(note, child.timezone if child else None)


@router.patch("/notes/{note_id}", response_model=NoteOut)
def update_note(
    note_id: int,
    payload: NoteUpdate,
    repos: ReposDep,
    config: ConfigDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> NoteOut:
    existing = _require_note(repos, note_id)
    child = child_or_default(repos, existing.child_id)
    changes = payload.model_dump(exclude_unset=True)
    # Taken from the model rather than the dump: to_spec() omits the fields the
    # caller did not send, and a dumped ``category: None`` would be written to
    # the tag row as the string "None".
    replace_tags = "tags" in changes
    changes.pop("tags", None)
    if "ts_ms" in changes and "night_of" not in changes:
        # Moving a note's timestamp across the day boundary must move the note
        # with it, or the note stays attached to a night it no longer describes.
        changes["night_of"] = resolve_night(child, None, changes["ts_ms"])
    try:
        note = repos.notes.update(
            note_id,
            tags=[t.to_spec() for t in (payload.tags or [])] if replace_tags else None,
            autocreate_tags=config.api.notes.autocreate_tags,
            **changes,
        )
    except KeyError as exc:
        raise BadRequest(
            f"Unknown tag {exc.args[0] if exc.args else ''}.", code="unknown_tag"
        ) from exc
    assert note is not None
    return _publish(runtime, note, child, "updated")


@router.delete("/notes/{note_id}")
def delete_note(
    note_id: int,
    repos: ReposDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> dict[str, Any]:
    note = _require_note(repos, note_id)
    repos.notes.delete(note_id)
    runtime.bus.publish(
        Topic.NOTE, {"action": "deleted", "note": {"id": note_id}}, child_id=note.child_id
    )
    return {"deleted": True, "id": note_id, "ts_ms": now_ms()}


def _require_note(repos: Repos, note_id: int) -> Note:
    note = repos.notes.get(note_id)
    if note is None:
        raise NotFound(f"No note with id {note_id}.", detail={"note_id": note_id})
    return note


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------


@router.get("/tags", response_model=dict)
def list_tags(
    repos: ReposDep,
    include_archived: Annotated[bool, Query()] = False,
    with_stats: Annotated[bool, Query()] = False,
) -> dict[str, Any]:
    tags = repos.tags.list(include_archived=include_archived)
    stats = repos.tags.stats() if with_stats else {}
    items = [TagOut.from_model(tag, stats.get(tag.slug)) for tag in tags]
    return {"items": items, "total": len(items), "limit": len(items), "offset": 0}


@router.post("/tags", response_model=TagOut, status_code=201)
def create_tag(
    payload: TagCreate,
    repos: ReposDep,
    idempotency_key: IdempotencyKey = None,
) -> TagOut:
    slug = payload.slug or payload.label
    if payload.slug and repos.tags.get_by_slug(payload.slug) is not None:
        raise Conflict(
            f"A tag with the slug {payload.slug!r} already exists.",
            code="duplicate_slug",
            detail={"slug": payload.slug},
        )
    data = payload.model_dump()
    data.pop("slug", None)
    label = data.pop("label")
    tag = repos.tags.create(slug, label=label, **data)
    return TagOut.from_model(tag)


@router.patch("/tags/{tag_id}", response_model=TagOut)
def update_tag(
    tag_id: int,
    payload: TagUpdate,
    repos: ReposDep,
    idempotency_key: IdempotencyKey = None,
) -> TagOut:
    if repos.tags.get(tag_id) is None:
        raise NotFound(f"No tag with id {tag_id}.", detail={"tag_id": tag_id})
    tag = repos.tags.update(tag_id, **payload.model_dump(exclude_unset=True))
    assert tag is not None
    return TagOut.from_model(tag)


@router.delete("/tags/{tag_id}", response_model=TagOut)
def archive_tag(
    tag_id: int,
    repos: ReposDep,
    idempotency_key: IdempotencyKey = None,
) -> TagOut:
    """Archive, never destroy: the nights it was applied to keep their history."""
    if repos.tags.get(tag_id) is None:
        raise NotFound(f"No tag with id {tag_id}.", detail={"tag_id": tag_id})
    repos.tags.archive(tag_id)
    tag = repos.tags.get(tag_id)
    assert tag is not None
    return TagOut.from_model(tag)
