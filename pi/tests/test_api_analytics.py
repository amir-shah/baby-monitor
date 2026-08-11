"""The analytics endpoints, over a seeded history with a planted effect."""

from __future__ import annotations

import csv
import io
from pathlib import Path

from babymon.models import EventKind, EventLabel, NightStatus

from .test_api_common import build, current_night, nights_ending

TODAY = current_night()
HISTORY = nights_ending(TODAY, 60)


def _with_history(tmp_path: Path):
    """Sixty nights, with 'dessert' on a fifth of them and worse sleep on those.

    The runs are deliberately blocky rather than alternating: the permutation
    null is a circular shift, which is only meaningful against a tag that comes
    in runs the way a real habit does.
    """
    harness = build(tmp_path)
    dessert_nights = set()
    for index, night in enumerate(HISTORY):
        dessert = (index // 3) % 5 == 0
        if dessert:
            dessert_nights.add(night)
        harness.add_night(
            night,
            quality=62.0 + (index % 5) if dessert else 80.0 + (index % 7),
            tst_min=520.0 + (index % 11) if dessert else 600.0 + (index % 13),
            awakenings=3 if dessert else 1,
            temp_c=19.0 + (index % 4) * 0.75,
        )
        harness.add_samples(night, count=4)
        if index % 4 == 0:
            harness.add_event(
                night, hour=14, kind=EventKind.SLEEP, label=EventLabel.AWAKENING,
                duration_s=300.0,
            )
    return harness, dessert_nights


def _tag_nights(harness, nights, slug: str) -> None:
    for night in nights:
        harness.repos.notes.create(
            child_id=harness.child.id, night_of=night, body="", source="api",
            tags=[{"slug": slug}],
        )


def test_summary_shape_and_deltas(tmp_path: Path) -> None:
    harness, _ = _with_history(tmp_path)
    with harness.client() as client:
        body = client.get("/api/analytics/summary?days=30").json()

    assert body["days"] == 30
    assert body["to"] == TODAY
    assert body["nights_total"] == 30
    assert body["nights_analysable"] == 30
    assert body["previous"]["nights_total"] == 30

    tst = body["metrics"]["tst_min"]
    assert tst["n"] == 30
    assert tst["mean"] is not None
    assert tst["unit"] == "min"
    assert tst["previous_mean"] is not None
    assert tst["delta"] is not None
    assert tst["direction"] in ("improving", "worsening", "flat")

    # A lower WASO is a better night, so a negative delta must read as improving.
    waso = body["metrics"]["waso_min"]
    assert waso["direction"] in ("improving", "worsening", "flat")

    assert body["timing"]["bedtime"]["mean_hhmm"] is not None
    assert body["timing"]["midpoint"]["sd_min"] is not None
    assert body["target_band"]["label"] == "Toddler"
    assert body["score_band"] in ("Excellent", "Good", "Fair", "Poor")


def test_summary_on_an_empty_database_is_still_a_valid_shape(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        body = client.get("/api/analytics/summary").json()
    assert body["nights_total"] == 0
    assert body["nights_analysable"] == 0
    assert body["metrics"]["tst_min"] == {
        "n": 0, "mean": None, "median": None, "sd": None, "min": None, "max": None,
        "unit": "min", "previous_mean": None, "delta": None, "direction": None,
    }
    assert body["target_band"] is None


def test_trends_by_night_and_by_week(tmp_path: Path) -> None:
    harness, _ = _with_history(tmp_path)
    with harness.client() as client:
        nightly = client.get("/api/analytics/trends?metric=tst_min&days=60").json()
        weekly = client.get("/api/analytics/trends?metric=tst_min&days=60&bucket=week").json()
        bad = client.get("/api/analytics/trends?metric=shoe_size")

    assert nightly["metric"] == "tst_min"
    assert nightly["metric_unit"] == "min"
    assert len(nightly["points"]) == 60
    assert nightly["points"][0]["night_of"] == HISTORY[0]
    assert all(p["rolling_median"] is not None for p in nightly["points"])
    trend = nightly["trend"]
    assert trend["n"] == 60
    assert trend["slope"] is not None
    assert trend["ci95"][0] <= trend["slope"] <= trend["ci95"][1]
    assert trend["direction"] in ("improving", "worsening", "flat")

    assert 8 <= len(weekly["points"]) <= 11
    assert all("week_of" in p and p["n"] >= 1 for p in weekly["points"])

    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "unknown_metric"


def test_trend_declines_to_fit_a_line_through_two_points(tmp_path: Path) -> None:
    harness = build(tmp_path)
    for night in nights_ending(TODAY, 2):
        harness.add_night(night)
    with harness.client() as client:
        trend = client.get("/api/analytics/trends?days=7").json()["trend"]
    assert trend["slope"] is None
    assert trend["note"]


def test_factors_finds_the_planted_effect(tmp_path: Path) -> None:
    harness, dessert_nights = _with_history(tmp_path)
    _tag_nights(harness, dessert_nights, "dessert-before-bed")

    with harness.client() as client:
        body = client.get("/api/analytics/factors?metric=quality_score&days=60").json()

    assert body["metric"] == "quality_score"
    assert body["nights_total"] == 60
    assert body["nights_analysable"] == 60
    assert body["method"]["correction"] == "benjamini-hochberg"
    assert body["disclaimer"]
    assert body["from"] and body["to"] == TODAY

    factors = {f["slug"]: f for f in body["factors"]}
    assert "dessert-before-bed" in factors
    dessert = factors["dessert-before-bed"]
    assert dessert["n_with"] == len(dessert_nights)
    assert dessert["n_without"] == 60 - len(dessert_nights)
    assert dessert["diff"] < 0                      # worse on dessert nights
    assert dessert["p_value"] is not None
    assert dessert["q_value"] is not None
    assert dessert["verdict"] in ("worse", "inconclusive")
    assert dessert["effect_size"]["name"] == "hedges_g"
    assert dessert["summary"]


def test_factors_refuses_when_there_is_not_enough_history(tmp_path: Path) -> None:
    harness = build(tmp_path)
    for night in nights_ending(TODAY, 8):
        harness.add_night(night)
        harness.repos.notes.create(
            child_id=harness.child.id, night_of=night, body="", tags=[{"slug": "bath"}]
        )
    with harness.client() as client:
        body = client.get("/api/analytics/factors?days=30").json()
    assert body["factors"] == []
    assert "blocked" in body["method"]


def test_factors_lists_a_thin_tag_as_insufficient(tmp_path: Path) -> None:
    harness, _ = _with_history(tmp_path)
    _tag_nights(harness, HISTORY[:3], "travel")
    with harness.client() as client:
        body = client.get("/api/analytics/factors?days=60&min_n=10").json()
    thin = {f["slug"]: f for f in body["insufficient"]}
    assert "travel" in thin
    assert thin["travel"]["n_with"] == 3
    assert thin["travel"]["reason"]


def test_regularity(tmp_path: Path) -> None:
    harness, _ = _with_history(tmp_path)
    with harness.client() as client:
        body = client.get("/api/analytics/regularity?days=30").json()

    assert body["epoch_min"] == 1
    assert body["sri_nights"] == 30
    assert body["sri"] is not None
    # The seeded schedule is identical every night, so agreement is near total.
    assert body["sri"] > 90
    assert body["sri_note"] is None
    assert len(body["actogram"]) == 30
    row = body["actogram"][-1]
    assert row["night_of"] == TODAY
    assert row["runs"]
    start, end = row["runs"][0]
    assert 0 <= start < end <= 1440
    assert 0.0 < row["coverage"] <= 1.0
    assert body["timing"]["bedtime"]["mean_hhmm"] is not None


def test_regularity_declines_below_a_week(tmp_path: Path) -> None:
    harness = build(tmp_path)
    for night in nights_ending(TODAY, 4):
        harness.add_night(night)
    with harness.client() as client:
        body = client.get("/api/analytics/regularity?days=10").json()
    assert body["sri"] is None
    assert "at least 7" in body["sri_note"]


def test_patterns(tmp_path: Path) -> None:
    harness, _ = _with_history(tmp_path)
    with harness.client() as client:
        body = client.get("/api/analytics/patterns?days=60&metric=quality_score").json()

    hours = body["awakenings_by_hour"]
    assert len(hours) == 24
    assert sum(h["count"] for h in hours) == 15  # one on every fourth night
    assert {h["hour"] for h in hours} == set(range(24))

    dow = body["day_of_week"]
    assert len(dow) == 7
    assert [d["label"] for d in dow][0] == "Monday"
    assert sum(d["n"] for d in dow) == 60

    temp_bins = body["environment"]["temp_c"]
    assert temp_bins
    assert sum(b["n"] for b in temp_bins) == 60
    assert all(b["bin_low"] < b["bin_high"] and b["unit"] == "°C" for b in temp_bins)


def test_export_json_and_csv(tmp_path: Path) -> None:
    harness, dessert_nights = _with_history(tmp_path)
    _tag_nights(harness, dessert_nights, "dessert-before-bed")

    with harness.client() as client:
        as_json = client.get("/api/analytics/export?days=60&format=json").json()
        as_csv = client.get("/api/analytics/export?days=60&format=csv")

    assert as_json["columns"][0] == "night_of"
    assert "dessert-before-bed" in as_json["columns"]
    assert "quality_score" in as_json["columns"]
    assert len(as_json["rows"]) == 60
    assert as_json["disclaimer"]

    assert as_csv.headers["content-type"].startswith("text/csv")
    assert "attachment" in as_csv.headers["content-disposition"]
    rows = list(csv.DictReader(io.StringIO(as_csv.text)))
    assert len(rows) == 60
    assert rows[0]["night_of"] == HISTORY[0]
    tagged = [r for r in rows if r["dessert-before-bed"]]
    assert len(tagged) == len(dessert_nights)


def test_excluded_nights_are_kept_out_of_the_statistics(tmp_path: Path) -> None:
    harness = build(tmp_path)
    nights = nights_ending(TODAY, 10)
    for index, night in enumerate(nights):
        harness.add_night(night, excluded=(index < 4))
    with harness.client() as client:
        body = client.get("/api/analytics/summary?days=10").json()
    assert body["nights_total"] == 10
    assert body["nights_analysable"] == 6
    assert body["metrics"]["tst_min"]["n"] == 6


def test_partial_nights_are_kept_out_too(tmp_path: Path) -> None:
    harness = build(tmp_path)
    nights = nights_ending(TODAY, 6)
    for index, night in enumerate(nights):
        harness.add_night(
            night, status=NightStatus.PARTIAL if index < 2 else NightStatus.COMPLETE
        )
    with harness.client() as client:
        body = client.get("/api/analytics/summary?days=6").json()
    assert body["nights_analysable"] == 4
