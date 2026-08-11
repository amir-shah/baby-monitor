"""Statistics, implemented against the standard library alone.

Everything the factor analysis needs — Welch's t, Mann-Whitney U, Spearman's
rho, Hedges' g, Cliff's delta, permutation tests, bootstrap intervals and
Benjamini-Hochberg correction — in about six hundred lines of ``math``.

The alternative was a scipy dependency, which on a 64-bit Pi means a 33 MB
wheel from PyPI (piwheels has no aarch64 builds) unpacking to well over
100 MB, plus the numpy/scipy ABI pinning that comes with it. For n ≤ 200
nights every operation here runs in microseconds, so the dependency buys
nothing but maintenance. ``tests/test_stats_vs_scipy.py`` runs a randomised
differential comparison against scipy whenever it happens to be installed, so
the hand-rolled maths cannot drift unnoticed.

A note on what these functions are *for*. The data is an N-of-1 observational
time series: one child, tags the parent chose to log, outcomes that are
strongly autocorrelated because children have good weeks and bad weeks. That
means every result here is hypothesis-generating and none of it is causal
evidence. Two consequences are baked into the code rather than left to the
caller: :func:`permutation_test` defaults to a circular-shift null that
preserves autocorrelation, and :func:`shrink_effects` pulls noisy estimates
toward zero so a tag with eleven nights cannot top the list on variance alone.
"""

from __future__ import annotations

import math
import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from math import erf, erfc, exp, fabs, lgamma, log, sqrt

__all__ = [
    "MIN_ROTATIONS",
    "Z_95",
    "EffectSize",
    "TestResult",
    "benjamini_hochberg",
    "betainc",
    "bootstrap_ci",
    "circular_mean",
    "circular_sd",
    "cliffs_delta",
    "cliffs_delta_ci",
    "hedges_g",
    "iqr",
    "mann_whitney_u",
    "mean",
    "mean_difference_ci",
    "median",
    "norm_cdf",
    "norm_ppf",
    "norm_sf",
    "percentile",
    "permutation_test",
    "phi_coefficient",
    "rankdata",
    "shrink_effects",
    "sleep_regularity_index",
    "spearman",
    "stdev",
    "student_t_ppf",
    "student_t_sf",
    "theil_sen",
    "variance",
    "welch_t_test",
]

#: Two-sided 95% normal quantile.
Z_95 = 1.959963984540054

#: Fewest distinct rotations that make a circular-shift null worth running. A
#: tag repeating on a fixed weekly cycle has only seven of them, which puts a
#: floor of about 0.14 under its p-value however large the real effect is.
MIN_ROTATIONS = 20


# ---------------------------------------------------------------------------
# Special functions
# ---------------------------------------------------------------------------


def _betacf(a: float, b: float, x: float, itmax: int = 300, eps: float = 3e-16) -> float:
    """Continued fraction for the incomplete beta, by modified Lentz.

    Numerical Recipes §6.4. The ``fpmin`` guard keeps a denominator that
    underflows to zero from producing an infinity.
    """
    fpmin = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if fabs(d) < fpmin:
        d = fpmin
    d = 1.0 / d
    h = d
    for m in range(1, itmax + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if fabs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if fabs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if fabs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if fabs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        delta = d * c
        h *= delta
        if fabs(delta - 1.0) < eps:
            break
    return h


def betainc(a: float, b: float, x: float) -> float:
    """Regularised incomplete beta ``I_x(a, b)``.

    The symmetry swap is not an optimisation: the continued fraction only
    converges quickly on one side of ``(a+1)/(a+b+2)``.
    """
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    # Computed in log space; the direct form overflows for even modest a, b.
    log_prefactor = lgamma(a + b) - lgamma(a) - lgamma(b) + a * log(x) + b * log(1.0 - x)
    if x < (a + 1.0) / (a + b + 2.0):
        return exp(log_prefactor) * _betacf(a, b, x) / a
    return 1.0 - exp(log_prefactor) * _betacf(b, a, 1.0 - x) / b


def student_t_sf(t: float, df: float) -> float:
    """Upper tail ``P(T > t)`` of Student's t."""
    if df <= 0:
        return float("nan")
    x = df / (df + t * t)
    two_sided = betainc(0.5 * df, 0.5, x)
    return 0.5 * two_sided if t > 0 else 1.0 - 0.5 * two_sided


def norm_cdf(z: float) -> float:
    return 0.5 * (1.0 + erf(z / sqrt(2.0)))


def norm_sf(z: float) -> float:
    """Upper tail of the standard normal; ``erfc`` avoids cancellation far out."""
    return 0.5 * erfc(z / sqrt(2.0))


_ACKLAM_A = (
    -3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
    1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00,
)
_ACKLAM_B = (
    -5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
    6.680131188771972e01, -1.328068155288572e01,
)
_ACKLAM_C = (
    -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
    -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00,
)
_ACKLAM_D = (
    7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
    3.754408661907416e00,
)


def norm_ppf(p: float) -> float:
    """Inverse standard normal CDF.

    Acklam's rational approximation (|error| < 1.15e-9) plus one Halley
    refinement, which takes it to about 4e-10 — far beyond what any of this
    is measuring, but it costs one exp.
    """
    if not 0.0 < p < 1.0:
        raise ValueError(f"norm_ppf requires 0 < p < 1, got {p}")
    a, b, c, d = _ACKLAM_A, _ACKLAM_B, _ACKLAM_C, _ACKLAM_D
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = sqrt(-2 * log(p))
        x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1
        )
    elif p > phigh:
        q = sqrt(-2 * log(1 - p))
        x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1
        )
    else:
        q = p - 0.5
        r = q * q
        x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (
            ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1
        )
    err = norm_cdf(x) - p
    u = err * sqrt(2 * math.pi) * exp(x * x / 2)
    return x - u / (1 + x * u / 2)


