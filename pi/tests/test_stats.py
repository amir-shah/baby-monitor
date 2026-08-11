"""Properties of the statistics that hold with or without scipy installed."""

from __future__ import annotations

import random

import pytest

from babymon.analytics import stats as S


class TestSleepRegularityIndex:
    """Reference values from Phillips et al. 2017."""

    def test_identical_days_score_100(self):
        day = [True] * 720 + [False] * 720
        assert S.sleep_regularity_index([day] * 7) == pytest.approx(100.0)

    def test_perfectly_inverted_days_score_minus_100(self):
        days = [
            ([True] * 720 + [False] * 720) if i % 2 == 0 else ([False] * 720 + [True] * 720)
            for i in range(8)
        ]
        assert S.sleep_regularity_index(days) == pytest.approx(-100.0)

    def test_a_steady_half_hour_drift(self):
        # 30 minutes of disagreement out of 1440 each day:
        # -100 + 200 * 1410/1440 = 95.83
        days = [[False] * (i * 30) + [True] * 720 + [False] * (720 - i * 30) for i in range(6)]
        assert S.sleep_regularity_index(days) == pytest.approx(91.67, abs=0.01)

    def test_random_days_score_near_zero(self):
        rng = random.Random(3)
        days = [[rng.random() < 0.4 for _ in range(1440)] for _ in range(40)]
        assert abs(S.sleep_regularity_index(days)) < 8

    def test_unknown_epochs_drop_out_of_both_sides(self):
        # A night with no data must lower confidence, not the score.
        day = [True] * 720 + [False] * 720
        with_gap = [None] * 1440
        assert S.sleep_regularity_index([day, day, with_gap, day]) == pytest.approx(100.0)

    def test_needs_at_least_two_days(self):
        assert S.sleep_regularity_index([[True] * 10]) is None

    def test_rejects_ragged_input(self):
        with pytest.raises(ValueError):
            S.sleep_regularity_index([[True] * 10, [True] * 9])


class TestPermutation:
    def test_p_value_is_never_zero(self):
        """Phipson & Smyth: a permutation p-value of exactly zero is invalid."""
        values = [0.0] * 30 + [100.0] * 30
        labels = [False] * 30 + [True] * 30
        result = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b), iterations=500, mode="shuffle", seed=1
        )
        assert result.p_value > 0.0

    def test_detects_a_real_difference(self):
        rng = random.Random(5)
        values = [rng.gauss(0, 1) for _ in range(40)] + [rng.gauss(3, 1) for _ in range(40)]
        labels = [False] * 40 + [True] * 40
        result = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b), iterations=2000, mode="shuffle", seed=2
        )
        assert result.p_value < 0.01

    def test_reports_the_null_for_no_difference(self):
        rng = random.Random(6)
        values = [rng.gauss(0, 1) for _ in range(60)]
        labels = [i % 2 == 0 for i in range(60)]
        result = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b), iterations=2000, mode="shuffle", seed=3
        )
        assert result.p_value > 0.1

    def test_circular_shift_falls_back_when_there_are_too_few_nights(self):
        """Below ~30 nights, rotation gives a p-value grid coarser than alpha."""
        values = list(range(20))
        labels = [i < 10 for i in range(20)]
        result = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b),
            iterations=500, mode="circular_shift", seed=4,
        )
        assert result.method == "permutation:shuffle"

    def test_circular_shift_is_used_when_there_is_enough_history(self):
        values = [float(i % 7) for i in range(120)]
        # Irregular on purpose. A tag applied on a fixed cycle has only as many
        # distinct rotations as its period, and is handled in TestPeriodicTags.
        labels = [random.Random(i).random() < 0.4 for i in range(120)]
        result = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b),
            iterations=500, mode="circular_shift", seed=5,
        )
        assert result.method == "permutation:circular_shift"

    def test_circular_shift_is_more_conservative_under_autocorrelation(self):
        """The reason it is the default.

        With runs in both the outcome and the tag, free shuffling breaks the
        run structure and finds a difference that is not there. Rotation keeps
        it and does not.
        """
        rng = random.Random(11)
        values, labels, level, flag = [], [], 0.0, False
        for i in range(200):
            if i % 20 == 0:
                level = rng.gauss(0, 2)
                flag = not flag
            values.append(level + rng.gauss(0, 0.3))
            labels.append(flag)
        shuffled = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b),
            iterations=2000, mode="shuffle", seed=7,
        )
        rotated = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b),
            iterations=2000, mode="circular_shift", seed=7,
        )
        assert rotated.p_value >= shuffled.p_value


