"""Authentication: off, on, cookies, bearer tokens, media tokens, throttling."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from itsdangerous.timed import TimestampSigner

from babymon.api.auth import SESSION_COOKIE, AuthManager, LoginThrottle
from babymon.config import AuthConfig

from .test_api_common import build

PASSWORD = "correct-horse-battery"
TOKEN = "bridge-token-0123456789"


def test_auth_disabled_lets_everything_through(tmp_path: Path) -> None:
    harness = build(tmp_path, auth=False)
    with harness.client() as client:
        assert client.get("/api/state").status_code == 200
        assert client.get("/api/events").status_code == 200
        assert client.get("/api/config").status_code == 200
        me = client.get("/api/auth/me").json()
    assert me["auth_required"] is False
    assert me["authenticated"] is True


def test_auth_enabled_rejects_anonymous_but_never_health(tmp_path: Path) -> None:
    harness = build(tmp_path, auth=True, password=PASSWORD, tokens=(TOKEN,))
    with harness.client() as client:
        assert client.get("/api/health").status_code == 200
        for path in ("/api/state", "/api/events", "/api/notes", "/api/tags",
                     "/api/nights", "/api/media", "/api/config", "/api/metrics",
                     "/api/analytics/summary", "/api/homekit/state"):
            response = client.get(path)
            assert response.status_code == 401, path
            assert response.json()["error"]["code"] == "auth_required"


def test_login_sets_a_session_cookie_that_works(tmp_path: Path) -> None:
    harness = build(tmp_path, auth=True, password=PASSWORD)
    with harness.client() as client:
        bad = client.post("/api/auth/login", json={"password": "wrong"})
        assert bad.status_code == 401
        assert bad.json()["error"]["code"] == "bad_credentials"

        good = client.post("/api/auth/login", json={"password": PASSWORD})
        assert good.status_code == 200
        cookie = good.cookies.get(SESSION_COOKIE)
        assert cookie
        set_cookie = good.headers["set-cookie"].lower()
        assert "httponly" in set_cookie
        assert "samesite=lax" in set_cookie

        assert client.get("/api/state").status_code == 200
        assert client.post("/api/auth/logout").status_code == 200
        client.cookies.clear()
        assert client.get("/api/state").status_code == 401


def test_bearer_token_is_accepted_and_a_wrong_one_is_not(tmp_path: Path) -> None:
    harness = build(tmp_path, auth=True, password=PASSWORD, tokens=(TOKEN,))
    with harness.client() as client:
        ok = client.get("/api/state", headers={"Authorization": f"Bearer {TOKEN}"})
        assert ok.status_code == 200
        # A prefix of a valid token must not be accepted: compare_digest, not
        # a length-insensitive comparison.
        for candidate in (TOKEN[:-1], TOKEN + "x", "", "  "):
            response = client.get("/api/state", headers={"Authorization": f"Bearer {candidate}"})
            assert response.status_code == 401, candidate


def test_media_token_works_only_on_media_routes(tmp_path: Path) -> None:
    harness = build(tmp_path, auth=True, password=PASSWORD, tokens=(TOKEN,))
    night = "2026-08-10"
    media_id = harness.add_media(night, rel_path="clips/one.ogg")
    with harness.client() as client:
        token = client.get(
            "/api/auth/media-token", headers={"Authorization": f"Bearer {TOKEN}"}
        ).json()["media_token"]
        assert token

        assert client.get(f"/api/media/{media_id}?t={token}").status_code == 200
        assert client.get(f"/api/snapshot.jpg?t={token}").status_code == 503  # no camera
        assert client.get(f"/api/stream/mjpeg?t={token}").status_code == 200

        # The same token buys nothing anywhere else.
        assert client.get(f"/api/events?t={token}").status_code == 401
        assert client.get(f"/api/media/{media_id}/meta?t={token}").status_code == 401
        assert client.get(f"/api/stream/events?t={token}").status_code == 401

        assert client.get(f"/api/media/{media_id}?t=not-a-real-token").status_code == 401
        assert client.get(f"/api/media/{media_id}").status_code == 401


def test_media_token_expires(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A token older than the TTL is refused, without waiting for one to age."""
    harness = build(tmp_path, auth=True, password=PASSWORD)
    harness.config.api.auth.media_token_ttl_s = 60
    manager = AuthManager(harness.config.api.auth)
    fresh = manager.mint_media_token()
    assert manager.verify_media_token(fresh) is True

    monkeypatch.setattr(TimestampSigner, "get_timestamp", lambda self: int(time.time()) - 3600)
    stale = manager.mint_media_token()
    monkeypatch.undo()

    assert manager.verify_media_token(stale) is False
    assert manager.verify_media_token("garbage") is False
    # A token minted for one purpose does not open another.
    assert manager.verify_media_token(manager.mint_media_token("other")) is False


def test_a_session_signed_with_another_secret_is_refused(tmp_path: Path) -> None:
    harness = build(tmp_path, auth=True, password=PASSWORD)
    other = AuthManager(AuthConfig(enabled=True, password=PASSWORD, secret="a-different-secret"))
    with harness.client() as client:
        client.cookies.set(SESSION_COOKIE, other.issue_session())
        assert client.get("/api/state").status_code == 401


def test_failed_logins_are_throttled_per_ip(tmp_path: Path) -> None:
    harness = build(tmp_path, auth=True, password=PASSWORD)
    with harness.client() as client:
        codes = [
            client.post("/api/auth/login", json={"password": "nope"}).status_code
            for _ in range(6)
        ]
    # The first few are plain rejections; once the backoff bites the answer
    # changes to 429 without ever consulting the password again.
    assert codes[:3] == [401, 401, 401]
    assert 429 in codes[3:]


def test_throttle_backoff_grows_and_resets_on_success() -> None:
    throttle = LoginThrottle(free_attempts=2, max_backoff_s=8.0)
    assert throttle.retry_after_s("10.0.0.5") == 0.0
    assert throttle.record_failure("10.0.0.5") == 0.0
    assert throttle.record_failure("10.0.0.5") == 0.0
    first = throttle.record_failure("10.0.0.5")
    second = throttle.record_failure("10.0.0.5")
    assert 0 < first < second <= 8.0
    assert throttle.retry_after_s("10.0.0.5") > 0
    assert throttle.retry_after_s("10.0.0.6") == 0.0
    throttle.record_success("10.0.0.5")
    assert throttle.retry_after_s("10.0.0.5") == 0.0


@pytest.mark.parametrize("candidate,expected", [(PASSWORD, True), (PASSWORD + " ", False),
                                                ("", False), ("CORRECT-HORSE-BATTERY", False)])
def test_password_comparison_is_exact(candidate: str, expected: bool) -> None:
    manager = AuthManager(AuthConfig(enabled=True, password=PASSWORD, secret="s"))
    assert manager.check_password(candidate) is expected


def test_no_password_configured_never_matches() -> None:
    manager = AuthManager(AuthConfig(enabled=True, password=None, tokens=[], secret="s"))
    assert manager.check_password("") is False
    assert manager.check_password("anything") is False
    assert manager.check_bearer("anything") is False
