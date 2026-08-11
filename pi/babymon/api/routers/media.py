"""Serving stored snapshots and clips.

Two things here are security-relevant rather than merely functional.

**Path containment.** ``media.rel_path`` comes out of the database, which makes
it tempting to treat as trusted. It is not: it was written by a capture path
that composes filenames from labels and timestamps, a restore could bring in
rows from anywhere, and the whole point of a check like this is that it holds
when an earlier assumption has already failed. Every path is resolved and
tested for containment under ``paths.media_dir`` before a byte is read, and
symlinks are resolved as part of that — a symlink inside the media directory
pointing at ``/etc`` is exactly the case a naive prefix comparison misses.

**Range requests.** ``<audio>`` will not let the user scrub a clip unless the
server answers ``Range``, and Safari refuses to start playback at all without
a ``206``. So the range handling is real: a single byte range, correct
``Content-Range``, ``416`` with a ``Content-Range: bytes */len`` on an
unsatisfiable one, and ``Accept-Ranges`` advertised on the full response.

These routes accept a ``?t=`` media token as well as the usual credentials,
because an ``<img>`` or ``<audio>`` tag cannot send a header.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response, StreamingResponse

from ...config import Config
from ...models import Media
from ..auth import require_auth, require_media_access
from ..deps import ChildDep, ConfigDep, PageDep, ReposDep
from ..errors import ApiError, NotFound
from ..schemas import MediaOut

log = logging.getLogger(__name__)

router = APIRouter(prefix="/media", tags=["media"])

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
#: 64 KiB: large enough that the syscall overhead is irrelevant, small enough
#: that ten clients seeking around clips do not add up to real memory on a Pi.
_CHUNK = 64 * 1024


class MediaPathError(ApiError):
    """A stored path that does not resolve inside the media directory."""

    status_code = 404
    code = "media_missing"


def resolve_media_path(config: Config, rel_path: str) -> Path:
    """Resolve a stored relative path, refusing anything outside ``media_dir``."""
    base = Path(config.paths.media_dir).resolve()
    if not rel_path or "\x00" in rel_path:
        raise MediaPathError("That media row has no usable path.")
    candidate = (base / rel_path).resolve()
    if candidate != base and not candidate.is_relative_to(base):
        # Logged loudly: a row like this is either a bug in the capture path or
        # someone editing the database, and both are worth knowing about.
        log.error("refusing media path %r: resolves outside %s", rel_path, base)
        raise MediaPathError("That media file is not inside the media directory.")
    return candidate


def _require_media(repos: Any, media_id: int) -> Media:
    media = repos.media.get(media_id)
    if media is None:
        raise NotFound(f"No media with id {media_id}.", detail={"media_id": media_id})
    return media


def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    """``(start, end)`` inclusive for a single byte range, or None for the lot.

    Multi-range requests are answered with the whole file, which is legal:
    ``Range`` is a hint a server may decline, and no browser needs multipart
    byte ranges to scrub a two-second clip.
    """
    match = _RANGE_RE.match(header.strip())
    if not match:
        return None
    first, last = match.group(1), match.group(2)
    if not first and not last:
        return None
    if not first:
        # bytes=-N — the final N bytes.
        length = int(last)
        if length <= 0:
            raise _unsatisfiable(size)
        return max(0, size - length), size - 1
    start = int(first)
    end = int(last) if last else size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        raise _unsatisfiable(size)
    return start, end


def _unsatisfiable(size: int) -> ApiError:
    return ApiError(
        "That byte range is outside the file.",
        code="range_not_satisfiable",
        status_code=416,
        headers={"Content-Range": f"bytes */{size}"},
    )


def _file_chunks(path: Path, start: int, length: int) -> Iterator[bytes]:
    with path.open("rb") as fh:
        fh.seek(start)
        remaining = length
        while remaining > 0:
            chunk = fh.read(min(_CHUNK, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


# ---------------------------------------------------------------------------


@router.get("", response_model=dict, dependencies=[Depends(require_auth)])
def list_media(
    child: ChildDep,
    repos: ReposDep,
    page: PageDep,
    night_of: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    kind: Annotated[str | None, Query(max_length=32)] = None,
    event_id: Annotated[int | None, Query()] = None,
) -> dict[str, Any]:
    if event_id is not None:
        rows = [
            m
            for m in repos.media.for_event(event_id)
            if (night_of is None or m.night_of == night_of)
            and (kind is None or str(m.kind) == kind)
            and m.child_id == child.id
        ]
        window = rows[page.offset : page.offset + page.limit]
        return page.envelope([MediaOut.from_model(m, child.timezone) for m in window], len(rows))

    rows, total = repos.media.list(
        child_id=child.id,
        night_of=night_of,
        kind=kind,
        limit=page.limit,
        offset=page.offset,
    )
    return page.envelope([MediaOut.from_model(m, child.timezone) for m in rows], total)


@router.get("/{media_id}/meta", response_model=MediaOut, dependencies=[Depends(require_auth)])
def media_meta(media_id: int, repos: ReposDep, config: ConfigDep) -> MediaOut:
    media = _require_media(repos, media_id)
    child = repos.children.get(media.child_id)
    out = MediaOut.from_model(media, child.timezone if child else None)
    try:
        path = resolve_media_path(config, media.rel_path)
        out.bytes = path.stat().st_size if path.is_file() else media.bytes
    except (MediaPathError, OSError):
        # The row outliving its file is normal after a retention sweep; the
        # metadata is still worth returning, with the size the row remembers.
        pass
    return out


@router.get("/{media_id}", dependencies=[Depends(require_media_access)])
def get_media(media_id: int, request: Request, repos: ReposDep, config: ConfigDep) -> Response:
    media = _require_media(repos, media_id)
    path = resolve_media_path(config, media.rel_path)
    if not path.is_file():
        raise NotFound(
            "That file is no longer on disk; it was probably removed by the "
            "retention sweep.",
            code="media_expired",
            detail={"media_id": media_id, "expires_ms": media.expires_ms},
        )

    size = path.stat().st_size
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=86400",
        "Content-Disposition": f'inline; filename="{_filename(media, path)}"',
    }

    raw_range = request.headers.get("range")
    if not raw_range:
        return StreamingResponse(
            _file_chunks(path, 0, size),
            media_type=media.mime,
            headers={**headers, "Content-Length": str(size)},
        )

    span = _parse_range(raw_range, size)
    if span is None:
        return StreamingResponse(
            _file_chunks(path, 0, size),
            media_type=media.mime,
            headers={**headers, "Content-Length": str(size)},
        )
    start, end = span
    length = end - start + 1
    return StreamingResponse(
        _file_chunks(path, start, length),
        status_code=206,
        media_type=media.mime,
        headers={
            **headers,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
        },
    )


def _filename(media: Media, path: Path) -> str:
    """A safe download name: the row's id and kind, never the stored path."""
    suffix = path.suffix if re.fullmatch(r"\.[A-Za-z0-9]{1,8}", path.suffix) else ""
    return f"babymon-{media.night_of}-{media.kind}-{media.id}{suffix}"


__all__ = ["router", "resolve_media_path", "MediaPathError"]