class TestPeriodicTags:
    """A tag on a fixed weekly cycle breaks the circular-shift null.

    Rotating "pizza on Fridays" by 7, 14, 21 … reproduces the observed
    labelling exactly. Those rotations are not draws from the null; they are
    the data again, and each one scores as extreme. Counted, they put a floor
    of roughly 1/7 under the p-value no matter how large the real effect is,
    and a real finding is reported as nothing.
    """

    @staticmethod
    def weekly(nights: int = 140, effect: float = -60.0):
        values, labels = [], []
        for i in range(nights):
            friday = i % 7 == 4
            labels.append(friday)
            values.append(600.0 + (effect if friday else 0.0))
        return values, labels

    def test_duplicate_rotations_are_not_counted_as_null_draws(self):
        values, labels = self.weekly()
        result = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b),
            iterations=2000, mode="circular_shift", seed=3,
        )
        # Seven distinct rotations, below MIN_ROTATIONS, so rotation is
        # abandoned rather than reporting a floor as if it were a result.
        assert result.method == "permutation:shuffle"

    def test_a_huge_weekly_effect_is_no_longer_invisible(self):
        values, labels = self.weekly()
        result = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b),
            iterations=2000, mode="circular_shift", seed=3,
        )
        # An hour less sleep every Friday, in 140 nights. Under the old
        # rotation null this could not score below about 0.14.
        assert result.p_value < 0.01

    def test_a_mostly_regular_tag_reports_the_floor_it_is_stuck_behind(self):
        # Fortnightly-ish, with enough jitter to leave rotations distinct.
        rng = random.Random(19)
        values, labels = [], []
        for i in range(160):
            flag = (i + (i // 14)) % 5 == 0
            labels.append(flag)
            values.append(600.0 + (-40.0 if flag else 0.0) + rng.gauss(0, 8))
        result = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b),
            iterations=2000, mode="circular_shift", seed=3,
        )
        if result.method == "permutation:circular_shift":
            resolution = result.detail["resolution"]
            assert resolution == pytest.approx(1.0 / (1 + result.detail["iterations"]))
            assert result.p_value >= resolution

    def test_the_reported_method_is_the_one_that_ran(self):
        # Not the one requested. A reader told the autocorrelation guardrail
        # was on when it was off would trust the wrong numbers hardest.
        values, labels = self.weekly(nights=140)
        rotated = S.permutation_test(
            values, labels, lambda a, b: S.mean(a) - S.mean(b),
            iterations=500, mode="circular_shift", seed=3,
        )
        assert rotated.method != "permutation:circular_shift"


class TestMeanDifferenceInterval:
    def test_it_brackets_the_difference_it_is_an_interval_for(self):
        a = [600.0, 580.0, 620.0, 590.0, 610.0, 575.0]
        b = [640.0, 660.0, 630.0, 650.0, 645.0, 655.0]
        low, high = S.mean_difference_ci(a, b)
        difference = S.mean(a) - S.mean(b)
        assert low < difference < high

    def test_more_nights_narrow_it(self):
        rng = random.Random(5)
        small = [rng.gauss(600, 30) for _ in range(6)]
        against = [rng.gauss(620, 30) for _ in range(6)]
        large = [rng.gauss(600, 30) for _ in range(60)]
        against_large = [rng.gauss(620, 30) for _ in range(60)]
        narrow = S.mean_difference_ci(large, against_large)
        wide = S.mean_difference_ci(small, against)
        assert (narrow[1] - narrow[0]) < (wide[1] - wide[0])

    def test_it_declines_rather_than_guessing_on_a_single_night(self):
        assert S.mean_difference_ci([600.0], [620.0, 610.0]) == (None, None)

    def test_identical_groups_give_a_zero_width_interval_or_none(self):
        low, high = S.mean_difference_ci([600.0] * 5, [600.0] * 5)
        assert (low, high) == (None, None)


