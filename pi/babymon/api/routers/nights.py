"""Night rollups: the list, one night in full, and manual correction.

``GET /api/nights/{night_of}`` is the single request behind the whole night
detail page — rollup, hypnogram, events, notes and a downsampled series — on
purpose. A page that made five round trips to a Pi over household wifi would
paint in five stages, and the timeline chart would arrive last.

The series is always bucketed. A night is around 5 700 sample rows at the
default 15-second interval; sending those to a phone to draw a chart 900 pixels
wide wastes most of a megabyte to draw the same picture. ``?series_bucket_s``
controls the resolution, and the bucketing itself lives in ``SampleRepo`` so
that peaks survive it — an averaged-away two-second cry is the one thing the
chart exists to show.

``PATCH`` writes the four anchors as *overrides* and then recomputes. The
recompute honours them (see ``compute_metrics(overrides=...)``), so correcting
a bedtime the state machine got wrong fixes SOL, TIB and efficiency together
rather than leaving a set of numbers that disagree with each other.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query

from ...bus import Topic
from ...models import Child, Night
from ...timeutil import night_bounds, parse_date
from ..deps import ChildDep, IdempotencyKey, ReposDep, RuntimeDep
from ..errors import BadRequest, NotFound
from ..schemas import EventOut, NightOut, NightUpdate, NoteOut, SegmentOut

router = APIRouter(prefix="/nights", tags=["nights"])

#: One point per minute is already finer than any phone screen; anything below
#: 10 s is asking for the raw table by another name.
MIN_BUCKET_S = 10
MAX_BUCKET_S = 3600


def _bounds(child: Child, night_of: str) -> tuple[int, int]:
    try:
        parse_date(night_of)
    except ValueError as exc:
        raise BadRequest(str(exc), code="bad_night_key") from exc
    return night_bounds(night_of, child.timezone, child.day_boundary_hour)


def _require_night(repos: Any, child: Child, night_of: str) -> Night:
    night = repos.nights.get(child.id, night_of)
    if night is None:
        raise NotFound(
            f"No rollup for the night of {night_of}.",
            detail={"child_id": child.id, "night_of": night_of},
        )
    return night


@router.get("", response_model=dict)
def list_nights(
    child: ChildDep,
    repos: ReposDep,
    night_from: Annotated[str | None, Query(alias="from", pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    night_to: Annotated[str | None, Query(alias="to", pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    include_excluded: Annotated[bool, Query()] = True,
    only_analysable: Annotated[bool, Query()] = False,
    limit: Annotated[int, Query(ge=1, le=1000)] = 400,
) -> dict[str, Any]:
    nights = repos.nights.list(
        child.id,
        night_from=night_from,
        night_to=night_to,
        include_excluded=include_excluded,
        only_analysable=only_analysable,
        limit=limit,
    )
    items = [NightOut.from_model(n) for n in nights]
    return {"items": items, "total": len(items), "limit": limit, "offset": 0}


@router.get("/{night_of}", response_model=dict)
def get_night(
    night_of: str,
    child: ChildDep,
    repos: ReposDep,
    series_bucket_s: Annotated[int, Query(ge=MIN_BUCKET_S, le=MAX_BUCKET_S)] = 60,
) -> dict[str, Any]:
    night = _require_night(repos, child, night_of)
    start_ms, end_ms = _bounds(child, night_of)
    events = repos.events.for_night(child.id, night_of, with_media=True)
    notes, _ = repos.notes.list(child_id=child.id, night_of=night_of, limit=500)
    tz = child.timezone
    return {
        "night": NightOut.from_model(night),
        "segments": [SegmentOut.from_model(s) for s in repos.segments.for_night(child.id, night_of)],
        "events": [EventOut.from_model(e, tz) for e in events],
        "notes": [NoteOut.from_model(n, tz) for n in notes],
        "series": repos.samples.downsample(child.id, start_ms, end_ms, series_bucket_s),
        "bounds": {"start_ms": start_ms, "end_ms": end_ms, "bucket_s": series_bucket_s},
    }


@router.get("/{night_of}/series", response_model=dict)
def night_series(
    night_of: str,
    child: ChildDep,
    repos: ReposDep,
    bucket_s: Annotated[int, Query(ge=MIN_BUCKET_S, le=MAX_BUCKET_S)] = 60,
) -> dict[str, Any]:
    """Just the time series, for a chart that is refreshing itself."""
    start_ms, end_ms = _bounds(child, night_of)
    points = repos.samples.downsample(child.id, start_ms, end_ms, bucket_s)
    return {
        "child_id": child.id,
        "night_of": night_of,
        "bucket_s": bucket_s,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "points": points,
        "total": len(points),
    }


@router.patch("/{night_of}", response_model=NightOut)
def update_night(
    night_of: str,
    payload: NightUpdate,
    child: ChildDep,
    repos: ReposDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> NightOut:
    """Correct the anchors or exclude the night, then rebuild the rollup."""
    _require_night(repos, child, night_of)
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise BadRequest("Nothing to change.", code="empty_patch")

    anchors = [changes[k] for k in ("bedtime_ms", "sleep_onset_ms", "final_wake_ms",
                                    "out_of_bed_ms") if changes.get(k) is not None]
    if anchors != sorted(anchors):
        raise BadRequest(
            "The anchors must run bedtime -> sleep onset -> final wake -> out of bed.",
            code="anchors_out_of_order",
        )

    repos.nights.set_flags(child.id, night_of, **changes)
    _recompute(repos, runtime, child, night_of)
    night = _require_night(repos, child, night_of)
    out = NightOut.from_model(night)
    runtime.bus.publish(Topic.NIGHT, out.model_dump(), child_id=child.id)
    return out


@router.post("/{night_of}/recompute", response_model=NightOut)
def recompute_night(
    night_of: str,
    child: ChildDep,
    repos: ReposDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> NightOut:
    _bounds(child, night_of)
    _recompute(repos, runtime, child, night_of)
    night = _require_night(repos, child, night_of)
    out = NightOut.from_model(night)
    runtime.bus.publish(Topic.NIGHT, out.model_dump(), child_id=child.id)
    return out


def _recompute(repos: Any, runtime: Any, child: Child, night_of: str) -> None:
    """Ask the service to rebuild a night, tolerating a runtime without sensors.

    A recompute failing is a degraded feature, not a corrupted one — the stored
    rollup is still whatever it was — so it is logged to the system log and the
    caller gets the unchanged night back rather than a 500.
    """
    try:
        runtime.recompute_night(child.id, night_of)
    except Exception as exc:  # noqa: BLE001 - see docstring
        repos.syslog.add(
            "warning", "api", f"recompute of {night_of} failed", error=str(exc),
            child_id=child.id,
        )
