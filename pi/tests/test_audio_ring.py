"""The audio ring, and what "catching up" has to mean.

The analysis loop reads frames from a ring the capture thread is filling. When
the loop falls behind — a garbage collection pause, a classifier that took too
long, the Pi throttling — it has to work through the backlog. Reading "the
newest window" each time while advancing a counter looks like catching up and
is not: the same audio is analysed repeatedly, the audio it fell behind on is
never looked at, and every frame in the burst is stamped with the current
time, so a cry recovered after a stall is logged minutes from when it
happened.

These tests address frames by position and check the samples that come back
are the ones asked for.
"""

from __future__ import annotations

import numpy as np
import pytest

from babymon.audio.capture import AudioRing

RATE = 16_000


def ramp(start: int, count: int) -> np.ndarray:
    """Samples whose values are their own stream index, so reads self-identify."""
    return np.arange(start, start + count, dtype=np.float32)


@pytest.fixture()
def ring() -> AudioRing:
    return AudioRing(RATE, seconds=2.0)  # 32000 samples


class TestPositionalReads:
    def test_a_frame_is_the_samples_it_was_asked_for(self, ring):
        ring.write(ramp(0, 10_000), ts_ms=1_000_000)
        got, _ = ring.ending_at(5_000, 400)
        assert np.array_equal(got, ramp(4_600, 400))

    def test_the_newest_frame_matches_latest(self, ring):
        ring.write(ramp(0, 10_000), ts_ms=1_000_000)
        got, _ = ring.ending_at(10_000, 400)
        assert np.array_equal(got, ring.latest(400))

    def test_consecutive_positions_tile_the_stream_without_gaps(self, ring):
        ring.write(ramp(0, 20_000), ts_ms=1_000_000)
        seen: list[float] = []
        for position in range(400, 20_001, 400):
            got, _ = ring.ending_at(position, 400)
            seen.extend(got.tolist())
        assert seen == list(range(0, 20_000))

    def test_a_position_that_has_scrolled_out_is_refused(self, ring):
        ring.write(ramp(0, 100_000), ts_ms=1_000_000)  # three times capacity
        assert ring.ending_at(5_000, 400) is None

    def test_a_position_not_yet_written_is_refused(self, ring):
        ring.write(ramp(0, 1_000), ts_ms=1_000_000)
        assert ring.ending_at(5_000, 400) is None

    def test_a_frame_longer_than_the_history_is_refused(self, ring):
        ring.write(ramp(0, 1_000), ts_ms=1_000_000)
        assert ring.ending_at(200, 400) is None


class TestTimestamps:
    def test_the_newest_frame_carries_the_last_write_time(self, ring):
        ring.write(ramp(0, 10_000), ts_ms=1_700_000_000_000)
        _, ts = ring.ending_at(10_000, 400)
        assert ts == 1_700_000_000_000

    def test_an_older_frame_is_dated_from_the_sample_rate_not_the_clock(self, ring):
        """The whole point. A backlog frame must not be stamped with now.

        Half a second of samples behind the newest write is half a second
        earlier, and that is what puts the event on the timeline where the
        parent heard it.
        """
        ring.write(ramp(0, 20_000), ts_ms=1_700_000_000_000)
        _, ts = ring.ending_at(20_000 - RATE // 2, 400)
        assert ts == pytest.approx(1_700_000_000_000 - 500, abs=1)

    def test_frames_walked_forward_have_increasing_timestamps(self, ring):
        ring.write(ramp(0, 20_000), ts_ms=1_700_000_000_000)
        stamps = [ring.ending_at(p, 400)[1] for p in range(10_000, 20_001, 800)]
        assert stamps == sorted(stamps)
        assert len(set(stamps)) == len(stamps)


class TestWrapAround:
    def test_a_frame_spanning_the_wrap_point_is_contiguous(self, ring):
        # Capacity is 32000; write past it so the buffer has wrapped, then read
        # a frame that straddles index 0.
        ring.write(ramp(0, 40_000), ts_ms=1_000_000)
        got, _ = ring.ending_at(32_200, 400)
        assert np.array_equal(got, ramp(31_800, 400))

    def test_reads_stay_correct_across_many_wraps(self, ring):
        for block in range(20):
            ring.write(ramp(block * 5_000, 5_000), ts_ms=1_000_000 + block)
        total = 20 * 5_000
        got, _ = ring.ending_at(total, 1_000)
        assert np.array_equal(got, ramp(total - 1_000, 1_000))


class TestCatchingUp:
    """The frame loop, driven without ever starting a real device."""

    @staticmethod
    def capture(**kwargs):
        from babymon.audio.capture import AudioCapture

        return AudioCapture(
            device="null", sample_rate=RATE, channels=1,
            frame_samples=1_600, hop_samples=800, ring_seconds=4.0, **kwargs
        )

    def test_a_backlog_is_replayed_in_order_and_not_re_read(self):
        cap = self.capture()
        cap.ring.write(ramp(0, 16_000), ts_ms=1_700_000_000_000)

        frames = []
        for samples, ts in cap.frames():
            frames.append((samples[0], samples[-1], ts))
            if len(frames) >= 8:
                cap._stop.set()

        firsts = [f[0] for f in frames]
        # Strictly advancing by the hop. Re-reading the newest window would
        # give eight identical frames, all at the head of the stream.
        assert firsts == [0.0, 800.0, 1600.0, 2400.0, 3200.0, 4000.0, 4800.0, 5600.0]
        assert len({f[2] for f in frames}) == len(frames), "every frame stamped the same"

    def test_backlog_frames_are_dated_earlier_than_the_newest(self):
        cap = self.capture()
        cap.ring.write(ramp(0, 32_000), ts_ms=1_700_000_000_000)
        stamps = []
        for _, ts in cap.frames():
            stamps.append(ts)
            if len(stamps) >= 4:
                cap._stop.set()
        # Two seconds of backlog: the first frame belongs near the start of it,
        # not to the instant the loop happened to get around to reading it.
        assert stamps[0] < 1_700_000_000_000 - 1_500
        assert stamps == sorted(stamps)

    def test_an_overrun_skips_forward_and_is_counted(self):
        cap = self.capture()
        # Four seconds of ring, sixteen seconds of audio: most of it is gone.
        cap.ring.write(ramp(0, 16_000), ts_ms=1_700_000_000_000)
        next(iter(cap.frames()))
        cap.ring.write(ramp(16_000, 240_000), ts_ms=1_700_000_015_000)

        samples, _ = next(iter(cap.frames()))
        assert cap.status()["overruns"] >= 1
        # Resumes at the oldest frame the ring can still serve whole, not at
        # the position it wanted, and not at the newest.
        assert samples[0] >= 256_000 - cap.ring.capacity
        assert samples[0] < 256_000 - cap.frame_samples

    def test_it_waits_rather_than_spinning_when_it_is_up_to_date(self):
        import threading
        import time

        cap = self.capture()
        cap.ring.write(ramp(0, 4_000), ts_ms=1_700_000_000_000)
        seen = []

        def drain():
            for frame in cap.frames():
                seen.append(frame)

        worker = threading.Thread(target=drain, daemon=True)
        worker.start()
        time.sleep(0.3)
        caught_up = len(seen)
        time.sleep(0.3)
        cap._stop.set()
        worker.join(timeout=2)
        # No new audio arrived, so no new frames should have.
        assert len(seen) == caught_up