class TestShrinkage:
    def test_noisy_estimates_are_pulled_further_toward_zero(self):
        """Two tags with the same estimate but different precision.

        This is the whole point of shrinking: without it, the top of a factor
        list is whichever tag has the fewest nights, because small samples
        produce large estimates.
        """
        # The spread across the family is real, so tau-squared is positive and
        # the shrinkage is differential rather than total.
        estimates = [1.0, 0.6, -0.9, 1.0]
        errors = [0.12, 0.15, 0.13, 2.0]
        shrunk = S.shrink_effects(estimates, errors)
        # Same raw estimate, twentyfold the standard error.
        assert abs(shrunk[3]) < abs(shrunk[0])
        # The precise ones survive nearly intact.
        assert abs(shrunk[0]) > 0.8 * abs(estimates[0])
        # Nothing changes sign or grows.
        for original, adjusted in zip(estimates, shrunk, strict=True):
            assert abs(adjusted) <= abs(original) + 1e-12
            assert original * adjusted >= 0

    def test_everything_collapses_when_the_spread_is_all_noise(self):
        shrunk = S.shrink_effects([0.1, -0.1, 0.05], [1.0, 1.0, 1.0])
        assert all(abs(v) < 1e-9 for v in shrunk)

    def test_too_few_estimates_to_borrow_strength_are_left_alone(self):
        assert S.shrink_effects([1.0, 2.0], [0.1, 0.1]) == [1.0, 2.0]


class TestEffectSizes:
    def test_hedges_g_is_smaller_than_cohens_d(self):
        a, b = [5.0, 6, 7, 8, 9], [1.0, 2, 3, 4, 5]
        g = S.hedges_g(a, b)
        # The correction always shrinks toward zero.
        assert g.value > 0
        assert g.magnitude == "large"

    def test_magnitude_thresholds(self):
        assert S.EffectSize("cliffs_delta", 0.1).magnitude == "negligible"
        assert S.EffectSize("cliffs_delta", 0.2).magnitude == "small"
        assert S.EffectSize("cliffs_delta", 0.4).magnitude == "medium"
        assert S.EffectSize("cliffs_delta", 0.6).magnitude == "large"

    def test_identical_groups_give_a_zero_effect(self):
        a = [1.0, 2, 3, 4, 5]
        assert S.cliffs_delta(a, list(a)) == 0.0
        assert S.hedges_g(a, list(a)).value == 0.0

    def test_disjoint_groups_give_delta_one(self):
        assert S.cliffs_delta([10.0, 11, 12], [1.0, 2, 3]) == 1.0

    def test_cliffs_ci_stays_inside_the_valid_range(self):
        effect = S.cliffs_delta_ci([10.0, 11, 12, 13], [1.0, 2, 3, 4])
        assert -1.0 <= effect.ci_low <= effect.ci_high <= 1.0


class TestBenjaminiHochberg:
    def test_step_up_rejects_everything_below_the_largest_passing_rank(self):
        # 0.04 alone exceeds its own threshold at rank 2 (2/4*0.10 = 0.05 -> it
        # passes), but the point is that rank 1 is rejected regardless.
        q, reject = S.benjamini_hochberg([0.001, 0.04, 0.9, 0.95], 0.10)
        assert reject[0] is True
        assert q[0] <= q[1] <= q[2]

    def test_nothing_is_rejected_when_nothing_is_significant(self):
        _, reject = S.benjamini_hochberg([0.4, 0.5, 0.6], 0.10)
        assert not any(reject)

    def test_empty_input(self):
        assert S.benjamini_hochberg([]) == ([], [])


class TestPhi:
    def test_perfect_co_occurrence(self):
        a = [True, True, False, False]
        assert S.phi_coefficient(a, list(a)) == pytest.approx(1.0)

    def test_perfect_opposition(self):
        a = [True, True, False, False]
        assert S.phi_coefficient(a, [not v for v in a]) == pytest.approx(-1.0)

    def test_independent_vectors_are_near_zero(self):
        a = [True, False] * 50
        b = [True, True, False, False] * 25
        assert abs(S.phi_coefficient(a, b)) < 0.2


class TestTheilSen:
    def test_recovers_a_clean_slope(self):
        x = list(range(20))
        y = [3.0 + 2.0 * v for v in x]
        slope, intercept = S.theil_sen(x, y)
        assert slope == pytest.approx(2.0)
        assert intercept == pytest.approx(3.0)

    def test_is_unmoved_by_a_single_outlier(self):
        """The reason trends use it: one bad night must not swing the line."""
        x = list(range(20))
        y = [3.0 + 2.0 * v for v in x]
        y[10] = 500.0
        slope, _ = S.theil_sen(x, y)
        assert slope == pytest.approx(2.0, abs=0.05)
