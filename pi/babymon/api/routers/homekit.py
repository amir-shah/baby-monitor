"""Endpoints that exist so the Node HomeKit bridge can stay stateless.

The bridge owns HAP: pairing, characteristics, the HKSV recording pipeline. It
deliberately owns no data. Every characteristic it publishes is either pushed
to it over SSE or read from ``/api/homekit/state`` in one call, and every
switch a user flips comes straight back here as a note. Keeping the split at
that line means there is exactly one definition of "is he asleep" in the
system, and it is not written twice in two languages.

``POST /api/homekit/tag`` has to be idempotent, and not in the polite sense.
HomeKit re-sends characteristic writes on reconnect, a scene can set the same
switch as an automation, and a user who is not sure whether the tap registered
will tap again. Any of those creating a second "dessert before bed" note would
double-count that night in the factor analysis. So the switch state is derived
from whether a note with that tag exists tonight — ``NoteRepo.find_tag_note`` —
and setting it to the state it is already in does nothing at all.

Turning a switch off removes the tag rather than the note, unless the note has
nothing else in it. A note that says "ice cream, then two episodes" with two
tags on it should not vanish because one switch was flipped back.
"""

from __future__ import annotations

import contextlib
import json
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from ...bus import Topic
from ...config import Config
from ...models import Child, EventKind, EventLabel, Severity, SleepState
from ...storage.repo import Repos
from ...timeutil import night_of as night_of_for
from ...timeutil import now_ms
from ..deps import ConfigDep, IdempotencyKey, ReposDep, RuntimeDep, child_or_default
from ..schemas import HomeKitRecordingRequest, HomeKitTagRequest, NoteOut

router = APIRouter(prefix="/homekit", tags=["homekit"])

#: HAP accessory category 2 is "Bridge". Used only when the persisted
#: AccessoryInfo does not say otherwise, i.e. before the bridge has ever run.
DEFAULT_HAP_CATEGORY = 2

