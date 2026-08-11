"""Two ways a night used to be destroyed by writing it down.

Both bugs shared a shape: something that reads the night also *changed* it, and
because every write replaces the night's rows wholesale, the damage was
permanent and silent. A parent looking at the dashboard at 22:00 would see a
plausible-looking night and never learn that the act of looking had ended it.

**Truncation.** ``SegmentBuilder.close`` finalises the open segment. The live
service called it on every flush, including the flush that a dashboard
recompute triggers. The child is asleep, the open segment is the sleep they are
still in, closing it ends the hypnogram at that instant — and nothing more is
recorded until they next change state, which for a sleeping child is hours.

**Nap-as-bedtime.** A ``night_of`` key covers a whole local day, so with the
noon boundary an afternoon nap carries the same key as the night that follows.
Without a cut between them the nap becomes the night's bedtime and sleep onset,
the whole afternoon and evening between nap and bedtime is scored as wake after
sleep onset, and a good night reads as a catastrophic one.

Neither test asserts on an implementation detail; both check the numbers a
parent would actually be shown.
"""

from __future__ import annotations

import datetime as dt

import pytest

from babymon.models import SleepSegment
from babymon.models import SleepState as S
from babymon.sleep.metrics import compute_metrics
from babymon.sleep.sessions import NightBuilder
from babymon.sleep.state import SegmentBuilder
from babymon.timeutil import get_tz, local_window_bounds, to_ms

MINUTE = 60_000
NIGHT = "2026-08-10"
TZ = "America/Los_Angeles"


def at(hour: int, minute: int = 0, *, day: int = 10) -> int:
    """A local wall-clock instant on the night of 2026-08-10, in epoch ms."""
    return to_ms(dt.datetime(2026, 8, day, hour, minute, tzinfo=get_tz(TZ)))


# ---------------------------------------------------------------------------
# Truncation
# ---------------------------------------------------------------------------


class TestSegmentBuilderSnapshot:
    def test_a_snapshot_includes_the_segment_still_in_progress(self):
        b = SegmentBuilder(1, NIGHT)
        b.push(at(19), S.SETTLING, 0.6)
        b.push(at(19, 30), S.ASLEEP, 0.8)

        out = b.snapshot(at(22))
        assert [s["state"] for s in out] == [S.SETTLING, S.ASLEEP]
        assert out[-1]["end_ms"] == at(22)

    def test_reading_the_buffer_does_not_disturb_it(self):
        # The bug in one line: a snapshot at 22:00 must not stop the night.
        b = SegmentBuilder(1, NIGHT)
        b.push(at(19), S.SETTLING, 0.6)
        b.push(at(19, 30), S.ASLEEP, 0.8)

        b.snapshot(at(22))
        b.push(at(6, day=11), S.AWAKE, 0.9)

        final = b.close(at(6, 30, day=11))
        assert [s["state"] for s in final] == [S.SETTLING, S.ASLEEP, S.AWAKE]
        # The sleep bout runs 19:30 -> 06:00, not 19:30 -> 22:00.
        assert final[1]["end_ms"] == at(6, day=11)

    def test_repeated_snapshots_keep_extending_the_open_segment(self):
        b = SegmentBuilder(1, NIGHT)
        b.push(at(19, 30), S.ASLEEP, 0.8)
        for hour in (21, 23):
            b.snapshot(at(hour))
        for hour in (2, 5):
            b.snapshot(at(hour, day=11))

        out = b.snapshot(at(6, day=11))
        assert len(out) == 1
        assert out[0]["end_ms"] == at(6, day=11)

    def test_a_snapshot_before_the_open_segment_started_is_not_inverted(self):
        b = SegmentBuilder(1, NIGHT)
        b.push(at(19, 30), S.ASLEEP, 0.8)
        # A clock step, or a flush racing the push that just happened.
        assert b.snapshot(at(19, 29)) == []

    def test_close_finalises_and_snapshot_does_not(self):
        b = SegmentBuilder(1, NIGHT)
        b.push(at(19, 30), S.ASLEEP, 0.8)
        assert b.segments == []          # snapshot's copy is not the buffer
        b.snapshot(at(22))
        assert b.segments == []
        b.close(at(22))
        assert len(b.segments) == 1

    def test_a_snapshot_is_a_copy_the_caller_cannot_corrupt(self):
        b = SegmentBuilder(1, NIGHT)
        b.push(at(19, 30), S.ASLEEP, 0.8)
        out = b.snapshot(at(22))
        out[0]["end_ms"] = 0
        assert b.snapshot(at(23))[0]["end_ms"] == at(23)


