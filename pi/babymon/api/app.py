"""Assembling the ASGI application.

``create_app(config, repos, runtime)`` is the only entry point. It takes its
three collaborators as arguments rather than building them, which is what lets
the service, the ``--no-sensors`` development mode and the test suite all stand
up the same application over different backings.

Four things happen here that are not "include a router":

* **The bus is bound to the running loop.** Producers publish from ordinary
  threads — the audio callback, the camera reader, a GPIO poll — and
  :meth:`EventBus.publish` needs a loop to hand messages to. Binding it in the
  lifespan is what turns those thread-side publishes into SSE frames, and
  publishing before it is bound is a silent no-op by design.
* **``Idempotency-Key`` is honoured.** The contract promises it on every
  mutating endpoint, and a middleware is the only layer that can see a response
  before it is sent. A repeated key replays the first response instead of
  applying the change twice, which matters most for the HomeKit endpoints: a
  bridge that reconnects mid-write will re-send it.
* **The dashboard is served with an SPA fallback**, so a refresh on
  ``/nights/2026-08-10`` loads the app rather than 404ing — without the
  fallback swallowing unknown ``/api`` paths, which must still fail loudly.
* **Errors leave in one shape.** See :mod:`babymon.api.errors`.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..bus import Runtime
from ..config import Config
from ..storage.repo import Repos
from . import auth as auth_module
from .auth import AuthManager
from .deps import AppContext
from .errors import NotFound, install_exception_handlers
from .routers import (
    analytics,
    children,
    events,
    homekit,
    media,
    nights,
    notes,
    state,
    system,
)

log = logging.getLogger(__name__)

__all__ = ["create_app"]

API_PREFIX = "/api"
_MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})

#: (idempotency key, method, path) and the raw header list of a stored response.
_Key = tuple[str, str, str]
_Headers = list[tuple[bytes, bytes]]

DESCRIPTION = """
The HTTP contract for babymon. The Python service is the only component that
touches the database; the dashboard and the HomeKit bridge are both clients of
this API.

