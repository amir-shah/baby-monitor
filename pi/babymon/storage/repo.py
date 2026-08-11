"""Typed repositories over the SQLite schema.

Everything above this layer speaks in :mod:`babymon.models` dataclasses; only
this module knows SQL. Repositories are cheap objects wrapping a shared
:class:`~babymon.storage.db.Database`, so create them freely.
"""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Iterable, Sequence
from typing import Any

from ..models import (
    Child,
    Event,
    EventKind,
    EventLabel,
    LiveState,
    Media,
    MediaKind,
    Night,
    NightStatus,
    Note,
    NoteTag,
    Sample,
    Severity,
    SleepSegment,
    SleepState,
    Tag,
    TagCategory,
    TagValueType,
    json_dumps,
    json_loads,
)
from ..timeutil import night_of as compute_night_of
from ..timeutil import now_ms
from .db import Database

log = logging.getLogger(__name__)

__all__ = [
    "BUILTIN_TAGS",
    "ChildRepo",
    "EventRepo",
    "MediaRepo",
    "NightRepo",
    "NoteRepo",
    "Repos",
    "SampleRepo",
    "SegmentRepo",
    "SettingsRepo",
    "SystemLogRepo",
    "TagRepo",
]


def _slugify(text: str) -> str:
    import re

    slug = re.sub(r"[^a-z0-9]+", "-", text.strip().lower()).strip("-")
    return slug or "tag"


# ---------------------------------------------------------------------------
# Children
# ---------------------------------------------------------------------------


class ChildRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    @staticmethod
    def _row(row: sqlite3.Row) -> Child:
        return Child(
            id=row["id"],
            name=row["name"],
            birthdate=row["birthdate"],
            room=row["room"],
            timezone=row["timezone"],
            day_boundary_hour=row["day_boundary_hour"],
            target_bedtime=row["target_bedtime"],
            target_waketime=row["target_waketime"],
            active=bool(row["active"]),
            avatar_color=row["avatar_color"],
            created_ms=row["created_ms"],
            updated_ms=row["updated_ms"],
        )

    def list(self, *, include_inactive: bool = False) -> list[Child]:
        sql = "SELECT * FROM children"
        if not include_inactive:
            sql += " WHERE active = 1"
        sql += " ORDER BY id"
        return [self._row(r) for r in self.db.query(sql)]

    def get(self, child_id: int) -> Child | None:
        row = self.db.query_one("SELECT * FROM children WHERE id = ?", (child_id,))
        return self._row(row) if row else None

    def get_by_name(self, name: str) -> Child | None:
        row = self.db.query_one("SELECT * FROM children WHERE name = ?", (name,))
        return self._row(row) if row else None

    def default(self) -> Child | None:
        """The child to use when a request does not name one."""
        row = self.db.query_one("SELECT * FROM children WHERE active = 1 ORDER BY id LIMIT 1")
        return self._row(row) if row else None

    def create(self, **kwargs: Any) -> Child:
        ts = now_ms()
        fields = {
            "name": kwargs["name"],
            "birthdate": kwargs.get("birthdate"),
            "room": kwargs.get("room"),
            "timezone": kwargs.get("timezone"),
            "day_boundary_hour": kwargs.get("day_boundary_hour", 12),
            "target_bedtime": kwargs.get("target_bedtime"),
            "target_waketime": kwargs.get("target_waketime"),
            "active": int(kwargs.get("active", True)),
            "avatar_color": kwargs.get("avatar_color"),
            "created_ms": ts,
            "updated_ms": ts,
        }
        cols = ", ".join(fields)
        marks = ", ".join("?" for _ in fields)
        with self.db.transaction() as conn:
            cur = conn.execute(
                f"INSERT INTO children ({cols}) VALUES ({marks})", tuple(fields.values())
            )
            child_id = int(cur.lastrowid or 0)
        result = self.get(child_id)
        assert result is not None
        return result

    def update(self, child_id: int, **kwargs: Any) -> Child | None:
        allowed = {
            "name", "birthdate", "room", "timezone", "day_boundary_hour",
            "target_bedtime", "target_waketime", "active", "avatar_color",
        }
        sets = {k: v for k, v in kwargs.items() if k in allowed}
        if not sets:
            return self.get(child_id)
        if "active" in sets:
            sets["active"] = int(bool(sets["active"]))
        sets["updated_ms"] = now_ms()
        clause = ", ".join(f"{k} = ?" for k in sets)
        with self.db.transaction() as conn:
            conn.execute(
                f"UPDATE children SET {clause} WHERE id = ?", (*sets.values(), child_id)
            )
        return self.get(child_id)

    def ensure_from_config(
        self, children_config: Sequence[Any], *, default_timezone: str | None = None
    ) -> list[Child]:
        """Reconcile the ``children:`` config block into the database.

        Matches on name. Config is the source of truth for a child's settings,
        but never deletes a child, because their history is worth keeping even
        if they are removed from the config file.

        ``default_timezone`` is ``site.timezone``, and a child without one of
        their own inherits it. Leaving the column NULL instead would send every
        night through the system zone, so a Pi still on UTC would bucket nights
        on the wrong day, put bedtime in the wrong hour, and cut the evening in
        the wrong place — all while the dashboard displayed the configured zone
        and looked entirely consistent with itself.
        """
        result: list[Child] = []
        for cc in children_config:
            existing = self.get_by_name(cc.name)
            payload = {
                "birthdate": cc.birthdate,
                "room": cc.room,
                "timezone": cc.timezone or default_timezone,
                "day_boundary_hour": cc.day_boundary_hour,
                "target_bedtime": cc.target_bedtime,
                "target_waketime": cc.target_waketime,
                "avatar_color": cc.avatar_color,
                "active": True,
            }
            if existing is None:
                result.append(self.create(name=cc.name, **payload))
            else:
                updated = self.update(existing.id, **payload)
                result.append(updated or existing)
        return result


# ---------------------------------------------------------------------------
# Tags
# ---------------------------------------------------------------------------

