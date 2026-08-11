"""The analytics surface: summary, trends, factors, regularity, patterns, export.

This router is deliberately thin. Every number it returns is computed in
:mod:`babymon.analytics.stats`, :mod:`babymon.analytics.correlate` or
:mod:`babymon.analytics.reports`, which are pure functions over rows and are
tested as such; the job here is to bound the query, hand the right window of
nights to the right function, and get out of the way.

The one piece of judgement that does live here is refusing to answer. The
factor engine already declines when a tag has too few nights either side, and
this layer keeps the config's minimums as the defaults rather than letting a
query string talk them down to something that would produce a confident-looking
result from eleven nights. ``min_n`` can be raised but not lowered below the
floor, and the disclaimer travels with every response.
"""

from __future__ import annotations

import json
import re
from typing import Annotated, Any

from fastapi import APIRouter, Query
from fastapi.responses import PlainTextResponse

from ...analytics import reports
from ...analytics.correlate import analyse_factors
from ...models import Tag
from ..deps import ChildDep, ConfigDep, ReposDep
from ..errors import BadRequest

router = APIRouter(prefix="/analytics", tags=["analytics"])

#: However small the config's minimum is set, a group of fewer than this many
#: nights cannot support a comparison anybody should read.
ABSOLUTE_MIN_PER_GROUP = 5
MAX_WINDOW_DAYS = 730


def _metric(name: str) -> str:
    if name not in reports.ANALYSABLE_METRICS:
        raise BadRequest(
            f"Unknown metric {name!r}.",
            code="unknown_metric",
            detail={"valid": list(reports.ANALYSABLE_METRICS)},
        )
    return name


DaysQuery = Annotated[int, Query(ge=1, le=MAX_WINDOW_DAYS)]
OptionalDaysQuery = Annotated[int | None, Query(ge=1, le=MAX_WINDOW_DAYS)]


@router.get("/summary")
def summary(child: ChildDep, repos: ReposDep, days: DaysQuery = 30) -> dict[str, Any]:
    """Headline metrics, the change against the previous window, and the target band."""
    return reports.summary(repos, child, days=days)


@router.get("/trends")
def trends(
    child: ChildDep,
    repos: ReposDep,
    metric: Annotated[str, Query()] = "tst_min",
    days: DaysQuery = 90,
    bucket: Annotated[str, Query(pattern="^(night|week)$")] = "night",
) -> dict[str, Any]:
    """A metric's series with a Theil-Sen trend and a rolling median."""
    return reports.trends(repos, child, metric=_metric(metric), days=days, bucket=bucket)


@router.get("/factors")
def factors(
    child: ChildDep,
    repos: ReposDep,
    config: ConfigDep,
    metric: Annotated[str | None, Query()] = None,
    days: OptionalDaysQuery = None,
    min_n: Annotated[int | None, Query(ge=ABSOLUTE_MIN_PER_GROUP)] = None,
) -> dict[str, Any]:
    """The correlation engine: every tag against one sleep outcome."""
    settings = config.analytics
    metric_name = _metric(metric or settings.default_metric)
    window_days = days or settings.default_window_days
    min_per_group = max(
        ABSOLUTE_MIN_PER_GROUP, min_n if min_n is not None else settings.min_nights_per_group
    )

    window = reports.resolve_window(child, window_days)
    nights = repos.nights.list(
        child.id, night_from=window.start, night_to=window.end, limit=1000
    )
    matrix = repos.notes.night_factor_matrix(child.id, [n.night_of for n in nights])
    tags: dict[str, Tag] = {t.slug: t for t in repos.tags.list(include_archived=True)}

    analysis = analyse_factors(
        nights,
        matrix,
        tags,
        metric=metric_name,
        min_per_group=min_per_group,
        min_total=settings.min_nights_total,
        permutations=settings.permutations,
        bootstrap_iterations=settings.bootstrap_iterations,
        fdr_q=settings.fdr_q,
        permutation_mode=settings.permutation_mode,
        shrinkage=settings.shrinkage,
        confound_phi=settings.confound_phi_threshold,
        min_span_fraction=settings.min_span_fraction,
        window_days=window_days,
        seed=settings.random_seed,
    )
    payload = analysis.to_dict()
    payload["child_id"] = child.id
    payload["from"] = window.start
    payload["to"] = window.end
    return payload


@router.get("/regularity")
def regularity(child: ChildDep, repos: ReposDep, days: DaysQuery = 30) -> dict[str, Any]:
    """Sleep Regularity Index, clock-time variability, and the actogram raster."""
    return reports.regularity(repos, child, days=days)


@router.get("/patterns")
def patterns(
    child: ChildDep,
    repos: ReposDep,
    days: DaysQuery = 90,
    metric: Annotated[str, Query()] = "quality_score",
) -> dict[str, Any]:
    """Awakening clock times, day-of-week effects, and environment against outcome."""
    return reports.patterns(repos, child, days=days, metric=_metric(metric))


@router.get("/export")
def export(
    child: ChildDep,
    repos: ReposDep,
    config: ConfigDep,
    days: OptionalDaysQuery = None,
    format: Annotated[str, Query(pattern="^(csv|json)$")] = "json",
) -> Any:
    """The full per-night factor matrix, so anyone can check the arithmetic."""
    window_days = days or config.analytics.default_window_days
    if format == "json":
        return json.loads(reports.export_matrix(repos, child, days=window_days, fmt="json"))

    body = reports.export_matrix(repos, child, days=window_days, fmt="csv")
    safe_name = re.sub(r"[^a-z0-9]+", "-", child.name.lower()).strip("-") or "child"
    filename = f"babymon-{safe_name}-{window_days}d.csv"
    return PlainTextResponse(
        body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