_MAC_RE = re.compile(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$")


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


def _tag_switch_states(
    repos: Repos, child: Child, night_of: str, switches: Any
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for switch in switches:
        note = repos.notes.find_tag_note(child.id, night_of, switch.slug)
        out.append(
            {
                "slug": switch.slug,
                "label": switch.label,
                "on": note is not None,
                "note_id": note.id if note else None,
            }
        )
    return out


@router.get("/state")
def homekit_state(
    repos: ReposDep,
    config: ConfigDep,
    runtime: RuntimeDep,
    child_id: int | None = None,
) -> dict[str, Any]:
    """Every characteristic the bridge publishes, in one round trip."""
    child = child_or_default(repos, child_id)
    try:
        state = runtime.live_state(child.id)
    except Exception:
        state = repos.live_state(child)
    if not state.night_of:
        state = repos.live_state(child)

    night_of = state.night_of or night_of_for(now_ms(), child.timezone, child.day_boundary_hour)
    sleep_state = SleepState(state.state)

    recent, _ = repos.events.list(
        child_id=child.id, kinds=["audio"], limit=1, order="desc", exclude_false_positives=True
    )
    open_audio = recent[0] if recent and recent[0].is_open else None

    return {
        "child_id": child.id,
        "ts_ms": state.ts_ms,
        "night_of": night_of,
        "temperature_c": state.temp_c,
        "humidity_pct": state.humidity_pct,
        "motion_detected": (state.motion or 0.0) >= config.motion.on_threshold,
        "motion_score": state.motion,
        "sound_detected": open_audio is not None,
        "sound_label": str(open_audio.label) if open_audio else None,
        "sound_confidence": open_audio.confidence if open_audio else None,
        "sound_dbfs": state.sound_dbfs,
        # HomeKit's occupancy sensor reads best as "someone is in the cot",
        # which is in-bed rather than asleep: an awake child is still there.
        "occupancy_detected": sleep_state.counts_as_in_bed,
        "awake": sleep_state in (SleepState.AWAKE, SleepState.SETTLING),
        "sleep_state": str(sleep_state),
        "asleep": sleep_state.counts_as_sleep,
        "camera_online": state.camera_online,
        "audio_online": state.audio_online,
        "tag_switches": _tag_switch_states(repos, child, night_of, config.homekit.tag_switches),
    }


# ---------------------------------------------------------------------------
# Tag switches
# ---------------------------------------------------------------------------


@router.post("/tag", response_model=dict)
def set_tag(
    payload: HomeKitTagRequest,
    repos: ReposDep,
    config: ConfigDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> dict[str, Any]:
    """Flip a HomeKit switch into (or out of) tonight's note. Idempotent."""
    child = child_or_default(repos, payload.child_id)
    night_of = payload.night_of or night_of_for(
        now_ms(), child.timezone, child.day_boundary_hour
    )
    existing = repos.notes.find_tag_note(child.id, night_of, payload.slug)

    if payload.on:
        if existing is not None:
            return _tag_result(child, payload.slug, night_of, True, existing, changed=False)
        label = payload.label or _label_for(config, payload.slug)
        note = repos.notes.create(
            child_id=child.id,
            night_of=night_of,
            body="",
            source="homekit",
            tags=[{"slug": payload.slug, "label": label}],
            autocreate_tags=config.api.notes.autocreate_tags,
        )
        result = _tag_result(child, payload.slug, night_of, True, note, changed=True)
    else:
        if existing is None:
            return _tag_result(child, payload.slug, night_of, False, None, changed=False)
        remaining = [t for t in existing.tags if t.slug != payload.slug]
        if remaining or existing.body.strip():
            # The note carries something else a human wrote; keep it and drop
            # only the tag this switch owns.
            note = repos.notes.update(
                existing.id,
                tags=[
                    {
                        "slug": t.slug,
                        "value_num": t.value_num,
                        "value_min_local": t.value_min_local,
                        "value_text": t.value_text,
                    }
                    for t in remaining
                ],
            )
        else:
            repos.notes.delete(existing.id)
            note = None
        result = _tag_result(child, payload.slug, night_of, False, note, changed=True)

    if result["changed"]:
        runtime.bus.publish(Topic.NOTE, {"action": "homekit_tag", **result}, child_id=child.id)
    return result


def _label_for(config: Config, slug: str) -> str:
    for switch in config.homekit.tag_switches:
        if switch.slug == slug:
            return switch.label
    return slug.replace("-", " ").capitalize()


def _tag_result(
    child: Child, slug: str, night_of: str, on: bool, note: Any, *, changed: bool
) -> dict[str, Any]:
    return {
        "child_id": child.id,
        "slug": slug,
        "night_of": night_of,
        "on": on,
        "changed": changed,
        "note": NoteOut.from_model(note, child.timezone).model_dump() if note else None,
    }


# ---------------------------------------------------------------------------
# HKSV recording markers
# ---------------------------------------------------------------------------


@router.post("/recording", response_model=dict)
def recording(
    payload: HomeKitRecordingRequest,
    repos: ReposDep,
    runtime: RuntimeDep,
    idempotency_key: IdempotencyKey = None,
) -> dict[str, Any]:
    """Mark an HKSV recording on the timeline so clips line up with events."""
    child = child_or_default(repos, payload.child_id)
    ts = now_ms()
    night_of = night_of_for(ts, child.timezone, child.day_boundary_hour)
    meta = {"reason": payload.reason, "stream_id": payload.stream_id}

    if payload.state == "started":
        event_id = repos.events.open(
            child_id=child.id,
            night_of=night_of,
            start_ms=ts,
            kind=EventKind.SYSTEM,
            label=EventLabel.HKSV_RECORDING,
            severity=Severity.INFO,
            source="homekit",
            meta=meta,
        )
        repos.syslog.add("info", "hksv", "recording started", **meta)
    else:
        event_id = _close_open_recording(repos, child, ts, meta)
        repos.syslog.add("info", "hksv", "recording stopped", **meta)

    runtime.bus.publish(
        Topic.SYSTEM,
        {"event": "hksv_recording", "state": payload.state, "event_id": event_id, "ts_ms": ts,
         **meta},
        child_id=child.id,
    )
    return {"ok": True, "event_id": event_id, "child_id": child.id, "night_of": night_of,
            "state": payload.state, "ts_ms": ts}


def _close_open_recording(repos: Repos, child: Child, ts: int, meta: dict[str, Any]) -> int | None:
    events, _ = repos.events.list(
        child_id=child.id, kinds=["system"], labels=[str(EventLabel.HKSV_RECORDING)],
        limit=5, order="desc",
    )
    for event in events:
        if event.is_open:
            repos.events.close(event.id, ts, meta={**event.meta, **meta})
            return event.id
    return None


# ---------------------------------------------------------------------------
# Pairing
# ---------------------------------------------------------------------------


@router.get("/pairing")
def pairing(config: ConfigDep) -> dict[str, Any]:
    """Pairing state read from the HAP persist directory, plus the setup code.

    Before the bridge has ever published, there is no ``AccessoryInfo`` file to
    read. That is a completely normal state — it is what a fresh install looks
    like — so it is reported as ``published: false`` with the setup code still
    filled in, rather than as an error the dashboard has to special-case.
    """
    hk = config.homekit
    username = hk.username or ""
    info, source = _load_accessory_info(config.paths.hap_dir, username)

    category = int(info.get("category", DEFAULT_HAP_CATEGORY)) if info else DEFAULT_HAP_CATEGORY
    pin = str(info.get("pincode") or hk.pin) if info else hk.pin
    setup_id = str(info.get("setupID") or hk.setup_id) if info else hk.setup_id
    paired_clients = list((info or {}).get("pairedClients", {}).keys())
    setup_uri = setup_payload(pin, setup_id, category)

    return {
        "enabled": hk.enabled,
        "published": info is not None,
        "paired": bool(paired_clients),
        "paired_clients": len(paired_clients),
        "accessory_name": (info or {}).get("displayName") or hk.name,
        "username": username,
        "category": category,
        "setup_code": pin,
        "setup_id": setup_id,
        "setup_uri": setup_uri,
        "qr_payload": setup_uri,
        "hap_dir": config.paths.hap_dir,
        "persist_file": source,
        "advertiser": hk.advertiser,
        "port": hk.port,
        "note": (
            None
            if info is not None
            else "The HomeKit bridge has not published yet, so there is no pairing "
            "state to read. Start the bridge, then add the accessory in the Home app."
        ),
    }


def _load_accessory_info(hap_dir: str, username: str) -> tuple[dict[str, Any] | None, str | None]:
    """Read hap-nodejs's ``AccessoryInfo.<MAC>.json``, if it is there yet.

    Named after the accessory's pseudo-MAC with the colons stripped. The
    configured username is tried first; failing that any single AccessoryInfo
    file in the directory is used, which covers a username changed in config
    after the bridge had already paired.
    """
    base = Path(hap_dir)
    candidates: list[Path] = []
    if _MAC_RE.match(username.upper()):
        candidates.append(base / f"AccessoryInfo.{username.replace(':', '').upper()}.json")
    with contextlib.suppress(OSError):
        candidates.extend(sorted(base.glob("AccessoryInfo.*.json")))
    for path in candidates:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict):
            return data, str(path)
    return None, None


def setup_payload(pin: str, setup_id: str, category: int = DEFAULT_HAP_CATEGORY) -> str:
    """Build the ``X-HM://`` setup URI a HomeKit QR code encodes.

    The layout is HAP's: an 8-byte value holding the version, reserved bits,
    the category, the "supports IP" flag and the eight-digit pin, rendered in
    base 36, zero-padded to nine characters, with the four-character setup id
    appended. Reimplemented here rather than shelled out to the bridge so the
    dashboard can show the pairing card before the bridge has ever started.
    """
    digits = re.sub(r"\D", "", pin)
    if not digits:
        return ""
    low = int(digits) | (1 << 28)  # supports IP
    if category & 1:
        # The category's low bit lives in the top byte of the low word.
        low |= 1 << 31
    value = low + (category >> 1) * 0x1_0000_0000
    encoded = _base36(value).rjust(9, "0")
    return f"X-HM://{encoded}{setup_id}"


def _base36(value: int) -> str:
    if value == 0:
        return "0"
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    out: list[str] = []
    while value:
        value, remainder = divmod(value, 36)
        out.append(alphabet[remainder])
    return "".join(reversed(out))
