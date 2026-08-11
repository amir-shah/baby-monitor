"""Authentication for a device that lives on a home LAN.

Three ways in, deliberately, because three different kinds of client need to
reach the same data:

1. **A session cookie** for the dashboard. ``POST /api/auth/login`` with the
   password sets an HttpOnly, SameSite=Lax cookie signed with itsdangerous.
   HttpOnly so a stray script cannot read it, SameSite=Lax so another site
   cannot make the browser use it, and signed-with-expiry rather than stored
   server-side so a restart does not log the household out.
2. **A bearer token** for the HomeKit bridge and for scripting, compared
   against ``api.auth.tokens``.
3. **A short-lived signed query token** (``?t=``) for the media, snapshot and
   MJPEG routes *only*. An ``<img src>`` or ``<audio src>`` cannot send an
   ``Authorization`` header and does not always send cookies, and the
   alternative — leaving the camera preview unauthenticated — is a nursery
   camera open to the whole network. The token is scoped to those routes, is
   minted only for an already-authenticated caller, and expires after
   ``api.auth.media_token_ttl_s``.

Every secret comparison goes through :func:`hmac.compare_digest`. ``==`` on
strings returns as soon as it finds a differing byte, and over a LAN that
timing difference is measurable; a six-character password is not something to
hand an attacker a byte at a time.

Failed logins are throttled per client IP with an exponential backoff. Without
it a four-digit-ish household password falls to a laptop on the same wifi in
seconds. The throttle is in-memory and per-process, which is the right size for
a single Pi serving a single household.
"""

from __future__ import annotations

import hmac
import logging
import threading
import time
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, Field

from ..config import AuthConfig
from .deps import get_ctx
from .errors import AuthRequired, RateLimited

log = logging.getLogger(__name__)

__all__ = [
    "SESSION_COOKIE",
    "AuthManager",
    "Principal",
    "require_auth",
    "require_media_access",
    "router",
]

SESSION_COOKIE = "babymon_session"

_SESSION_SALT = "babymon.session.v1"
#: Settings key holding the instant before which every session is void.
_SIGNOUT_KEY = "auth.signed_out_before"
_MEDIA_SALT = "babymon.media.v1"

#: Attempts allowed before the backoff starts biting. Three covers a genuine
#: typo or two without making the household wait.
_FREE_ATTEMPTS = 3
_MAX_BACKOFF_S = 300.0
#: How long a failure is remembered after the fact. Longer than any penalty,
#: because the count has to survive the free attempts for backoff to begin.
_RETENTION_S = 900.0
#: Distinct addresses tracked before the least recently active are evicted.
_THROTTLE_CAPACITY = 512


@dataclass(slots=True)
class Principal:
    """Who is making a request, as far as the API can tell."""

    kind: str  # "session" | "token" | "media" | "anonymous"
    authenticated: bool = True
    label: str = ""

    @property
    def is_anonymous(self) -> bool:
        return self.kind == "anonymous"


ANONYMOUS = Principal(kind="anonymous", authenticated=True, label="auth disabled")


class LoginThrottle:
    """Per-IP exponential backoff on failed logins.

    Counts failures rather than requests, so the dashboard polling ``/me`` with
    a valid cookie is never affected.

    An entry outlives its penalty. The first few failures are free and carry no
    penalty at all, so expiring entries the moment they stop being blocked
    discards exactly the counts the backoff is built from — and because the
    sweep ran whenever the table grew past its cap, an attacker spread across
    enough addresses could trigger it on every attempt and reset every
    accumulating count in the table, including their own. The state is instead
    kept for ``retention_s`` after the last failure, which is what makes
    repeated attempts add up.

    The table is still bounded. When it is over the cap after sweeping, the
    least recently active entries are evicted first, so a live attacker's
    record is the last thing to go rather than the first.
    """

    def __init__(
        self,
        *,
        free_attempts: int = _FREE_ATTEMPTS,
        max_backoff_s: float = _MAX_BACKOFF_S,
        retention_s: float = _RETENTION_S,
        capacity: int = _THROTTLE_CAPACITY,
    ) -> None:
        self._free = free_attempts
        self._max = max_backoff_s
        self._retention = retention_s
        self._capacity = capacity
        self._lock = threading.Lock()
        #: ip -> (failures, blocked_until, expires_at), all monotonic seconds.
        self._state: dict[str, tuple[int, float, float]] = {}

    def retry_after_s(self, ip: str) -> float:
        """Seconds the caller must wait, or 0.0 if they may try now."""
        with self._lock:
            entry = self._state.get(ip)
            if entry is None:
                return 0.0
            _, blocked_until, _ = entry
            return max(0.0, blocked_until - time.monotonic())

    def record_failure(self, ip: str) -> float:
        with self._lock:
            now = time.monotonic()
            failures, _, expires_at = self._state.get(ip, (0, 0.0, 0.0))
            if expires_at and expires_at <= now:
                failures = 0  # the last attempt was long enough ago to forget
            failures += 1
            penalty = 0.0
            if failures > self._free:
                penalty = min(self._max, 2.0 ** (failures - self._free))
            self._state[ip] = (
                failures,
                now + penalty,
                now + max(self._retention, penalty),
            )
            if len(self._state) > self._capacity:
                self._sweep(now)
            return penalty

    def record_success(self, ip: str) -> None:
        with self._lock:
            self._state.pop(ip, None)

    def _sweep(self, now: float) -> None:
        for key, (_, _, expires_at) in list(self._state.items()):
            if expires_at <= now:
                del self._state[key]
        if len(self._state) <= self._capacity:
            return
        # Still over. Drop the fewest failures first, oldest breaking the tie.
        # An entry with one failure is nearly worthless and an entry with eight
        # is the whole point of the table, so evicting by recency alone would
        # let a flood of single attempts from fresh addresses push out the one
        # record that was about to lock somebody out.
        ordered = sorted(self._state.items(), key=lambda item: (item[1][0], item[1][2]))
        for key, _ in ordered[: len(self._state) - self._capacity]:
            del self._state[key]


