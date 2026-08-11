"""Every list endpoint's filters, plus children CRUD and event correction."""

from __future__ import annotations

from pathlib import Path

from babymon.models import EventKind, EventLabel, NightStatus, Severity

from .test_api_common import build, nights_ending

NIGHTS = nights_ending("2026-08-12", 5)


def _seeded(tmp_path: Path):
    harness = build(tmp_path)
    for index, night in enumerate(NIGHTS):
        harness.add_night(
            night,
            quality=70.0 + index,
            tst_min=540.0 + index * 10,
            awakenings=index % 3,
            excluded=(index == 0),
            status=NightStatus.PARTIAL if index == 1 else NightStatus.COMPLETE,
        )
        harness.add_samples(night)
    return harness


# ---------------------------------------------------------------------------
# Children
# ---------------------------------------------------------------------------


def test_children_crud_and_soft_delete(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        listed = client.get("/api/children").json()
        assert listed["total"] == 1
        assert listed["items"][0]["name"] == "Kiddo"
        assert listed["items"][0]["age_days"] is not None

        created = client.post(
            "/api/children",
            json={"name": "Sibling", "birthdate": "2026-01-05", "day_boundary_hour": 13},
        )
        assert created.status_code == 201
        new_id = created.json()["id"]

        duplicate = client.post("/api/children", json={"name": "Sibling"})
        assert duplicate.status_code == 409
        assert duplicate.json()["error"]["code"] == "duplicate_name"

        patched = client.patch(f"/api/children/{new_id}", json={"room": "Back bedroom"})
        assert patched.json()["room"] == "Back bedroom"

        deleted = client.delete(f"/api/children/{new_id}")
        assert deleted.status_code == 200
        assert deleted.json()["active"] is False

        assert client.get("/api/children").json()["total"] == 1
        assert client.get("/api/children?include_inactive=true").json()["total"] == 2
        # Soft-deleted, so the row is still readable by id.
        assert client.get(f"/api/children/{new_id}").status_code == 200
        assert client.get("/api/children/999").status_code == 404


def test_child_id_is_required_once_there_are_two(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        client.post("/api/children", json={"name": "Sibling"})
        ambiguous = client.get("/api/events")
        assert ambiguous.status_code == 400
        assert ambiguous.json()["error"]["code"] == "child_id_required"
        assert client.get(f"/api/events?child_id={harness.child.id}").status_code == 200


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


def test_event_filters(tmp_path: Path) -> None:
    harness = build(tmp_path)
    night, other = NIGHTS[-1], NIGHTS[-2]
    cry = harness.add_event(night, hour=14, label=EventLabel.CRY, confidence=0.9)
    harness.add_event(night, hour=15, label=EventLabel.FUSS, confidence=0.4)
    harness.add_event(
        night, hour=16, kind=EventKind.MOTION, label=EventLabel.MOTION, confidence=0.8
    )
    harness.add_event(other, hour=14, label=EventLabel.CRY, confidence=0.7)

    with harness.client() as client:
        assert client.get("/api/events").json()["total"] == 4
        assert client.get(f"/api/events?night_of={night}").json()["total"] == 3
        assert client.get(f"/api/events?night_of={night}&kind=audio").json()["total"] == 2
        assert client.get("/api/events?label=cry").json()["total"] == 2
        assert client.get("/api/events?label=cry,fuss").json()["total"] == 3
        assert client.get("/api/events?min_confidence=0.8").json()["total"] == 2
        assert client.get("/api/events?acknowledged=false").json()["total"] == 4
        assert client.get("/api/events?acknowledged=true").json()["total"] == 0

        start = harness.at(night, 15)
        assert client.get(f"/api/events?from_ms={start}").json()["total"] == 2

        page = client.get("/api/events?limit=2&offset=1").json()
        assert page["limit"] == 2 and page["offset"] == 1 and page["total"] == 4
        assert len(page["items"]) == 2

        ascending = client.get("/api/events?order=asc").json()["items"]
        descending = client.get("/api/events?order=desc").json()["items"]
        assert ascending[0]["id"] == descending[-1]["id"]

        bad = client.get("/api/events?kind=telepathy")
        assert bad.status_code == 400
        assert bad.json()["error"]["code"] == "unknown_kind"

        one = client.get(f"/api/events/{cry}").json()
        assert one["duration_s"] == 60.0
        assert one["effective_label"] == "cry"
        assert one["start_iso"].endswith(("-07:00", "-08:00"))


def test_event_label_correction_and_acknowledgement(tmp_path: Path) -> None:
    harness = build(tmp_path)
    night = NIGHTS[-1]
    event_id = harness.add_event(night, label=EventLabel.CRY)

    with harness.client() as client:
        fixed = client.patch(f"/api/events/{event_id}", json={"corrected_label": "door"})
        assert fixed.status_code == 200
        assert fixed.json()["label"] == "cry"           # the guess is preserved
        assert fixed.json()["corrected_label"] == "door"
        assert fixed.json()["effective_label"] == "door"

        # An empty correction is the "that was not a real event" marker, and it
        # must survive being sent as "" rather than being read as absent.
        false_positive = client.patch(f"/api/events/{event_id}", json={"corrected_label": ""})
        assert false_positive.json()["corrected_label"] == ""
        assert false_positive.json()["effective_label"] == ""

        acknowledged = client.patch(f"/api/events/{event_id}", json={"acknowledged": True})
        assert acknowledged.json()["acknowledged_ms"] is not None
        assert acknowledged.json()["corrected_label"] == ""  # untouched by this patch
        assert client.get("/api/events?acknowledged=true").json()["total"] == 1

        severity = client.patch(f"/api/events/{event_id}", json={"severity": "alert"})
        assert severity.json()["severity"] == "alert"

        assert client.get("/api/events?exclude_false_positives=true").json()["total"] == 0
        assert client.patch("/api/events/9999", json={"acknowledged": True}).status_code == 404


def test_manual_events_can_be_created_and_deleted_detected_ones_cannot(tmp_path: Path) -> None:
    harness = build(tmp_path)
    night = NIGHTS[-1]
    detected = harness.add_event(night, label=EventLabel.CRY, source="detector")
    start = harness.at(night, 10)

    with harness.client() as client:
        created = client.post(
            "/api/events",
            json={"start_ms": start, "end_ms": start + 5000, "kind": "manual",
                  "label": "fed", "severity": "info"},
        )
        assert created.status_code == 201
        body = created.json()
        assert body["source"] == "manual"
        assert body["night_of"] == night

        assert client.delete(f"/api/events/{body['id']}").status_code == 200
        refused = client.delete(f"/api/events/{detected}")
        assert refused.status_code == 409
        assert refused.json()["error"]["code"] == "not_manual"

        backwards = client.post(
            "/api/events",
            json={"start_ms": start, "end_ms": start - 1000, "kind": "manual", "label": "fed"},
        )
        assert backwards.status_code == 400


# ---------------------------------------------------------------------------
# Nights
# ---------------------------------------------------------------------------


def test_night_list_filters(tmp_path: Path) -> None:
    harness = _seeded(tmp_path)
    with harness.client() as client:
        assert client.get("/api/nights").json()["total"] == 5
        assert client.get("/api/nights?include_excluded=false").json()["total"] == 4
        assert client.get("/api/nights?only_analysable=true").json()["total"] == 3
        window = client.get(f"/api/nights?from={NIGHTS[1]}&to={NIGHTS[3]}").json()
        assert [n["night_of"] for n in window["items"]] == list(reversed(NIGHTS[1:4]))
        assert client.get("/api/nights?limit=2").json()["total"] == 2


def test_night_detail_carries_everything_the_page_needs(tmp_path: Path) -> None:
    harness = _seeded(tmp_path)
    night = NIGHTS[-1]
    event_id = harness.add_event(night)
    harness.add_media(night, rel_path=f"clips/{night}.ogg", event_id=event_id)

    with harness.client() as client:
        detail = client.get(f"/api/nights/{night}?series_bucket_s=60").json()
        assert detail["night"]["night_of"] == night
        assert detail["night"]["analysable"] is True
        assert len(detail["segments"]) == 3
        assert detail["events"][0]["media"][0]["url"].startswith("/api/media/")
        assert detail["bounds"]["bucket_s"] == 60
        assert len(detail["series"]) > 0
        assert detail["series"][0]["state"] == "asleep"

        series = client.get(f"/api/nights/{night}/series?bucket_s=300").json()
        assert series["bucket_s"] == 300
        assert series["total"] == len(series["points"])

        assert client.get("/api/nights/2020-01-01").status_code == 404
        assert client.get(f"/api/nights/{night}?series_bucket_s=1").status_code == 422


def test_night_patch_corrects_anchors_and_excludes(tmp_path: Path) -> None:
    harness = _seeded(tmp_path)
    night = NIGHTS[-1]
    bedtime = harness.at(night, 7, 0)

    with harness.client() as client:
        patched = client.patch(
            f"/api/nights/{night}",
            json={"bedtime_ms": bedtime, "excluded": True, "exclude_reason": "away from home"},
        )
        assert patched.status_code == 200
        assert patched.json()["bedtime_ms"] == bedtime
        assert patched.json()["excluded"] is True
        assert patched.json()["analysable"] is False

        out_of_order = client.patch(
            f"/api/nights/{night}",
            json={"bedtime_ms": bedtime + 10_000, "sleep_onset_ms": bedtime},
        )
        assert out_of_order.status_code == 400
        assert out_of_order.json()["error"]["code"] == "anchors_out_of_order"

        assert client.patch(f"/api/nights/{night}", json={}).status_code == 400
        assert client.post(f"/api/nights/{night}/recompute").status_code == 200


# ---------------------------------------------------------------------------
# Media listing
# ---------------------------------------------------------------------------


def test_media_list_filters(tmp_path: Path) -> None:
    harness = build(tmp_path)
    first, second = NIGHTS[-1], NIGHTS[-2]
    event_id = harness.add_event(first)
    harness.add_media(first, rel_path="clips/a.ogg", event_id=event_id)
    harness.add_media(first, rel_path="snapshots/a.jpg", kind="snapshot", mime="image/jpeg")
    harness.add_media(second, rel_path="clips/b.ogg")

    with harness.client() as client:
        assert client.get("/api/media").json()["total"] == 3
        assert client.get(f"/api/media?night_of={first}").json()["total"] == 2
        assert client.get("/api/media?kind=snapshot").json()["total"] == 1
        by_event = client.get(f"/api/media?event_id={event_id}").json()
        assert by_event["total"] == 1
        assert by_event["items"][0]["event_id"] == event_id
        # rel_path is a filesystem detail and is never handed to a client.
        assert "rel_path" not in by_event["items"][0]


# ---------------------------------------------------------------------------
# System
# ---------------------------------------------------------------------------


def test_system_endpoints(tmp_path: Path) -> None:
    harness = _seeded(tmp_path)
    harness.repos.syslog.add("warning", "audio", "device went away", device="hw:1,0")
    harness.repos.syslog.add("info", "api", "started")

    with harness.client() as client:
        info = client.get("/api/system/info").json()
        assert info["versions"]["babymon"]
        assert info["database"]["rows"]["nights"] == 5

        log = client.get("/api/system/log?limit=1").json()
        assert log["total"] == 1
        assert client.get("/api/system/log?level=warning").json()["items"][0]["component"] == "audio"

        config = client.get("/api/config").json()["config"]
        assert config["camera"]["rtsp_url"].startswith("rtsp://")
        assert config["api"]["auth"]["secret"] == "***"
        assert config["api"]["auth"]["password"] in (None, "***")

        metrics = client.get("/api/metrics")
        assert metrics.headers["content-type"].startswith("text/plain")
        assert "babymon_up 1.0" in metrics.text
        assert 'babymon_rows{table="nights"} 5.0' in metrics.text

        recompute = client.post(
            "/api/system/recompute", json={"from": NIGHTS[0], "to": NIGHTS[-1]}
        )
        assert recompute.status_code == 200
        assert recompute.json()["recomputed"] == NIGHTS
        assert client.post("/api/system/recompute", json={}).status_code == 400


def test_idempotency_key_replays_instead_of_repeating(tmp_path: Path) -> None:
    harness = build(tmp_path)
    headers = {"Idempotency-Key": "abc-123"}
    start = harness.at(NIGHTS[-1], 10)
    body = {"start_ms": start, "kind": "manual", "label": "fed"}

    with harness.client() as client:
        first = client.post("/api/events", json=body, headers=headers)
        second = client.post("/api/events", json=body, headers=headers)
        assert first.status_code == second.status_code == 201
        assert first.json()["id"] == second.json()["id"]
        assert second.headers.get("idempotent-replay") == "true"
        assert client.get("/api/events").json()["total"] == 1

        # A different key is a different request.
        third = client.post("/api/events", json=body, headers={"Idempotency-Key": "xyz"})
        assert third.json()["id"] != first.json()["id"]
        assert client.get("/api/events").json()["total"] == 2


def test_severity_enum_round_trips(tmp_path: Path) -> None:
    harness = build(tmp_path)
    harness.add_event(NIGHTS[-1], severity=Severity.ALERT)
    with harness.client() as client:
        assert client.get("/api/events").json()["items"][0]["severity"] == "alert"
