"""Live state: the snapshot, the push channel, and the two camera streams.

The Server-Sent Events endpoint is the spine of the whole product — the
dashboard and the HomeKit bridge both hang off it rather than polling — so two
of its properties are load-bearing rather than incidental:

* **The subscription is always torn down.** A phone that walks out of wifi
  range leaves a dead connection, and a bus subscription per dead phone is a
  slow leak in a process that is meant to run for months. Starlette cancels the
  generator when the client goes away; the ``finally`` here is what turns that
  cancellation into an unsubscribe.
* **The heartbeat does not disturb the queue.** Waiting for the next message
  with a timeout would cancel the pending read, and cancelling this bus's
  iterator closes the subscription. So the pending read is kept as a task
  across heartbeat ticks instead of being cancelled and restarted.

``?t=`` media tokens are accepted on the snapshot and MJPEG routes because an
``<img src>`` cannot send an ``Authorization`` header. They are not accepted
here: an event stream carries the whole event log, which is not something to
hand out in a URL that ends up in a browser history.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response, StreamingResponse

from ...bus import Topic
from ...models import Child, LiveState
from ...storage.repo import Repos
from ...timeutil import iso, now_ms
from ..auth import require_auth, require_media_access
from ..deps import ChildDep, ConfigDep, ReposDep, RuntimeDep, get_ctx
from ..errors import BadRequest, Unavailable
from ..schemas import LiveStateOut

log = logging.getLogger(__name__)

router = APIRouter(tags=["state"])

#: The multipart boundary the MJPEG preview uses. Browsers do not care what it
#: is, only that the parts and the header agree, so it is fixed here and the
#: capture side formats its chunks against it.
MJPEG_BOUNDARY = "babymonframe"


# ---------------------------------------------------------------------------
# Current state
# ---------------------------------------------------------------------------


def _night_so_far(repos: Repos, child: Child, night_of: str) -> dict[str, Any]:
    """Tonight's running totals, from the rollup if there is one.

    The rollup for a night in progress is recomputed periodically by the
    service, so this is the same arithmetic the finished night will show rather
    than a second, subtly different definition living in the web layer.
    """
    night = repos.nights.get(child.id, night_of) if night_of else None
    if night is not None:
        return {
            "tst_min": night.tst_min,
            "awakenings": night.awakenings or 0,
            "cry_events": night.cry_events,
            "waso_min": night.waso_min,
            "quality_score": night.quality_score,
        }
    counts = repos.events.counts_for_night(child.id, night_of) if night_of else {}
    return {
        "tst_min": None,
        "awakenings": counts.get("awakening", 0),
        "cry_events": sum(counts.get(label, 0) for label in ("cry", "scream", "whimper", "fuss")),
        "waso_min": None,
        "quality_score": None,
    }


def _live_state(repos: Repos, runtime: Any, child: Child) -> LiveState:
    """The runtime's view, falling back to the last stored sample."""
    try:
        state = runtime.live_state(child.id)
    except Exception:
        log.exception("runtime.live_state failed for child %s", child.id)
        state = None
    if state is None or not state.night_of:
        state = repos.live_state(child)
    return state


@router.get("/state", response_model=LiveStateOut, dependencies=[Depends(require_auth)])
def current_state(child: ChildDep, repos: ReposDep, runtime: RuntimeDep) -> LiveStateOut:
    state = _live_state(repos, runtime, child)
    payload = state.to_dict()
    if not payload.get("night_so_far"):
        payload["night_so_far"] = _night_so_far(repos, child, state.night_of)
    payload["ts_iso"] = iso(state.ts_ms, child.timezone)
    return LiveStateOut(**payload)


# ---------------------------------------------------------------------------
# Server-Sent Events
# ---------------------------------------------------------------------------


def _parse_topics(raw: str | None) -> set[Topic] | None:
    if not raw:
        return None
    wanted: set[Topic] = set()
    unknown: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if not name:
            continue
        try:
            wanted.add(Topic(name))
        except ValueError:
            unknown.append(name)
    if unknown:
        raise BadRequest(
            f"Unknown event type(s): {', '.join(sorted(unknown))}.",
            code="unknown_event_type",
            detail={"valid": sorted(str(t) for t in Topic)},
        )
    # Heartbeats are emitted by this endpoint rather than published on the bus,
    # so asking for them explicitly must not filter everything else out.
    wanted.discard(Topic.HEARTBEAT)
    return wanted or None