# ---------------------------------------------------------------------------
# Descriptive statistics
# ---------------------------------------------------------------------------


def mean(values: Sequence[float]) -> float:
    if not values:
        raise ValueError("mean of an empty sequence")
    return sum(values) / len(values)


def variance(values: Sequence[float]) -> float:
    """Sample variance, Bessel-corrected."""
    n = len(values)
    if n < 2:
        return 0.0
    m = mean(values)
    return sum((x - m) ** 2 for x in values) / (n - 1)


def stdev(values: Sequence[float]) -> float:
    return sqrt(variance(values))


def median(values: Sequence[float]) -> float:
    return percentile(values, 50.0)


def percentile(values: Sequence[float], q: float) -> float:
    """Linear-interpolation percentile, matching numpy's default method."""
    if not values:
        raise ValueError("percentile of an empty sequence")
    if not 0.0 <= q <= 100.0:
        raise ValueError(f"percentile q must be in 0..100, got {q}")
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * q / 100.0
    lower = math.floor(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def iqr(values: Sequence[float]) -> float:
    return percentile(values, 75.0) - percentile(values, 25.0)


def rankdata(values: Sequence[float]) -> tuple[list[float], list[int]]:
    """Midranks (1-based) and the sizes of each tie group.

    Ties matter here: sleep data is full of them (integer awakening counts,
    minute-quantised durations), and the ``1 - 6Σd²/(n(n²-1))`` shortcut for
    Spearman is simply wrong in their presence.
    """
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    ties: list[int] = []
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        average = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = average
        ties.append(j - i + 1)
        i = j + 1
    return ranks, ties


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class TestResult:
    statistic: float
    p_value: float
    df: float | None = None
    method: str = ""
    detail: dict[str, float] = field(default_factory=dict)


@dataclass(slots=True)
class EffectSize:
    name: str
    value: float
    ci_low: float | None = None
    ci_high: float | None = None
    se: float | None = None

    @property
    def magnitude(self) -> str:
        """Conventional magnitude label for the effect-size family."""
        v = abs(self.value)
        if self.name in ("cohens_d", "hedges_g"):
            # Cohen's conventions.
            if v < 0.2:
                return "negligible"
            if v < 0.5:
                return "small"
            if v < 0.8:
                return "medium"
            return "large"
        if self.name == "cliffs_delta":
            # Romano et al. 2006, the thresholds R's `effsize` package uses.
            if v < 0.147:
                return "negligible"
            if v < 0.33:
                return "small"
            if v < 0.474:
                return "medium"
            return "large"
        return "unknown"

    @property
    def crosses_zero(self) -> bool:
        if self.ci_low is None or self.ci_high is None:
            return True
        return self.ci_low <= 0.0 <= self.ci_high


# ---------------------------------------------------------------------------
# Two-sample tests
# ---------------------------------------------------------------------------


def welch_t_test(a: Sequence[float], b: Sequence[float]) -> TestResult:
    """Welch's unequal-variance t-test.

    Always Welch, never Student: the two groups here are "nights with the tag"
    and "nights without", which differ in both size and spread essentially by
    construction.
    """
    n1, n2 = len(a), len(b)
    if n1 < 2 or n2 < 2:
        return TestResult(float("nan"), 1.0, None, "welch")
    v1, v2 = variance(a), variance(b)
    se_squared = v1 / n1 + v2 / n2
    if se_squared <= 0:
        return TestResult(0.0, 1.0, None, "welch")
    t = (mean(a) - mean(b)) / sqrt(se_squared)
    denominator = (v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1)
    df = se_squared**2 / denominator if denominator > 0 else float(n1 + n2 - 2)
    return TestResult(t, min(1.0, 2.0 * student_t_sf(abs(t), df)), df, "welch")


def mean_difference_ci(
    a: Sequence[float], b: Sequence[float], *, confidence: float = 0.95
) -> tuple[float | None, float | None]:
    """Welch interval for ``mean(a) - mean(b)``, in the units of the data.

    This is the interval on the headline number — "18 minutes less sleep" —
    and it is the one a reader leans on hardest, so its stated coverage has to
    be close to true. Measured against simulated nights (skewed, capped, a
    handful of disasters, groups of 8 v 22 and 12 v 38) the alternatives came
    out at: percentile bootstrap 89%, BCa 86%, studentised bootstrap 90%,
    Welch 93%. All of them are labelled 95%; Welch is the least wrong, and it
    is also the interval that agrees with the Welch test elsewhere in this
    module rather than quietly using a different model of the same data.

    93% is still not 95%, and ``docs/ANALYTICS.md`` says so. The residual gap
    is the price of estimating two variances from a handful of nights, and no
    amount of resampling buys it back.
    """
    n1, n2 = len(a), len(b)
    if n1 < 2 or n2 < 2:
        return None, None
    v1, v2 = variance(a) / n1, variance(b) / n2
    se_squared = v1 + v2
    if se_squared <= 0:
        return None, None
    denominator = v1 * v1 / (n1 - 1) + v2 * v2 / (n2 - 1)
    df = se_squared**2 / denominator if denominator > 0 else float(n1 + n2 - 2)
    critical = student_t_ppf(1.0 - (1.0 - confidence) / 2.0, df)
    if critical is None:
        return None, None
    half_width = critical * sqrt(se_squared)
    difference = mean(a) - mean(b)
    return difference - half_width, difference + half_width


def student_t_ppf(p: float, df: float) -> float | None:
    """Inverse of the Student-t CDF, by bisection on :func:`student_t_sf`.

    Bisection rather than a closed form because there is not one, and because
    a hundred halvings of a bracket cost nothing next to the bootstrap this
    replaces.
    """
    if not 0.0 < p < 1.0 or df <= 0:
        return None
    target = 1.0 - p
    low, high = 0.0, 1.0
    while student_t_sf(high, df) > target:
        high *= 2.0
        if high > 1e6:
            return None
    for _ in range(200):
        middle = (low + high) / 2.0
        if student_t_sf(middle, df) > target:
            low = middle
        else:
            high = middle
    return (low + high) / 2.0


def mann_whitney_u(
    a: Sequence[float], b: Sequence[float], *, continuity: bool = True
) -> TestResult:
    """Mann-Whitney U with the normal approximation and tie correction."""
    n1, n2 = len(a), len(b)
    if n1 == 0 or n2 == 0:
        return TestResult(float("nan"), 1.0, None, "mann-whitney")
    ranks, ties = rankdata([*a, *b])
    rank_sum_a = sum(ranks[:n1])
    u1 = rank_sum_a - n1 * (n1 + 1) / 2.0
    u2 = n1 * n2 - u1
    total = n1 + n2
    mu = n1 * n2 / 2.0
    tie_term = sum(t**3 - t for t in ties)
    if total < 2:
        return TestResult(u1, 1.0, None, "mann-whitney")
    sigma_squared = n1 * n2 / 12.0 * ((total + 1) - tie_term / (total * (total - 1.0)))
    if sigma_squared <= 0:
        return TestResult(u1, 1.0, None, "mann-whitney")
    numerator = abs(max(u1, u2) - mu) - (0.5 if continuity else 0.0)
    z = max(0.0, numerator) / sqrt(sigma_squared)
    return TestResult(u1, min(1.0, 2.0 * norm_sf(z)), None, "mann-whitney", {"z": z, "u2": u2})


def spearman(x: Sequence[float], y: Sequence[float]) -> tuple[float, TestResult]:
    """Spearman's rank correlation and its two-sided p-value."""
    if len(x) != len(y):
        raise ValueError("spearman requires equal-length sequences")
    n = len(x)
    if n < 3:
        return 0.0, TestResult(0.0, 1.0, None, "spearman")
    rx, _ = rankdata(x)
    ry, _ = rankdata(y)
    mx, my = mean(rx), mean(ry)
    sxy = sum((p - mx) * (q - my) for p, q in zip(rx, ry, strict=True))
    sxx = sum((p - mx) ** 2 for p in rx)
    syy = sum((q - my) ** 2 for q in ry)
    if sxx <= 0 or syy <= 0:
        # Every value tied on one side; the correlation is undefined, not zero,
        # but zero with p=1 is the honest thing to report.
        return 0.0, TestResult(0.0, 1.0, None, "spearman")
    rho = sxy / sqrt(sxx * syy)
    clamped = max(-0.999999999999, min(0.999999999999, rho))
    df = n - 2
    t = clamped * sqrt(df / (1 - clamped * clamped))
    return rho, TestResult(t, min(1.0, 2.0 * student_t_sf(abs(t), df)), float(df), "spearman")


# ---------------------------------------------------------------------------
# Effect sizes
# ---------------------------------------------------------------------------


def hedges_g(a: Sequence[float], b: Sequence[float]) -> EffectSize:
    """Hedges' g — Cohen's d with the exact small-sample correction.

    The correction factor uses the lgamma form rather than the familiar
    ``1 - 3/(4m-1)`` approximation. The two agree to three decimals even at
    m=8, but the exact one costs nothing.
    """
    n1, n2 = len(a), len(b)
    if n1 < 2 or n2 < 2:
        return EffectSize("hedges_g", 0.0)
    v1, v2 = variance(a), variance(b)
    pooled = sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2))
    if pooled <= 0:
        return EffectSize("hedges_g", 0.0)
    d = (mean(a) - mean(b)) / pooled
    m = n1 + n2 - 2
    correction = exp(lgamma(m / 2.0) - 0.5 * log(m / 2.0) - lgamma((m - 1) / 2.0))
    g = correction * d
    # Hedges & Olkin's large-sample variance.
    var_d = (n1 + n2) / (n1 * n2) + d * d / (2 * (n1 + n2))
    se = correction * sqrt(var_d)
    return EffectSize("hedges_g", g, g - Z_95 * se, g + Z_95 * se, se)


