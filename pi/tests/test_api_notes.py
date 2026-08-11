"""Notes, tags, autocreation, and the idempotent HomeKit tag switch."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from babymon.api.routers.homekit import setup_payload
from babymon.timeutil import now_ms

from .test_api_common import build, nights_ending

NIGHTS = nights_ending("2026-08-12", 3)
NIGHT = NIGHTS[-1]


def test_note_with_known_and_autocreated_tags(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        created = client.post(
            "/api/notes",
            json={
                "night_of": NIGHT,
                "body": "ice cream after dinner, then two episodes",
                "tags": [
                    {"slug": "dessert-before-bed"},
                    {"slug": "screen-before-bed", "value_num": 44},
                    {"slug": "lights-off", "value_min_local": 1170},
                    {"slug": "grandma-visiting", "label": "Grandma visiting"},
                ],
            },
        )
        assert created.status_code == 201
        note = created.json()
        assert note["night_of"] == NIGHT
        assert note["ts_iso"] is None  # no ts_ms was given

        by_slug = {t["slug"]: t for t in note["tags"]}
        assert by_slug["dessert-before-bed"]["category"] == "food"
        assert by_slug["dessert-before-bed"]["value_type"] == "bool"
        assert by_slug["screen-before-bed"]["value_num"] == 44
        assert by_slug["screen-before-bed"]["value_display"] == "44 min"
        assert by_slug["lights-off"]["value_type"] == "time"
        assert by_slug["lights-off"]["value_display"] == "19:30"

        # The unknown slug became a real tag, typed from the value it carried.
        autocreated = by_slug["grandma-visiting"]
        assert autocreated["label"] == "Grandma visiting"
        assert autocreated["value_type"] == "bool"
        slugs = {t["slug"] for t in client.get("/api/tags").json()["items"]}
        assert "grandma-visiting" in slugs


def test_autocreate_can_be_turned_off(tmp_path: Path) -> None:
    harness = build(tmp_path)
    harness.config.api.notes.autocreate_tags = False
    with harness.client() as client:
        refused = client.post(
            "/api/notes", json={"night_of": NIGHT, "tags": [{"slug": "brand-new-thing"}]}
        )
        assert refused.status_code == 400
        assert refused.json()["error"]["code"] == "unknown_tag"


def test_note_night_is_derived_from_the_timestamp(tmp_path: Path) -> None:
    harness = build(tmp_path)
    # 00:20 local the following morning still belongs to the previous night.
    after_midnight = harness.at(NIGHT, 12, 20)
    with harness.client() as client:
        note = client.post("/api/notes", json={"ts_ms": after_midnight, "body": "woke"}).json()
        assert note["night_of"] == NIGHT
        assert note["ts_iso"] is not None


def test_note_filters(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        client.post("/api/notes", json={"night_of": NIGHTS[0], "body": "quiet evening",
                                        "tags": [{"slug": "bath"}]})
        client.post("/api/notes", json={"night_of": NIGHTS[1], "body": "teething again",
                                        "tags": [{"slug": "teething"}]})
        client.post("/api/notes", json={"night_of": NIGHTS[2], "body": "quiet again",
                                        "tags": [{"slug": "bath"}, {"slug": "story"}]})

        assert client.get("/api/notes").json()["total"] == 3
        assert client.get(f"/api/notes?night_of={NIGHTS[1]}").json()["total"] == 1
        assert client.get(f"/api/notes?from={NIGHTS[1]}").json()["total"] == 2
        assert client.get(f"/api/notes?to={NIGHTS[0]}").json()["total"] == 1
        assert client.get("/api/notes?tag=bath").json()["total"] == 2
        assert client.get("/api/notes?q=quiet").json()["total"] == 2
        assert client.get("/api/notes?q=teething").json()["total"] == 1
        page = client.get("/api/notes?limit=1&offset=2").json()
        assert page["total"] == 3 and len(page["items"]) == 1


def test_note_update_replaces_the_whole_tag_set(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        note = client.post(
            "/api/notes",
            json={"night_of": NIGHT, "body": "first", "tags": [{"slug": "bath"},
                                                               {"slug": "story"}]},
        ).json()

        body_only = client.patch(f"/api/notes/{note['id']}", json={"body": "second"}).json()
        assert body_only["body"] == "second"
        assert len(body_only["tags"]) == 2  # tags absent means leave them alone

        replaced = client.patch(
            f"/api/notes/{note['id']}", json={"tags": [{"slug": "teething"}]}
        ).json()
        assert [t["slug"] for t in replaced["tags"]] == ["teething"]

        cleared = client.patch(f"/api/notes/{note['id']}", json={"tags": []}).json()
        assert cleared["tags"] == []


def test_moving_a_note_across_the_day_boundary_moves_its_night(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        note = client.post("/api/notes", json={"night_of": NIGHT, "body": "x"}).json()
        # Hour 23 on the night clock is 11:00 the next morning — still NIGHT.
        moved = client.patch(
            f"/api/notes/{note['id']}", json={"ts_ms": harness.at(NIGHT, 23)}
        ).json()
        assert moved["night_of"] == NIGHT
        # Hour 25 is 13:00 the next day, which is the following night.
        moved_again = client.patch(
            f"/api/notes/{note['id']}", json={"ts_ms": harness.at(NIGHT, 25)}
        ).json()
        assert moved_again["night_of"] > NIGHT


def test_note_delete_is_soft(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        note = client.post("/api/notes", json={"night_of": NIGHT, "body": "oops"}).json()
        assert client.delete(f"/api/notes/{note['id']}").json()["deleted"] is True
        assert client.get("/api/notes").json()["total"] == 0
        assert client.get("/api/notes?include_deleted=true").json()["total"] == 1
        assert client.delete("/api/notes/4242").status_code == 404


def test_duplicate_tag_slugs_in_one_note_are_rejected(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        response = client.post(
            "/api/notes",
            json={"night_of": NIGHT, "tags": [{"slug": "bath"}, {"slug": "bath"}]},
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------


def test_tag_crud_and_stats(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        builtin_total = client.get("/api/tags").json()["total"]
        assert builtin_total > 10

        created = client.post(
            "/api/tags",
            json={"slug": "swim-lesson", "label": "Swim lesson", "category": "activity",
                  "value_type": "duration", "unit": "min"},
        )
        assert created.status_code == 201
        tag = created.json()
        assert tag["slug"] == "swim-lesson"
        assert tag["builtin"] is False

        assert client.post(
            "/api/tags", json={"slug": "swim-lesson", "label": "Again"}
        ).status_code == 409

        renamed = client.patch(f"/api/tags/{tag['id']}", json={"label": "Swimming"}).json()
        assert renamed["label"] == "Swimming"

        client.post("/api/notes", json={"night_of": NIGHT, "tags": [{"slug": "swim-lesson"}]})
        client.post("/api/notes", json={"night_of": NIGHTS[0], "tags": [{"slug": "swim-lesson"}]})
        with_stats = client.get("/api/tags?with_stats=true").json()["items"]
        stats = next(t for t in with_stats if t["slug"] == "swim-lesson")
        assert stats["nights_applied"] == 2
        assert stats["first_ms"] and stats["last_ms"]

        archived = client.delete(f"/api/tags/{tag['id']}").json()
        assert archived["archived"] is True
        assert client.get("/api/tags").json()["total"] == builtin_total
        assert client.get("/api/tags?include_archived=true").json()["total"] == builtin_total + 1
        # Archiving never destroys history.
        assert client.get("/api/notes?tag=swim-lesson").json()["total"] == 2
        assert client.patch("/api/tags/9999", json={"label": "x"}).status_code == 404


# ---------------------------------------------------------------------------
# HomeKit tag switches
# ---------------------------------------------------------------------------


def test_homekit_tag_switch_is_idempotent(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        first = client.post(
            "/api/homekit/tag", json={"slug": "dessert-before-bed", "on": True}
        ).json()
        assert first["on"] is True and first["changed"] is True
        note_id = first["note"]["id"]

        second = client.post(
            "/api/homekit/tag", json={"slug": "dessert-before-bed", "on": True}
        ).json()
        assert second["changed"] is False
        assert second["note"]["id"] == note_id
        assert client.get("/api/notes?tag=dessert-before-bed").json()["total"] == 1

        off = client.post(
            "/api/homekit/tag", json={"slug": "dessert-before-bed", "on": False}
        ).json()
        assert off["on"] is False and off["changed"] is True
        assert client.get("/api/notes?tag=dessert-before-bed").json()["total"] == 0

        off_again = client.post(
            "/api/homekit/tag", json={"slug": "dessert-before-bed", "on": False}
        ).json()
        assert off_again["changed"] is False

        back_on = client.post(
            "/api/homekit/tag", json={"slug": "dessert-before-bed", "on": True}
        ).json()
        assert back_on["note"]["id"] != note_id
        assert client.get("/api/notes?tag=dessert-before-bed").json()["total"] == 1


def test_homekit_switch_off_keeps_a_note_that_says_something_else(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        note = client.post(
            "/api/notes",
            json={"night_of": harness.repos.night_of_for(harness.child, now_ms()),
                  "body": "ice cream, then two episodes",
                  "tags": [{"slug": "dessert-before-bed"}, {"slug": "screen-before-bed"}]},
        ).json()

        result = client.post(
            "/api/homekit/tag", json={"slug": "dessert-before-bed", "on": False}
        ).json()
        assert result["changed"] is True

        kept = client.get(f"/api/notes/{note['id']}").json()
        assert kept["body"] == "ice cream, then two episodes"
        assert [t["slug"] for t in kept["tags"]] == ["screen-before-bed"]


def test_homekit_state_reflects_the_switches(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        state = client.get("/api/homekit/state").json()
        switches = {s["slug"]: s for s in state["tag_switches"]}
        assert set(switches) == {"dessert-before-bed", "screen-before-bed", "late-nap", "teething"}
        assert all(s["on"] is False for s in switches.values())
        assert state["sleep_state"] == "unknown"
        assert state["motion_detected"] is False

        client.post("/api/homekit/tag", json={"slug": "late-nap", "on": True})
        after = client.get("/api/homekit/state").json()
        assert {s["slug"]: s["on"] for s in after["tag_switches"]}["late-nap"] is True


def test_homekit_recording_markers_open_and_close_an_event(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        started = client.post(
            "/api/homekit/recording",
            json={"state": "started", "reason": "motion", "stream_id": 3},
        ).json()
        assert started["ok"] is True
        event_id = started["event_id"]

        opened = client.get(f"/api/events/{event_id}").json()
        assert opened["label"] == "hksv_recording"
        assert opened["kind"] == "system"
        assert opened["end_ms"] is None
        assert opened["meta"]["stream_id"] == 3

        stopped = client.post(
            "/api/homekit/recording", json={"state": "stopped", "reason": "motion"}
        ).json()
        assert stopped["event_id"] == event_id
        assert client.get(f"/api/events/{event_id}").json()["end_ms"] is not None


def test_homekit_pairing_says_so_when_the_bridge_has_not_run(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        pairing = client.get("/api/homekit/pairing").json()
    assert pairing["published"] is False
    assert pairing["paired"] is False
    assert pairing["note"]
    assert pairing["setup_code"] == harness.config.homekit.pin
    assert pairing["setup_uri"].startswith("X-HM://")
    assert pairing["setup_uri"].endswith(harness.config.homekit.setup_id)
    assert pairing["qr_payload"] == pairing["setup_uri"]


def test_homekit_pairing_reads_the_hap_persist_directory(tmp_path: Path) -> None:
    harness = build(tmp_path)
    username = harness.config.homekit.username or "AA:BB:CC:DD:EE:FF"
    harness.config.homekit.username = username
    persist = Path(harness.config.paths.hap_dir)
    persist.mkdir(parents=True, exist_ok=True)
    (persist / f"AccessoryInfo.{username.replace(':', '')}.json").write_text(
        json.dumps(
            {
                "displayName": "Baby Monitor",
                "category": 2,
                "pincode": "031-45-154",
                "setupID": "BBMN",
                "pairedClients": {"7C2E-CLIENT": "abcd"},
                "pairedClientsPermission": {"7C2E-CLIENT": 1},
            }
        ),
        encoding="utf-8",
    )

    with harness.client() as client:
        pairing = client.get("/api/homekit/pairing").json()
    assert pairing["published"] is True
    assert pairing["paired"] is True
    assert pairing["paired_clients"] == 1
    assert pairing["accessory_name"] == "Baby Monitor"
    assert pairing["note"] is None


@pytest.mark.parametrize(
    "pin,setup_id,category,expected",
    [
        # Golden vectors generated from hap-nodejs's own Accessory#setupURI, so
        # the Python port cannot drift from what the bridge advertises.
        ("031-45-154", "BBMN", 1, "X-HM://001408XXEBBMN"),
        ("031-45-154", "BBMN", 2, "X-HM://0023ISYWYBBMN"),
        ("842-13-970", "ABCD", 2, "X-HM://0024V2K0IABCD"),
        ("842-13-970", "ABCD", 17, "X-HM://00GXLEYTUABCD"),
        ("842-13-970", "ABCD", 31, "X-HM://00UQT7CNMABCD"),
    ],
)
def test_setup_uri_matches_the_hap_algorithm(
    pin: str, setup_id: str, category: int, expected: str
) -> None:
    assert setup_payload(pin, setup_id, category) == expected


def test_setup_uri_declines_a_pin_it_cannot_parse() -> None:
    assert setup_payload("not-a-pin", "BBMN", 2) == ""
