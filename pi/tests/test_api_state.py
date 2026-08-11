"""Live state, the SSE channel, the camera routes, CORS and the SPA fallback."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from babymon.api.routers.state import event_stream
from babymon.bus import ComponentHealth, Topic
from babymon.models import LiveState, SleepState

from .test_api_common import build, current_night

NIGHT = current_night()


class FakeRuntime:
    """A runtime with a camera and a state, so the happy paths are reachable."""

    def __init__(self, bus: Any, state: LiveState | None = None) -> None:
        self.bus = bus
        self.state = state
        self.frame: bytes | None = b"\xff\xd8\xff-not-really-a-jpeg"
        self.recomputed: list[tuple[int, str]] = []

    def live_state(self, child_id: int) -> LiveState | None:
        return self.state

    def snapshot(self, width: int | None = None, height: int | None = None) -> bytes | None:
        return self.frame

    def mjpeg_stream(self, fps: float = 5.0, width: int | None = None):
        yield b"--babymonframe\r\nContent-Type: image/jpeg\r\n\r\nxx\r\n"

    def health(self) -> list[ComponentHealth]:
        return [
            ComponentHealth("camera", True, "streaming"),
            ComponentHealth("audio", False, "no such device"),
        ]

    def recompute_night(self, child_id: int, night_of: str) -> None:
        self.recomputed.append((child_id, night_of))


def _with_runtime(tmp_path: Path, state: LiveState | None = None):
    harness = build(tmp_path)
    harness.runtime = FakeRuntime(harness.runtime.bus, state)
    harness.app.state.ctx.runtime = harness.runtime
    return harness


# ---------------------------------------------------------------------------
# /api/state
# ---------------------------------------------------------------------------


def test_state_falls_back_to_the_last_stored_sample(tmp_path: Path) -> None:
    harness = build(tmp_path)
    harness.add_samples(NIGHT, count=3)
    with harness.client() as client:
        body = client.get("/api/state").json()
    assert body["child_id"] == harness.child.id
    assert body["night_of"] == NIGHT
    assert body["state"] == "asleep"
    assert body["ts_iso"] is not None
    assert body["night_so_far"]["awakenings"] == 0


def test_state_reports_the_runtime_view_and_derived_fields(tmp_path: Path) -> None:
    harness = build(tmp_path)
    start, _ = harness.night_bounds(NIGHT)
    state = LiveState(
        ts_ms=start + 9_000_000,
        child_id=harness.child.id,
        night_of=NIGHT,
        state=SleepState.ASLEEP,
        state_since_ms=start + 3_000_000,
        sound_dbfs=-54.2,
        noise_floor_dbfs=-58.0,
        cry_score=0.02,
        motion=0.004,
        temp_c=20.8,
        humidity_pct=47.0,
        camera_online=True,
        audio_online=True,
    )
    harness.runtime = FakeRuntime(harness.runtime.bus, state)
    harness.app.state.ctx.runtime = harness.runtime
    harness.add_night(NIGHT, tst_min=88.0, awakenings=1)

    with harness.client() as client:
        body = client.get("/api/state").json()
    assert body["state"] == "asleep"
    assert body["sound_above_floor_db"] == pytest.approx(3.8, abs=1e-6)
    assert body["asleep_for_min"] == pytest.approx(100.0)
    assert body["camera_online"] is True
    assert body["night_so_far"]["tst_min"] == 88.0
    assert body["night_so_far"]["awakenings"] == 1


def test_health_reflects_the_runtime_components(tmp_path: Path) -> None:
    harness = _with_runtime(tmp_path)
    with harness.client() as client:
        body = client.get("/api/health").json()
    assert body["status"] == "degraded"
    assert body["components"]["camera"]["ok"] is True
    assert body["components"]["audio"]["ok"] is False
    assert "audio" in body["degraded"]
    assert "env" in body["degraded"]  # never reported by this runtime


# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------


def test_snapshot_and_mjpeg(tmp_path: Path) -> None:
    harness = _with_runtime(tmp_path)
    with harness.client() as client:
        shot = client.get("/api/snapshot.jpg?width=320&max_age_s=5")
        assert shot.status_code == 200
        assert shot.headers["content-type"] == "image/jpeg"
        assert shot.headers["cache-control"] == "private, max-age=5"

        fresh = client.get("/api/snapshot.jpg")
        assert fresh.headers["cache-control"] == "no-store"

        stream = client.get("/api/stream/mjpeg?fps=2")
        assert stream.status_code == 200
        assert "boundary=babymonframe" in stream.headers["content-type"]

        harness.runtime.frame = None
        missing = client.get("/api/snapshot.jpg")
        assert missing.status_code == 503
        assert missing.json()["error"]["code"] == "camera_unavailable"


def test_snapshot_without_a_camera_is_503_not_500(tmp_path: Path) -> None:
    harness = build(tmp_path)  # NullRuntime: no camera at all
    with harness.client() as client:
        response = client.get("/api/snapshot.jpg")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "camera_unavailable"


# ---------------------------------------------------------------------------
# Server-Sent Events
# ---------------------------------------------------------------------------


class StubRequest:
    """Just enough of a ``Request`` for the stream generator.

    Starlette's ``TestClient`` buffers a response body to completion before
    handing it back, so an endpoint that never finishes cannot be driven over
    it. The generator is therefore exercised directly — which is also where the
    behaviour that matters lives: filtering, heartbeats, and unsubscribing.
    """

    def __init__(self, app: Any, disconnected: bool = False) -> None:
        self.app = app
        self.disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self.disconnected


def _parse(frame: bytes) -> tuple[str, dict[str, Any]]:
    text = frame.decode()
    assert text.endswith("\n\n")
    event_line, data_line = text.strip().split("\n", 1)
    return event_line.removeprefix("event: "), json.loads(data_line.removeprefix("data: "))


async def _bound(harness: Any) -> Any:
    harness.runtime.bus.bind_loop(asyncio.get_running_loop())
    return harness.runtime.bus


async def test_sse_delivers_published_messages_and_honours_the_type_filter(
    tmp_path: Path,
) -> None:
    harness = build(tmp_path)
    bus = await _bound(harness)
    stream = event_stream(StubRequest(harness.app), {Topic.STATE, Topic.MOTION}, None, 5.0)

    event, payload = _parse(await anext(stream))
    assert event == "heartbeat"
    assert payload["subscribed"] is True

    # The unsubscribed topic must not appear between the two that follow it.
    bus.publish(Topic.NOTE, {"action": "created"}, child_id=harness.child.id)
    bus.publish(Topic.STATE, {"state": "asleep"}, child_id=harness.child.id)
    bus.publish(Topic.MOTION, {"active": True, "score": 0.12}, child_id=harness.child.id)

    first = _parse(await anext(stream))
    second = _parse(await anext(stream))
    await stream.aclose()

    assert first == ("state", {"state": "asleep"})
    assert second[0] == "motion"
    assert second[1]["score"] == 0.12


async def test_sse_filters_by_child(tmp_path: Path) -> None:
    harness = build(tmp_path)
    bus = await _bound(harness)
    stream = event_stream(StubRequest(harness.app), None, harness.child.id, 5.0)
    await anext(stream)

    bus.publish(Topic.STATE, {"who": "other"}, child_id=harness.child.id + 99)
    bus.publish(Topic.STATE, {"who": "mine"}, child_id=harness.child.id)
    _, payload = _parse(await anext(stream))
    await stream.aclose()
    assert payload["who"] == "mine"


async def test_sse_emits_a_heartbeat_when_nothing_happens(tmp_path: Path) -> None:
    harness = build(tmp_path)
    await _bound(harness)
    stream = event_stream(StubRequest(harness.app), None, None, 0.05)
    frames = [_parse(await anext(stream)) for _ in range(3)]
    await stream.aclose()
    assert [name for name, _ in frames] == ["heartbeat"] * 3
    assert all("ts_ms" in payload for _, payload in frames)


async def test_sse_keeps_its_place_across_heartbeats(tmp_path: Path) -> None:
    """A heartbeat must not cancel the pending read and lose a message.

    Cancelling the bus iterator closes the subscription, so the endpoint holds
    the pending read across heartbeat ticks rather than restarting it. If that
    ever regresses, this is the test that notices: the message published while
    the stream was idle still has to arrive.
    """
    harness = build(tmp_path)
    bus = await _bound(harness)
    stream = event_stream(StubRequest(harness.app), None, None, 0.05)
    await anext(stream)
    assert _parse(await anext(stream))[0] == "heartbeat"

    bus.publish(Topic.SOUND, {"active": True, "label": "cry"}, child_id=harness.child.id)
    frames = []
    for _ in range(5):
        name, payload = _parse(await anext(stream))
        frames.append(name)
        if name == "sound":
            assert payload["label"] == "cry"
            break
    await stream.aclose()
    assert "sound" in frames
    assert bus.stats["subscribers"] == 0


async def test_sse_unsubscribes_when_the_client_goes_away(tmp_path: Path) -> None:
    harness = build(tmp_path)
    bus = await _bound(harness)
    assert bus.stats["subscribers"] == 0

    stream = event_stream(StubRequest(harness.app), None, None, 5.0)
    await anext(stream)
    assert bus.stats["subscribers"] == 1

    # Closing the generator is what Starlette does when a client disconnects.
    await stream.aclose()
    assert bus.stats["subscribers"] == 0


async def test_sse_stops_when_the_client_is_already_gone(tmp_path: Path) -> None:
    harness = build(tmp_path)
    bus = await _bound(harness)
    stream = event_stream(StubRequest(harness.app, disconnected=True), None, None, 0.02)
    await anext(stream)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert bus.stats["subscribers"] == 0


def test_sse_rejects_an_unknown_event_type(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        response = client.get("/api/stream/events?types=state,telepathy")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "unknown_event_type"
    assert "state" in response.json()["error"]["detail"]["valid"]


# ---------------------------------------------------------------------------
# CORS and static assets
# ---------------------------------------------------------------------------


def test_cors_headers_are_set_for_configured_origins(tmp_path: Path) -> None:
    harness = build(tmp_path, cors_origins=["http://localhost:5173"])
    with harness.client() as client:
        allowed = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
        other = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert allowed.headers["access-control-allow-credentials"] == "true"
    assert "access-control-allow-origin" not in other.headers


def test_static_dashboard_is_served_with_an_spa_fallback(tmp_path: Path) -> None:
    static = tmp_path / "dashboard"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>babymon</title>", encoding="utf-8")
    (static / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")

    harness = build(tmp_path / "data", static_dir=str(static))
    with harness.client() as client:
        root = client.get("/")
        asset = client.get("/assets/app.js")
        deep = client.get("/nights/2026-08-10")
        api = client.get("/api/health")
        unknown_api = client.get("/api/does-not-exist")

    assert root.status_code == 200
    assert "babymon" in root.text
    assert asset.status_code == 200 and "console.log" in asset.text
    # A client-side route must reach the app rather than 404 on refresh.
    assert deep.status_code == 200 and "babymon" in deep.text
    # ...without the fallback swallowing the API.
    assert api.status_code == 200 and api.json()["status"] in ("ok", "degraded")
    assert unknown_api.status_code == 404
    assert unknown_api.json()["error"]["code"] == "not_found"


def test_static_traversal_falls_back_to_the_index(tmp_path: Path) -> None:
    static = tmp_path / "dashboard"
    static.mkdir(parents=True)
    (static / "index.html").write_text("app", encoding="utf-8")
    (tmp_path / "outside.txt").write_text("secret", encoding="utf-8")

    harness = build(tmp_path / "data", static_dir=str(static))
    with harness.client() as client:
        response = client.get("/../outside.txt")
    assert response.status_code == 200
    assert "secret" not in response.text


def test_no_static_dir_leaves_the_api_intact(tmp_path: Path) -> None:
    harness = build(tmp_path, static_dir=None)
    with harness.client() as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/").status_code == 404