def cliffs_delta(a: Sequence[float], b: Sequence[float]) -> float:
    """Cliff's delta: ``P(x > y) - P(x < y)``.

    Distribution-free, which matters because WASO and sleep-onset latency have
    heavy right tails that make a mean difference misleading.
    """
    n1, n2 = len(a), len(b)
    if n1 == 0 or n2 == 0:
        return 0.0
    # O(n1·n2) is fine at these sizes and is much easier to read than the
    # rank-based identity.
    greater = sum(1 for x in a for y in b if x > y)
    less = sum(1 for x in a for y in b if x < y)
    return (greater - less) / float(n1 * n2)


def cliffs_delta_ci(
    a: Sequence[float], b: Sequence[float], *, z: float = Z_95
) -> EffectSize:
    """Cliff's delta with its consistent-variance asymmetric interval (Cliff 1993)."""
    n1, n2 = len(a), len(b)
    delta = cliffs_delta(a, b)
    if n1 < 2 or n2 < 2:
        return EffectSize("cliffs_delta", delta)

    signs = [[_sign(x - y) for y in b] for x in a]
    row_means = [sum(row) / n2 for row in signs]
    col_means = [sum(signs[i][j] for i in range(n1)) / n1 for j in range(n2)]

    sum_rows = sum((r - delta) ** 2 for r in row_means)
    sum_cols = sum((c - delta) ** 2 for c in col_means)
    sum_all = sum((signs[i][j] - delta) ** 2 for i in range(n1) for j in range(n2))

    denominator = n1 * n2 * (n1 - 1) * (n2 - 1)
    if denominator <= 0:
        return EffectSize("cliffs_delta", delta)
    var = (n2 * n2 * sum_rows + n1 * n1 * sum_cols - sum_all) / denominator
    if var <= 0:
        return EffectSize("cliffs_delta", delta, delta, delta, 0.0)
    sigma = sqrt(var)

    # The interval is built on a transformed scale so it stays inside [-1, 1].
    d2 = delta * delta
    common = 1 - d2 + z * z * var
    spread = z * sigma * sqrt((1 - d2) ** 2 + z * z * var)
    low = (delta - delta**3 - spread) / common
    high = (delta - delta**3 + spread) / common
    return EffectSize(
        "cliffs_delta", delta, max(-1.0, min(1.0, low)), max(-1.0, min(1.0, high)), sigma
    )


