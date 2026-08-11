"""The dashboard's camera preview: framing, and the boundary both ends must share."""

from __future__ import annotations

import io
import threading

from babymon.bus import MJPEG_BOUNDARY
from babymon.video.source import _split_jpegs

SOI, EOI = b"\xff\xd8", b"\xff\xd9"


def jpeg(marker: bytes, size: int = 32) -> bytes:
    return SOI + marker * size + EOI


class TestJpegFraming:
    @staticmethod
    def split(payload: bytes, chunk: int = 8) -> list[bytes]:
        stop = threading.Event()
        return list(_split_jpegs(io.BytesIO(payload), stop, chunk_size=chunk))

    def test_a_concatenated_stream_is_cut_into_images(self):
        frames = self.split(jpeg(b"a") + jpeg(b"b") + jpeg(b"c"))
        assert len(frames) == 3
        assert all(f.startswith(SOI) and f.endswith(EOI) for f in frames)

    def test_images_survive_being_split_across_reads(self):
        # One byte at a time: every marker straddles a chunk boundary.
        assert self.split(jpeg(b"a") + jpeg(b"b"), chunk=1) == [jpeg(b"a"), jpeg(b"b")]

    def test_leading_junk_before_the_first_image_is_discarded(self):
        assert self.split(b"ffmpeg said something\n" + jpeg(b"a")) == [jpeg(b"a")]

    def test_a_truncated_final_image_is_not_emitted(self):
        # Half an image is not an image; yielding it would show a torn frame.
        frames = self.split(jpeg(b"a") + SOI + b"bbbb")
        assert frames == [jpeg(b"a")]

    def test_an_empty_stream_yields_nothing(self):
        assert self.split(b"") == []

    def test_it_stops_when_asked(self):
        stop = threading.Event()
        stop.set()
        assert list(_split_jpegs(io.BytesIO(jpeg(b"a")), stop)) == []


def test_the_boundary_is_defined_once():
    """The header and the body have to agree, and once they did not.

    The response advertised `boundary=babymonframe` while the parts were
    separated by `--frame`. No browser reports that: the preview is simply
    blank for ever, with nothing in any log to say why.
    """
    from babymon.api.routers.state import MJPEG_BOUNDARY as router_boundary

    assert router_boundary == MJPEG_BOUNDARY
    assert MJPEG_BOUNDARY and "--" not in MJPEG_BOUNDARY
