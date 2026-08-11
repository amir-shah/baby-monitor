"""Night boundaries, DST, and clock arithmetic.

The DST cases are the point of this file. A night that spans a transition is
23 or 25 real hours long, and an implementation that subtracts a fixed twelve
hours from UTC gets it wrong twice a year and stays wrong in the analytics for
months afterwards.
"""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

import pytest

from babymon import timeutil as T

LA = "America/Los_Angeles"
LONDON = "Europe/London"


def ms(year, month, day, hour=0, minute=0, tz=LA) -> int:
    return T.to_ms(dt.datetime(year, month, day, hour, minute, tzinfo=ZoneInfo(tz)))


class TestNightOf:
    @pytest.mark.parametrize(
        ("hour", "expected"),
        [(12, "2026-08-10"), (19, "2026-08-10"), (23, "2026-08-10"), (11, "2026-08-09")],
    )
    def test_boundary_at_noon(self, hour, expected):
        assert T.night_of(ms(2026, 8, 10, hour), LA) == expected

    def test_after_midnight_belongs_to_the_previous_evening(self):
        assert T.night_of(ms(2026, 8, 11, 3), LA) == "2026-08-10"

    def test_configurable_boundary(self):
        # With an 18:00 boundary, 17:00 is still the previous night.
        assert T.night_of(ms(2026, 8, 10, 17), LA, day_boundary_hour=18) == "2026-08-09"
        assert T.night_of(ms(2026, 8, 10, 19), LA, day_boundary_hour=18) == "2026-08-10"

    def test_rejects_an_impossible_boundary(self):
        with pytest.raises(ValueError):
            T.night_of(ms(2026, 8, 10, 12), LA, day_boundary_hour=25)


class TestDst:
    def test_fall_back_night_is_25_hours(self):
        # US clocks go back at 02:00 on 2026-11-01.
        start, end = T.night_bounds("2026-10-31", LA)
        assert (end - start) / 3_600_000 == 25.0

    def test_spring_forward_night_is_23_hours(self):
        # US clocks go forward at 02:00 on 2026-03-08.
        start, end = T.night_bounds("2026-03-07", LA)
        assert (end - start) / 3_600_000 == 23.0

    def test_ordinary_night_is_24_hours(self):
        start, end = T.night_bounds("2026-06-01", LA)
        assert (end - start) / 3_600_000 == 24.0

    def test_uk_transition_too(self):
        start, end = T.night_bounds("2026-10-24", LONDON)
        assert (end - start) / 3_600_000 == 25.0

    def test_bounds_are_contiguous_across_a_transition(self):
        # No gap and no overlap: the end of one night is the start of the next,
        # or a sample lands in no night at all.
        _, end = T.night_bounds("2026-10-31", LA)
        start, _ = T.night_bounds("2026-11-01", LA)
        assert end == start

    def test_every_instant_maps_into_its_own_night(self):
        for key in T.night_dates("2026-10-29", "2026-11-03"):
            start, end = T.night_bounds(key, LA)
            for probe in (start, start + 1000, (start + end) // 2, end - 1000):
                assert T.night_of(probe, LA) == key


class TestWindows:
    def test_evening_window_lands_on_the_night_itself(self):
        start, end = T.local_window_bounds("2026-08-10", ("17:00", "23:59"), LA)
        assert T.from_ms(start, LA).date() == dt.date(2026, 8, 10)
        assert T.from_ms(start, LA).hour == 17
        assert end > start

    def test_morning_window_lands_on_the_following_day(self):
        start, end = T.local_window_bounds("2026-08-10", ("04:00", "11:00"), LA)
        assert T.from_ms(start, LA).date() == dt.date(2026, 8, 11)
        assert T.from_ms(end, LA).hour == 11


class TestClockArithmetic:
    def test_format_wraps(self):
        assert T.format_hhmm(1170) == "19:30"
        assert T.format_hhmm(-30) == "23:30"
        assert T.format_hhmm(1500) == "01:00"

    def test_signed_distance_takes_the_short_way_round_midnight(self):
        assert T.signed_minutes_from_reference(10, 1430) == 20
        assert T.signed_minutes_from_reference(1430, 10) == -20

    def test_circular_mean_of_times_either_side_of_midnight(self):
        assert T.circular_mean_minutes([1430, 10]) == pytest.approx(0.0, abs=0.01)

    def test_circular_sd_is_small_for_a_tight_cluster(self):
        assert T.circular_sd_minutes([1430, 10, 1420]) < 20


class TestConversions:
    def test_naive_datetime_is_rejected_rather_than_guessed(self):
        with pytest.raises(ValueError):
            T.to_ms(dt.datetime(2026, 8, 10, 12, 0))

    def test_bool_is_not_a_timestamp(self):
        with pytest.raises(TypeError):
            T.to_ms(True)

    def test_round_trip(self):
        value = ms(2026, 8, 10, 19, 30)
        assert T.to_ms(T.from_ms(value, LA)) == value


class TestSubHourDstGaps:
    """Not every clock change is an hour.

    Lord Howe Island moves by thirty minutes. Stepping a non-existent local
    time forward by a fixed hour overshoots such a gap and lands past its end,
    at which point the instant a night *starts* and the night an instant
    *belongs to* stop agreeing — the one invariant the whole night_of scheme
    rests on.
    """

    ZONE = "Australia/Lord_Howe"
    #: 2026-10-04, 02:00 -> 02:30 local.
    GAP_DATE = dt.date(2026, 10, 4)

    def test_the_boundary_lands_on_the_end_of_the_gap_not_past_it(self):
        zone = T.get_tz(self.ZONE)
        naive = dt.datetime.combine(self.GAP_DATE, dt.time(2, 0), tzinfo=zone)
        resolved = T.from_ms(T._resolve_local(naive, zone), zone)
        assert (resolved.hour, resolved.minute) == (2, 30)

    def test_a_night_starting_in_the_gap_still_contains_its_own_instants(self):
        zone = T.get_tz(self.ZONE)
        start, end = T.night_bounds(self.GAP_DATE.isoformat(), zone, 2)
        for offset_h in (0, 1, 6, 12, 20):
            moment = start + offset_h * 3_600_000
            if moment >= end:
                continue
            assert T.night_of(moment, zone, 2) == self.GAP_DATE.isoformat()

    def test_consecutive_nights_still_abut_exactly(self):
        zone = T.get_tz(self.ZONE)
        _, end = T.night_bounds(self.GAP_DATE.isoformat(), zone, 2)
        next_start, _ = T.night_bounds(T.shift_night(self.GAP_DATE.isoformat(), 1), zone, 2)
        assert end == next_start

    def test_an_hour_wide_gap_is_still_handled(self):
        # The ordinary case must not regress: US spring forward, 02:00 -> 03:00.
        zone = T.get_tz("America/Los_Angeles")
        naive = dt.datetime(2026, 3, 8, 2, 0, tzinfo=zone)
        resolved = T.from_ms(T._resolve_local(naive, zone), zone)
        assert (resolved.hour, resolved.minute) == (3, 0)
