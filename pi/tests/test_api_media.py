"""Serving stored media: containment, Range requests, and missing files."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from babymon.api.routers.media import MediaPathError, resolve_media_path

from .test_api_common import build

NIGHT = "2026-08-10"
BODY = bytes(range(256)) * 8  # 2048 bytes, every value distinguishable


def test_whole_file_is_served_with_range_support_advertised(tmp_path: Path) -> None:
    harness = build(tmp_path)
    media_id = harness.add_media(NIGHT, rel_path="clips/cry.ogg", contents=BODY)
    with harness.client() as client:
        response = client.get(f"/api/media/{media_id}")
    assert response.status_code == 200
    assert response.content == BODY
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-length"] == str(len(BODY))
    assert response.headers["content-type"].startswith("audio/ogg")
    # The download name is built from the row, never from the stored path.
    assert "clips" not in response.headers["content-disposition"]
    assert f"babymon-{NIGHT}-audio_clip-{media_id}.ogg" in response.headers["content-disposition"]


@pytest.mark.parametrize(
    "header,expected_slice,expected_range",
    [
        ("bytes=0-99", slice(0, 100), "bytes 0-99/2048"),
        ("bytes=100-199", slice(100, 200), "bytes 100-199/2048"),
        ("bytes=2000-", slice(2000, 2048), "bytes 2000-2047/2048"),
        ("bytes=-48", slice(2000, 2048), "bytes 2000-2047/2048"),
        ("bytes=0-99999", slice(0, 2048), "bytes 0-2047/2048"),
    ],
)
def test_byte_ranges(
    tmp_path: Path, header: str, expected_slice: slice, expected_range: str
) -> None:
    harness = build(tmp_path)
    media_id = harness.add_media(NIGHT, rel_path="clips/cry.ogg", contents=BODY)
    with harness.client() as client:
        response = client.get(f"/api/media/{media_id}", headers={"Range": header})
    assert response.status_code == 206
    assert response.headers["content-range"] == expected_range
    assert response.content == BODY[expected_slice]
    assert response.headers["content-length"] == str(len(BODY[expected_slice]))


def test_unsatisfiable_range_is_416_with_the_size(tmp_path: Path) -> None:
    harness = build(tmp_path)
    media_id = harness.add_media(NIGHT, rel_path="clips/cry.ogg", contents=BODY)
    with harness.client() as client:
        response = client.get(f"/api/media/{media_id}", headers={"Range": "bytes=9000-9100"})
    assert response.status_code == 416
    assert response.headers["content-range"] == f"bytes */{len(BODY)}"
    assert response.json()["error"]["code"] == "range_not_satisfiable"


def test_unparseable_or_multipart_range_falls_back_to_the_whole_file(tmp_path: Path) -> None:
    harness = build(tmp_path)
    media_id = harness.add_media(NIGHT, rel_path="clips/cry.ogg", contents=BODY)
    with harness.client() as client:
        for header in ("bytes=abc-def", "items=0-10", "bytes=0-10,20-30", "bytes=-"):
            response = client.get(f"/api/media/{media_id}", headers={"Range": header})
            assert response.status_code == 200, header
            assert response.content == BODY


@pytest.mark.parametrize(
    "rel_path",
    [
        "../../etc/passwd",
        "../outside.txt",
        "clips/../../outside.txt",
        "/etc/passwd",
        "clips/../../../../../../etc/hostname",
    ],
)
def test_paths_escaping_the_media_directory_are_refused(tmp_path: Path, rel_path: str) -> None:
    harness = build(tmp_path)
    # The file genuinely exists outside the media directory, so a handler that
    # skipped the containment check would happily serve it.
    (tmp_path / "outside.txt").write_bytes(b"secret")
    media_id = harness.add_media(NIGHT, rel_path=rel_path, contents=None)

    with harness.client() as client:
        response = client.get(f"/api/media/{media_id}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] in ("media_missing", "not_found")
    assert b"secret" not in response.content


def test_a_symlink_out_of_the_media_directory_is_refused(tmp_path: Path) -> None:
    harness = build(tmp_path)
    secret = tmp_path / "secret.txt"
    secret.write_bytes(b"not for the network")
    link = Path(harness.config.paths.media_dir) / "clips" / "escape.ogg"
    link.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(secret, link)
    media_id = harness.add_media(NIGHT, rel_path="clips/escape.ogg", contents=None)

    with harness.client() as client:
        response = client.get(f"/api/media/{media_id}")
    assert response.status_code == 404
    assert b"not for the network" not in response.content


def test_resolve_media_path_directly(tmp_path: Path) -> None:
    harness = build(tmp_path)
    base = Path(harness.config.paths.media_dir).resolve()
    assert resolve_media_path(harness.config, "clips/a.ogg") == base / "clips" / "a.ogg"
    for bad in ("", "../x", "/etc/passwd", "a\x00b"):
        with pytest.raises(MediaPathError):
            resolve_media_path(harness.config, bad)


def test_a_row_whose_file_is_gone_is_a_clean_404(tmp_path: Path) -> None:
    harness = build(tmp_path)
    media_id = harness.add_media(NIGHT, rel_path="clips/pruned.ogg", contents=None)
    with harness.client() as client:
        response = client.get(f"/api/media/{media_id}")
        meta = client.get(f"/api/media/{media_id}/meta")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "media_expired"
    # The metadata still answers: the row outliving its file is normal.
    assert meta.status_code == 200
    assert meta.json()["id"] == media_id


def test_media_meta_reports_the_real_size(tmp_path: Path) -> None:
    harness = build(tmp_path)
    media_id = harness.add_media(NIGHT, rel_path="clips/cry.ogg", contents=BODY)
    with harness.client() as client:
        meta = client.get(f"/api/media/{media_id}/meta").json()
    assert meta["bytes"] == len(BODY)
    assert meta["url"] == f"/api/media/{media_id}"
    assert meta["ts_iso"] is not None


def test_missing_media_id(tmp_path: Path) -> None:
    harness = build(tmp_path)
    with harness.client() as client:
        assert client.get("/api/media/12345").status_code == 404
        assert client.get("/api/media/12345/meta").status_code == 404


class TestAbsurdRangeHeaders:
    """A malformed Range must be a 4xx or ignored, never a 500."""

    def test_an_enormous_byte_count_does_not_crash(self):
        from babymon.api.routers.media import _parse_range

        # Python refuses to parse an integer literal longer than 4300 digits
        # and raises ValueError doing it, which became a 500 from a header
        # anybody can send.
        assert _parse_range("bytes=0-" + "9" * 5000, 1000) is None

    def test_a_long_start_offset_does_not_crash(self):
        from babymon.api.routers.media import _parse_range

        assert _parse_range("bytes=" + "9" * 5000 + "-", 1000) is None

    def test_ordinary_ranges_still_parse(self):
        from babymon.api.routers.media import _parse_range

        assert _parse_range("bytes=0-99", 1000) == (0, 99)
        assert _parse_range("bytes=-100", 1000) == (900, 999)
        assert _parse_range("bytes=500-", 1000) == (500, 999)