#: Seeded on first run so the notes UI is useful immediately. The user can
#: archive any of them; they are never re-created once archived.
BUILTIN_TAGS: tuple[dict[str, Any], ...] = (
    {"slug": "dessert-before-bed", "label": "Dessert before bedtime", "category": "food",
     "value_type": "bool", "icon": "cake", "expected_direction": "worse"},
    {"slug": "big-dinner", "label": "Large dinner", "category": "food", "value_type": "bool",
     "icon": "utensils"},
    {"slug": "chocolate", "label": "Chocolate", "category": "food", "value_type": "bool",
     "icon": "cocoa", "expected_direction": "worse"},
    {"slug": "screen-before-bed", "label": "Screen time before bed", "category": "screen",
     "value_type": "duration", "unit": "min", "icon": "tv", "expected_direction": "worse"},
    {"slug": "tv-before-bed", "label": "TV before bedtime", "category": "screen",
     "value_type": "bool", "icon": "tv", "expected_direction": "worse"},
    {"slug": "lights-off", "label": "Lights off", "category": "routine", "value_type": "time",
     "icon": "moon"},
    {"slug": "bath", "label": "Bath before bed", "category": "routine", "value_type": "bool",
     "icon": "bath", "expected_direction": "better"},
    {"slug": "story", "label": "Bedtime story", "category": "routine", "value_type": "bool",
     "icon": "book"},
    {"slug": "white-noise", "label": "White noise on", "category": "environment",
     "value_type": "bool", "icon": "waves"},
    {"slug": "window-open", "label": "Window open", "category": "environment",
     "value_type": "bool", "icon": "wind"},
    {"slug": "late-nap", "label": "Late nap", "category": "activity", "value_type": "bool",
     "icon": "clock", "expected_direction": "worse"},
    {"slug": "no-nap", "label": "Skipped nap", "category": "activity", "value_type": "bool",
     "icon": "clock-off"},
    {"slug": "outdoor-play", "label": "Outdoor play", "category": "activity",
     "value_type": "duration", "unit": "min", "icon": "sun", "expected_direction": "better"},
    {"slug": "teething", "label": "Teething", "category": "health", "value_type": "bool",
     "icon": "tooth", "expected_direction": "worse"},
    {"slug": "sick", "label": "Unwell", "category": "health", "value_type": "bool",
     "icon": "thermometer", "expected_direction": "worse"},
    {"slug": "growth-spurt", "label": "Growth spurt", "category": "health", "value_type": "bool"},
    {"slug": "travel", "label": "Away from home", "category": "care", "value_type": "bool"},
    {"slug": "guest", "label": "Visitors", "category": "care", "value_type": "bool"},
    {"slug": "daycare", "label": "Daycare day", "category": "care", "value_type": "bool"},
)


class TagRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    @staticmethod
    def _row(row: sqlite3.Row) -> Tag:
        return Tag(
            id=row["id"],
            slug=row["slug"],
            label=row["label"],
            category=TagCategory(row["category"]),
            value_type=TagValueType(row["value_type"]),
            unit=row["unit"],
            color=row["color"],
            icon=row["icon"],
            expected_direction=row["expected_direction"],
            builtin=bool(row["builtin"]),
            archived=bool(row["archived"]),
            created_ms=row["created_ms"],
        )

    def list(self, *, include_archived: bool = False) -> list[Tag]:
        sql = "SELECT * FROM tags"
        if not include_archived:
            sql += " WHERE archived = 0"
        sql += " ORDER BY category, label"
        return [self._row(r) for r in self.db.query(sql)]

    def get(self, tag_id: int) -> Tag | None:
        row = self.db.query_one("SELECT * FROM tags WHERE id = ?", (tag_id,))
        return self._row(row) if row else None

    def get_by_slug(self, slug: str) -> Tag | None:
        row = self.db.query_one("SELECT * FROM tags WHERE slug = ?", (slug,))
        return self._row(row) if row else None

    def stats(self) -> dict[str, dict[str, Any]]:
        """Per-slug usage counts, for the tag manager UI."""
        rows = self.db.query(
            """
            SELECT t.slug,
                   COUNT(DISTINCT n.night_of) AS nights_applied,
                   MIN(n.created_ms)          AS first_ms,
                   MAX(n.created_ms)          AS last_ms
              FROM tags t
              JOIN note_tags nt ON nt.tag_id = t.id
              JOIN notes     n  ON n.id = nt.note_id AND n.deleted_ms IS NULL
             GROUP BY t.slug
            """
        )
        return {r["slug"]: dict(r) for r in rows}

    def create(self, slug: str | None = None, *, label: str, **kwargs: Any) -> Tag:
        slug = _slugify(slug or label)
        with self.db.transaction() as conn:
            conn.execute(
                """
                INSERT INTO tags (slug, label, category, value_type, unit, color, icon,
                                  expected_direction, builtin, archived, created_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(slug) DO NOTHING
                """,
                (
                    slug,
                    label,
                    str(kwargs.get("category", TagCategory.OTHER)),
                    str(kwargs.get("value_type", TagValueType.BOOL)),
                    kwargs.get("unit"),
                    kwargs.get("color"),
                    kwargs.get("icon"),
                    kwargs.get("expected_direction"),
                    int(kwargs.get("builtin", False)),
                    now_ms(),
                ),
            )
        tag = self.get_by_slug(slug)
        assert tag is not None
        return tag

    def get_or_create(self, slug: str, *, label: str | None = None, **kwargs: Any) -> Tag:
        slug = _slugify(slug)
        existing = self.get_by_slug(slug)
        if existing is not None:
            return existing
        pretty = label or slug.replace("-", " ").capitalize()
        return self.create(slug, label=pretty, **kwargs)

    def update(self, tag_id: int, **kwargs: Any) -> Tag | None:
        allowed = {"label", "category", "value_type", "unit", "color", "icon",
                   "expected_direction", "archived"}
        sets = {k: (int(v) if k == "archived" else str(v) if v is not None else None)
                for k, v in kwargs.items() if k in allowed}
        if not sets:
            return self.get(tag_id)
        clause = ", ".join(f"{k} = ?" for k in sets)
        with self.db.transaction() as conn:
            conn.execute(f"UPDATE tags SET {clause} WHERE id = ?", (*sets.values(), tag_id))
        return self.get(tag_id)

    def archive(self, tag_id: int) -> None:
        with self.db.transaction() as conn:
            conn.execute("UPDATE tags SET archived = 1 WHERE id = ?", (tag_id,))

    def seed_builtins(self) -> int:
        """Insert the built-in tags. Safe to call on every startup."""
        ts = now_ms()
        created = 0
        with self.db.transaction() as conn:
            for spec in BUILTIN_TAGS:
                cur = conn.execute(
                    """
                    INSERT INTO tags (slug, label, category, value_type, unit, color, icon,
                                      expected_direction, builtin, archived, created_ms)
                    VALUES (:slug, :label, :category, :value_type, :unit, NULL, :icon,
                            :expected_direction, 1, 0, :created_ms)
                    ON CONFLICT(slug) DO NOTHING
                    """,
                    {
                        "unit": None,
                        "icon": None,
                        "expected_direction": None,
                        **spec,
                        "created_ms": ts,
                    },
                )
                created += cur.rowcount if cur.rowcount > 0 else 0
        return created


# ---------------------------------------------------------------------------
# Notes
# ---------------------------------------------------------------------------