class AuthManager:
    """Signs and checks the three credentials, and holds the login throttle."""

    def __init__(self, config: AuthConfig, settings: Any = None) -> None:
        self.config = config
        secret = config.secret or "babymon-unconfigured-secret"
        self._sessions = URLSafeTimedSerializer(secret, salt=_SESSION_SALT)
        self._media = URLSafeTimedSerializer(secret, salt=_MEDIA_SALT)
        self.throttle = LoginThrottle()
        #: Where the sign-out watermark is kept. Without it, logout deletes the
        #: browser's copy of the cookie and nothing else, so a cookie captured
        #: beforehand — off a shared machine, out of a proxy log — keeps working
        #: for the full session_days. Optional so tests and tools can build an
        #: AuthManager without a database; logout then degrades to
        #: cookie-clearing and says so.
        self._settings = settings

    # -- configuration -----------------------------------------------------

    @property
    def enabled(self) -> bool:
        return bool(self.config.enabled)

    @property
    def session_max_age_s(self) -> int:
        return max(1, int(self.config.session_days)) * 86400

    @property
    def media_ttl_s(self) -> int:
        return max(1, int(self.config.media_token_ttl_s))

    # -- credentials -------------------------------------------------------

    def check_password(self, candidate: str) -> bool:
        expected = self.config.password or ""
        if not expected:
            return False
        return hmac.compare_digest(candidate.encode("utf-8"), expected.encode("utf-8"))

    def check_bearer(self, candidate: str) -> bool:
        # Every configured token is compared even after a match, so the time
        # taken does not reveal which token (or how many) exist.
        matched = False
        for token in self.config.tokens:
            if token and hmac.compare_digest(candidate.encode("utf-8"), token.encode("utf-8")):
                matched = True
        return matched

    # -- session cookie ----------------------------------------------------

    def issue_session(self) -> str:
        return self._sessions.dumps({"v": 1})

    def verify_session(self, token: str) -> bool:
        try:
            _, issued_at = self._sessions.loads(
                token, max_age=self.session_max_age_s, return_timestamp=True
            )
        except (BadSignature, SignatureExpired):
            return False
        cutoff = self._signed_out_before()
        return not (cutoff and issued_at.timestamp() < cutoff)

    def _signed_out_before(self) -> float:
        if self._settings is None:
            return 0.0
        try:
            return float(self._settings.get(_SIGNOUT_KEY) or 0.0)
        except (TypeError, ValueError):
            return 0.0

    def sign_out_everywhere(self) -> bool:
        """Invalidate every session issued up to now.

        The token is a signed timestamp with nothing in it to revoke
        individually, so signing out is a watermark rather than a denylist:
        one row, no growth, and it survives a restart — which an in-memory set
        would not, quietly resurrecting the cookie the user just revoked.

        Logging out of one browser therefore logs out of all of them. On a
        household dashboard that is the safer reading of the button anyway.
        """
        if self._settings is None:
            return False
        # Truncated to the second, and compared with a strict <, because
        # itsdangerous stamps whole seconds. Rounding up instead would also
        # void a token minted in the same second *after* the sign-out — which
        # is the user logging straight back in, and their new session would be
        # dead on arrival. Nothing is lost: the only token that can survive
        # this is one minted in the same second, and an attacker holding a
        # captured cookie cannot mint anything at all.
        self._settings.set(_SIGNOUT_KEY, float(int(time.time())))
        return True

    def set_session_cookie(self, response: Response, token: str) -> None:
        response.set_cookie(
            SESSION_COOKIE,
            token,
            max_age=self.session_max_age_s,
            httponly=True,
            samesite="lax",
            path="/",
        )

    def clear_session_cookie(self, response: Response) -> None:
        response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax")

    # -- media query tokens ------------------------------------------------

    def mint_media_token(self, scope: str = "media") -> str:
        """A short-lived token for URLs that cannot carry a header."""
        return self._media.dumps({"s": scope})

    def verify_media_token(self, token: str, scope: str = "media") -> bool:
        try:
            payload = self._media.loads(token, max_age=self.media_ttl_s)
        except (BadSignature, SignatureExpired):
            return False
        return isinstance(payload, dict) and payload.get("s") == scope


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------