def test_recomputing_tonight_costs_nothing(repos, child, config):
    """The whole scenario, through the database, as the service runs it.

    Three dashboard recomputes during a ten-hour sleep. Before the fix the
    first one ended the night and the reported TST fell from ten hours to
    ninety minutes.
    """
    builder = SegmentBuilder(child.id, NIGHT)
    builder.push(at(19), S.SETTLING, 0.6)
    builder.push(at(19, 30), S.ASLEEP, 0.85)

    def persist(ts: int) -> None:
        repos.segments.replace_night(
            child.id,
            NIGHT,
            [
                SleepSegment(0, child.id, NIGHT, s["start_ms"], s["end_ms"], s["state"])
                for s in builder.snapshot(ts)
            ],
        )

    for ts in (at(22), at(2, day=11), at(5, day=11)):
        persist(ts)

    builder.push(at(5, 30, day=11), S.AWAKE, 0.9)
    persist(at(6, day=11))

    night = NightBuilder(config, repos).rebuild(child, NIGHT)
    assert night is not None
    assert night.tst_min == pytest.approx(600.0)
    assert night.sleep_onset_ms == at(19, 30)


# ---------------------------------------------------------------------------
# Nap as bedtime
# ---------------------------------------------------------------------------


def nocturnal_cut() -> int:
    start, _ = local_window_bounds(NIGHT, ("17:00", "23:59"), TZ, 12)
    return start


class TestNocturnalCut:
    """A day with a 13:00 nap and a 19:00 bedtime, under one night_of key."""

    @pytest.fixture()
    def day(self) -> list[SleepSegment]:
        def seg(start: int, end: int, state: S) -> SleepSegment:
            return SleepSegment(0, 1, NIGHT, start, end, state)

        return [
            seg(at(13), at(14, 30), S.ASLEEP),          # 90-minute nap
            seg(at(14, 30), at(19), S.ABSENT),          # downstairs all afternoon
            seg(at(19), at(19, 30), S.SETTLING),
            seg(at(19, 30), at(1, 30, day=11), S.ASLEEP),
            seg(at(1, 30, day=11), at(1, 50, day=11), S.AWAKE),
            seg(at(1, 50, day=11), at(6, 30, day=11), S.ASLEEP),
            seg(at(6, 30, day=11), at(7, day=11), S.AWAKE),
        ]

    @pytest.fixture()
    def m(self, day):
        return compute_metrics(
            day, [], [], awakening_min_min=5.0, coverage=1.0, night_start_ms=nocturnal_cut()
        )

    def test_bedtime_is_the_evening_not_the_nap(self, m):
        assert m.bedtime_ms == at(19)

    def test_sleep_onset_is_the_evening_not_the_nap(self, m):
        assert m.sleep_onset_ms == at(19, 30)

    def test_the_afternoon_is_not_wake_after_sleep_onset(self, m):
        assert m.waso_min == pytest.approx(20.0)

    def test_the_nap_is_not_night_sleep(self, m):
        # 19:30-01:30 plus 01:50-06:30, and not a minute of the 13:00 nap.
        assert m.tst_min == pytest.approx(360 + 280)

    def test_time_in_bed_starts_at_bedtime(self, m):
        assert m.tib_min == pytest.approx(720.0)

    def test_efficiency_is_not_wrecked_by_the_afternoon(self, m):
        assert m.sleep_efficiency == pytest.approx(640 / 720)

    def test_one_awakening_not_two(self, m):
        assert m.awakenings == 1

    def test_without_the_cut_the_nap_would_have_been_the_bedtime(self, day):
        # The bug, preserved: this is what every night with a nap used to say.
        broken = compute_metrics(day, [], [], awakening_min_min=5.0, coverage=1.0)
        assert broken.bedtime_ms == at(13)
        assert broken.tst_min > (m := 640) and broken.tst_min == pytest.approx(m + 90)