Timestamps are integer Unix epoch **milliseconds, UTC**, on fields suffixed
`_ms`. `night_of` is the local calendar date, `YYYY-MM-DD`, on which a night
began. Durations are minutes (`_min`) or seconds (`_s`). List endpoints return
`{"items": [], "total": N, "limit": L, "offset": O}`; errors return
`{"error": {"code", "message", "detail"}}`.
""".strip()


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


class IdempotencyCache:
    """Replay store for ``Idempotency-Key``, bounded in both size and age.

    In-memory on purpose. The keys are worth remembering for as long as a
    client might reasonably retry — minutes — and a restart losing them means
    at worst that one retry is applied twice, which is the behaviour of not
    having the header at all.
    """

    def __init__(self, *, ttl_s: float = 600.0, max_entries: int = 512) -> None:
        self._ttl = ttl_s
        self._max = max_entries
        self._entries: dict[_Key, tuple[float, int, bytes, _Headers]] = {}

    def get(self, key: _Key) -> tuple[int, bytes, _Headers] | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        stored_at, status, body, headers = entry
        if time.monotonic() - stored_at > self._ttl:
            self._entries.pop(key, None)
            return None
        return status, body, headers

    def put(self, key: _Key, status: int, body: bytes, headers: _Headers) -> None:
        if len(self._entries) >= self._max:
            self._evict()
        self._entries[key] = (time.monotonic(), status, body, headers)

    def _evict(self) -> None:
        now = time.monotonic()
        for key, (stored_at, *_rest) in list(self._entries.items()):
            if now - stored_at > self._ttl:
                del self._entries[key]
        while len(self._entries) >= self._max:
            self._entries.pop(next(iter(self._entries)))


# ---------------------------------------------------------------------------


def create_app(config: Config, repos: Repos, runtime: Runtime) -> FastAPI:
    """Build the ASGI application over an already-open database and runtime."""
    auth = AuthManager(config.api.auth)
    ctx = AppContext(config=config, repos=repos, runtime=runtime, auth=auth)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Until the bus knows the loop, every publish from a sensing thread is
        # dropped — correctly, since nothing can be listening before startup.
        runtime.bus.bind_loop(asyncio.get_running_loop())
        log.info("babymon API %s ready (auth %s)", __version__,
                 "on" if auth.enabled else "OFF")
        try:
            yield
        finally:
            log.info("babymon API shutting down")

    app = FastAPI(
        title="babymon",
        version=__version__,
        description=DESCRIPTION,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.ctx = ctx
    app.state.idempotency = IdempotencyCache()

    install_exception_handlers(app)
    _install_cors(app, config)
    _install_idempotency(app)
    _install_routers(app)
    _install_static(app, config)
    return app


def _install_cors(app: FastAPI, config: Config) -> None:
    origins = list(config.api.cors_origins or [])
    if not origins:
        return
    # Credentials are allowed because the dashboard authenticates with a
    # cookie; that is also why the origin list is explicit and "*" is not
    # special-cased into it — a wildcard with credentials is both refused by
    # browsers and the wrong thing to want.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
        expose_headers=["Content-Range", "Accept-Ranges", "Idempotent-Replay"],
        max_age=600,
    )


def _install_idempotency(app: FastAPI) -> None:
    @app.middleware("http")
    async def idempotency(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        key = request.headers.get("idempotency-key")
        if not key or request.method not in _MUTATING:
            return await call_next(request)

        cache: IdempotencyCache = request.app.state.idempotency
        entry = (key, request.method, request.url.path)
        replay = cache.get(entry)
        if replay is not None:
            status, body, headers = replay
            response = Response(content=body, status_code=status)
            response.raw_headers = [*headers, (b"idempotent-replay", b"true")]
            return response

        response = await call_next(request)
        # Streaming bodies are not replayable and never come from a mutation;
        # a 5xx is not cached because the retry is the whole point of retrying.
        if response.status_code >= 500 or not hasattr(response, "body_iterator"):
            return response
        body = b"".join([chunk async for chunk in response.body_iterator])
        cache.put(entry, response.status_code, body, list(response.raw_headers))
        buffered = Response(content=body, status_code=response.status_code)
        buffered.raw_headers = list(response.raw_headers)
        return buffered


def _install_routers(app: FastAPI) -> None:
    from fastapi import Depends

    from .auth import require_auth

    protected = [Depends(require_auth)]
    app.include_router(auth_module.router, prefix=API_PREFIX)
    # system.py guards its own routes: /api/health is never authenticated.
    app.include_router(system.router, prefix=API_PREFIX)
    app.include_router(children.router, prefix=API_PREFIX, dependencies=protected)
    # state.py and media.py also guard their own, because the snapshot, MJPEG
    # and stored-media routes additionally accept a ?t= media token.
    app.include_router(state.router, prefix=API_PREFIX)
    app.include_router(media.router, prefix=API_PREFIX)
    app.include_router(events.router, prefix=API_PREFIX, dependencies=protected)
    app.include_router(notes.router, prefix=API_PREFIX, dependencies=protected)
    app.include_router(nights.router, prefix=API_PREFIX, dependencies=protected)
    app.include_router(analytics.router, prefix=API_PREFIX, dependencies=protected)
    app.include_router(homekit.router, prefix=API_PREFIX, dependencies=protected)


def _install_static(app: FastAPI, config: Config) -> None:
    """Serve the built dashboard, with a client-side-routing fallback.

    Absent a build the API still works; the dashboard is developed against a
    Vite dev server on another port, which is what ``api.cors_origins`` is for.
    """
    raw = config.paths.static_dir
    if not raw:
        return
    root = Path(raw).expanduser()
    if not root.is_dir():
        log.warning("paths.static_dir %s does not exist; the dashboard will not be served", root)
        return
    root = root.resolve()

    # Hashed build assets get their own mount so they can be cached hard,
    # unlike index.html which must never be.
    for sub in ("assets", "static"):
        if (root / sub).is_dir():
            app.mount(f"/{sub}", StaticFiles(directory=root / sub), name=sub)

    index = root / "index.html"

    @app.get("/", include_in_schema=False)
    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str = "") -> Any:
        # Registered last, so a real route always wins. The guard is for
        # *unknown* /api paths, which must 404 rather than be handed the
        # dashboard's HTML — a client parsing that as JSON gets a baffling error.
        if full_path.startswith("api/") or full_path == "api":
            raise NotFound("No such endpoint.", detail={"path": f"/{full_path}"})
        if full_path:
            candidate = (root / full_path).resolve()
            if candidate.is_relative_to(root) and candidate.is_file():
                return FileResponse(candidate)
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        raise NotFound("The dashboard has not been built.", code="dashboard_missing")