def _sign(value: float) -> int:
    return (value > 0) - (value < 0)


# ---------------------------------------------------------------------------
# Resampling
# ---------------------------------------------------------------------------


def permutation_test(
    values: Sequence[float],
    labels: Sequence[bool],
    statistic: Callable[[Sequence[float], Sequence[float]], float],
    *,
    iterations: int = 10000,
    mode: str = "circular_shift",
    seed: int | None = None,
) -> TestResult:
    """Two-sided permutation test of a statistic between labelled groups.

    ``mode`` chooses the null:

    ``"shuffle"``
        Free permutation of the labels. Correct when nights are exchangeable.
        They are not: both sleep quality and habits arrive in runs, and under
        realistic AR(1) structure a nominal 5% test actually fires about 18% of
        the time. Available because it is the textbook null, not because it is
        the right one here.

    ``"circular_shift"``
        Rotate the label vector by a random offset. This preserves the tag's
        own run structure *and* the outcome's autocorrelation, which removes
        most of that inflation. The number of distinct rotations is only ``n``,
        so the p-value cannot resolve below about ``1/n`` — the code falls back
        to shuffling when there are too few nights for rotation to say anything.

        A periodic tag is the trap here. "Pizza on Fridays" repeats every seven
        nights, so rotating by 7, 14, 21 … reproduces the original labelling
        exactly: those rotations are not null draws, they are the observed data
        again, and every one of them counts as extreme. Left alone, a weekly
        habit can never score better than about p=0.14 no matter how large its
        effect. Only *distinct* rotations are used, and the count of them is
        reported so the caller can say the floor out loud instead of
        presenting a structural artefact as a null result.

    The mode actually used is always what comes back in ``method``, which is
    not always the mode asked for. Reporting the requested one would tell a
    reader their results were protected against day-to-day carryover when they
    were not.

    The ``(1 + count) / (1 + iterations)`` form is deliberate: a permutation
    p-value of exactly zero is never a valid estimate (Phipson & Smyth 2010).
    """
    if len(values) != len(labels):
        raise ValueError("permutation_test requires values and labels of equal length")
    n = len(values)
    group_a = [v for v, flag in zip(values, labels, strict=True) if flag]
    group_b = [v for v, flag in zip(values, labels, strict=True) if not flag]
    if len(group_a) < 2 or len(group_b) < 2:
        return TestResult(float("nan"), 1.0, None, f"permutation:{mode}")

    observed = statistic(group_a, group_b)
    if not math.isfinite(observed):
        return TestResult(observed, 1.0, None, f"permutation:{mode}")

    rng = random.Random(seed)
    label_list = list(labels)
    extreme = 0
    effective_mode = mode

    if mode == "circular_shift":
        # With fewer than ~30 nights, n rotations give a p-value grid coarser
        # than the threshold we would test it against.
        if n < 30:
            effective_mode = "shuffle"
        else:
            original = tuple(label_list)
            seen: set[tuple[bool, ...]] = {original}
            offsets = list(range(1, n))
            rng.shuffle(offsets)
            if len(offsets) > iterations:
                offsets = offsets[:iterations]
            usable = 0
            for offset in offsets:
                rotated = tuple(label_list[offset:] + label_list[:offset])
                if rotated in seen:
                    # A rotation of a periodic tag onto itself. Not a draw
                    # from the null — it is the observed data wearing a hat.
                    continue
                seen.add(rotated)
                a = [v for v, flag in zip(values, rotated, strict=True) if flag]
                b = [v for v, flag in zip(values, rotated, strict=True) if not flag]
                if len(a) < 2 or len(b) < 2:
                    continue
                usable += 1
                candidate = statistic(a, b)
                if math.isfinite(candidate) and abs(candidate) >= abs(observed) - 1e-12:
                    extreme += 1
            if usable < MIN_ROTATIONS:
                # Too regular to test this way at all: a tag applied on a fixed
                # weekday, or on every night bar two. Shuffling ignores the
                # autocorrelation, which is why it is not the default, but a
                # coarse honest answer beats a fine dishonest one, and the mode
                # that comes back says which was used.
                effective_mode = "shuffle"
            else:
                return TestResult(
                    observed,
                    (1 + extreme) / (1 + usable),
                    None,
                    "permutation:circular_shift",
                    {
                        "iterations": float(usable),
                        # The smallest p-value this null can produce. A weekly
                        # tag bottoms out around 0.14 however real its effect.
                        "resolution": 1.0 / (1 + usable),
                    },
                )

    pool = list(values)
    n1 = len(group_a)
    extreme = 0  # anything the abandoned rotation pass counted does not carry over
    for _ in range(iterations):
        rng.shuffle(pool)
        candidate = statistic(pool[:n1], pool[n1:])
        if math.isfinite(candidate) and abs(candidate) >= abs(observed) - 1e-12:
            extreme += 1
    return TestResult(
        observed,
        (1 + extreme) / (1 + iterations),
        None,
        f"permutation:{effective_mode}",
        {"iterations": float(iterations)},
    )


