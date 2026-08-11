"""Retention, and the file that outlives the row that pointed at it.

``media.event_id`` is ``ON DELETE CASCADE``. Pruning events therefore takes the
media rows with it — and the row is the only record of where the file lives, so
the clip stays on the card for ever, invisible to this pass and to every later
one. On a device that writes clips every night and runs from an SD card, that
is not a leak, it is the eventual end of recording.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from babymon.maintenance import prune
from babymon.models import EventKind, EventLabel, MediaKind
from babymon.timeutil import now_ms

DAY_MS = 86_400_000


@pytest.fixture()
def aged(repos, child, config):
    """One event well past retention and one inside it, each with a clip."""
    media_dir = Path(config.paths.media_dir)
    media_dir.mkdir(parents=True, exist_ok=True)
    now = now_ms()
    made: dict[str, Path] = {}

    for name, age_days in (("old", 400), ("recent", 1)):
        ts = now - age_days * DAY_MS
        event_id = repos.events.open(
            child_id=child.id,
            night_of="2025-01-01" if name == "old" else "2026-08-10",
            start_ms=ts,
            kind=EventKind.AUDIO,
            label=EventLabel.CRY,
        )
        repos.events.close(event_id, ts + 30_000)
        path = media_dir / f"{name}.wav"
        path.write_bytes(b"RIFF" + b"\0" * 64)
        made[name] = path
        repos.media.add(
            child_id=child.id,
            event_id=event_id,
            night_of="2025-01-01" if name == "old" else "2026-08-10",
            kind=MediaKind.AUDIO_CLIP,
            rel_path=path.name,
            mime="audio/wav",
            bytes_=path.stat().st_size,
            ts_ms=ts,
            expires_ms=None,  # no expiry of its own; only the cascade reaches it
        )
    return made


def test_pruning_events_takes_their_clips_with_them(repos, child, config, aged):
    config.retention.events_days = 30
    config.retention.media_max_gb = 0

    prune(config, repos)

    assert not aged["old"].exists(), "the clip outlived the event that owned it"
    assert aged["recent"].exists(), "a clip inside the retention window was deleted"


def test_the_rows_go_too(repos, child, config, aged):
    config.retention.events_days = 30
    config.retention.media_max_gb = 0
    before = repos.media.list(child_id=child.id)[0]

    prune(config, repos)

    after = repos.media.list(child_id=child.id)[0]
    assert len(after) == len(before) - 1


def test_nothing_is_deleted_when_retention_is_off(repos, child, config, aged):
    config.retention.events_days = 0
    config.retention.media_max_gb = 0

    prune(config, repos)

    assert aged["old"].exists()
    assert aged["recent"].exists()


def test_a_missing_file_does_not_stop_the_pass(repos, child, config, aged):
    config.retention.events_days = 30
    config.retention.media_max_gb = 0
    aged["old"].unlink()  # already gone: a half-finished earlier prune

    summary = prune(config, repos)

    assert summary["media_pruned"] >= 1
