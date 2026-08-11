"""The state machine, driven a tick at a time through realistic nights.

The machine decides what a night *was*. Everything downstream — the hypnogram,
WASO, the awakening count, the score, and every correlation run over months of
those scores — is a function of the states it emits, so a bias here is a bias
in all of it, applied consistently enough to look like a finding.

The cases below are the ones where a plausible implementation is wrong in a
direction that flatters the data: a real awakening missed, a roll-over counted
as one, an outage recorded as an empty room.
"""

from __future__ import annotations

import pytest

from babymon.models import SleepState as S
from babymon.sleep.state import Observation, SleepStateMachine

TICK_MS = 15_000


class Room:
    """A machine and a clock, ticked in whole minutes of a described scene."""

    def __init__(self, **kwargs) -> None:
        self.machine = SleepStateMachine(**kwargs)
        self.ts = 0
        self.changes = []

    def tick(self, minutes: float, **evidence) -> Room:
        for _ in range(int(minutes * 60_000 / TICK_MS)):
            self.ts += TICK_MS
            change = self.machine.observe(Observation(ts_ms=self.ts, **evidence))
            if change is not None:
                self.changes.append(change)
        return self

    def quiet(self, minutes: float) -> Room:
        return self.tick(minutes, motion=0.01)

    def crying(self, minutes: float) -> Room:
        return self.tick(minutes, motion=0.3, cry_score=0.9, sound_excess_db=18.0)

    @property
    def state(self) -> S:
        return self.machine.state

    def awakenings(self) -> int:
        return sum(1 for c in self.changes if c.current is S.AWAKE)


@pytest.fixture()
def room() -> Room:
    return Room(sample_interval_s=15.0)


def asleep(room: Room) -> Room:
    """Get the machine to a settled ASLEEP, the state most tests start from."""
    room.tick(2, motion=0.1).quiet(20)
    assert room.state is S.ASLEEP
    return room


class TestFallingAsleep:
    def test_sustained_quiet_becomes_sleep(self, room):
        room.tick(1, motion=0.1)
        assert room.state is S.SETTLING
        room.quiet(20)
        assert room.state is S.ASLEEP
        assert room.machine.sleep_onset_ms is not None

    def test_onset_is_backdated_to_when_the_quiet_began(self, room):
        room.tick(1, motion=0.1).quiet(20)
        # Not to when the twelve-minute dwell expired: the child fell asleep at
        # the start of the quiet period, and dating it later would inflate
        # every night's sleep-onset latency by the dwell time.
        assert room.machine.sleep_onset_ms == pytest.approx(60_000 + TICK_MS, abs=TICK_MS)

    def test_activity_before_onset_is_settling_not_restless(self, room):
        room.tick(5, motion=0.1)
        assert room.state is S.SETTLING


class TestArousalsAreNotAwakenings:
    def test_rolling_over_does_not_wake_the_child(self, room):
        asleep(room).tick(0.5, motion=0.3).quiet(10)
        assert room.awakenings() == 0
        assert room.state is S.ASLEEP

    def test_a_brief_stir_becomes_restless_at_most(self, room):
        asleep(room).tick(2, motion=0.08).quiet(10)
        assert S.AWAKE not in [c.current for c in room.changes]

    def test_two_minutes_of_crying_is_still_not_an_awakening(self, room):
        # Under the five-minute bar. Real, logged as a sound event elsewhere,
        # but not an awakening in the night's tally.
        asleep(room).crying(2).quiet(15)
        assert room.awakenings() == 0


class TestRealAwakenings:
    def test_sustained_crying_is_an_awakening(self, room):
        asleep(room).crying(8)
        assert room.state is S.AWAKE
        assert room.awakenings() == 1

    def test_intermittent_crying_accumulates(self, room):
        """The bug this file was written for.

        Waking children cry in bursts. Requiring five *unbroken* minutes means
        every pause resets the timer, no burst ever reaches the bar, and a
        twenty-minute settling battle is scored as unbroken sleep — no
        awakening, no WASO, and a night that reads better than it was.
        """
        asleep(room)
        for _ in range(7):
            room.crying(1.5).quiet(0.75)
        assert room.state is S.AWAKE
        assert room.awakenings() == 1

    def test_the_awakening_is_dated_from_the_first_cry(self, room):
        asleep(room)
        first_cry_ms = room.ts + TICK_MS
        for _ in range(7):
            room.crying(1.5).quiet(0.75)
        woke = next(c for c in room.changes if c.current is S.AWAKE)
        assert woke.ts_ms == pytest.approx(first_cry_ms, abs=TICK_MS)

    def test_a_long_enough_pause_writes_the_evidence_off(self, room):
        # Two minutes of crying, three minutes of silence, two more. The child
        # settled in between, so this is two arousals and not one awakening.
        asleep(room).crying(2).quiet(3).crying(2).quiet(10)
        assert room.awakenings() == 0

    def test_the_tolerance_is_configurable(self):
        strict = Room(sample_interval_s=15.0, lapse_tolerance_s=15.0)
        asleep(strict)
        for _ in range(7):
            strict.crying(1.5).quiet(0.75)
        # With no tolerance for pauses, the same night shows nothing at all.
        assert strict.awakenings() == 0


class TestAbsence:
    def test_a_long_empty_room_reads_as_absent(self, room):
        room.tick(1, motion=0.1).tick(40, motion=0.0)
        assert room.state is S.ABSENT

    def test_an_outage_is_not_an_empty_room(self, room):
        asleep(room)
        for _ in range(160):
            room.ts += TICK_MS
            room.machine.observe(
                Observation(ts_ms=room.ts, video_ok=False, audio_ok=False)
            )
        # Holding the last known state is honest; ABSENT would claim the child
        # left the room, which the monitor has no way to know.
        assert room.state is S.ASLEEP

    def test_a_camera_outage_alone_does_not_invent_absence(self, room):
        asleep(room).tick(40, motion=0.0, video_ok=False)
        assert room.state is not S.ABSENT


class TestNightBoundary:
    def test_onset_does_not_carry_over_to_the_next_evening(self, room):
        asleep(room)
        assert room.machine.sleep_onset_ms is not None
        room.machine.begin_night(room.ts)
        assert room.machine.sleep_onset_ms is None
        # ...so the following evening's activity is settling again, not the
        # post-onset restlessness it would otherwise be scored as.
        room.tick(5, motion=0.1)
        assert room.state is S.SETTLING


class TestTickAccounting:
    def test_a_stalled_sensor_cannot_bank_hours_of_evidence(self, room):
        """A gap in the stream is unobserved time, not evidence.

        Crediting the whole gap would let one tick either side of a two-hour
        stall satisfy any dwell requirement in the machine.
        """
        asleep(room)
        room.ts += 2 * 3_600_000
        room.machine.observe(
            Observation(ts_ms=room.ts, motion=0.3, cry_score=0.9, sound_excess_db=18.0)
        )
        assert room.state is S.ASLEEP