class NoteRepo:
    def __init__(self, db: Database, tags: TagRepo | None = None) -> None:
        self.db = db
        self.tags = tags or TagRepo(db)

    def _hydrate(self, rows: Sequence[sqlite3.Row]) -> list[Note]:
        notes = [
            Note(
                id=r["id"],
                child_id=r["child_id"],
                night_of=r["night_of"],
                body=r["body"],
                ts_ms=r["ts_ms"],
                source=r["source"],
                created_ms=r["created_ms"],
                updated_ms=r["updated_ms"],
                deleted_ms=r["deleted_ms"],
            )
            for r in rows
        ]
        if not notes:
            return notes
        by_id = {n.id: n for n in notes}
        marks = ", ".join("?" for _ in by_id)
        tag_rows = self.db.query(
            f"""
            SELECT nt.note_id, t.slug, t.label, t.category, t.value_type,
                   nt.value_num, nt.value_min_local, nt.value_text
              FROM note_tags nt
              JOIN tags t ON t.id = nt.tag_id
             WHERE nt.note_id IN ({marks})
             ORDER BY t.category, t.label
            """,
            tuple(by_id),
        )
        for r in tag_rows:
            by_id[r["note_id"]].tags.append(
                NoteTag(
                    slug=r["slug"],
                    label=r["label"],
                    category=TagCategory(r["category"]),
                    value_type=TagValueType(r["value_type"]),
                    value_num=r["value_num"],
                    value_min_local=r["value_min_local"],
                    value_text=r["value_text"],
                )
            )
        return notes

    def get(self, note_id: int) -> Note | None:
        rows = self.db.query("SELECT * FROM notes WHERE id = ?", (note_id,))
        found = self._hydrate(rows)
        return found[0] if found else None

    def list(
        self,
        *,
        child_id: int | None = None,
        night_of: str | None = None,
        night_from: str | None = None,
        night_to: str | None = None,
        tag: str | None = None,
        search: str | None = None,
        include_deleted: bool = False,
        limit: int = 200,
        offset: int = 0,
    ) -> tuple[list[Note], int]:
        where: list[str] = []
        params: list[Any] = []
        if child_id is not None:
            where.append("n.child_id = ?")
            params.append(child_id)
        if night_of is not None:
            where.append("n.night_of = ?")
            params.append(night_of)
        if night_from is not None:
            where.append("n.night_of >= ?")
            params.append(night_from)
        if night_to is not None:
            where.append("n.night_of <= ?")
            params.append(night_to)
        if not include_deleted:
            where.append("n.deleted_ms IS NULL")
        if search:
            where.append("n.body LIKE ?")
            params.append(f"%{search}%")
        join = ""
        if tag:
            join = " JOIN note_tags nt ON nt.note_id = n.id JOIN tags t ON t.id = nt.tag_id"
            where.append("t.slug = ?")
            params.append(tag)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        total = int(
            self.db.scalar(f"SELECT COUNT(DISTINCT n.id) FROM notes n{join}{clause}", params) or 0
        )
        rows = self.db.query(
            f"SELECT DISTINCT n.* FROM notes n{join}{clause} "
            "ORDER BY n.night_of DESC, COALESCE(n.ts_ms, n.created_ms) DESC, n.id DESC "
            "LIMIT ? OFFSET ?",
            (*params, limit, offset),
        )
        return self._hydrate(rows), total

    def create(
        self,
        *,
        child_id: int,
        night_of: str,
        body: str = "",
        ts_ms: int | None = None,
        source: str = "dashboard",
        tags: Iterable[dict[str, Any]] = (),
        autocreate_tags: bool = True,
    ) -> Note:
        ts = now_ms()
        with self.db.transaction() as conn:
            cur = conn.execute(
                """
                INSERT INTO notes (child_id, night_of, ts_ms, body, source, created_ms, updated_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (child_id, night_of, ts_ms, body, source, ts, ts),
            )
            note_id = int(cur.lastrowid or 0)
            self._write_tags(conn, note_id, tags, autocreate_tags)
        note = self.get(note_id)
        assert note is not None
        return note

    def update(
        self,
        note_id: int,
        *,
        tags: Iterable[dict[str, Any]] | None = None,
        autocreate_tags: bool = True,
        **kwargs: Any,
    ) -> Note | None:
        allowed = {"body", "ts_ms", "night_of", "child_id"}
        sets = {k: v for k, v in kwargs.items() if k in allowed}
        with self.db.transaction() as conn:
            if sets:
                sets["updated_ms"] = now_ms()
                clause = ", ".join(f"{k} = ?" for k in sets)
                conn.execute(
                    f"UPDATE notes SET {clause} WHERE id = ?", (*sets.values(), note_id)
                )
            if tags is not None:
                conn.execute("DELETE FROM note_tags WHERE note_id = ?", (note_id,))
                self._write_tags(conn, note_id, tags, autocreate_tags)
                conn.execute("UPDATE notes SET updated_ms = ? WHERE id = ?", (now_ms(), note_id))
        return self.get(note_id)

    def _write_tags(
        self,
        conn: sqlite3.Connection,
        note_id: int,
        tags: Iterable[dict[str, Any]],
        autocreate: bool,
    ) -> None:
        for spec in tags:
            slug = _slugify(str(spec.get("slug") or spec.get("label") or ""))
            if not slug:
                continue
            row = conn.execute("SELECT id, value_type FROM tags WHERE slug = ?", (slug,)).fetchone()
            if row is None:
                if not autocreate:
                    raise KeyError(f"unknown tag {slug!r}")
                value_type = str(spec.get("value_type") or _infer_value_type(spec))
                label = str(spec.get("label") or slug.replace("-", " ").capitalize())
                conn.execute(
                    """
                    INSERT INTO tags (slug, label, category, value_type, unit, color, icon,
                                      expected_direction, builtin, archived, created_ms)
                    VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, ?)
                    """,
                    (slug, label, str(spec.get("category", "other")), value_type, now_ms()),
                )
                row = conn.execute(
                    "SELECT id, value_type FROM tags WHERE slug = ?", (slug,)
                ).fetchone()
            assert row is not None
            conn.execute(
                """
                INSERT INTO note_tags (note_id, tag_id, value_num, value_min_local, value_text)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(note_id, tag_id) DO UPDATE SET
                    value_num = excluded.value_num,
                    value_min_local = excluded.value_min_local,
                    value_text = excluded.value_text
                """,
                (
                    note_id,
                    row["id"],
                    _as_float(spec.get("value_num")),
                    _as_float(spec.get("value_min_local")),
                    spec.get("value_text"),
                ),
            )

    def delete(self, note_id: int, *, hard: bool = False) -> bool:
        with self.db.transaction() as conn:
            if hard:
                cur = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
            else:
                cur = conn.execute(
                    "UPDATE notes SET deleted_ms = ? WHERE id = ? AND deleted_ms IS NULL",
                    (now_ms(), note_id),
                )
            return cur.rowcount > 0

    def find_tag_note(self, child_id: int, night_of: str, slug: str) -> Note | None:
        """The note carrying a given tag on a given night, if any.

        Used by the HomeKit tag switches, which must be idempotent: flipping
        the same switch twice should not create two notes.
        """
        rows = self.db.query(
            """
            SELECT n.* FROM notes n
              JOIN note_tags nt ON nt.note_id = n.id
              JOIN tags t       ON t.id = nt.tag_id
             WHERE n.child_id = ? AND n.night_of = ? AND t.slug = ? AND n.deleted_ms IS NULL
             ORDER BY n.id DESC LIMIT 1
            """,
            (child_id, night_of, slug),
        )
        found = self._hydrate(rows)
        return found[0] if found else None

    def night_factor_matrix(
        self, child_id: int, nights: Sequence[str]
    ) -> dict[str, dict[str, float | None]]:
        """``{night_of: {tag_slug: analysis_value}}`` for the factor analysis.

        A tag applied more than once on a night collapses to a single value:
        the mean for numeric tags, the earliest for time tags (the first time
        the lights went off is the one that matters), presence for booleans.
        """
        if not nights:
            return {}
        marks = ", ".join("?" for _ in nights)
        rows = self.db.query(
            f"""
            SELECT n.night_of, t.slug, t.value_type,
                   nt.value_num, nt.value_min_local
              FROM notes n
              JOIN note_tags nt ON nt.note_id = n.id
              JOIN tags t       ON t.id = nt.tag_id
             WHERE n.child_id = ? AND n.deleted_ms IS NULL AND n.night_of IN ({marks})
            """,
            (child_id, *nights),
        )
        acc: dict[str, dict[str, list[float]]] = {}
        types: dict[str, str] = {}
        for r in rows:
            types[r["slug"]] = r["value_type"]
            night = acc.setdefault(r["night_of"], {})
            values = night.setdefault(r["slug"], [])
            if r["value_type"] == "bool":
                values.append(1.0)
            elif r["value_type"] == "time" and r["value_min_local"] is not None:
                values.append(float(r["value_min_local"]))
            elif r["value_type"] in ("number", "duration") and r["value_num"] is not None:
                values.append(float(r["value_num"]))

        matrix: dict[str, dict[str, float | None]] = {night: {} for night in nights}
        for night, slugs in acc.items():
            for slug, values in slugs.items():
                if not values:
                    # Tag present but with no usable value (e.g. a time tag with
                    # no time filled in). Treat as present-but-unmeasured.
                    matrix[night][slug] = None if types[slug] != "bool" else 1.0
                elif types[slug] == "bool":
                    matrix[night][slug] = 1.0
                elif types[slug] == "time":
                    matrix[night][slug] = min(values)
                else:
                    matrix[night][slug] = sum(values) / len(values)
        return matrix


def _infer_value_type(spec: dict[str, Any]) -> str:
    if spec.get("value_min_local") is not None:
        return "time"
    if spec.get("value_num") is not None:
        return "number"
    if spec.get("value_text") is not None:
        return "text"
    return "bool"


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Samples
# ---------------------------------------------------------------------------


class SampleRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    _COLUMNS = (
        "ts_ms", "child_id", "night_of", "sound_dbfs", "sound_peak_dbfs",
        "noise_floor_dbfs", "cry_score", "motion", "temp_c", "humidity_pct",
        "lux", "state",
    )

    def add(self, sample: Sample) -> None:
        self.add_many([sample])

    def add_many(self, samples: Sequence[Sample]) -> int:
        if not samples:
            return 0
        marks = ", ".join("?" for _ in self._COLUMNS)
        cols = ", ".join(self._COLUMNS)
        rows = [
            (
                s.ts_ms, s.child_id, s.night_of, s.sound_dbfs, s.sound_peak_dbfs,
                s.noise_floor_dbfs, s.cry_score, s.motion, s.temp_c, s.humidity_pct,
                s.lux, str(s.state),
            )
            for s in samples
        ]
        with self.db.transaction() as conn:
            # A restart inside the same interval can replay a timestamp; last
            # write wins rather than blowing up the sensing loop.
            conn.executemany(
                f"INSERT INTO samples ({cols}) VALUES ({marks}) "
                "ON CONFLICT(child_id, ts_ms) DO UPDATE SET "
                + ", ".join(
                    f"{c} = excluded.{c}"
                    for c in self._COLUMNS
                    if c not in ("child_id", "ts_ms")
                ),
                rows,
            )
        return len(rows)

    def range(
        self, child_id: int, start_ms: int, end_ms: int, *, limit: int | None = None
    ) -> list[Sample]:
        sql = (
            "SELECT * FROM samples WHERE child_id = ? AND ts_ms >= ? AND ts_ms < ? "
            "ORDER BY ts_ms"
        )
        params: list[Any] = [child_id, start_ms, end_ms]
        if limit:
            sql += " LIMIT ?"
            params.append(limit)
        return [self._row(r) for r in self.db.query(sql, params)]

    def for_night(self, child_id: int, night_of: str) -> list[Sample]:
        return [
            self._row(r)
            for r in self.db.query(
                "SELECT * FROM samples WHERE child_id = ? AND night_of = ? ORDER BY ts_ms",
                (child_id, night_of),
            )
        ]

    def latest(self, child_id: int) -> Sample | None:
        row = self.db.query_one(
            "SELECT * FROM samples WHERE child_id = ? ORDER BY ts_ms DESC LIMIT 1", (child_id,)
        )
        return self._row(row) if row else None

    def downsample(
        self, child_id: int, start_ms: int, end_ms: int, bucket_s: int
    ) -> list[dict[str, Any]]:
        """Bucketed series for charting; the dashboard never fetches raw rows.

        Levels are aggregated with MAX for peaks and AVG for means, which keeps
        a two-second cry visible after an hour-wide bucket has been applied.
        The state of a bucket is its *worst* (most awake) state, for the same
        reason: a chart that averages away an awakening is worse than useless.
        """
        bucket_ms = max(1, bucket_s) * 1000
        rows = self.db.query(
            """
            SELECT (ts_ms / ?) * ?               AS bucket_ms,
                   AVG(sound_dbfs)               AS sound_dbfs,
                   MAX(sound_peak_dbfs)          AS sound_peak_dbfs,
                   AVG(noise_floor_dbfs)         AS noise_floor_dbfs,
                   MAX(cry_score)                AS cry_score,
                   AVG(motion)                   AS motion,
                   MAX(motion)                   AS motion_peak,
                   AVG(temp_c)                   AS temp_c,
                   AVG(humidity_pct)             AS humidity_pct,
                   COUNT(*)                      AS n,
                   MIN(CASE state
                         WHEN 'awake'    THEN 0
                         WHEN 'settling' THEN 1
                         WHEN 'restless' THEN 2
                         WHEN 'asleep'   THEN 3
                         WHEN 'absent'   THEN 4
                         ELSE 5 END)             AS state_rank
              FROM samples
             WHERE child_id = ? AND ts_ms >= ? AND ts_ms < ?
             GROUP BY bucket_ms
             ORDER BY bucket_ms
            """,
            (bucket_ms, bucket_ms, child_id, start_ms, end_ms),
        )
        ranks = ["awake", "settling", "restless", "asleep", "absent", "unknown"]
        out = []
        for r in rows:
            d = dict(r)
            rank = d.pop("state_rank")
            d["state"] = ranks[rank] if rank is not None and 0 <= rank < len(ranks) else "unknown"
            out.append(d)
        return out

    def coverage(self, child_id: int, start_ms: int, end_ms: int, interval_s: float) -> float:
        """Fraction of the window for which we actually have samples, 0..1."""
        expected = max(1.0, (end_ms - start_ms) / 1000.0 / max(interval_s, 1e-6))
        actual = int(
            self.db.scalar(
                "SELECT COUNT(*) FROM samples WHERE child_id = ? AND ts_ms >= ? AND ts_ms < ?",
                (child_id, start_ms, end_ms),
            )
            or 0
        )
        return min(1.0, actual / expected)

    def prune(self, before_ms: int) -> int:
        with self.db.transaction() as conn:
            cur = conn.execute("DELETE FROM samples WHERE ts_ms < ?", (before_ms,))
            return cur.rowcount

    @staticmethod
    def _row(row: sqlite3.Row) -> Sample:
        return Sample(
            ts_ms=row["ts_ms"],
            child_id=row["child_id"],
            night_of=row["night_of"],
            sound_dbfs=row["sound_dbfs"],
            sound_peak_dbfs=row["sound_peak_dbfs"],
            noise_floor_dbfs=row["noise_floor_dbfs"],
            cry_score=row["cry_score"],
            motion=row["motion"],
            temp_c=row["temp_c"],
            humidity_pct=row["humidity_pct"],
            lux=row["lux"],
            state=SleepState(row["state"] or "unknown"),
        )


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


class EventRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    @staticmethod
    def _row(row: sqlite3.Row) -> Event:
        return Event(
            id=row["id"],
            child_id=row["child_id"],
            night_of=row["night_of"],
            start_ms=row["start_ms"],
            end_ms=row["end_ms"],
            kind=EventKind(row["kind"]),
            label=row["label"],
            confidence=row["confidence"],
            severity=Severity(row["severity"]),
            peak_dbfs=row["peak_dbfs"],
            mean_dbfs=row["mean_dbfs"],
            motion_peak=row["motion_peak"],
            source=row["source"],
            corrected_label=row["corrected_label"],
            acknowledged_ms=row["acknowledged_ms"],
            meta=json_loads(row["meta"]),
            created_ms=row["created_ms"],
        )

    def get(self, event_id: int, *, with_media: bool = True) -> Event | None:
        row = self.db.query_one("SELECT * FROM events WHERE id = ?", (event_id,))
        if row is None:
            return None
        event = self._row(row)
        if with_media:
            event.media = MediaRepo(self.db).for_event(event_id)
        return event

    def open(
        self,
        *,
        child_id: int,
        night_of: str,
        start_ms: int,
        kind: EventKind | str,
        label: EventLabel | str,
        confidence: float | None = None,
        severity: Severity | str = Severity.INFO,
        source: str = "detector",
        meta: dict[str, Any] | None = None,
        end_ms: int | None = None,
        peak_dbfs: float | None = None,
        mean_dbfs: float | None = None,
        motion_peak: float | None = None,
    ) -> int:
        with self.db.transaction() as conn:
            cur = conn.execute(
                """
                INSERT INTO events (child_id, night_of, start_ms, end_ms, kind, label,
                                    confidence, severity, peak_dbfs, mean_dbfs, motion_peak,
                                    source, meta, created_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    child_id, night_of, start_ms, end_ms, str(kind), str(label),
                    confidence, str(severity), peak_dbfs, mean_dbfs, motion_peak,
                    source, json_dumps(meta or {}), now_ms(),
                ),
            )
            return int(cur.lastrowid or 0)

    def close(
        self,
        event_id: int,
        end_ms: int,
        *,
        peak_dbfs: float | None = None,
        mean_dbfs: float | None = None,
        motion_peak: float | None = None,
        confidence: float | None = None,
        label: EventLabel | str | None = None,
        severity: Severity | str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> Event | None:
        sets: dict[str, Any] = {"end_ms": end_ms}
        for key, value in (
            ("peak_dbfs", peak_dbfs), ("mean_dbfs", mean_dbfs),
            ("motion_peak", motion_peak), ("confidence", confidence),
        ):
            if value is not None:
                sets[key] = value
        if label is not None:
            sets["label"] = str(label)
        if severity is not None:
            sets["severity"] = str(severity)
        if meta is not None:
            sets["meta"] = json_dumps(meta)
        clause = ", ".join(f"{k} = ?" for k in sets)
        with self.db.transaction() as conn:
            conn.execute(f"UPDATE events SET {clause} WHERE id = ?", (*sets.values(), event_id))
        return self.get(event_id)

    def close_stale(self, child_id: int, before_ms: int, end_ms: int) -> int:
        """Close events left open by a crash, so the log has no dangling rows."""
        with self.db.transaction() as conn:
            cur = conn.execute(
                "UPDATE events SET end_ms = ? WHERE child_id = ? AND end_ms IS NULL "
                "AND start_ms < ?",
                (end_ms, child_id, before_ms),
            )
            return cur.rowcount

    def list(
        self,
        *,
        child_id: int | None = None,
        night_of: str | None = None,
        night_from: str | None = None,
        night_to: str | None = None,
        from_ms: int | None = None,
        to_ms: int | None = None,
        kinds: Sequence[str] | None = None,
        labels: Sequence[str] | None = None,
        min_confidence: float | None = None,
        acknowledged: bool | None = None,
        exclude_false_positives: bool = False,
        limit: int = 200,
        offset: int = 0,
        order: str = "desc",
        with_media: bool = False,
    ) -> tuple[list[Event], int]:
        where: list[str] = []
        params: list[Any] = []
        if child_id is not None:
            where.append("child_id = ?")
            params.append(child_id)
        if night_of is not None:
            where.append("night_of = ?")
            params.append(night_of)
        # night_of sorts lexicographically because it is YYYY-MM-DD, so a range
        # needs no date arithmetic and no timezone.
        if night_from is not None:
            where.append("night_of >= ?")
            params.append(night_from)
        if night_to is not None:
            where.append("night_of <= ?")
            params.append(night_to)
        if from_ms is not None:
            where.append("start_ms >= ?")
            params.append(from_ms)
        if to_ms is not None:
            where.append("start_ms < ?")
            params.append(to_ms)
        if kinds:
            where.append(f"kind IN ({', '.join('?' for _ in kinds)})")
            params.extend(kinds)
        if labels:
            where.append(f"label IN ({', '.join('?' for _ in labels)})")
            params.extend(labels)
        if min_confidence is not None:
            where.append("(confidence IS NULL OR confidence >= ?)")
            params.append(min_confidence)
        if acknowledged is not None:
            where.append(
                "acknowledged_ms IS NOT NULL" if acknowledged else "acknowledged_ms IS NULL"
            )
        if exclude_false_positives:
            where.append("(corrected_label IS NULL OR corrected_label != '')")
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        total = int(self.db.scalar(f"SELECT COUNT(*) FROM events{clause}", params) or 0)
        direction = "DESC" if order.lower() == "desc" else "ASC"
        rows = self.db.query(
            f"SELECT * FROM events{clause} ORDER BY start_ms {direction}, id {direction} "
            "LIMIT ? OFFSET ?",
            (*params, limit, offset),
        )
        events = [self._row(r) for r in rows]
        if with_media and events:
            media_by_event = MediaRepo(self.db).for_events([e.id for e in events])
            for event in events:
                event.media = media_by_event.get(event.id, [])
        return events, total

    def for_night(self, child_id: int, night_of: str, *, with_media: bool = True) -> list[Event]:
        events, _ = self.list(
            child_id=child_id, night_of=night_of, limit=10_000, order="asc", with_media=with_media
        )
        return events

    def update(self, event_id: int, **kwargs: Any) -> Event | None:
        allowed = {
            "corrected_label", "severity", "label", "confidence", "end_ms", "acknowledged_ms",
        }
        sets = {k: v for k, v in kwargs.items() if k in allowed}
        if "acknowledged" in kwargs:
            sets["acknowledged_ms"] = now_ms() if kwargs["acknowledged"] else None
        if "meta" in kwargs:
            sets["meta"] = json_dumps(kwargs["meta"])
        if not sets:
            return self.get(event_id)
        clause = ", ".join(f"{k} = ?" for k in sets)
        with self.db.transaction() as conn:
            conn.execute(f"UPDATE events SET {clause} WHERE id = ?", (*sets.values(), event_id))
        return self.get(event_id)

    def delete(self, event_id: int) -> bool:
        with self.db.transaction() as conn:
            cur = conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
            return cur.rowcount > 0

    def counts_for_night(self, child_id: int, night_of: str) -> dict[str, int]:
        rows = self.db.query(
            """
            SELECT COALESCE(NULLIF(corrected_label, ''), label) AS label, COUNT(*) AS n
              FROM events
             WHERE child_id = ? AND night_of = ?
               AND (corrected_label IS NULL OR corrected_label != '')
             GROUP BY 1
            """,
            (child_id, night_of),
        )
        return {r["label"]: r["n"] for r in rows}

    def label_feedback(self, *, since_ms: int | None = None) -> list[dict[str, Any]]:
        """Detector accuracy from the user's corrections, for the tuning page."""
        where = "WHERE corrected_label IS NOT NULL"
        params: list[Any] = []
        if since_ms is not None:
            where += " AND start_ms >= ?"
            params.append(since_ms)
        rows = self.db.query(
            f"""
            SELECT label AS detected,
                   corrected_label AS corrected,
                   COUNT(*) AS n,
                   AVG(confidence) AS mean_confidence
              FROM events {where}
             GROUP BY detected, corrected
             ORDER BY n DESC
            """,
            params,
        )
        return [dict(r) for r in rows]

    def prune(self, before_ms: int) -> int:
        with self.db.transaction() as conn:
            cur = conn.execute(
                "DELETE FROM events WHERE start_ms < ? AND source != 'manual'", (before_ms,)
            )
            return cur.rowcount


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------


class MediaRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    @staticmethod
    def _row(row: sqlite3.Row) -> Media:
        return Media(
            id=row["id"],
            child_id=row["child_id"],
            night_of=row["night_of"],
            kind=MediaKind(row["kind"]),
            rel_path=row["rel_path"],
            mime=row["mime"],
            ts_ms=row["ts_ms"],
            event_id=row["event_id"],
            bytes=row["bytes"],
            duration_s=row["duration_s"],
            expires_ms=row["expires_ms"],
            created_ms=row["created_ms"],
        )

    def add(
        self,
        *,
        child_id: int,
        night_of: str,
        kind: MediaKind | str,
        rel_path: str,
        mime: str,
        ts_ms: int,
        event_id: int | None = None,
        bytes_: int | None = None,
        duration_s: float | None = None,
        expires_ms: int | None = None,
    ) -> int:
        with self.db.transaction() as conn:
            cur = conn.execute(
                """
                INSERT INTO media (event_id, child_id, night_of, kind, rel_path, mime,
                                   bytes, duration_s, ts_ms, expires_ms, created_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id, child_id, night_of, str(kind), rel_path, mime,
                    bytes_, duration_s, ts_ms, expires_ms, now_ms(),
                ),
            )
            return int(cur.lastrowid or 0)

    def get(self, media_id: int) -> Media | None:
        row = self.db.query_one("SELECT * FROM media WHERE id = ?", (media_id,))
        return self._row(row) if row else None

    def for_event(self, event_id: int) -> list[Media]:
        return [
            self._row(r)
            for r in self.db.query(
                "SELECT * FROM media WHERE event_id = ? ORDER BY id", (event_id,)
            )
        ]

    def for_events(self, event_ids: Sequence[int]) -> dict[int, list[Media]]:
        if not event_ids:
            return {}
        marks = ", ".join("?" for _ in event_ids)
        out: dict[int, list[Media]] = {}
        for r in self.db.query(
            f"SELECT * FROM media WHERE event_id IN ({marks}) ORDER BY id", tuple(event_ids)
        ):
            out.setdefault(r["event_id"], []).append(self._row(r))
        return out

    def list(
        self,
        *,
        child_id: int | None = None,
        night_of: str | None = None,
        kind: str | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> tuple[list[Media], int]:
        where: list[str] = []
        params: list[Any] = []
        for column, value in (("child_id", child_id), ("night_of", night_of), ("kind", kind)):
            if value is not None:
                where.append(f"{column} = ?")
                params.append(value)
        clause = (" WHERE " + " AND ".join(where)) if where else ""
        total = int(self.db.scalar(f"SELECT COUNT(*) FROM media{clause}", params) or 0)
        rows = self.db.query(
            f"SELECT * FROM media{clause} ORDER BY ts_ms DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        )
        return [self._row(r) for r in rows], total

    def expired(self, now: int | None = None, limit: int = 1000) -> list[Media]:
        now = now or now_ms()
        return [
            self._row(r)
            for r in self.db.query(
                "SELECT * FROM media WHERE expires_ms IS NOT NULL AND expires_ms < ? "
                "ORDER BY expires_ms LIMIT ?",
                (now, limit),
            )
        ]

    def oldest(self, limit: int = 100) -> list[Media]:
        return [
            self._row(r)
            for r in self.db.query("SELECT * FROM media ORDER BY ts_ms LIMIT ?", (limit,))
        ]

    def total_bytes(self) -> int:
        return int(self.db.scalar("SELECT COALESCE(SUM(bytes), 0) FROM media") or 0)

    def delete(self, media_id: int) -> bool:
        with self.db.transaction() as conn:
            cur = conn.execute("DELETE FROM media WHERE id = ?", (media_id,))
            return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Sleep segments
# ---------------------------------------------------------------------------


class SegmentRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    @staticmethod
    def _row(row: sqlite3.Row) -> SleepSegment:
        return SleepSegment(
            id=row["id"],
            child_id=row["child_id"],
            night_of=row["night_of"],
            start_ms=row["start_ms"],
            end_ms=row["end_ms"],
            state=SleepState(row["state"]),
            confidence=row["confidence"],
            source=row["source"],
            created_ms=row["created_ms"],
        )

    def for_night(self, child_id: int, night_of: str) -> list[SleepSegment]:
        return [
            self._row(r)
            for r in self.db.query(
                "SELECT * FROM sleep_segments WHERE child_id = ? AND night_of = ? "
                "ORDER BY start_ms",
                (child_id, night_of),
            )
        ]

    def range(self, child_id: int, start_ms: int, end_ms: int) -> list[SleepSegment]:
        return [
            self._row(r)
            for r in self.db.query(
                "SELECT * FROM sleep_segments WHERE child_id = ? AND end_ms > ? AND start_ms < ? "
                "ORDER BY start_ms",
                (child_id, start_ms, end_ms),
            )
        ]

    def replace_night(
        self, child_id: int, night_of: str, segments: Sequence[SleepSegment]
    ) -> int:
        """Swap in a freshly computed hypnogram, keeping manual segments.

        Manual segments are the user saying "he was actually awake here"; a
        recompute must never throw that away.
        """
        ts = now_ms()
        with self.db.transaction() as conn:
            conn.execute(
                "DELETE FROM sleep_segments WHERE child_id = ? AND night_of = ? "
                "AND source != 'manual'",
                (child_id, night_of),
            )
            conn.executemany(
                """
                INSERT INTO sleep_segments (child_id, night_of, start_ms, end_ms, state,
                                            confidence, source, created_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        child_id, night_of, s.start_ms, s.end_ms, str(s.state),
                        s.confidence, s.source, ts,
                    )
                    for s in segments
                    if s.source != "manual"
                ],
            )
        return len(segments)

    def add_manual(
        self, child_id: int, night_of: str, start_ms: int, end_ms: int, state: SleepState
    ) -> int:
        with self.db.transaction() as conn:
            cur = conn.execute(
                """
                INSERT INTO sleep_segments (child_id, night_of, start_ms, end_ms, state,
                                            confidence, source, created_ms)
                VALUES (?, ?, ?, ?, ?, 1.0, 'manual', ?)
                """,
                (child_id, night_of, start_ms, end_ms, str(state), now_ms()),
            )
            return int(cur.lastrowid or 0)

    def delete(self, segment_id: int) -> bool:
        with self.db.transaction() as conn:
            cur = conn.execute("DELETE FROM sleep_segments WHERE id = ?", (segment_id,))
            return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Nights