class TestRestInterval:
    """Time in bed is the run around the night's sleep, not the whole key."""

    def seg(self, start: int, end: int, state: S) -> SleepSegment:
        return SleepSegment(0, 1, NIGHT, start, end, state)

    def test_an_empty_room_before_bedtime_does_not_start_the_night(self):
        # Playing in their room at 17:30, taken down for dinner, back at 19:00.
        m = compute_metrics(
            [
                self.seg(at(17, 15), at(17, 40), S.AWAKE),
                self.seg(at(17, 40), at(19), S.ABSENT),
                self.seg(at(19), at(19, 30), S.SETTLING),
                self.seg(at(19, 30), at(6, day=11), S.ASLEEP),
            ],
            [], [], coverage=1.0, night_start_ms=nocturnal_cut(),
        )
        assert m.bedtime_ms == at(19)
        assert m.sol_min == pytest.approx(30.0)
        assert m.tib_min == pytest.approx(660.0)

    def test_playing_in_the_room_after_breakfast_is_not_time_in_bed(self):
        # Up at 06:30, out of the room, back at 09:00 to play. Counting that as
        # time in bed would put efficiency at 66% for an excellent night.
        m = compute_metrics(
            [
                self.seg(at(19), at(19, 15), S.SETTLING),
                self.seg(at(19, 15), at(6, 30, day=11), S.ASLEEP),
                self.seg(at(6, 30, day=11), at(6, 45, day=11), S.AWAKE),
                self.seg(at(6, 45, day=11), at(9, day=11), S.ABSENT),
                self.seg(at(9, day=11), at(10, day=11), S.AWAKE),
            ],
            [], [], coverage=1.0, night_start_ms=nocturnal_cut(),
        )
        assert m.out_of_bed_ms == at(6, 45, day=11)
        assert m.tib_min == pytest.approx(705.0)
        assert m.sleep_efficiency == pytest.approx(675 / 705)

    def test_a_child_awake_in_their_own_room_before_bedtime_is_scored_in_bed(self):
        """The known limit of this, asserted rather than left to be discovered.

        A camera cannot tell a child lying awake in bed from one playing on the
        floor, and the state machine calls both AWAKE. So an early-evening play
        session inside the bedroom does count towards time in bed and does cost
        efficiency. The remedy is the nocturnal cut — set the start of
        ``sleep.bedtime_window`` to when the child actually goes up.
        """
        m = compute_metrics(
            [
                self.seg(at(17, 30), at(19), S.AWAKE),
                self.seg(at(19), at(6, day=11), S.ASLEEP),
            ],
            [], [], coverage=1.0, night_start_ms=nocturnal_cut(),
        )
        assert m.bedtime_ms == at(17, 30)
        assert m.sol_min == pytest.approx(90.0)

    def test_a_gap_in_the_record_is_not_evidence_of_being_in_bed(self):
        # The service was down between 18:00 and 19:00; nothing was observed,
        # so nothing is claimed.
        m = compute_metrics(
            [
                self.seg(at(17, 30), at(18), S.AWAKE),
                self.seg(at(19), at(6, day=11), S.ASLEEP),
            ],
            [], [], coverage=0.9, night_start_ms=nocturnal_cut(),
        )
        assert m.bedtime_ms == at(19)
        assert m.sol_min == pytest.approx(0.0)


