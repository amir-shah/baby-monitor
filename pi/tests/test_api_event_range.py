"""Night-range filtering on the event log.

A range of nights is a span in the *child's* timezone, with the child's
day-boundary hour inside it. The dashboard used to resolve that span into
milliseconds itself, which meant it used the browser's timezone — correct in
the house, wrong for anyone looking from another zone, and wrong only near the
boundary. These tests exist so the server keeps owning the resolution.
"""

from __future__ import annotations

from pathlib import Path

from .test_api_common import build

NIGHTS = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]


def seed(tmp_path: Path):
    harness = build(tmp_path)
    for night in NIGHTS:
        harness.add_event(night)
    return harness


def nights_returned(payload) -> list[str]:
    return sorted({item["night_of"] for item in payload["items"]})


def test_inclusive_on_both_ends(tmp_path: Path) -> None:
    harness = seed(tmp_path)
    with harness.client() as client:
        body = client.get("/api/events", params={"night_from": "2026-08-02", "night_to": "2026-08-04"}).json()
    assert nights_returned(body) == ["2026-08-02", "2026-08-03", "2026-08-04"]
    assert body["total"] == 3


def test_open_ended_ranges(tmp_path: Path) -> None:
    harness = seed(tmp_path)
    with harness.client() as client:
        after = client.get("/api/events", params={"night_from": "2026-08-04"}).json()
        before = client.get("/api/events", params={"night_to": "2026-08-02"}).json()
    assert nights_returned(after) == ["2026-08-04", "2026-08-05"]
    assert nights_returned(before) == ["2026-08-01", "2026-08-02"]


def test_a_single_night_range_matches_the_exact_filter(tmp_path: Path) -> None:
    harness = seed(tmp_path)
    with harness.client() as client:
        ranged = client.get(
            "/api/events", params={"night_from": "2026-08-03", "night_to": "2026-08-03"}
        ).json()
        exact = client.get("/api/events", params={"night_of": "2026-08-03"}).json()
    assert nights_returned(ranged) == nights_returned(exact) == ["2026-08-03"]
    assert ranged["total"] == exact["total"] == 1


def test_an_inverted_range_returns_nothing_rather_than_everything(tmp_path: Path) -> None:
    harness = seed(tmp_path)
    with harness.client() as client:
        body = client.get(
            "/api/events", params={"night_from": "2026-08-05", "night_to": "2026-08-01"}
        ).json()
    assert body["total"] == 0


def test_a_malformed_night_key_is_rejected_not_ignored(tmp_path: Path) -> None:
    harness = seed(tmp_path)
    with harness.client() as client:
        # Silently dropping an unparseable filter would return every event and
        # look like a working query.
        assert client.get("/api/events", params={"night_from": "last-tuesday"}).status_code == 422
        assert client.get("/api/events", params={"night_to": "2026-8-1"}).status_code == 422


def test_the_range_composes_with_the_other_filters(tmp_path: Path) -> None:
    harness = build(tmp_path)
    harness.add_event("2026-08-02", label="cry")
    harness.add_event("2026-08-03", label="cry")
    harness.add_event("2026-08-03", label="talk")
    harness.add_event("2026-08-09", label="cry")
    with harness.client() as client:
        body = client.get(
            "/api/events",
            params={"night_from": "2026-08-01", "night_to": "2026-08-05", "label": "cry"},
        ).json()
    assert body["total"] == 2
    assert nights_returned(body) == ["2026-08-02", "2026-08-03"]


def test_night_of_and_a_range_together_intersect(tmp_path: Path) -> None:
    harness = seed(tmp_path)
    with harness.client() as client:
        inside = client.get(
            "/api/events",
            params={"night_of": "2026-08-03", "night_from": "2026-08-01", "night_to": "2026-08-05"},
        ).json()
        outside = client.get(
            "/api/events",
            params={"night_of": "2026-08-09", "night_from": "2026-08-01", "night_to": "2026-08-05"},
        ).json()
    assert inside["total"] == 1
    assert outside["total"] == 0
