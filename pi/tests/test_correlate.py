"""Guardrails in the factor analysis that only matter when they are wrong.

Each of these is a way the engine could look like it was being careful while
quietly not being: a confounder it declines to consider, a lag that compares
against the wrong night, a p-value that assumes independence sitting next to
one that refuses to.
"""

from __future__ import annotations

import datetime as dt
import random

import pytest

from babymon.analytics import stats
from babymon.analytics.correlate import _shift_to_previous_night, analyse_factors
from babymon.models import Night, NightStatus, Tag, TagCategory, TagValueType


def key_for(index: int, start: str = "2026-01-01") -> str:
    """Consecutive calendar nights. Not f"{month}-{day}" — that invents 30 February."""
    return (dt.date.fromisoformat(start) + dt.timedelta(days=index)).isoformat()


def night(key: str, value: float) -> Night:
    return Night(
        child_id=1, night_of=key, timezone="UTC", tst_min=value,
        quality_score=80.0, status=NightStatus.COMPLETE, coverage=1.0,
    )


def tag(slug: str, value_type: TagValueType = TagValueType.BOOL) -> Tag:
    return Tag(
        id=1, slug=slug, label=slug.replace("-", " ").capitalize(),
        category=TagCategory.FOOD, value_type=value_type,
    )


class TestPreviousNight:
    def test_it_is_the_calendar_night_before(self):
        keys = ["2026-08-01", "2026-08-02", "2026-08-03"]
        assert _shift_to_previous_night(keys, [False, False, True]) == [False, True, False]

    def test_a_gap_breaks_the_lag_rather_than_reaching_across_it(self):
        # Nothing recorded between the 2nd and the 10th. Shifting by one
        # position would pair the 10th with the 2nd — eight days apart — and
        # that comparison decides whether a real finding is dismissed as
        # reverse causality.
        keys = ["2026-08-01", "2026-08-02", "2026-08-10", "2026-08-11"]
        assert _shift_to_previous_night(keys, [False, False, True, False]) == [False] * 4

    def test_the_first_night_has_no_predecessor(self):
        keys = ["2026-08-01", "2026-08-02"]
        assert _shift_to_previous_night(keys, [True, False]) == [False, False]

    def test_several_tagged_nights_each_move_back_one_day(self):
        keys = [f"2026-08-{d:02d}" for d in range(1, 6)]
        flags = [False, True, False, True, False]
        assert _shift_to_previous_night(keys, flags) == [True, False, True, False, False]


class TestConfounders:
    @staticmethod
    def build(rng: random.Random):
        nights, matrix = [], {}
        for i in range(120):
            key = key_for(i)
            dessert = i % 3 == 0
            # Teething: four nights, every one of them also a dessert night.
            teething = i in (0, 3, 6, 9)
            row = {}
            if dessert:
                row["dessert-before-bed"] = 1.0
            if teething:
                row["teething"] = 1.0
            matrix[key] = row
            nights.append(night(key, 600 - (40 if dessert else 0) + rng.gauss(0, 15)))
        return nights, matrix

    def test_a_tag_too_rare_to_test_is_still_named_as_a_companion(self):
        """Being too rare to test is not being too rare to confound.

        Only tags that passed the min-n gate used to be considered, so the
        rare co-occurring tag — the dangerous one — could never be surfaced by
        anything.
        """
        nights, matrix = self.build(random.Random(3))
        tags = {"dessert-before-bed": tag("dessert-before-bed"), "teething": tag("teething")}
        out = analyse_factors(nights, matrix, tags, metric="tst_min", permutations=500)

        dessert = next(f for f in out.factors if f.slug == "dessert-before-bed")
        assert "teething" in {c["slug"] for c in dessert.confounders}
        # ...and teething itself is still gated out of being tested.
        assert "teething" in {f.slug for f in out.insufficient}

    def test_a_single_shared_night_is_not_called_a_confounder(self):
        nights, matrix = self.build(random.Random(4))
        matrix[key_for(0)]["bath"] = 1.0  # one night, nothing else
        tags = {"dessert-before-bed": tag("dessert-before-bed"), "bath": tag("bath")}
        out = analyse_factors(nights, matrix, tags, metric="tst_min", permutations=500)

        dessert = next(f for f in out.factors if f.slug == "dessert-before-bed")
        assert "bath" not in {c["slug"] for c in dessert.confounders}


class TestDoseResponse:
    def test_its_p_value_comes_from_the_same_null_as_the_headline(self):
        rng = random.Random(9)
        nights, matrix = [], {}
        for i in range(120):
            key = key_for(i)
            # A third of nights with no screen time at all, so the tag clears
            # the min-n gate on both sides and the dose check runs.
            watched = i % 3 != 0
            minutes = float(rng.randrange(10, 120, 10)) if watched else 0.0
            matrix[key] = {"screen-before-bed": minutes} if watched else {}
            nights.append(night(key, 620 - minutes * 0.5 + rng.gauss(0, 20)))

        tags = {"screen-before-bed": tag("screen-before-bed", TagValueType.DURATION)}
        out = analyse_factors(nights, matrix, tags, metric="tst_min", permutations=500)
        factor = out.factors[0] if out.factors else out.insufficient[0]

        assert factor.dose_response_p is not None
        # Not Spearman's asymptotic t, which assumes nights are independent —
        # the assumption the headline test exists to avoid.
        assert factor.dose_response_method is not None
        assert factor.dose_response_method.startswith("rotation:")


class TestPairedRotation:
    def test_it_finds_a_real_dose_response(self):
        rng = random.Random(11)
        xs = [float(i % 40) for i in range(120)]
        ys = [600 - x * 2 + rng.gauss(0, 10) for x in xs]
        result = stats.paired_rotation_test(
            xs, ys, lambda a, b: stats.spearman(a, b)[0], iterations=500, seed=1
        )
        assert result.p_value < 0.05

    def test_it_reports_the_null_for_noise(self):
        rng = random.Random(12)
        xs = [rng.gauss(0, 1) for _ in range(120)]
        ys = [rng.gauss(0, 1) for _ in range(120)]
        result = stats.paired_rotation_test(
            xs, ys, lambda a, b: stats.spearman(a, b)[0], iterations=500, seed=2
        )
        assert result.p_value > 0.10

    def test_short_series_are_declined_rather_than_guessed_at(self):
        result = stats.paired_rotation_test(
            [1.0, 2.0], [3.0, 4.0], lambda a, b: stats.spearman(a, b)[0]
        )
        assert result.p_value == 1.0

    def test_mismatched_lengths_are_a_programming_error(self):
        with pytest.raises(ValueError, match="equal length"):
            stats.paired_rotation_test([1.0], [1.0, 2.0], lambda a, b: 0.0)
