"""Associating notes and tags with sleep outcomes.

This is the module that answers "does dessert before bedtime wreck his sleep?"
It is also the easiest place in the whole product to mislead someone, so a
disproportionate amount of the code here exists to *refuse* to answer.

What makes this hard is not the arithmetic. It is that the data is an N-of-1
observational time series with every pathology at once:

* **Autocorrelation.** Children have good weeks and bad weeks, and habits come
  in runs. Under realistic AR(1) structure in both the outcome and the tag, a
  nominal 5% test fires roughly 18% of the time. The default null is therefore
  a circular shift of the tag vector, which preserves both run structures.
* **Multiplicity.** Twenty tags on a screen means twenty tests. Benjamini-
  Hochberg at a 10% false discovery rate, computed over every test *run*, not
  every test displayed.
* **Tiny samples.** At ten nights per group only effects large enough to be
  obvious without statistics are detectable, and the ones that do reach
  significance are biased upward — the winner's curse. Hence the hard minimum
  and the empirical-Bayes shrinkage that stops a tag with eleven nights
  automatically topping the list.
* **Confounding.** Dessert nights are also television nights are also weekend
  nights. Tags that co-occur are flagged rather than reported as independent.
* **Age drift.** Over six months an infant's sleep changes profoundly on its
  own. A tag whose nights all fall in one stretch of the record cannot be
  separated from that, and says so.
* **Reverse causality.** An extra nap may be a response to a bad night rather
  than a cause of the next one. Every factor gets a lag check: if the tag
  "predicts" the *previous* night just as well, that is not an effect.

None of the output is causal. The wording the API emits reflects that, and the
verdict vocabulary has no word for "causes".
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from ..models import Night, Tag, TagValueType
from . import stats

__all__ = [
    "DISCLAIMER",
    "EvidenceTier",
    "FactorAnalysis",
    "FactorResult",
    "analyse_factors",
]

#: Attached to every response. Deliberately plain.
DISCLAIMER = (
    "These are associations in your own data, not causes. They show what tended to "
    "happen on nights you logged something — many things change together, and a "
    "pattern here is a hint worth watching, not an explanation. This is not medical "
    "advice or a medical device."
)

#: Outcome metrics where a *lower* number is the better outcome, so that
#: "worse" and "better" verdicts come out the right way round.
LOWER_IS_BETTER = frozenset(
    {"waso_min", "sol_min", "awakenings", "cry_events", "cry_min", "noise_events",
     "motion_index", "restless_min"}
)

#: Outcome metrics with a comfortable band rather than a good end. A metric in
#: neither set defaults to "higher is better", which called a nursery two
#: degrees warmer on dessert nights a *better* outcome. There is no verdict to
#: give here — 15 °C and 27 °C are both wrong — so the difference is reported
#: and the direction left to the reader and ``environment.comfort``.
NO_BETTER_DIRECTION = frozenset({"temp_c_mean", "humidity_mean"})

#: Natural units for the headline difference, keyed by metric.
METRIC_UNITS: dict[str, str] = {
    "tst_min": "min", "tib_min": "min", "sol_min": "min", "waso_min": "min",
    "longest_bout_min": "min", "restless_min": "min", "cry_min": "min",
    "quality_score": "points", "sleep_efficiency": "", "awakenings": "",
    "cry_events": "", "noise_events": "", "motion_index": "",
    "temp_c_mean": "°C", "humidity_mean": "%",
}

#: Shared nights below which two tags co-occurring is a coincidence rather
#: than a confounder, and phi over them is noise.
MIN_CONFOUND_OVERLAP = 3

#: Share of a companion tag's nights that must fall inside this one before the
#: two are called inseparable, whatever phi says about it.
CONFOUND_SHARE = 0.75

#: Decimals to keep for each metric, in the API payload and in the sentence.
#:
#: One decimal is right for minutes and points, and destroys the two metrics
#: that live on 0..1. Sleep efficiency moving from 0.91 to 0.87 is four
#: percentage points — around forty minutes of a child's night — and rounded
#: to one decimal it prints as "0 less (95% CI -0 to -0)", which reads as no
#: effect at all rather than the largest one in the table.
METRIC_DECIMALS: dict[str, int] = {
    "sleep_efficiency": 3,
    "motion_index": 3,
}
DEFAULT_DECIMALS = 1


class EvidenceTier:
    """How much weight a result can carry, by sample size alone."""

    INSUFFICIENT = "insufficient"
    EXPLORATORY = "exploratory"
    SUGGESTIVE = "suggestive"
    NOTABLE = "notable"


@dataclass(slots=True)
class FactorResult:
    slug: str
    label: str
    category: str
    value_type: str

    n_with: int = 0
    n_without: int = 0
    n: int = 0

    mean_with: float | None = None
    mean_without: float | None = None
    median_with: float | None = None
    median_without: float | None = None
    diff: float | None = None
    diff_ci95: tuple[float | None, float | None] = (None, None)
    unit: str = ""

    effect_size: dict[str, Any] = field(default_factory=dict)
    cliffs_delta: dict[str, Any] = field(default_factory=dict)
    shrunk_effect: float | None = None

    #: Dose-response, computed only over the nights the tag was applied to.
    #: Reported alongside the group comparison, never in place of it.
    spearman_rho: float | None = None
    rho_ci95: tuple[float | None, float | None] = (None, None)
    slope_per_unit: float | None = None
    dose_response_p: float | None = None
    #: The null behind ``dose_response_p``, so it can be compared with the
    #: headline's ``test_method`` rather than assumed to match it.
    dose_response_method: str | None = None
    dose_response_n: int = 0

    p_value: float | None = None
    #: The null the p-value actually came from, which is not always the one
    #: that was asked for — see ``stats.permutation_test``.
    test_method: str | None = None
    #: The smallest p-value that null could have produced, where it is bounded
    #: away from zero by the tag's own regularity.
    p_floor: float | None = None
    q_value: float | None = None
    significant: bool = False
    tier: str = EvidenceTier.INSUFFICIENT
    verdict: str = "inconclusive"

    #: Decimals this metric needs to be legible. See METRIC_DECIMALS.
    decimals: int = DEFAULT_DECIMALS

    confounders: list[dict[str, Any]] = field(default_factory=list)
    caveats: list[str] = field(default_factory=list)
    reason: str | None = None
    nights_needed: int = 0
    span_fraction: float | None = None
    lag_check_p: float | None = None
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "label": self.label,
            "category": self.category,
            "value_type": self.value_type,
            "n": self.n,
            "n_with": self.n_with,
            "n_without": self.n_without,
            "mean_with": _round(self.mean_with, self.decimals),
            "mean_without": _round(self.mean_without, self.decimals),
            "median_with": _round(self.median_with, self.decimals),
            "median_without": _round(self.median_without, self.decimals),
            "diff": _round(self.diff, self.decimals),
            "diff_ci95": [
                _round(self.diff_ci95[0], self.decimals),
                _round(self.diff_ci95[1], self.decimals),
            ],
            "unit": self.unit,
            "decimals": self.decimals,
            "effect_size": self.effect_size,
            "cliffs_delta": self.cliffs_delta,
            "shrunk_effect": _round(self.shrunk_effect, 3),
            "spearman_rho": _round(self.spearman_rho, 3),
            "rho_ci95": [_round(self.rho_ci95[0], 3), _round(self.rho_ci95[1], 3)],
            "slope_per_unit": _round(self.slope_per_unit, 4),
            "dose_response_p": _round(self.dose_response_p, 5),
            "dose_response_method": self.dose_response_method,
            "dose_response_n": self.dose_response_n,
            "p_value": _round(self.p_value, 5),
            "test_method": self.test_method,
            "p_floor": _round(self.p_floor, 4),
            "q_value": _round(self.q_value, 5),
            "significant": self.significant,
            "tier": self.tier,
            "verdict": self.verdict,
            "confounders": self.confounders,
            "caveats": self.caveats,
            "reason": self.reason,
            "nights_needed": self.nights_needed,
            "span_fraction": _round(self.span_fraction, 2),
            "lag_check_p": _round(self.lag_check_p, 4),
            "summary": self.summary,
        }


@dataclass(slots=True)
class FactorAnalysis:
    metric: str
    metric_label: str
    window_days: int
    nights_total: int
    nights_analysable: int
    factors: list[FactorResult]
    insufficient: list[FactorResult]
    method: dict[str, Any]
    disclaimer: str = DISCLAIMER

    def to_dict(self) -> dict[str, Any]:
        return {
            "metric": self.metric,
            "metric_label": self.metric_label,
            "window_days": self.window_days,
            "nights_total": self.nights_total,
            "nights_analysable": self.nights_analysable,
            "tests_run": len(self.factors),
            "method": self.method,
            "factors": [f.to_dict() for f in self.factors],
            "insufficient": [f.to_dict() for f in self.insufficient],
            "disclaimer": self.disclaimer,
        }


METRIC_LABELS: dict[str, str] = {
    "quality_score": "sleep quality score",
    "tst_min": "total sleep",
    "tib_min": "time in bed",
    "sol_min": "time to fall asleep",
    "waso_min": "time awake during the night",
    "awakenings": "number of awakenings",
    "longest_bout_min": "longest unbroken stretch",
    "sleep_efficiency": "sleep efficiency",
    "cry_events": "crying episodes",
    "cry_min": "time crying",
    "restless_min": "restless time",
    "motion_index": "movement",
}


# ---------------------------------------------------------------------------


def analyse_factors(
    nights: list[Night],
    factor_matrix: dict[str, dict[str, float | None]],
    tags: dict[str, Tag],
    *,
    metric: str = "quality_score",
    min_per_group: int = 10,
    min_total: int = 20,
    permutations: int = 10000,
    bootstrap_iterations: int = 5000,
    fdr_q: float = 0.10,
    permutation_mode: str = "circular_shift",
    shrinkage: bool = True,
    confound_phi: float = 0.3,
    min_span_fraction: float = 0.4,
    window_days: int = 180,
    seed: int = 20260101,
) -> FactorAnalysis:
    """Compare each tag against a sleep outcome across a window of nights.

    ``nights`` should already be filtered to the window; only nights that are
    complete, not excluded and carry the metric take part.
    """
    method = {
        "test": f"permutation ({permutation_mode})",
        "iterations": permutations,
        "correction": "benjamini-hochberg",
        "fdr_q": fdr_q,
        "min_per_group": min_per_group,
        "shrinkage": shrinkage,
        "effect_size": "hedges_g",
    }

    usable = [n for n in nights if n.analysable and n.metric(metric) is not None]
    usable.sort(key=lambda n: n.night_of)
    ordered_keys = [n.night_of for n in usable]
    values = [n.metric(metric) or 0.0 for n in usable]

    if len(usable) < min_total:
        return FactorAnalysis(
            metric=metric,
            metric_label=METRIC_LABELS.get(metric, metric),
            window_days=window_days,
            nights_total=len(nights),
            nights_analysable=len(usable),
            factors=[],
            insufficient=[],
            method={
                **method,
                "blocked": (
                    f"{len(usable)} analysable nights in this window; "
                    f"{min_total} are needed before any comparison is meaningful"
                ),
            },
        )

    lower_better = metric in LOWER_IS_BETTER
    banded = metric in NO_BETTER_DIRECTION
    unit = METRIC_UNITS.get(metric, "")
    decimals = METRIC_DECIMALS.get(metric, DEFAULT_DECIMALS)
    span = len(ordered_keys)

    results: list[FactorResult] = []
    insufficient: list[FactorResult] = []
    presence: dict[str, list[bool]] = {}
    labels: dict[str, str] = {}

    all_slugs = sorted({slug for row in factor_matrix.values() for slug in row})

    for slug in all_slugs:
        tag = tags.get(slug)
        value_type = tag.value_type if tag else TagValueType.BOOL
        result = FactorResult(
            slug=slug,
            label=tag.label if tag else slug.replace("-", " ").capitalize(),
            category=str(tag.category) if tag else "other",
            value_type=str(value_type),
            unit=unit,
            decimals=decimals,
            n=len(usable),
        )

        applied = [factor_matrix.get(key, {}).get(slug) for key in ordered_keys]
        flags = [v is not None for v in applied]
        result.n_with = sum(flags)
        result.n_without = len(flags) - result.n_with
        presence[slug] = flags
        labels[slug] = result.label

        if value_type is TagValueType.TEXT:
            result.reason = "Free-text tags are shown for reference but cannot be compared."
            insufficient.append(result)
            continue

        if result.n_with < min_per_group or result.n_without < min_per_group:
            needed = max(min_per_group - result.n_with, min_per_group - result.n_without)
            result.nights_needed = max(0, needed)
            side = "with" if result.n_with < min_per_group else "without"
            result.reason = (
                f"{result.nights_needed} more night"
                f"{'s' if result.nights_needed != 1 else ''} {side} this tag before "
                "there is enough to compare."
            )
            insufficient.append(result)
            continue

        # Where in the record this tag's nights fall. A tag used only in one
        # month is indistinguishable from the child simply growing older.
        indices = [i for i, flag in enumerate(flags) if flag]
        if indices and span > 1:
            result.span_fraction = (max(indices) - min(indices) + 1) / span
            if result.span_fraction < min_span_fraction:
                result.caveats.append(
                    "All of these nights fall in one stretch of the record, so this "
                    "cannot be told apart from other things that changed over time."
                )

        group_with = [v for v, flag in zip(values, flags, strict=True) if flag]
        group_without = [v for v, flag in zip(values, flags, strict=True) if not flag]

        _compare_groups(
            result,
            group_with,
            group_without,
            values,
            flags,
            permutations=permutations,
            bootstrap_iterations=bootstrap_iterations,
            permutation_mode=permutation_mode,
            seed=seed,
        )

        if value_type.is_continuous:
            _correlate_continuous(
                result, applied, values,
                permutations=permutations,
                permutation_mode=permutation_mode,
                seed=seed,
            )

        # Reverse-causality check: does the tag line up with the night *before*
        # it as strongly as with its own? An extra nap logged after a bad night
        # would look like a cause when it was a response.
        #
        # Only worth running, and only worth warning about, when the main
        # comparison found something. Warning that a null result might also be
        # a null result for the wrong reason is noise.
        if len(values) > 2 and result.p_value is not None and result.p_value <= 0.10:
            lagged = _shift_to_previous_night(ordered_keys, flags)
            if min_per_group <= sum(lagged) <= len(lagged) - min_per_group:
                lag = stats.permutation_test(
                    values,
                    lagged,
                    lambda a, b: stats.mean(a) - stats.mean(b),
                    iterations=min(2000, permutations),
                    mode=permutation_mode,
                    seed=seed + 1,
                )
                result.lag_check_p = lag.p_value
                if lag.p_value <= max(0.05, result.p_value * 1.5):
                    result.caveats.append(
                        "This tag lines up with the previous night's sleep about as "
                        "strongly as with its own, which usually means something else "
                        "is driving both."
                    )

        results.append(result)

    _flag_confounders(results, presence, labels, confound_phi)
    _apply_multiplicity(results, fdr_q)
    if shrinkage:
        _apply_shrinkage(results)
    for result in results:
        _finalise(result, lower_better, min_per_group, banded=banded)

    # Rank by the shrunken effect where we have one, so that a noisy small
    # sample cannot buy its way to the top of the list.
    results.sort(
        key=lambda r: (
            not r.significant,
            -abs(r.shrunk_effect if r.shrunk_effect is not None else 0.0),
            r.q_value if r.q_value is not None else 1.0,
        )
    )
    insufficient.sort(key=lambda r: (r.nights_needed, r.label))

    method["tests_run"] = len(results)
    # What ran, not what was asked for. The circular-shift null is the reason
    # these results are not riddled with false positives from day-to-day
    # carryover, and it silently downgrades itself when a tag is too regular or
    # the record too short for rotation to mean anything. A reader told the
    # guardrail was on when it was off would trust the wrong numbers hardest.
    used = sorted({r.test_method for r in results if r.test_method})
    if used:
        method["test"] = " / ".join(m.replace("permutation:", "") for m in used)
        method["test"] = f"permutation ({method['test']})"
    if any(m == "permutation:shuffle" for m in used) and permutation_mode != "shuffle":
        method["downgraded"] = (
            "Some tags fell back to free shuffling because there were too few "
            "nights, or too regular a pattern, for rotation to provide a null. "
            "Those p-values do not account for one night's sleep resembling the "
            "next, and read as more certain than they are."
        )
    return FactorAnalysis(
        metric=metric,
        metric_label=METRIC_LABELS.get(metric, metric),
        window_days=window_days,
        nights_total=len(nights),
        nights_analysable=len(usable),
        factors=results,
        insufficient=insufficient,
        method=method,
    )


def _shift_to_previous_night(keys: list[str], flags: list[bool]) -> list[bool]:
    """Move each tag onto the night *before* it — by the calendar, not the list.

    Shifting the list by one position asks whether the tag lines up with the
    previous *analysable* night, which after a week of missing data is a night
    from a week earlier. That comparison means nothing, and it is the one that
    decides whether a real finding gets a reverse-causality warning attached.

    A tag whose preceding night is missing simply drops out of the lagged
    vector: it has nothing to be compared against.
    """
    from ..timeutil import shift_night

    position = {key: index for index, key in enumerate(keys)}
    lagged = [False] * len(keys)
    for index, key in enumerate(keys):
        if not flags[index]:
            continue
        previous = position.get(shift_night(key, -1))
        if previous is not None:
            lagged[previous] = True
    return lagged


def _compare_groups(
    result: FactorResult,
    group_with: list[float],
    group_without: list[float],
    values: list[float],
    flags: list[bool],
    *,
    permutations: int,
    bootstrap_iterations: int,
    permutation_mode: str,
    seed: int,
) -> None:
    result.mean_with = stats.mean(group_with)
    result.mean_without = stats.mean(group_without)
    result.median_with = stats.median(group_with)
    result.median_without = stats.median(group_without)
    result.diff = result.mean_with - result.mean_without

    g = stats.hedges_g(group_with, group_without)
    delta = stats.cliffs_delta_ci(group_with, group_without)
    result.effect_size = {
        "name": g.name,
        "value": _round(g.value, 3),
        "ci95": [_round(g.ci_low, 3), _round(g.ci_high, 3)],
        "se": _round(g.se, 4),
        "magnitude": g.magnitude,
    }
    result.cliffs_delta = {
        "value": _round(delta.value, 3),
        "ci95": [_round(delta.ci_low, 3), _round(delta.ci_high, 3)],
        "magnitude": delta.magnitude,
    }

    # The interval on the difference in natural units — that is the number
    # shown, so that is the number whose uncertainty the reader needs. Welch
    # rather than a bootstrap: see stats.mean_difference_ci for the measured
    # coverage of each, which is not what the textbook ordering suggests.
    low, high = stats.mean_difference_ci(group_with, group_without)
    if low is None:
        low, high = stats.bootstrap_ci(
            group_with,
            group_without,
            lambda a, b: stats.mean(a) - stats.mean(b),
            iterations=bootstrap_iterations,
            seed=seed,
        )
    result.diff_ci95 = (low, high)

    test = stats.permutation_test(
        values,
        flags,
        lambda a, b: stats.mean(a) - stats.mean(b),
        iterations=permutations,
        mode=permutation_mode,
        seed=seed,
    )
    result.p_value = test.p_value
    result.test_method = test.method
    floor = test.detail.get("resolution")
    if floor is not None:
        result.p_floor = floor
        if floor > 0.05:
            result.caveats.append(
                "This tag follows too regular a pattern for the test to resolve a "
                "small p-value: the best it could report for these nights is "
                f"{floor:.2f}, however large the real effect. Vary when it happens "
                "and the comparison becomes able to see it."
            )


def _correlate_continuous(
    result: FactorResult,
    applied: list[float | None],
    values: list[float],
    *,
    permutations: int,
    permutation_mode: str,
    seed: int,
) -> None:
    """Dose-response check for tags carrying a number (screen minutes, lights-off).

    This asks a different question from the group comparison above: not "were
    nights with screen time worse?" but "were nights with *more* screen time
    worse still?". It is computed only over the nights where the tag was
    applied, so it is a smaller sample answering a narrower question, and it
    deliberately does **not** replace the group-comparison p-value or enter the
    multiplicity correction — otherwise the headline verdict for a duration tag
    would be driven by a test on a fraction of the data.

    Spearman rather than Pearson: these relationships are rarely linear and one
    unusual night should not set the slope. Theil-Sen for the same reason.

    The p-value comes from the same rotation null as the headline, not from
    Spearman's asymptotic t. The two numbers sit on the same row of the same
    table, and one of them quietly assuming nights are independent — the very
    assumption the other exists to avoid — is how a reader ends up trusting
    the weaker of the two.
    """
    pairs = [(a, v) for a, v in zip(applied, values, strict=True) if a is not None]
    if len(pairs) < 8:
        return
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    if len({round(x, 6) for x in xs}) < 3:
        # Fewer than three distinct values is a boolean wearing a number's
        # clothes; a rank correlation over it says nothing.
        return
    rho, _ = stats.spearman(xs, ys)
    guarded = stats.paired_rotation_test(
        xs, ys,
        lambda a, b: stats.spearman(a, b)[0],
        iterations=min(2000, permutations),
        mode=permutation_mode,
        seed=seed + 2,
    )
    result.spearman_rho = rho
    result.dose_response_p = guarded.p_value
    result.dose_response_method = guarded.method
    result.dose_response_n = len(pairs)
    # Fisher z interval, which behaves better than a normal interval on rho.
    n = len(pairs)
    if n > 3 and abs(rho) < 1.0:
        z = 0.5 * math.log((1 + rho) / (1 - rho))
        se = 1.0 / math.sqrt(n - 3)
        lo, hi = z - stats.Z_95 * se, z + stats.Z_95 * se
        result.rho_ci95 = (math.tanh(lo), math.tanh(hi))
    slope, _ = stats.theil_sen(xs, ys)
    result.slope_per_unit = slope


def _flag_confounders(
    results: list[FactorResult],
    presence: dict[str, list[bool]],
    labels: dict[str, str],
    threshold: float,
) -> None:
    """Flag tags that keep company with each other.

    Every logged tag is considered as a possible companion, not only the ones
    with enough nights to be tested in their own right. The rare tag is exactly
    the dangerous one: four nights of teething that happen to be four of the
    twelve dessert nights will move the dessert result, and being too rare to
    test is not being too rare to confound — it only means nothing else will
    ever surface it.
    """
    for result in results:
        mine = presence.get(result.slug)
        if not mine:
            continue
        for slug, theirs in presence.items():
            if slug == result.slug or not theirs:
                continue
            overlap = sum(1 for a, b in zip(mine, theirs, strict=True) if a and b)
            if overlap < MIN_CONFOUND_OVERLAP:
                # One or two shared nights is a coincidence, and phi over a
                # handful of nights is noise. Say nothing rather than send the
                # reader chasing it.
                continue
            phi = stats.phi_coefficient(mine, theirs)
            # phi alone cannot see a rare tag nested inside a common one. Four
            # teething nights that are every one of them dessert nights score
            # phi = 0.26 against a 0.3 threshold — perfect nesting, invisible.
            # The ceiling is structural: phi is bounded by how lopsided the two
            # rates are, so no threshold fixes it. Concentration answers the
            # question phi cannot: what share of the companion's nights were
            # also mine, and is that more than the base rate would give?
            share = overlap / sum(theirs)
            base = sum(mine) / len(mine)
            concentrated = share >= max(CONFOUND_SHARE, 2.0 * base)
            if abs(phi) >= threshold or concentrated:
                result.confounders.append(
                    {
                        "slug": slug,
                        "label": labels.get(slug, slug),
                        "phi": _round(phi, 2),
                        "overlap_nights": overlap,
                        "share_of_theirs": _round(share, 2),
                    }
                )
        if result.confounders:
            names = ", ".join(c["label"] for c in result.confounders[:3])
            result.caveats.append(
                f"Usually happens on the same nights as {names}, so their effects "
                "cannot be separated."
            )


def _apply_multiplicity(results: list[FactorResult], fdr_q: float) -> None:
    tested = [r for r in results if r.p_value is not None]
    if not tested:
        return
    q_values, rejected = stats.benjamini_hochberg([r.p_value or 1.0 for r in tested], fdr_q)
    for result, q, reject in zip(tested, q_values, rejected, strict=True):
        result.q_value = q
        result.significant = reject


def _apply_shrinkage(results: list[FactorResult]) -> None:
    usable = [r for r in results if r.effect_size.get("se")]
    if len(usable) < 3:
        for result in results:
            result.shrunk_effect = result.effect_size.get("value")
        return
    shrunk = stats.shrink_effects(
        [float(r.effect_size["value"] or 0.0) for r in usable],
        [float(r.effect_size["se"] or 1.0) for r in usable],
    )
    for result, value in zip(usable, shrunk, strict=True):
        result.shrunk_effect = value
    for result in results:
        if result.shrunk_effect is None:
            result.shrunk_effect = result.effect_size.get("value")


def _finalise(
    result: FactorResult, lower_is_better: bool, min_per_group: int, *, banded: bool = False
) -> None:
    smaller_group = min(result.n_with, result.n_without)
    if smaller_group < min_per_group:
        result.tier = EvidenceTier.INSUFFICIENT
    elif smaller_group >= 50 and result.significant:
        result.tier = EvidenceTier.NOTABLE
    elif smaller_group >= 30:
        result.tier = EvidenceTier.SUGGESTIVE
    else:
        result.tier = EvidenceTier.EXPLORATORY

    low, high = result.diff_ci95
    crosses_zero = low is None or high is None or (low <= 0.0 <= high)

    if result.diff is None or crosses_zero or not result.significant:
        result.verdict = "inconclusive"
    elif banded:
        # A real difference, but not one this code is entitled to call good or
        # bad. "shifted" is the honest verdict for a banded metric.
        result.verdict = "shifted"
    else:
        improved = (result.diff < 0) if lower_is_better else (result.diff > 0)
        result.verdict = "better" if improved else "worse"

    result.summary = _summarise(result, crosses_zero)


def _summarise(result: FactorResult, crosses_zero: bool) -> str:
    """One plain sentence. No causal verbs — only what tended to happen."""
    if result.diff is None:
        return f"Not enough measured nights to compare {result.label.lower()}."
    magnitude = abs(result.diff)
    unit = f" {result.unit}".rstrip()
    direction = "more" if result.diff > 0 else "less"
    low, high = result.diff_ci95
    # Enough places for the metric, and never so few that a real difference
    # rounds away to nothing: a whole-number format on a 0..1 metric prints
    # every finding it has as "0 less (95% CI -0 to -0)", which reads as no
    # effect rather than the largest one in the table.
    places = result.decimals
    while magnitude > 0 and round(magnitude, places) == 0 and places < 6:
        places += 1
    interval = (
        f" (95% CI {low:+.{places}f} to {high:+.{places}f})"
        if low is not None and high is not None
        else ""
    )
    sentence = (
        f"On nights with {result.label.lower()}, the figure was "
        f"{magnitude:.{places}f}{unit} {direction}{interval}, across "
        f"{result.n_with} nights with and {result.n_without} without."
    )
    if crosses_zero:
        sentence += " That range includes no difference at all, so this could easily be chance."
    return sentence


def _round(value: float | None, digits: int = 1) -> float | None:
    if value is None or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return round(float(value), digits)