def bootstrap_ci(
    a: Sequence[float],
    b: Sequence[float],
    statistic: Callable[[Sequence[float], Sequence[float]], float],
    *,
    iterations: int = 5000,
    confidence: float = 0.95,
    seed: int | None = None,
) -> tuple[float | None, float | None]:
    """Bias-corrected and accelerated (BCa) bootstrap interval.

    Preferred over the analytic interval below about thirty per group, where
    the closed forms are slightly anti-conservative, and the only option at all
    for statistics like Cliff's delta on skewed data.

    ``z0`` measures the median bias of the bootstrap distribution and ``acc``
    its skew, estimated by jackknife; together they shift and stretch the
    percentiles taken from the replicates. Where the correction cannot be
    computed — every replicate identical, a degenerate jackknife — it falls
    back to the plain percentiles rather than inventing an adjustment. Agrees
    with ``scipy.stats.bootstrap(method="BCa")`` to within resampling noise,
    which ``tests/test_stats_vs_scipy.py`` checks.

    Not used for the headline difference in means: at the group sizes this
    project actually sees, BCa measured *worse* than the plain percentile
    interval and both were beaten by :func:`mean_difference_ci`, which has the
    closed form this statistic deserves. Asymptotic second-order accuracy is
    not a coverage guarantee at n=8, and the numbers in that docstring are
    measured rather than assumed.
    """
    if len(a) < 2 or len(b) < 2:
        return None, None
    rng = random.Random(seed)
    n1, n2 = len(a), len(b)
    observed = statistic(a, b)
    samples: list[float] = []
    for _ in range(iterations):
        resample_a = [a[rng.randrange(n1)] for _ in range(n1)]
        resample_b = [b[rng.randrange(n2)] for _ in range(n2)]
        value = statistic(resample_a, resample_b)
        if math.isfinite(value):
            samples.append(value)
    if len(samples) < 20:
        return None, None

    alpha = (1.0 - confidence) / 2.0
    low_q, high_q = alpha, 1.0 - alpha
    if math.isfinite(observed):
        adjusted = _bca_quantiles(observed, samples, a, b, statistic, alpha)
        if adjusted is not None:
            low_q, high_q = adjusted
    return percentile(samples, low_q * 100), percentile(samples, high_q * 100)