def _client_ip(request: Request) -> str:
    # No X-Forwarded-For handling: this service is meant to be reached directly
    # on the LAN, and trusting that header from an untrusted client would let
    # anyone reset someone else's throttle by spoofing an address.
    return request.client.host if request.client else "unknown"


def _principal_from_request(request: Request) -> Principal | None:
    """Session cookie or bearer token, or None if neither is valid."""
    auth = get_ctx(request).auth
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        if auth.check_bearer(header[7:].strip()):
            return Principal(kind="token", label="bearer token")
        return None
    cookie = request.cookies.get(SESSION_COOKIE)
    if cookie and auth.verify_session(cookie):
        return Principal(kind="session", label="dashboard session")
    return None


def require_auth(request: Request) -> Principal:
    """Reject anything without a valid session cookie or bearer token."""
    auth = get_ctx(request).auth
    if not auth.enabled:
        return ANONYMOUS
    principal = _principal_from_request(request)
    if principal is None:
        raise AuthRequired(
            "Sign in, or send a bearer token from api.auth.tokens.",
            headers={"WWW-Authenticate": 'Bearer realm="babymon"'},
        )
    return principal


def require_media_access(
    request: Request,
    t: Annotated[str | None, Query(description="Short-lived signed media token.")] = None,
) -> Principal:
    """As :func:`require_auth`, but also accepts a ``?t=`` media token.

    Only mounted on the snapshot, MJPEG and stored-media routes. Everything
    else keeps the header/cookie requirement, so a leaked preview URL cannot be
    turned into a read of the event log.
    """
    auth = get_ctx(request).auth
    if not auth.enabled:
        return ANONYMOUS
    principal = _principal_from_request(request)
    if principal is not None:
        return principal
    if t and auth.verify_media_token(t):
        return Principal(kind="media", label="media token")
    raise AuthRequired(
        "This resource needs a session, a bearer token, or a ?t= media token.",
        headers={"WWW-Authenticate": 'Bearer realm="babymon"'},
    )


AuthDep = Annotated[Principal, Depends(require_auth)]
MediaAuthDep = Annotated[Principal, Depends(require_media_access)]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    password: str = Field(min_length=1, max_length=512)


class SessionInfo(BaseModel):
    authenticated: bool
    auth_required: bool
    principal: str
    #: Minted for an authenticated caller so ``<img>``/``<audio>`` tags work.
    media_token: str | None = None
    media_token_ttl_s: int | None = None


router = APIRouter(prefix="/auth", tags=["auth"])


def _session_info(request: Request, principal: Principal) -> SessionInfo:
    auth = get_ctx(request).auth
    return SessionInfo(
        authenticated=True,
        auth_required=auth.enabled,
        principal=principal.kind,
        media_token=auth.mint_media_token() if auth.enabled else None,
        media_token_ttl_s=auth.media_ttl_s if auth.enabled else None,
    )


@router.post("/login", response_model=SessionInfo)
def login(request: Request, response: Response, payload: LoginRequest) -> SessionInfo:
    auth = get_ctx(request).auth
    if not auth.enabled:
        return _session_info(request, ANONYMOUS)

    ip = _client_ip(request)
    wait = auth.throttle.retry_after_s(ip)
    if wait > 0:
        raise RateLimited(
            f"Too many failed sign-ins. Try again in {wait:.0f} seconds.",
            detail={"retry_after_s": round(wait, 1)},
            headers={"Retry-After": str(max(1, int(wait)))},
        )

    if not auth.check_password(payload.password):
        penalty = auth.throttle.record_failure(ip)
        log.warning("failed login from %s (next attempt in %.0fs)", ip, penalty)
        raise AuthRequired("That password is not right.", code="bad_credentials")

    auth.throttle.record_success(ip)
    principal = Principal(kind="session", label="dashboard session")
    auth.set_session_cookie(response, auth.issue_session())
    return _session_info(request, principal)


@router.post("/logout")
def logout(request: Request, response: Response) -> dict[str, Any]:
    auth = get_ctx(request).auth
    auth.clear_session_cookie(response)
    revoked = auth.sign_out_everywhere()
    return {"ok": True, "revoked_existing_sessions": revoked}


@router.get("/me", response_model=SessionInfo)
def me(request: Request, principal: AuthDep) -> SessionInfo:
    return _session_info(request, principal)


@router.get("/media-token", response_model=SessionInfo)
def media_token(request: Request, principal: AuthDep) -> SessionInfo:
    """Mint a fresh media token; the dashboard refreshes one before it expires."""
    return _session_info(request, principal)
