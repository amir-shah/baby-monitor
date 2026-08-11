"""Shared scaffolding for the API tests, plus a smoke test that it works.

Deliberately not a ``conftest.py``: the fixtures here are functions the other
``test_api_*`` modules import explicitly, so it is obvious where a client came
from and a second agent adding a conftest cannot collide with this one.

Everything stands on a temporary SQLite file and a :class:`NullRuntime`, which
is the whole point of the ``Runtime`` protocol — the entire HTTP surface is
exercised without a camera, a microphone or a Raspberry Pi.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from babymon.api.app import create_app
from babymon.bus import EventBus, NullRuntime
from babymon.config import ChildConfig, Config
from babymon.models import (
    EventKind,
    EventLabel,
    Night,
    NightStatus,
    Sample,
    Severity,
    SleepSegment,
    SleepState,
)
from babymon.storage.db import open_database
from babymon.storage.repo import Repos
from babymon.timeutil import night_bounds, night_of, now_ms, to_ms

TZ = "America/Los_Angeles"
BOUNDARY_HOUR = 12


class Harness:
    """An application, its collaborators, and helpers for seeding data."""

    def __init__(self, config: Config, repos: Repos, runtime: NullRuntime, app: Any) -> None:
        self.config = config
        self.repos = repos
        self.runtime = runtime
        self.app = app
        self.child = repos.children.list()[0]

    def client(self, **kwargs: Any) -> TestClient:
        return TestClient(self.app, **kwargs)

    # -- seeding -----------------------------------------------------------

    def night_bounds(self, night_of: str) -> tuple[int, int]:
        return night_bounds(night_of, TZ, BOUNDARY_HOUR)

    def at(self, night_of: str, hour: int, minute: int = 0) -> int:
        """An instant on a night, given as an hour on the 24h night clock.

        Hour 0 is the day boundary (noon local), so hour 8 is 20:00 that
        evening and hour 19 is 07:00 the next morning.
        """
        start, _ = self.night_bounds(night_of)
        return start + (hour * 60 + minute) * 60_000

    def add_night(
        self,
        night_of: str,
        *,
        quality: float | None = 80.0,
        tst_min: float = 600.0,
        awakenings: int = 1,
        status: NightStatus = NightStatus.COMPLETE,
        excluded: bool = False,
        temp_c: float = 20.5,
        with_segments: bool = True,
    ) -> Night:
        bedtime = self.at(night_of, 7, 30)
        onset = self.at(night_of, 8, 0)
        wake = onset + int(tst_min * 60_000)
        night = Night(
            child_id=self.child.id,
            night_of=night_of,
            timezone=TZ,
            bedtime_ms=bedtime,
            sleep_onset_ms=onset,
            final_wake_ms=wake,
            out_of_bed_ms=wake + 15 * 60_000,
            tib_min=(wake + 15 * 60_000 - bedtime) / 60_000,
            tst_min=tst_min,
            sol_min=30.0,
            waso_min=20.0,
            awakenings=awakenings,
            longest_bout_min=tst_min / 2,
            sleep_efficiency=0.9,
            midpoint_ms=onset + (wake - onset) // 2,
            restless_min=12.0,
            cry_events=awakenings,
            cry_min=4.0,
            noise_events=awakenings + 1,
            peak_dbfs=-18.0,
            mean_dbfs=-52.0,
            motion_index=0.01,
            temp_c_mean=temp_c,
            temp_c_min=temp_c - 0.5,
            temp_c_max=temp_c + 0.5,
            humidity_mean=47.0,
            quality_score=quality,
            score_components={"score": quality},
            coverage=0.95,
            status=status,
            excluded=excluded,
            age_days=400,
        )
        stored = self.repos.nights.upsert(night)
        if with_segments:
            self.repos.segments.replace_night(
                self.child.id,
                night_of,
                [
                    SleepSegment(0, self.child.id, night_of, bedtime, onset, SleepState.SETTLING),
                    SleepSegment(0, self.child.id, night_of, onset, wake, SleepState.ASLEEP),
                    SleepSegment(
                        0, self.child.id, night_of, wake, wake + 15 * 60_000, SleepState.AWAKE
                    ),
                ],
            )
        return stored

    def add_samples(self, night_of: str, count: int = 8) -> None:
        start = self.at(night_of, 8, 0)
        self.repos.samples.add_many(
            [
                Sample(
                    ts_ms=start + i * 60_000,
                    child_id=self.child.id,
                    night_of=night_of,
                    sound_dbfs=-52.0 + i,
                    sound_peak_dbfs=-30.0,
                    noise_floor_dbfs=-58.0,
                    cry_score=0.02,
                    motion=0.003,
                    temp_c=20.4,
                    humidity_pct=46.0,
                    state=SleepState.ASLEEP,
                )
                for i in range(count)
            ]
        )

    def add_event(
        self,
        night_of: str,
        *,
        hour: int = 14,
        kind: EventKind = EventKind.AUDIO,
        label: str = EventLabel.CRY,
        confidence: float = 0.87,
        severity: Severity = Severity.NOTICE,
        duration_s: float = 60.0,
        source: str = "detector",
    ) -> int:
        start = self.at(night_of, hour)
        return self.repos.events.open(
            child_id=self.child.id,
            night_of=night_of,
            start_ms=start,
            end_ms=start + int(duration_s * 1000),
            kind=kind,
            label=label,
            confidence=confidence,
            severity=severity,
            source=source,
            meta={"classes": {"Baby cry, infant cry": confidence}},
        )

    def add_media(
        self,
        night_of: str,
        *,
        rel_path: str,
        contents: bytes | None = b"fake-media-bytes",
        kind: str = "audio_clip",
        mime: str = "audio/ogg",
        event_id: int | None = None,
    ) -> int:
        if contents is not None:
            target = Path(self.config.paths.media_dir) / rel_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(contents)
        return self.repos.media.add(
            child_id=self.child.id,
            night_of=night_of,
            kind=kind,
            rel_path=rel_path,
            mime=mime,
            ts_ms=self.at(night_of, 9),
            event_id=event_id,
            bytes_=len(contents) if contents else None,
            duration_s=12.0,
        )


def build(
    tmp_path: Path,
    *,
    auth: bool = False,
    password: str | None = None,
    tokens: tuple[str, ...] = (),
    static_dir: str | None = None,
    cors_origins: list[str] | None = None,
) -> Harness:
    """A fully wired application over a temporary database."""
    config = Config()
    config.site.timezone = TZ
    config.paths.data_dir = str(tmp_path)
    config.paths.db = str(tmp_path / "babymon.db")
    config.paths.media_dir = str(tmp_path / "media")
    config.paths.hap_dir = str(tmp_path / "hap")
    config.paths.models_dir = str(tmp_path / "models")
    config.paths.static_dir = static_dir
    config.paths.ensure()

    config.children = [
        ChildConfig(
            name="Kiddo",
            timezone=TZ,
            birthdate="2024-01-01",
            day_boundary_hour=BOUNDARY_HOUR,
        )
    ]
    config.api.cors_origins = cors_origins if cors_origins is not None else []
    config.api.auth.enabled = auth
    config.api.auth.password = password
    config.api.auth.tokens = list(tokens)
    config.api.auth.secret = "unit-test-signing-secret"
    config.api.sse_heartbeat_s = 1.0
    # Keeps the factor engine from spending ten thousand permutations per tag
    # in a test that only cares about the response shape.
    config.analytics.permutations = 200
    config.analytics.bootstrap_iterations = 200

    repos = Repos(open_database(config.paths.db))
    repos.bootstrap(config)
    runtime = NullRuntime(EventBus())
    return Harness(config, repos, runtime, create_app(config, repos, runtime))


def nights_ending(last: str, count: int) -> list[str]:
    """``count`` consecutive night keys ending at ``last``, oldest first."""
    end = dt.date.fromisoformat(last)
    return [(end - dt.timedelta(days=i)).isoformat() for i in range(count - 1, -1, -1)]


def current_night() -> str:
    """The night key the service currently considers 'tonight'.

    The analytics windows are anchored on now, so any seeded history that is
    meant to fall inside them has to be counted back from here.
    """
    return night_of(now_ms(), TZ, BOUNDARY_HOUR)


# ---------------------------------------------------------------------------


def test_harness_builds_and_serves_health(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in ("ok", "degraded")
    assert set(body["components"]) >= {"camera", "audio", "env", "db"}
    assert body["components"]["db"]["ok"] is True


def test_openapi_and_docs_are_served_under_api(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        schema = client.get("/api/openapi.json")
        docs = client.get("/api/docs")
    assert schema.status_code == 200
    assert docs.status_code == 200
    paths = schema.json()["paths"]
    for path in (
        "/api/health", "/api/state", "/api/events", "/api/notes", "/api/tags",
        "/api/nights", "/api/media", "/api/analytics/factors", "/api/homekit/tag",
        "/api/auth/login",
    ):
        assert path in paths, path


def test_unknown_api_path_is_a_json_error(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        response = client.get("/api/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_seeded_timestamps_land_on_the_expected_night(tmp_path: Path) -> None:
    harness = build(tmp_path)
    # Hour 8 on the night clock is 20:00 local, which must belong to that night.
    evening = harness.at("2026-08-10", 8)
    assert to_ms(dt.datetime.fromtimestamp(evening / 1000, dt.timezone.utc)) == evening
    start, end = harness.night_bounds("2026-08-10")
    assert start < evening < end