def _bca_quantiles(
    observed: float,
    samples: Sequence[float],
    a: Sequence[float],
    b: Sequence[float],
    statistic: Callable[[Sequence[float], Sequence[float]], float],
    alpha: float,
) -> tuple[float, float] | None:
    """The two BCa-adjusted quantiles, or None if the correction is degenerate."""
    below = sum(1 for value in samples if value < observed)
    ties = sum(1 for value in samples if value == observed)
    # The mid-p proportion, so a discrete statistic with many ties does not
    # push z0 to an extreme on the strength of the ties alone.
    proportion = (below + 0.5 * ties) / len(samples)
    if not 0.0 < proportion < 1.0:
        return None
    z0 = norm_ppf(proportion)

    # Empirical influence values, group by group. They cannot be pooled raw:
    # dropping one night from a group of eight moves the statistic far more
    # than dropping one from a group of twenty-two, and treating those as
    # comparable makes the smaller group look wildly skewed. Each group is
    # centred within itself, scaled by its own size, and its cubes and squares
    # normalised by that size before the two groups are combined — the
    # multi-sample acceleration of Efron & Tibshirani §14.3, and the form
    # scipy's own BCa uses, which the differential test pins this against.
    numerator = 0.0
    denominator = 0.0
    for group, other, first in ((a, b, True), (b, a, False)):
        size = len(group)
        if size < 2:
            return None
        deletions: list[float] = []
        for i in range(size):
            trimmed = [*group[:i], *group[i + 1 :]]
            value = statistic(trimmed, other) if first else statistic(other, trimmed)
            if not math.isfinite(value):
                return None
            deletions.append(value)
        centre = mean(deletions)
        influence = [(size - 1) * (centre - value) for value in deletions]
        numerator += sum(d**3 for d in influence) / size**3
        denominator += sum(d * d for d in influence) / size**2

    if denominator <= 0.0:
        return None
    acc = numerator / (6.0 * denominator**1.5)

    def adjust(probability: float) -> float | None:
        z = norm_ppf(probability)
        denominator = 1.0 - acc * (z0 + z)
        if abs(denominator) < 1e-12:
            return None
        return norm_cdf(z0 + (z0 + z) / denominator)

    low, high = adjust(alpha), adjust(1.0 - alpha)
    if low is None or high is None or not 0.0 < low < high < 1.0:
        return None
    return low, high


