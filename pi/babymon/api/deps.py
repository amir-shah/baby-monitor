"""What every request handler is allowed to reach for.

The whole web layer is parameterised by one object, :class:`AppContext`, which
is attached to ``app.state`` by :func:`babymon.api.app.create_app`. Handlers
never import a global database handle or a global config; they take the pieces
they need as dependencies. That is what lets the test suite stand up a complete
API against a temporary SQLite file and a :class:`~babymon.bus.NullRuntime`
without patching anything.

The child-resolution dependency deserves a note. Almost every endpoint is
scoped to a child, and almost every caller has exactly one, so ``child_id`` is
optional everywhere and falls back to the first active child. Getting this
wrong in the other direction — defaulting silently to child 1 when several
exist — would attribute one child's night to another, so the fallback is
"the only active child" and an explicit id is required once there are more.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import Depends, Header, Query, Request

from ..config import Config
from ..models import Child
from ..storage.repo import Repos
from ..timeutil import now_ms
from .errors import BadRequest, NotFound

if TYPE_CHECKING:  # pragma: no cover - import cycle only exists for type checkers
    from ..bus import Runtime
    from .auth import AuthManager

__all__ = [
    "AppContext",
    "get_ctx",
    "get_config",
    "get_repos",
    "get_runtime",
    "current_child",
    "child_or_default",
    "Pagination",
    "pagination",
    "ConfigDep",
    "ReposDep",
    "RuntimeDep",
    "ChildDep",
    "PageDep",
    "IdempotencyKey",
]

#: Nothing in this API returns an unbounded list; a night of samples is tens of
#: thousands of rows and a phone asking for all of them helps nobody.
MAX_LIMIT = 1000


@dataclass(slots=True)
class AppContext:
    """Everything the request handlers share, created once at startup."""

    config: Config
    repos: Repos
    runtime: "Runtime"
    auth: "AuthManager"
    started_ms: int = field(default_factory=now_ms)
    started_monotonic: float = field(default_factory=time.monotonic)

    @property
    def uptime_s(self) -> float:
        return time.monotonic() - self.started_monotonic


def get_ctx(request: Request) -> AppContext:
    ctx: AppContext | None = getattr(request.app.state, "ctx", None)
    if ctx is None:  # pragma: no cover - only reachable if create_app was bypassed
        raise RuntimeError("the application was not created by babymon.api.app.create_app")
    return ctx


def get_config(request: Request) -> Config:
    return get_ctx(request).config


def get_repos(request: Request) -> Repos:
    return get_ctx(request).repos


def get_runtime(request: Request) -> "Runtime":
    return get_ctx(request).runtime


def child_or_default(repos: Repos, child_id: int | None) -> Child:
    """Resolve the child a request is about, or explain why it cannot.

    Shared by the query-parameter dependency below and by the handlers whose
    ``child_id`` arrives in the request body instead.
    """
    if child_id is not None:
        child = repos.children.get(child_id)
        if child is None:
            raise NotFound(f"No child with id {child_id}.", detail={"child_id": child_id})
        return child

    active = repos.children.list()
    if not active:
        raise NotFound(
            "No children are configured yet.", code="no_children", detail={"child_id": None}
        )
    if len(active) > 1:
        raise BadRequest(
            "More than one child is configured, so child_id is required on this request.",
            code="child_id_required",
            detail={"children": [{"id": c.id, "name": c.name} for c in active]},
        )
    return active[0]


def current_child(
    request: Request,
    child_id: Annotated[int | None, Query(description="Defaults to the only active child.")] = None,
) -> Child:
    return child_or_default(get_repos(request), child_id)


@dataclass(slots=True)
class Pagination:
    limit: int
    offset: int

    def envelope(self, items: list[Any], total: int) -> dict[str, Any]:
        return {"items": items, "total": total, "limit": self.limit, "offset": self.offset}


def pagination(
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Pagination:
    return Pagination(limit=limit, offset=offset)


ConfigDep = Annotated[Config, Depends(get_config)]
ReposDep = Annotated[Repos, Depends(get_repos)]
RuntimeDep = Annotated["Runtime", Depends(get_runtime)]
ChildDep = Annotated[Child, Depends(current_child)]
PageDep = Annotated[Pagination, Depends(pagination)]

#: Declared on mutating endpoints so the header shows up in the OpenAPI schema.
#: The replay itself happens in the middleware in :mod:`babymon.api.app`, which
#: is the only place that can see a response before it is sent; handlers accept
#: the header and ignore it.
IdempotencyKey = Annotated[
    str | None,
    Header(
        alias="Idempotency-Key",
        description=(
            "Repeat this key to replay the first response instead of applying the "
            "change twice."
        ),
    ),
]
