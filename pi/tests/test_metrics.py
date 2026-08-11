"""Sleep metrics, checked against arithmetic done by hand.

The definitions here are the ones the whole analytics layer rests on, and each
has a specific exclusion that is easy to get wrong and impossible to notice
afterwards:

* WASO excludes the settling time before sleep onset, and excludes time awake
  after the final awakening. Include either and every night looks worse than
  it was.
* An awakening is a maximal wake run *inside* the sleep period, at or above
  the threshold. A shorter stir is counted separately and must not inflate the
  tally.
* Sleep efficiency has two defensible denominators and they differ materially.
  Both are reported, both are labelled.

The night below is written out minute by minute so a reader can check the
expected values without trusting the implementation.
"""

from __future__ import annotations

from itertools import pairwise

import pytest

from babymon.models import NightStatus, SleepSegment
from babymon.models import SleepState as S
from babymon.sleep.metrics import (
    AASM_BANDS,
    age_band,
    compute_metrics,
    score_band_label,
    score_night,
)

MINUTE = 60_000
WEIGHTS = {"duration": 0.40, "efficiency": 0.20, "continuity": 0.20, "timing": 0.20}


def seg(start_min: int, end_min: int, state: S) -> SleepSegment:
    return SleepSegment(0, 1, "2026-08-10", start_min * MINUTE, end_min * MINUTE, state)


@pytest.fixture()
def worked_example() -> list[SleepSegment]:
    """A night with one real awakening and one stir.

    ===========  ==========================================
    0 - 30       in bed, settling            -> SOL 30
    30 - 150     asleep                      120 min
    150 - 170    awake                       -> awakening (20 min)
    170 - 300    asleep                      130 min
    300 - 303    awake                       -> stir (3 min)
    303 - 600    asleep                      297 min  <- longest bout
    600 - 620    awake, still in bed         -> TASAFA 20
    ===========  ==========================================
    """
    return [
        seg(0, 30, S.SETTLING),
        seg(30, 150, S.ASLEEP),
        seg(150, 170, S.AWAKE),
        seg(170, 300, S.ASLEEP),
        seg(300, 303, S.AWAKE),
        seg(303, 600, S.ASLEEP),
        seg(600, 620, S.AWAKE),
    ]


class TestWorkedExample:
    @pytest.fixture()
    def m(self, worked_example):
        return compute_metrics(worked_example, [], [], awakening_min_min=5.0, coverage=1.0)

    def test_time_in_bed_spans_first_to_last_in_bed(self, m):
        assert m.tib_min == 620

    def test_sleep_period_spans_onset_to_final_wake(self, m):
        assert m.spt_min == 570

    def test_sleep_onset_latency(self, m):
        assert m.sol_min == 30

    def test_total_sleep_time(self, m):
        assert m.tst_min == 120 + 130 + 297

    def test_waso_excludes_onset_latency_and_time_after_final_wake(self, m):
        # Only the 20-minute and 3-minute wake runs inside the sleep period.
        assert m.waso_min == 23

    def test_the_identity_holds(self, m):
        assert m.spt_min - m.waso_min == pytest.approx(m.tst_min)

    def test_only_runs_over_the_threshold_count_as_awakenings(self, m):
        assert m.awakenings == 1
        assert m.stirrings == 1

    def test_longest_bout(self, m):
        assert m.longest_bout_min == 297

    def test_time_awake_after_final_awakening_is_tracked_separately(self, m):
        assert m.tasafa_min == 20

    def test_both_efficiency_denominators(self, m):
        assert m.sleep_efficiency == pytest.approx(547 / 620)
        assert m.sleep_efficiency_spt == pytest.approx(547 / 570)

    def test_midpoint_is_halfway_through_the_sleep_period(self, m):
        assert m.midpoint_ms / MINUTE == pytest.approx(30 + 570 / 2)

    def test_threshold_changes_what_counts_as_an_awakening(self, worked_example):
        # At a 2-minute bar the 3-minute stir becomes an awakening too.
        loose = compute_metrics(worked_example, [], [], awakening_min_min=2.0, coverage=1.0)
        assert loose.awakenings == 2
        assert loose.stirrings == 0
        # ...but the time awake is the same either way.
        assert loose.waso_min == 23


class TestDegenerateInput:
    def test_no_segments_at_all(self):
        m = compute_metrics([], [], [], coverage=1.0)
        assert m.tst_min is None
        assert m.tib_min is None

    def test_in_bed_but_never_asleep(self):
        m = compute_metrics([seg(0, 300, S.AWAKE)], [], [], coverage=1.0)
        assert m.tib_min == 300
        assert m.sleep_efficiency == 0.0

    def test_zero_length_segments_are_ignored(self):
        m = compute_metrics(
            [seg(0, 0, S.ASLEEP), seg(0, 60, S.ASLEEP), seg(60, 60, S.AWAKE)],
            [], [], coverage=1.0,
        )
        assert m.tst_min == 60

    def test_out_of_order_segments_are_sorted(self):
        forwards = compute_metrics(
            [seg(0, 30, S.SETTLING), seg(30, 200, S.ASLEEP)], [], [], coverage=1.0
        )
        backwards = compute_metrics(
            [seg(30, 200, S.ASLEEP), seg(0, 30, S.SETTLING)], [], [], coverage=1.0
        )
        assert forwards.tst_min == backwards.tst_min
        assert forwards.sol_min == backwards.sol_min

    def test_absent_does_not_count_as_in_bed(self):
        m = compute_metrics(
            [seg(0, 60, S.ABSENT), seg(60, 90, S.SETTLING), seg(90, 300, S.ASLEEP)],
            [], [], coverage=1.0,
        )
        # Time in bed starts when they were put down, not when the room was empty.
        assert m.tib_min == 240

    def test_restless_counts_as_sleep(self):
        m = compute_metrics(
            [seg(0, 60, S.ASLEEP), seg(60, 90, S.RESTLESS), seg(90, 200, S.ASLEEP)],
            [], [], coverage=1.0,
        )
        assert m.tst_min == 200
        assert m.restless_min == 30
        assert m.awakenings == 0


