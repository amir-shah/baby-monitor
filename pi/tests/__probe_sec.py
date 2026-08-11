"""Scratch security probes. Not part of the suite."""
from __future__ import annotations
import os, time
from pathlib import Path
from .test_api_common import build

NIGHT = "2026-08-10"
BODY = bytes(range(256)) * 8
PW = "correct-horse-battery"
TOK = "bridge-token-0123456789"


def test_probe_traversal(tmp_path: Path) -> None:
    h = build(tmp_path)
    media_root = Path(h.config.paths.media_dir)
    secret = tmp_path / "secret.txt"
    secret.write_bytes(b"TOP SECRET")
    cases = {
        "traversal": "../secret.txt",
        "deep": "clips/../../secret.txt",
        "absolute": str(secret),
        "abs_etc": "/etc/hostname",
        "urlenc": "%2e%2e%2fsecret.txt",
        "nullbyte": "clips/cry.ogg\x00.txt",
        "backslash": "..\\secret.txt",
        "dotdot_enc": "..%2Fsecret.txt",
    }
    # symlink inside media dir
    (media_root / "clips").mkdir(parents=True, exist_ok=True)
    os.symlink(str(secret), str(media_root / "clips" / "link.ogg"))
    cases["symlink"] = "clips/link.ogg"

    with h.client() as c:
        for name, rel in cases.items():
            mid = h.repos.media.add(
                child_id=h.child.id, night_of=NIGHT, kind="audio_clip",
                rel_path=rel, mime="audio/ogg", ts_ms=h.at(NIGHT, 9),
                event_id=None, bytes_=10, duration_s=1.0,
            )
            r = c.get(f"/api/media/{mid}")
            body = r.content[:40]
            print(f"{name:12} rel={rel!r:40} -> {r.status_code} {body!r}")


def test_probe_range(tmp_path: Path) -> None:
    h = build(tmp_path)
    mid = h.add_media(NIGHT, rel_path="clips/cry.ogg", contents=BODY)
    with h.client() as c:
        for hdr in ["bytes=0-99",
                    "bytes=" + "9" * 5000 + "-",
                    "bytes=-" + "9" * 5000,
                    "bytes=0-" + "9" * 5000,
                    "bytes=" + "1" * 4400 + "-",
                    ]:
            try:
                r = c.get(f"/api/media/{mid}", headers={"Range": hdr})
                print(f"len={len(hdr):6} -> {r.status_code} {r.headers.get('content-range')}")
            except Exception as e:
                print(f"len={len(hdr):6} -> EXC {type(e).__name__}: {str(e)[:200]}")


def test_probe_session_replay_after_logout(tmp_path: Path) -> None:
    h = build(tmp_path, auth=True, password=PW, tokens=(TOK,))
    with h.client() as c:
        r = c.post("/api/auth/login", json={"password": PW})
        cookie = r.cookies.get("babymon_session")
        print("login:", r.status_code, "cookie:", (cookie or "")[:30])
        print("state before logout:", c.get("/api/state").status_code)
        print("logout:", c.post("/api/auth/logout").status_code)
    # a fresh client presenting the *captured* cookie
    with h.client() as c2:
        r = c2.get("/api/state", cookies={"babymon_session": cookie})
        print("state with captured cookie AFTER logout:", r.status_code)


def test_probe_media_token_scope(tmp_path: Path) -> None:
    h = build(tmp_path, auth=True, password=PW, tokens=(TOK,))
    mid = h.add_media(NIGHT, rel_path="clips/cry.ogg", contents=BODY)
    with h.client() as c:
        info = c.post("/api/auth/login", json={"password": PW}).json()
        mt = info["media_token"]
        print("media token:", mt[:40], "ttl", info["media_token_ttl_s"])
    with h.client() as c2:
        for p in [f"/api/media/{mid}", "/api/state", "/api/events", "/api/config",
                  "/api/nights", "/api/snapshot.jpg", "/api/stream/events",
                  f"/api/media/{mid}/meta", "/api/homekit/state"]:
            try:
                r = c2.get(p, params={"t": mt}, timeout=3)
                print(f"  {p:28} ?t= -> {r.status_code}")
            except Exception as e:
                print(f"  {p:28} ?t= -> EXC {type(e).__name__}")
        # can a media token be replayed as a session cookie?
        r = c2.get("/api/state", cookies={"babymon_session": mt})
        print("  media token as session cookie ->", r.status_code)


def test_probe_throttle(tmp_path: Path) -> None:
    h = build(tmp_path, auth=True, password=PW, tokens=(TOK,))
    with h.client() as c:
        for i in range(8):
            r = c.post("/api/auth/login", json={"password": "nope"})
            print(i, r.status_code, r.json()["error"].get("detail"))
        # bearer brute force -- throttled?
        for i in range(5):
            r = c.get("/api/state", headers={"Authorization": "Bearer wrongwrongwrong"})
            print("bearer attempt", i, r.status_code)
        # does a *correct* password still get through while blocked?
        r = c.post("/api/auth/login", json={"password": PW})
        print("correct pw while blocked:", r.status_code)


def test_probe_throttle_memory(tmp_path: Path) -> None:
    from babymon.api.auth import LoginThrottle
    t = LoginThrottle()
    for i in range(5000):
        ip = f"fe80::{i:x}"
        for _ in range(5):
            t.record_failure(ip)
    print("entries retained after 5000 distinct IPs x5 failures:", len(t._state))


def test_probe_cors(tmp_path: Path) -> None:
    h = build(tmp_path, auth=True, password=PW, cors_origins=["http://good.example"])
    with h.client() as c:
        for origin in ["http://good.example", "http://evil.example", "null"]:
            r = c.get("/api/health", headers={"Origin": origin})
            print(f"{origin:22} -> acao={r.headers.get('access-control-allow-origin')!r} "
                  f"acac={r.headers.get('access-control-allow-credentials')!r}")
    h2 = build(tmp_path / "b", auth=True, password=PW, cors_origins=["*"])
    with h2.client() as c:
        r = c.get("/api/health", headers={"Origin": "http://evil.example"})
        print("wildcard configured -> acao=", r.headers.get("access-control-allow-origin"),
              "acac=", r.headers.get("access-control-allow-credentials"))