# ---------------------------------------------------------------------------
# Multiplicity and shrinkage
# ---------------------------------------------------------------------------


def benjamini_hochberg(
    p_values: Sequence[float], q: float = 0.10
) -> tuple[list[float], list[bool]]:
    """Benjamini-Hochberg FDR control.

    Returns per-test adjusted q-values and the rejection decisions.

    The step-up detail people get wrong: having found the largest rank ``k``
    with ``p₍ₖ₎ ≤ (k/m)·q``, *every* hypothesis of rank 1..k is rejected —
    including ones whose own p-value exceeds their own threshold.

    ``m`` must be the number of tests actually run, not the number displayed.
    Evaluating forty tags and showing the best three is still forty tests.
    """
    m = len(p_values)
    if m == 0:
        return [], []
    order = sorted(range(m), key=lambda i: p_values[i])

    adjusted = [1.0] * m
    running_min = 1.0
    for rank in range(m, 0, -1):
        index = order[rank - 1]
        running_min = min(running_min, p_values[index] * m / rank)
        adjusted[index] = min(1.0, max(0.0, running_min))

    k = 0
    for rank in range(1, m + 1):
        if p_values[order[rank - 1]] <= q * rank / m:
            k = rank
    reject = [False] * m
    for rank in range(1, k + 1):
        reject[order[rank - 1]] = True
    return adjusted, reject


def shrink_effects(
    estimates: Sequence[float], standard_errors: Sequence[float]
) -> list[float]:
    """Empirical-Bayes shrinkage of a family of effect estimates toward zero.

    Without this, the top of any factor list is whichever tag has the fewest
    nights, because small samples produce large estimates and nothing else
    penalises them for it.

    The model is ``yᵢ = θᵢ + εᵢ`` with ``εᵢ ~ N(0, seᵢ²)`` and ``θᵢ ~ N(0, τ²)``.
    Each estimate is then pulled toward zero by ``τ²/(τ² + seᵢ²)`` — the share
    of its variance that is real signal rather than noise.

    Everything turns on ``τ²``. The obvious estimator — observed spread minus
    the *mean* sampling variance — is unusable here, because a single very
    imprecise tag dominates that mean and collapses ``τ²`` to zero, shrinking
    the entire family away. Since a family with one eleven-night tag beside a
    hundred-night one is the normal case, ``τ²`` is instead found by solving
    ``Σ yᵢ²/(τ² + seᵢ²) = k``, the Paule-Mandel condition. That weights each
    estimate by its own precision, so an imprecise one contributes little
    rather than swamping the result.
    """
    if len(estimates) != len(standard_errors):
        raise ValueError("shrink_effects requires matching estimates and standard errors")
    n = len(estimates)
    if n < 3:
        # With one or two tags there is no family to borrow strength from.
        return list(estimates)

    variances = [max(se * se, 1e-12) for se in standard_errors]
    squares = [y * y for y in estimates]

    def statistic(tau_squared: float) -> float:
        return sum(s / (tau_squared + v) for s, v in zip(squares, variances, strict=True))

    # Decreasing in tau-squared, so if it is already at or below k with no
    # between-tag variance at all, everything here is explicable as noise.
    if statistic(0.0) <= n:
        return [0.0] * n

    low, high = 0.0, max(squares) + max(variances) + 1.0
    while statistic(high) > n and high < 1e12:
        high *= 4.0
    for _ in range(80):
        mid = 0.5 * (low + high)
        if statistic(mid) > n:
            low = mid
        else:
            high = mid
    tau_squared = 0.5 * (low + high)

    return [
        y * (tau_squared / (tau_squared + v))
        for y, v in zip(estimates, variances, strict=True)
    ]