def _frame(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n".encode()


async def event_stream(
    request: Request,
    topics: set[Topic] | None,
    child_id: int | None,
    heartbeat_s: float,
) -> Any:
    ctx = get_ctx(request)
    subscription = ctx.runtime.bus.subscribe(topics, child_id)
    messages = subscription.__aiter__()
    pending: asyncio.Task[Any] | None = None
    try:
        # An immediate heartbeat lets a client distinguish "connected, nothing
        # happening" from "still connecting" without waiting a full interval.
        yield _frame(str(Topic.HEARTBEAT), {"ts_ms": now_ms(), "subscribed": True})
        while True:
            if pending is None:
                pending = asyncio.ensure_future(anext(messages))
            done, _ = await asyncio.wait({pending}, timeout=heartbeat_s)
            if pending not in done:
                if await request.is_disconnected():
                    break
                yield _frame(str(Topic.HEARTBEAT), {"ts_ms": now_ms()})
                continue
            task, pending = pending, None
            try:
                message = task.result()
            except (StopAsyncIteration, asyncio.CancelledError):
                break
            yield _frame(str(message.topic), message.data)
    finally:
        if pending is not None:
            pending.cancel()
        subscription.close()


@router.get("/stream/events", dependencies=[Depends(require_auth)])
async def stream_events(
    request: Request,
    config: ConfigDep,
    types: Annotated[str | None, Query(description="Comma-separated SSE event names.")] = None,
    child_id: Annotated[int | None, Query()] = None,
) -> StreamingResponse:
    topics = _parse_topics(types)
    return StreamingResponse(
        event_stream(request, topics, child_id, max(1.0, config.api.sse_heartbeat_s)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # nginx in front of a Pi will otherwise buffer the stream into
            # uselessness, which looks exactly like the monitor having died.
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------


@router.get(
    "/snapshot.jpg",
    dependencies=[Depends(require_media_access)],
    response_class=StreamingResponse,
    responses={200: {"content": {"image/jpeg": {}}}},
)
def snapshot(
    runtime: RuntimeDep,
    width: Annotated[int | None, Query(ge=16, le=4096)] = None,
    height: Annotated[int | None, Query(ge=16, le=4096)] = None,
    max_age_s: Annotated[float, Query(ge=0, le=3600)] = 0,
) -> Any:
    """The current frame as JPEG. What the HomeKit bridge serves for snapshots.

    ``max_age_s`` is how stale a frame the caller is willing to accept, and is
    passed straight through as ``Cache-Control``; zero means always refetch.
    """
    try:
        frame = runtime.snapshot(width, height)
    except Exception as exc:
        log.exception("snapshot failed")
        raise Unavailable(f"The camera could not produce a frame: {exc}") from exc
    if not frame:
        raise Unavailable(
            "No camera frame is available. The camera may be disabled or still starting.",
            code="camera_unavailable",
        )
    cache = "no-store" if max_age_s <= 0 else f"private, max-age={int(max_age_s)}"
    return Response(
        content=frame,
        media_type="image/jpeg",
        headers={"Cache-Control": cache, "Content-Length": str(len(frame))},
    )


@router.get("/stream/mjpeg", dependencies=[Depends(require_media_access)])
def mjpeg(
    runtime: RuntimeDep,
    fps: Annotated[float, Query(gt=0, le=30)] = 5.0,
    width: Annotated[int | None, Query(ge=16, le=4096)] = None,
) -> StreamingResponse:
    """A ``multipart/x-mixed-replace`` preview for the dashboard."""
    try:
        chunks = runtime.mjpeg_stream(fps, width)
    except Exception as exc:
        log.exception("mjpeg stream failed to start")
        raise Unavailable(f"The camera preview could not start: {exc}") from exc
    return StreamingResponse(
        chunks,
        media_type=f"multipart/x-mixed-replace; boundary={MJPEG_BOUNDARY}",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