# ---------------------------------------------------------------------------


class NightRepo:
    _COLUMNS = (
        "child_id", "night_of", "timezone", "bedtime_ms", "sleep_onset_ms", "final_wake_ms",
        "out_of_bed_ms", "tib_min", "tst_min", "sol_min", "waso_min", "awakenings",
        "longest_bout_min", "sleep_efficiency", "midpoint_ms", "restless_min",
        "cry_events", "cry_min", "noise_events", "peak_dbfs", "mean_dbfs", "motion_index",
        "temp_c_mean", "temp_c_min", "temp_c_max", "humidity_mean",
        "quality_score", "score_components", "coverage", "status", "excluded",
        "exclude_reason", "age_days", "computed_ms", "schema_version",
    )

    def __init__(self, db: Database) -> None:
        self.db = db

    @staticmethod
    def _row(row: sqlite3.Row) -> Night:
        return Night(
            child_id=row["child_id"],
            night_of=row["night_of"],
            timezone=row["timezone"],
            bedtime_ms=row["bedtime_ms"],
            sleep_onset_ms=row["sleep_onset_ms"],
            final_wake_ms=row["final_wake_ms"],
            out_of_bed_ms=row["out_of_bed_ms"],
            tib_min=row["tib_min"],
            tst_min=row["tst_min"],
            sol_min=row["sol_min"],
            waso_min=row["waso_min"],
            awakenings=row["awakenings"],
            longest_bout_min=row["longest_bout_min"],
            sleep_efficiency=row["sleep_efficiency"],
            midpoint_ms=row["midpoint_ms"],
            restless_min=row["restless_min"],
            cry_events=row["cry_events"] or 0,
            cry_min=row["cry_min"],
            noise_events=row["noise_events"] or 0,
            peak_dbfs=row["peak_dbfs"],
            mean_dbfs=row["mean_dbfs"],
            motion_index=row["motion_index"],
            temp_c_mean=row["temp_c_mean"],
            temp_c_min=row["temp_c_min"],
            temp_c_max=row["temp_c_max"],
            humidity_mean=row["humidity_mean"],
            quality_score=row["quality_score"],
            score_components=json_loads(row["score_components"]),
            coverage=row["coverage"],
            status=NightStatus(row["status"]),
            excluded=bool(row["excluded"]),
            exclude_reason=row["exclude_reason"],
            age_days=row["age_days"],
            computed_ms=row["computed_ms"],
            schema_version=row["schema_version"],
        )

    def get(self, child_id: int, night_of: str) -> Night | None:
        row = self.db.query_one(
            "SELECT * FROM nights WHERE child_id = ? AND night_of = ?", (child_id, night_of)
        )
        return self._row(row) if row else None

    def upsert(self, night: Night) -> Night:
        values = {
            "child_id": night.child_id,
            "night_of": night.night_of,
            "timezone": night.timezone,
            "bedtime_ms": night.bedtime_ms,
            "sleep_onset_ms": night.sleep_onset_ms,
            "final_wake_ms": night.final_wake_ms,
            "out_of_bed_ms": night.out_of_bed_ms,
            "tib_min": night.tib_min,
            "tst_min": night.tst_min,
            "sol_min": night.sol_min,
            "waso_min": night.waso_min,
            "awakenings": night.awakenings,
            "longest_bout_min": night.longest_bout_min,
            "sleep_efficiency": night.sleep_efficiency,
            "midpoint_ms": night.midpoint_ms,
            "restless_min": night.restless_min,
            "cry_events": night.cry_events,
            "cry_min": night.cry_min,
            "noise_events": night.noise_events,
            "peak_dbfs": night.peak_dbfs,
            "mean_dbfs": night.mean_dbfs,
            "motion_index": night.motion_index,
            "temp_c_mean": night.temp_c_mean,
            "temp_c_min": night.temp_c_min,
            "temp_c_max": night.temp_c_max,
            "humidity_mean": night.humidity_mean,
            "quality_score": night.quality_score,
            "score_components": json_dumps(night.score_components),
            "coverage": night.coverage,
            "status": str(night.status),
            "excluded": int(night.excluded),
            "exclude_reason": night.exclude_reason,
            "age_days": night.age_days,
            "computed_ms": night.computed_ms or now_ms(),
            "schema_version": night.schema_version,
        }
        cols = ", ".join(values)
        marks = ", ".join("?" for _ in values)
        # A recompute must not silently clear a user's manual exclusion, so
        # `excluded`/`exclude_reason` are preserved unless explicitly set.
        updates = ", ".join(
            f"{c} = excluded.{c}" for c in values if c not in ("child_id", "night_of")
        )
        with self.db.transaction() as conn:
            conn.execute(
                f"INSERT INTO nights ({cols}) VALUES ({marks}) "
                f"ON CONFLICT(child_id, night_of) DO UPDATE SET {updates}",
                tuple(values.values()),
            )
        result = self.get(night.child_id, night.night_of)
        assert result is not None
        return result

    def list(
        self,
        child_id: int,
        *,
        night_from: str | None = None,
        night_to: str | None = None,
        include_excluded: bool = True,
        only_analysable: bool = False,
        limit: int = 400,
    ) -> list[Night]:
        where = ["child_id = ?"]
        params: list[Any] = [child_id]
        if night_from:
            where.append("night_of >= ?")
            params.append(night_from)
        if night_to:
            where.append("night_of <= ?")
            params.append(night_to)
        if not include_excluded:
            where.append("excluded = 0")
        if only_analysable:
            where.append("excluded = 0 AND status = 'complete' AND quality_score IS NOT NULL")
        rows = self.db.query(
            f"SELECT * FROM nights WHERE {' AND '.join(where)} ORDER BY night_of DESC LIMIT ?",
            (*params, limit),
        )
        return [self._row(r) for r in rows]

    def set_flags(self, child_id: int, night_of: str, **kwargs: Any) -> Night | None:
        allowed = {
            "excluded", "exclude_reason", "status", "bedtime_ms", "sleep_onset_ms",
            "final_wake_ms", "out_of_bed_ms",
        }
        sets = {k: v for k, v in kwargs.items() if k in allowed}
        if "excluded" in sets:
            sets["excluded"] = int(bool(sets["excluded"]))
        if "status" in sets:
            sets["status"] = str(sets["status"])
        if not sets:
            return self.get(child_id, night_of)
        clause = ", ".join(f"{k} = ?" for k in sets)
        with self.db.transaction() as conn:
            conn.execute(
                f"UPDATE nights SET {clause} WHERE child_id = ? AND night_of = ?",
                (*sets.values(), child_id, night_of),
            )
        return self.get(child_id, night_of)

    def delete(self, child_id: int, night_of: str) -> bool:
        with self.db.transaction() as conn:
            cur = conn.execute(
                "DELETE FROM nights WHERE child_id = ? AND night_of = ?", (child_id, night_of)
            )
            return cur.rowcount > 0

    def nights_needing_recompute(self, child_id: int, schema_version: int) -> list[str]:
        rows = self.db.query(
            "SELECT night_of FROM nights WHERE child_id = ? AND (schema_version < ? "
            "OR status = 'in_progress') ORDER BY night_of",
            (child_id, schema_version),
        )
        return [r["night_of"] for r in rows]