class TestManualOverrides:
    def test_a_corrected_anchor_is_honoured_and_everything_recomputes(self, worked_example):
        base = compute_metrics(worked_example, [], [], coverage=1.0)
        fixed = compute_metrics(
            worked_example, [], [], coverage=1.0,
            overrides={"sleep_onset_ms": 50 * MINUTE},
        )
        assert base.sol_min == 30
        assert fixed.sol_min == 50
        # The sleep period shrank, so the sleep inside it did too.
        assert fixed.spt_min == 550
        assert fixed.tst_min < base.tst_min


class TestAgeBands:
    def test_bands_are_contiguous_and_cover_every_age(self):
        for days in range(0, 6600, 7):
            assert age_band(days) is not None
        for earlier, later in pairwise(AASM_BANDS):
            assert earlier.max_days is not None
            assert later.min_days == earlier.max_days + 1

    def test_unknown_birthdate_has_no_band(self):
        assert age_band(None) is None

    @pytest.mark.parametrize(
        ("days", "label", "low", "high"),
        [
            (200, "Infant", 12.0, 16.0),
            (500, "Toddler", 11.0, 14.0),
            (1500, "Preschool", 10.0, 13.0),
            (3000, "School age", 9.0, 12.0),
        ],
    )
    def test_aasm_values(self, days, label, low, high):
        band = age_band(days)
        assert (band.label, band.low_h, band.high_h) == (label, low, high)


class TestScoring:
    @pytest.fixture()
    def good_night(self):
        return compute_metrics(
            [seg(0, 15, S.SETTLING), seg(15, 660, S.ASLEEP), seg(660, 670, S.AWAKE)],
            [], [], coverage=1.0,
        )

    def test_a_good_night_scores_well(self, good_night):
        result = score_night(
            good_night, age_days=700, weights=WEIGHTS, nap_min=90, sri=85.0, midpoint_sd_min=15.0
        )
        assert result.score is not None
        assert result.score >= 80
        assert set(result.components) == {"duration", "efficiency", "continuity", "timing"}

    def test_under_four_months_is_not_scored_at_all(self, good_night):
        result = score_night(good_night, age_days=60, weights=WEIGHTS)
        assert result.score is None
        assert "four months" in (result.suppressed_reason or "")

    def test_thin_coverage_is_not_scored(self, good_night):
        good_night.coverage = 0.3
        result = score_night(good_night, age_days=700, weights=WEIGHTS, min_coverage=0.6)
        assert result.score is None
        assert "30%" in (result.suppressed_reason or "")

    def test_a_missing_component_is_dropped_and_the_rest_renormalised(self, good_night):
        # No SRI and no midpoint spread, so timing cannot be computed.
        result = score_night(good_night, age_days=700, weights=WEIGHTS, nap_min=90)
        assert "timing" not in result.components
        assert sum(result.weights.values()) == pytest.approx(1.0)
        assert any("reweighted" in n for n in result.notes)

    def test_no_birthdate_drops_duration_rather_than_guessing(self, good_night):
        result = score_night(good_night, age_days=None, weights=WEIGHTS, sri=80.0)
        assert "duration" not in result.components
        assert any("birthdate" in n for n in result.notes)

    def test_undersleep_is_penalised_harder_than_oversleep(self):
        short = compute_metrics([seg(0, 400, S.ASLEEP)], [], [], coverage=1.0)
        long = compute_metrics([seg(0, 1000, S.ASLEEP)], [], [], coverage=1.0)
        short_score = score_night(short, age_days=700, weights=WEIGHTS, sri=80.0, midpoint_sd_min=20.0)
        long_score = score_night(long, age_days=700, weights=WEIGHTS, sri=80.0, midpoint_sd_min=20.0)
        # 6.7 h against an 11-14 h band bottoms out; 16.7 h floors at 60.
        assert short_score.components["duration"] == 0.0
        assert long_score.components["duration"] == 60.0

    def test_score_bands(self):
        assert score_band_label(95) == "Excellent"
        assert score_band_label(85) == "Good"
        assert score_band_label(70) == "Fair"
        assert score_band_label(40) == "Poor"
        assert score_band_label(None) is None

    def test_the_breakdown_is_always_shown_alongside_the_total(self, good_night):
        payload = score_night(
            good_night, age_days=700, weights=WEIGHTS, nap_min=90, sri=85.0, midpoint_sd_min=15.0
        ).to_dict()
        # A single number invites more trust than it deserves, so the parts and
        # the weights that produced it travel with it.
        assert payload["components"] and payload["weights"]
        assert payload["band"] in ("Excellent", "Good", "Fair", "Poor")
        # And never with false precision.
        assert payload["score"] == round(payload["score"], 1)


def test_night_status_excluded_is_distinct_from_partial():
    assert NightStatus.EXCLUDED != NightStatus.PARTIAL
