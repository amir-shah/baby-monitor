"""The event log, and the correction loop that keeps the detector honest.

``PATCH /api/events/{id}`` with ``corrected_label`` is the most valuable write
in the whole API. It is how a parent says "that was the radiator, not the
baby", and ``EventRepo.label_feedback`` turns a season of those corrections
into the detector-tuning report. Two conventions make it work:

* ``corrected_label: ""`` means *this was not a real event*. Empty string, not
  null — null means "no correction has been made", and conflating the two
  would make every untouched event look like a confirmed true positive.
* The original ``label`` is never overwritten. Both the detector's guess and
  the human's answer are kept, because a correction is only useful as a pair.

Deletion is restricted to manual events. A detected event is a record of what
the microphone heard; disagreeing with it is what the correction is for.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query

from ...bus import Topic
from ...models import EventKind, Severity
from ...timeutil import night_of as night_of_for
from ...timeutil import now_ms
from ..deps import ChildDep, IdempotencyKey, PageDep, ReposDep, RuntimeDep
from ..errors import BadRequest, Conflict, NotFound
from ..schemas import EventCreate, EventOut, EventUpdate

router = APIRouter(prefix="/events", tags=["events"])


def _split(raw: str | None) -> list[str] | None:
    if not raw:
        return None
    values = [part.strip() for part in raw.split(",") if part.strip()]
    return values or None


@router.get("", response_model=dict)
def list_events(
    child: ChildDep,
    repos: ReposDep,
    page: PageDep,
    night_of: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    night_from: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    night_to: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    from_ms: Annotated[int | None, Query()] = None,
    to_ms: Annotated[int | None, Query()] = None,
    kind: Annotated[str | None, Query(description="Comma-separated event kinds.")] = None,
    label: Annotated[str | None, Query(description="Comma-separated labels.")] = None,
    min_confidence: Annotated[float | None, Query(ge=0.0, le=1.0)] = None,
    acknowledged: Annotated[bool | None, Query()] = None,
    exclude_false_positives: Annotated[bool, Query()] = False,
    order: Annotated[str, Query(pattern="^(asc|desc)$")] = "desc",
    with_media: Annotated[bool, Query()] = True,
) -> dict[str, Any]:
    kinds = _split(kind)
    if kinds:
        unknown = [k for k in kinds if k not in {str(v) for v in EventKind}]
        if unknown:
            raise BadRequest(
                f"Unknown event kind(s): {', '.join(unknown)}.",
                code="unknown_kind",
                detail={"valid": [str(v) for v in EventKind]},
            )
    # A night range must be resolved here, not in the browser. "The nights of
    # the 3rd to the 7th" is a span in the *child's* timezone with the child's
    # day boundary in it; a client computing the millisecond bounds itself would
    # use the phone's timezone and silently return the wrong events to anyone
    # looking at the dashboard from another zone.
    events, total = repos.events.list(
        child_id=child.id,
        night_of=night_of,
        night_from=night_from,
        night_to=night_to,
        from_ms=from_ms,
        to_ms=to_ms,
        kinds=kinds,
        labels=_split(label),
        min_confidence=min_confidence,
        acknowledged=acknowledged,
        exclude_false_positives=exclude_false_positives,
        limit=page.limit,
        offset=page.offset,
        order=order,
        with_media=with_media,
    )
    tz = child.timezone
    return page.envelope([EventOut.from_model(e, tz) for e in events], total)


@router.post("", response_model=EventOut, status_code=201)
def create_event(
    payload: EventCreate,
    child: ChildDep,
    repos: ReposDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> EventOut:
    """Record something a human observed. Always ``source: manual``."""
    if payload.end_ms is not None and payload.end_ms < payload.start_ms:
        raise BadRequest("end_ms is before start_ms.", code="bad_range")
    night = night_of_for(payload.start_ms, child.timezone, child.day_boundary_hour)
    event_id = repos.events.open(
        child_id=child.id,
        night_of=night,
        start_ms=payload.start_ms,
        end_ms=payload.end_ms,
        kind=payload.kind,
        label=payload.label,
        confidence=payload.confidence,
        severity=Severity(payload.severity),
        source="manual",
        meta=payload.meta,
    )
    event = repos.events.get(event_id)
    assert event is not None
    out = EventOut.from_model(event, child.timezone)
    runtime.bus.publish(
        Topic.EVENT_CLOSE if event.end_ms is not None else Topic.EVENT_OPEN,
        out.model_dump(),
        child_id=child.id,
    )
    return out


@router.get("/{event_id}", response_model=EventOut)
def get_event(event_id: int, repos: ReposDep) -> EventOut:
    event = repos.events.get(event_id)
    if event is None:
        raise NotFound(f"No event with id {event_id}.", detail={"event_id": event_id})
    child = repos.children.get(event.child_id)
    return EventOut.from_model(event, child.timezone if child else None)


@router.patch("/{event_id}", response_model=EventOut)
def update_event(
    event_id: int,
    payload: EventUpdate,
    repos: ReposDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> EventOut:
    existing = repos.events.get(event_id)
    if existing is None:
        raise NotFound(f"No event with id {event_id}.", detail={"event_id": event_id})

    # exclude_unset is what distinguishes corrected_label="" (a false positive)
    # from corrected_label absent (leave the correction alone).
    changes = payload.model_dump(exclude_unset=True)
    if "severity" in changes and changes["severity"] is not None:
        changes["severity"] = str(Severity(changes["severity"]))
    if "acknowledged" in changes and changes["acknowledged"] is None:
        del changes["acknowledged"]
    if not changes:
        child = repos.children.get(existing.child_id)
        return EventOut.from_model(existing, child.timezone if child else None)

    event = repos.events.update(event_id, **changes)
    assert event is not None
    child = repos.children.get(event.child_id)
    out = EventOut.from_model(event, child.timezone if child else None)
    runtime.bus.publish(Topic.EVENT_CLOSE, out.model_dump(), child_id=event.child_id)
    return out


@router.delete("/{event_id}")
def delete_event(
    event_id: int,
    repos: ReposDep,
    idempotency_key: IdempotencyKey = None,
) -> dict[str, Any]:
    event = repos.events.get(event_id)
    if event is None:
        raise NotFound(f"No event with id {event_id}.", detail={"event_id": event_id})
    if event.source != "manual":
        raise Conflict(
            "Only manually created events can be deleted. To say a detected event "
            "was wrong, set corrected_label instead — that feeds the tuning report.",
            code="not_manual",
            detail={"source": event.source},
        )
    repos.events.delete(event_id)
    return {"deleted": True, "id": event_id, "ts_ms": now_ms()}