def phi_coefficient(a: Sequence[bool], b: Sequence[bool]) -> float:
    """Phi (Matthews) correlation between two binary vectors.

    Used to detect tags that co-occur so often the analysis cannot separate
    them — dessert nights are also TV nights are also weekend nights.
    """
    if len(a) != len(b):
        raise ValueError("phi_coefficient requires equal-length sequences")
    n11 = sum(1 for x, y in zip(a, b, strict=True) if x and y)
    n10 = sum(1 for x, y in zip(a, b, strict=True) if x and not y)
    n01 = sum(1 for x, y in zip(a, b, strict=True) if not x and y)
    n00 = sum(1 for x, y in zip(a, b, strict=True) if not x and not y)
    numerator = n11 * n00 - n10 * n01
    denominator = math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00))
    return numerator / denominator if denominator > 0 else 0.0


def theil_sen(x: Sequence[float], y: Sequence[float]) -> tuple[float, float]:
    """Theil-Sen slope and intercept: the median of all pairwise slopes.

    Used for trend lines because one unusual night — an illness, a holiday —
    would drag a least-squares fit around, and the picture a parent takes away
    from a trend line should not hinge on a single point.
    """
    n = len(x)
    if n != len(y):
        raise ValueError("theil_sen requires equal-length sequences")
    if n < 2:
        return 0.0, y[0] if y else 0.0
    slopes = [
        (y[j] - y[i]) / (x[j] - x[i])
        for i in range(n)
        for j in range(i + 1, n)
        if x[j] != x[i]
    ]
    if not slopes:
        return 0.0, median(y)
    slope = median(slopes)
    intercept = median([y[i] - slope * x[i] for i in range(n)])
    return slope, intercept


# ---------------------------------------------------------------------------
# Circular statistics — clock times are angles, not numbers
# ---------------------------------------------------------------------------


def circular_mean(minutes: Sequence[float], period: float = 1440.0) -> float | None:
    """Mean clock time, in minutes after midnight.

    An arithmetic mean of 23:50 and 00:10 is midday. Every bedtime statistic in
    this application therefore goes through here.
    """
    values = [m for m in minutes if m is not None]
    if not values:
        return None
    sin_sum = sum(math.sin(2 * math.pi * m / period) for m in values)
    cos_sum = sum(math.cos(2 * math.pi * m / period) for m in values)
    if abs(sin_sum) < 1e-12 and abs(cos_sum) < 1e-12:
        return None
    angle = math.atan2(sin_sum / len(values), cos_sum / len(values))
    return (angle * period / (2 * math.pi)) % period


def circular_sd(minutes: Sequence[float], period: float = 1440.0) -> float | None:
    """Circular standard deviation of clock times, in minutes."""
    values = [m for m in minutes if m is not None]
    if len(values) < 2:
        return None
    sin_mean = sum(math.sin(2 * math.pi * m / period) for m in values) / len(values)
    cos_mean = sum(math.cos(2 * math.pi * m / period) for m in values) / len(values)
    r = math.hypot(sin_mean, cos_mean)
    if r <= 1e-12:
        return None
    if r >= 1.0:
        return 0.0
    return sqrt(-2 * log(r)) * period / (2 * math.pi)


def sleep_regularity_index(days: Sequence[Sequence[bool | None]]) -> float | None:
    """Sleep Regularity Index (Phillips et al. 2017).

    ``days`` is one sequence of equal-length epoch flags per day: True asleep,
    False awake, None unknown. The index is the percentage agreement between
    each pair of consecutive days at the same clock position, rescaled to
    [-100, 100]::

        SRI = -100 + (200 / valid_comparisons) · Σ δ(s[i][j], s[i+1][j])

    100 means every day is identical, 0 means no better than chance, and
    negative values mean consecutive days are systematically opposed.

    Unlike the standard deviation of bedtime, this counts naps and captures
    *when* sleep happens rather than only how much — which is exactly the
    difference that matters for a small child. It needs at least seven days
    before it stabilises; the caller is expected to enforce that.

    Unknown epochs drop out of both the numerator and the denominator, so a
    night with a sensor outage lowers confidence rather than the score.
    """
    if len(days) < 2:
        return None
    epochs = len(days[0])
    if epochs == 0 or any(len(day) != epochs for day in days):
        raise ValueError("sleep_regularity_index requires equal-length days")

    agreements = 0
    comparisons = 0
    for i in range(len(days) - 1):
        today, tomorrow = days[i], days[i + 1]
        for j in range(epochs):
            a, b = today[j], tomorrow[j]
            if a is None or b is None:
                continue
            comparisons += 1
            if a == b:
                agreements += 1
    if comparisons == 0:
        return None
    return -100.0 + 200.0 * agreements / comparisons