# ---------------------------------------------------------------------------
# Settings and system log
# ---------------------------------------------------------------------------


class SettingsRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    def get(self, key: str, default: Any = None) -> Any:
        row = self.db.query_one("SELECT value FROM settings WHERE key = ?", (key,))
        if row is None:
            return default
        import json

        try:
            return json.loads(row["value"])
        except ValueError:
            return default

    def set(self, key: str, value: Any) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO settings (key, value, updated_ms) VALUES (?, ?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
                "updated_ms = excluded.updated_ms",
                (key, json_dumps(value), now_ms()),
            )

    def all(self) -> dict[str, Any]:
        import json

        out: dict[str, Any] = {}
        for row in self.db.query("SELECT key, value FROM settings"):
            try:
                out[row["key"]] = json.loads(row["value"])
            except ValueError:
                out[row["key"]] = row["value"]
        return out


class SystemLogRepo:
    def __init__(self, db: Database) -> None:
        self.db = db

    def add(self, level: str, component: str, message: str, **meta: Any) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO system_log (ts_ms, level, component, message, meta) "
                "VALUES (?, ?, ?, ?, ?)",
                (now_ms(), level, component, message, json_dumps(meta) if meta else None),
            )

    def recent(self, limit: int = 200, level: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM system_log"
        params: list[Any] = []
        if level:
            sql += " WHERE level = ?"
            params.append(level)
        sql += " ORDER BY ts_ms DESC LIMIT ?"
        params.append(limit)
        return [
            {**dict(r), "meta": json_loads(r["meta"])} for r in self.db.query(sql, params)
        ]

    def prune(self, before_ms: int) -> int:
        with self.db.transaction() as conn:
            cur = conn.execute("DELETE FROM system_log WHERE ts_ms < ?", (before_ms,))
            return cur.rowcount


# ---------------------------------------------------------------------------


class Repos:
    """One handle carrying every repository, passed around the service."""

    def __init__(self, db: Database) -> None:
        self.db = db
        self.children = ChildRepo(db)
        self.tags = TagRepo(db)
        self.notes = NoteRepo(db, self.tags)
        self.samples = SampleRepo(db)
        self.events = EventRepo(db)
        self.media = MediaRepo(db)
        self.segments = SegmentRepo(db)
        self.nights = NightRepo(db)
        self.settings = SettingsRepo(db)
        self.syslog = SystemLogRepo(db)

    def bootstrap(self, config: Any) -> list[Child]:
        """First-run setup: seed built-in tags and reconcile the child list."""
        self.tags.seed_builtins()
        return self.children.ensure_from_config(
            config.children, default_timezone=config.timezone
        )

    def night_of_for(self, child: Child, ts_ms: int) -> str:
        return compute_night_of(ts_ms, child.timezone, child.day_boundary_hour)

    def live_state(self, child: Child) -> LiveState:
        """Best-effort current state, reconstructed from the last sample."""
        sample = self.samples.latest(child.id)
        ts = sample.ts_ms if sample else now_ms()
        return LiveState(
            ts_ms=ts,
            child_id=child.id,
            night_of=sample.night_of if sample else self.night_of_for(child, ts),
            state=sample.state if sample else SleepState.UNKNOWN,
            sound_dbfs=sample.sound_dbfs if sample else None,
            noise_floor_dbfs=sample.noise_floor_dbfs if sample else None,
            cry_score=sample.cry_score if sample else None,
            motion=sample.motion if sample else None,
            temp_c=sample.temp_c if sample else None,
            humidity_pct=sample.humidity_pct if sample else None,
        )