class TestCutEdgeCases:
    def test_a_segment_straddling_the_cut_is_clipped_not_dropped(self):
        # Down at 16:30, half an hour before the bedtime window opens.
        segments = [SleepSegment(0, 1, NIGHT, at(16, 30), at(6, day=11), S.ASLEEP)]
        m = compute_metrics(segments, [], [], coverage=1.0, night_start_ms=nocturnal_cut())
        assert m.bedtime_ms == nocturnal_cut()
        assert m.tst_min == pytest.approx(13 * 60)

    def test_a_night_entirely_before_the_cut_is_measured_not_discarded(self):
        # An ill child down at 15:00 and up at 22:00. Nothing survives the cut,
        # so the cut is ignored rather than reporting no night at all.
        segments = [
            SleepSegment(0, 1, NIGHT, at(15), at(15, 20), S.SETTLING),
            SleepSegment(0, 1, NIGHT, at(15, 20), at(16, 50), S.ASLEEP),
        ]
        m = compute_metrics(segments, [], [], coverage=1.0, night_start_ms=nocturnal_cut())
        assert m.tst_min == pytest.approx(90.0)
        assert m.bedtime_ms == at(15)

    def test_no_cut_given_means_no_cut_applied(self):
        segments = [SleepSegment(0, 1, NIGHT, at(13), at(14), S.ASLEEP)]
        m = compute_metrics(segments, [], [], coverage=1.0)
        assert m.tst_min == pytest.approx(60.0)
        assert m.night_start_ms is None


def test_a_nap_is_counted_once_as_a_nap_and_never_as_night_sleep(repos, child, config):
    """The two halves of the fix have to agree on where the night starts.

    ``_nap_minutes`` counts sleep before the cut and ``compute_metrics`` counts
    sleep after it. If those two instants differ, the overlap is either counted
    twice in the 24-hour duration total or lost from both.
    """
    rows = [
        (at(13), at(14, 30), S.ASLEEP),
        (at(14, 30), at(19), S.ABSENT),
        (at(19), at(19, 30), S.SETTLING),
        (at(19, 30), at(6, 30, day=11), S.ASLEEP),
        (at(6, 30, day=11), at(7, day=11), S.AWAKE),
    ]
    repos.segments.replace_night(
        child.id,
        NIGHT,
        [SleepSegment(0, child.id, NIGHT, s, e, st) for s, e, st in rows],
    )

    builder = NightBuilder(config, repos)
    night = builder.rebuild(child, NIGHT, finalise=True)
    assert night is not None

    nap_min = night.score_components["nap_min"]
    assert nap_min == pytest.approx(90.0)
    assert night.tst_min == pytest.approx(660.0)
    # 11 h of night plus 1.5 h of nap, each counted exactly once.
    assert night.tst_min + nap_min == pytest.approx(750.0)
    assert night.bedtime_ms == at(19)


def test_a_lie_in_past_the_day_boundary_is_not_this_days_nap(repos, child, config):
    """Only the part of a segment inside this 24-hour period belongs to it.

    A child still asleep at noon produces a segment that began under
    yesterday's key and crosses the boundary. Counting all of it here would
    add last night's small hours to today's nap total — and it is the nap
    total that decides whether the child met their age band's 24-hour target.
    """
    previous = "2026-08-09"
    repos.segments.replace_night(
        child.id,
        previous,
        [SleepSegment(0, child.id, previous, at(6, day=10), at(13, day=10), S.ASLEEP)],
    )
    repos.segments.replace_night(
        child.id,
        NIGHT,
        [
            SleepSegment(0, child.id, NIGHT, at(19), at(19, 15), S.SETTLING),
            SleepSegment(0, child.id, NIGHT, at(19, 15), at(6, day=11), S.ASLEEP),
        ],
    )

    night = NightBuilder(config, repos).rebuild(child, NIGHT, finalise=True)
    assert night is not None
    # 12:00 to 13:00 of that lie-in, not 06:00 to 13:00.
    assert night.score_components["nap_min"] == pytest.approx(60.0)


