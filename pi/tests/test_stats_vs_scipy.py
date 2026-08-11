"""Differential test of the pure-Python statistics against scipy.

The whole reason for hand-rolling this maths is to avoid a 33 MB scipy wheel on
a Raspberry Pi for operations that run in microseconds without it. The risk of
that decision is silent drift, so whenever scipy happens to be installed — in
CI, on a developer's laptop — every function is re-checked against it over
randomised inputs.

scipy is never imported at runtime, only here.
"""

from __future__ import annotations

import math
import random

import pytest

from babymon.analytics import stats as S

scipy_stats = pytest.importorskip("scipy.stats", reason="scipy is a test-only oracle")


@pytest.fixture()
def rng() -> random.Random:
    return random.Random(20260811)


def test_welch_matches_scipy(rng):
    worst_t = worst_p = 0.0
    for _ in range(300):
        a = [rng.gauss(0, rng.uniform(0.5, 3)) for _ in range(rng.randint(4, 60))]
        b = [rng.gauss(0.4, rng.uniform(0.5, 3)) for _ in range(rng.randint(4, 60))]
        ours = S.welch_t_test(a, b)
        theirs = scipy_stats.ttest_ind(a, b, equal_var=False)
        worst_t = max(worst_t, abs(ours.statistic - theirs.statistic))
        worst_p = max(worst_p, abs(ours.p_value - theirs.pvalue))
    assert worst_t < 1e-10, worst_t
    assert worst_p < 1e-10, worst_p


def test_mann_whitney_matches_scipy_on_tie_heavy_data(rng):
    """Ties matter: sleep data is full of them (integer awakening counts)."""
    worst_u = worst_p = 0.0
    for _ in range(300):
        a = [rng.randint(0, 6) for _ in range(rng.randint(5, 40))]
        b = [rng.randint(0, 6) for _ in range(rng.randint(5, 40))]
        ours = S.mann_whitney_u(a, b)
        theirs = scipy_stats.mannwhitneyu(a, b, method="asymptotic", use_continuity=True)
        worst_u = max(worst_u, abs(ours.statistic - theirs.statistic))
        worst_p = max(worst_p, abs(ours.p_value - theirs.pvalue))
    assert worst_u == 0.0
    assert worst_p < 1e-12, worst_p


def test_spearman_matches_scipy_with_ties(rng):
    worst_rho = worst_p = 0.0
    for _ in range(300):
        n = rng.randint(6, 60)
        x = [rng.randint(0, 8) for _ in range(n)]
        y = [rng.randint(0, 8) for _ in range(n)]
        rho, test = S.spearman(x, y)
        theirs = scipy_stats.spearmanr(x, y)
        if math.isnan(theirs.statistic):
            continue
        worst_rho = max(worst_rho, abs(rho - theirs.statistic))
        worst_p = max(worst_p, abs(test.p_value - theirs.pvalue))
    assert worst_rho < 1e-12, worst_rho
    assert worst_p < 1e-10, worst_p


def test_student_t_survival_matches_scipy(rng):
    worst = 0.0
    for _ in range(500):
        df = rng.uniform(1, 1e5)
        t = rng.uniform(0.01, 40)
        worst = max(worst, abs(S.student_t_sf(t, df) - scipy_stats.t.sf(t, df)))
    assert worst < 1e-9, worst


def test_norm_ppf_matches_scipy(rng):
    worst = 0.0
    for _ in range(500):
        p = rng.uniform(1e-9, 1 - 1e-9)
        worst = max(worst, abs(S.norm_ppf(p) - scipy_stats.norm.ppf(p)))
    assert worst < 1e-8, worst


def test_benjamini_hochberg_matches_scipy(rng):
    """Both the adjusted q-values and, more importantly, the reject set."""
    worst_q = 0.0
    for _ in range(200):
        m = rng.randint(2, 40)
        p_values = [rng.random() ** 2 for _ in range(m)]
        ours_q, ours_reject = S.benjamini_hochberg(p_values, 0.10)
        theirs_q = scipy_stats.false_discovery_control(p_values, method="bh")
        worst_q = max(worst_q, max(abs(a - b) for a, b in zip(ours_q, theirs_q)))
        assert ours_reject == [q <= 0.10 for q in theirs_q]
    assert worst_q < 1e-12, worst_q


def test_percentile_matches_numpy(rng):
    numpy = pytest.importorskip("numpy")
    for _ in range(200):
        values = [rng.gauss(0, 5) for _ in range(rng.randint(2, 50))]
        q = rng.uniform(0, 100)
        assert S.percentile(values, q) == pytest.approx(float(numpy.percentile(values, q)))


def test_cliffs_delta_equals_the_rank_identity(rng):
    """delta == 2*AUC - 1, which is a free cross-check on both implementations."""
    for _ in range(100):
        a = [rng.gauss(0, 1) for _ in range(rng.randint(5, 30))]
        b = [rng.gauss(0.5, 1) for _ in range(rng.randint(5, 30))]
        u = scipy_stats.mannwhitneyu(a, b).statistic
        assert S.cliffs_delta(a, b) == pytest.approx(2 * u / (len(a) * len(b)) - 1)
