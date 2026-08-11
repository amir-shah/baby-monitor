"""One error shape for every failing request.

A dashboard that has to guess whether a failure arrives as FastAPI's
``{"detail": ...}``, as a bare string, or as an HTML traceback ends up with
error handling in every call site. So everything — raised application errors,
request validation, unhandled exceptions — is funnelled into::

    {"error": {"code": "...", "message": "...", "detail": {...}}}

``code`` is a stable machine-readable token clients may branch on; ``message``
is one sentence a parent could read; ``detail`` carries whatever structured
extras are useful and is never required to be present.

The split between :class:`ApiError` subclasses mirrors the rule the rest of
the codebase follows: something that would corrupt or misreport data raises,
something that merely degrades a feature is reported as unavailable rather
than pretended away.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger(__name__)

__all__ = [
    "ApiError",
    "BadRequest",
    "AuthRequired",
    "Forbidden",
    "NotFound",
    "Conflict",
    "RateLimited",
    "Unavailable",
    "error_body",
    "install_exception_handlers",
]


class ApiError(Exception):
    """An error the API deliberately produces, with a client-facing shape."""

    status_code: int = 500
    code: str = "internal_error"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        detail: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        self.detail = detail or {}
        self.headers = headers or {}

    def body(self) -> dict[str, Any]:
        return error_body(self.code, self.message, self.detail)


class BadRequest(ApiError):
    status_code = 400
    code = "bad_request"


class AuthRequired(ApiError):
    status_code = 401
    code = "auth_required"


class Forbidden(ApiError):
    status_code = 403
    code = "forbidden"


class NotFound(ApiError):
    status_code = 404
    code = "not_found"


class Conflict(ApiError):
    status_code = 409
    code = "conflict"


class RateLimited(ApiError):
    status_code = 429
    code = "rate_limited"


class Unavailable(ApiError):
    """A subsystem the request needed is not running.

    Distinct from an error: the camera being absent is a normal state for a
    monitor running without sensors, and the caller should be able to tell that
    apart from a genuine failure.
    """

    status_code = 503
    code = "unavailable"


def error_body(code: str, message: str, detail: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "detail": detail or {}}}


#: Mapping used when Starlette itself raises (404 on an unrouted path, 405 on a
#: wrong method), so those come back in the same envelope as everything else.
_STATUS_CODES = {
    400: "bad_request",
    401: "auth_required",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    416: "range_not_satisfiable",
    422: "validation_error",
    429: "rate_limited",
    500: "internal_error",
    503: "unavailable",
}


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(exc.body(), status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            error_body(
                "validation_error",
                "The request did not match the expected shape.",
                {"errors": _clean_validation_errors(exc.errors())},
            ),
            status_code=422,
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "error")
        message = exc.detail if isinstance(exc.detail, str) else code.replace("_", " ")
        detail = {} if isinstance(exc.detail, str) else {"detail": exc.detail}
        return JSONResponse(
            error_body(code, message, detail),
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        # The traceback goes to the log, never to the client: this API is
        # reachable from the whole LAN and a traceback names paths and versions.
        log.exception("unhandled error serving %s %s", request.method, request.url.path)
        return JSONResponse(
            error_body(
                "internal_error",
                "Something went wrong handling this request. The details are in the "
                "service log.",
            ),
            status_code=500,
        )


def _clean_validation_errors(errors: list[Any]) -> list[dict[str, Any]]:
    """Strip the parts of Pydantic's error list that do not survive JSON."""
    out: list[dict[str, Any]] = []
    for err in errors:
        if not isinstance(err, dict):
            continue
        out.append(
            {
                "loc": [str(part) for part in err.get("loc", ())],
                "type": str(err.get("type", "")),
                "msg": str(err.get("msg", "")),
            }
        )
    return out