# ---------------------------------------------------------------------------
# Regularity
# ---------------------------------------------------------------------------


class TestClockColumns:
    """The SRI grid asks "same clock position", which is not "same elapsed minute".

    Two days a year those differ, and indexing by elapsed minutes makes every
    minute after the transition compare against the wrong minute of the
    neighbouring day — so a clock change reads as two nights of chaos, and the
    fourteen-day window carries it for a fortnight.
    """

    @staticmethod
    def columns(key: str):
        from babymon.sleep.sessions import _clock_columns
        from babymon.timeutil import NightWindow

        window = NightWindow.for_key(key, TZ, 12)
        return _clock_columns(window, TZ, 12), window

    def test_an_ordinary_day_is_the_identity(self):
        columns, window = self.columns("2026-08-10")
        assert window.duration_h == 24
        assert columns == list(range(1440))

    def test_noon_is_always_column_zero(self):
        for key in ("2026-08-10", "2026-03-07", "2026-10-31"):
            columns, _ = self.columns(key)
            assert columns[0] == 0

    def test_a_25_hour_day_keeps_all_of_itself(self):
        columns, window = self.columns("2026-10-31")  # fall back
        assert window.duration_h == 25
        assert len(columns) == 1500  # not truncated at 1440
        assert max(columns) < 1440

    def test_a_23_hour_day_is_not_padded_with_unknowns(self):
        columns, window = self.columns("2026-03-07")  # spring forward
        assert window.duration_h == 23
        assert len(columns) == 1380

    def test_the_same_clock_time_lands_in_the_same_column_across_dst(self):
        # 21:00 local on an ordinary night and on the spring-forward night.
        ordinary, ordinary_w = self.columns("2026-08-10")
        shifted, shifted_w = self.columns("2026-03-07")

        def column_at(hour: int, day: int, month: int, columns, window) -> int:
            when = to_ms(dt.datetime(2026, month, day, hour, tzinfo=get_tz(TZ)))
            return columns[int((when - window.start_ms) / 60_000)]

        assert column_at(21, 10, 8, ordinary, ordinary_w) == column_at(
            21, 7, 3, shifted, shifted_w
        )

    def test_the_morning_after_a_clock_change_still_lines_up(self):
        # 07:00 the next morning, on both sides of the transition.
        ordinary, ordinary_w = self.columns("2026-08-10")
        shifted, shifted_w = self.columns("2026-03-07")
        a = ordinary[int(
            (to_ms(dt.datetime(2026, 8, 11, 7, tzinfo=get_tz(TZ))) - ordinary_w.start_ms) / 60_000
        )]
        b = shifted[int(
            (to_ms(dt.datetime(2026, 3, 8, 7, tzinfo=get_tz(TZ))) - shifted_w.start_ms) / 60_000
        )]
        assert a == b


def test_a_sliver_of_data_does_not_count_as_a_night_of_regularity(repos, child, config):
    """One minute a night agrees with itself perfectly.

    Counting any day with a single observed minute toward the seven-night
    minimum let fourteen almost-empty nights produce a Sleep Regularity Index
    of 100 — a perfect score for a monitor that had recorded nothing.
    """
    from babymon.timeutil import night_dates

    builder = NightBuilder(config, repos)
    keys = list(night_dates("2026-08-01", "2026-08-14"))
    for key in keys:
        start = to_ms(dt.datetime.fromisoformat(f"{key}T22:00").replace(tzinfo=get_tz(TZ)))
        repos.segments.replace_night(
            child.id,
            key,
            [SleepSegment(0, child.id, key, start, start + MINUTE, S.ASLEEP)],
        )

    assert builder._sri(child, keys[-1]) is None
