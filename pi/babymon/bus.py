"""In-process publish/subscribe, and the contract between sensing and serving.

The sensing loops run in ordinary threads (audio callbacks, camera reads, a
GPIO poll) while the API runs in asyncio. Rather than have either side reach
into the other, everything meets here:

* Producers call :meth:`EventBus.publish` from any thread.
* Consumers — the SSE endpoint, the notifier — subscribe and get an async
  iterator, each with its own bounded queue. A slow consumer drops its own
  oldest messages and never blocks a producer, because a phone on a bad
  connection must not be able to stall the cry detector.

:class:`Runtime` is the handle the API layer is given. Defining it as a
protocol keeps the web layer testable without a camera, a microphone or a
Raspberry Pi.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
from collections import deque
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol, runtime_checkable

from .models import LiveState

log = logging.getLogger(__name__)

__all__ = [
    "MJPEG_BOUNDARY",
    "ComponentHealth",
    "EventBus",
    "Message",
    "NullRuntime",
    "Runtime",
    "Topic",
]

#: Multipart separator for the MJPEG preview. Browsers do not care what it
#: says, only that the body and the Content-Type agree — so both sides take
#: it from here rather than each spelling out their own.
MJPEG_BOUNDARY = "babymonframe"


class Topic(StrEnum):
    """SSE event names. These are API surface — renaming one breaks clients."""

    STATE = "state"
    EVENT_OPEN = "event.open"
    EVENT_CLOSE = "event.close"
    NOTE = "note"
    NIGHT = "night"
    MOTION = "motion"
    SOUND = "sound"
    HEARTBEAT = "heartbeat"
    SYSTEM = "system"


@dataclass(slots=True)
class Message:
    topic: Topic
    data: dict[str, Any]
    child_id: int | None = None
    ts_ms: int = 0


class EventBus:
    """Fan-out to any number of async subscribers, publishable from any thread."""

    def __init__(self, *, queue_size: int = 256) -> None:
        self._queue_size = queue_size
        self._subscribers: set[_Subscription] = set()
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._published = 0
        self._dropped = 0

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Tell the bus which event loop its subscribers live on.

        Called once by the API during startup. Publishing before this simply
        drops the message, which is correct: nobody is listening yet.
        """
        self._loop = loop

    def publish(self, topic: Topic, data: dict[str, Any], *, child_id: int | None = None) -> None:
        """Publish from any thread. Never blocks, never raises."""
        from .timeutil import now_ms

        message = Message(topic=topic, data=data, child_id=child_id, ts_ms=now_ms())
        self._published += 1
        loop = self._loop
        if loop is None:
            return
        with self._lock:
            subscribers = list(self._subscribers)
        if not subscribers:
            return
        for subscription in subscribers:
            # The loop may be closing, in which case the subscription is about
            # to be torn down anyway and the message has nowhere to go.
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(subscription.offer, message)

    def subscribe(
        self, topics: set[Topic] | None = None, child_id: int | None = None
    ) -> _Subscription:
        subscription = _Subscription(self, topics, child_id, self._queue_size)
        with self._lock:
            self._subscribers.add(subscription)
        return subscription

    def _unsubscribe(self, subscription: _Subscription) -> None:
        with self._lock:
            self._subscribers.discard(subscription)

    @property
    def stats(self) -> dict[str, int]:
        with self._lock:
            count = len(self._subscribers)
        return {"subscribers": count, "published": self._published, "dropped": self._dropped}

    def _note_drop(self) -> None:
        self._dropped += 1


class _Subscription:
    """One consumer's view of the bus."""

    def __init__(
        self,
        bus: EventBus,
        topics: set[Topic] | None,
        child_id: int | None,
        queue_size: int,
    ) -> None:
        self._bus = bus
        self._topics = topics
        self._child_id = child_id
        self._queue: deque[Message] = deque(maxlen=queue_size)
        self._waiter: asyncio.Future[None] | None = None
        self._closed = False

    def offer(self, message: Message) -> None:
        """Called on the event loop thread. Drops rather than blocks."""
        if self._closed:
            return
        if self._topics is not None and message.topic not in self._topics:
            return
        if (
            self._child_id is not None
            and message.child_id is not None
            and message.child_id != self._child_id
        ):
            return
        if len(self._queue) == self._queue.maxlen:
            self._bus._note_drop()
        self._queue.append(message)
        waiter = self._waiter
        if waiter is not None and not waiter.done():
            waiter.set_result(None)

    async def __aiter__(self) -> AsyncIterator[Message]:
        while not self._closed:
            if self._queue:
                yield self._queue.popleft()
                continue
            loop = asyncio.get_running_loop()
            self._waiter = loop.create_future()
            try:
                await self._waiter
            except asyncio.CancelledError:
                self.close()
                raise
            finally:
                self._waiter = None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._bus._unsubscribe(self)
        waiter = self._waiter
        if waiter is not None and not waiter.done():
            waiter.set_result(None)

    def __enter__(self) -> _Subscription:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ComponentHealth:
    name: str
    ok: bool
    detail: str = ""
    last_ok_ms: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "ok": self.ok,
            "detail": self.detail,
            "last_ok_ms": self.last_ok_ms,
            **self.extra,
        }


@runtime_checkable
class Runtime(Protocol):
    """What the web layer is allowed to ask of the sensing service.

    Deliberately small. Anything the API needs beyond this belongs in a
    repository query, not a reach into a live subsystem.
    """

    bus: EventBus

    def live_state(self, child_id: int) -> LiveState:
        """The current state snapshot for a child."""
        ...

    def snapshot(self, width: int | None = None, height: int | None = None) -> bytes | None:
        """Current camera frame as JPEG, or None when the camera is unavailable."""
        ...

    def mjpeg_stream(self, fps: float = 5.0, width: int | None = None) -> Iterator[bytes]:
        """Multipart MJPEG chunks for the dashboard preview.

        Parts are separated by :data:`MJPEG_BOUNDARY`, which the HTTP layer
        must repeat in the ``Content-Type``. The two live in one place because
        they silently disagreed once: the header advertised one boundary and
        the body used another, so no browser could find a single frame and the
        preview showed nothing at all, with no error anywhere to explain it.
        """
        ...

    def health(self) -> list[ComponentHealth]:
        """Per-subsystem health, for ``/api/health`` and the System page."""
        ...

    def recompute_night(self, child_id: int, night_of: str) -> None:
        """Rebuild one night's rollup, synchronously."""
        ...


class NullRuntime:
    """A runtime with no hardware behind it.

    Used by the test suite and by ``babymon serve --no-sensors``, so the API
    and dashboard can be developed on a laptop.
    """

    def __init__(self, bus: EventBus | None = None) -> None:
        self.bus = bus or EventBus()

    def live_state(self, child_id: int) -> LiveState:
        from .timeutil import now_ms

        return LiveState(ts_ms=now_ms(), child_id=child_id, night_of="")

    def snapshot(self, width: int | None = None, height: int | None = None) -> bytes | None:
        return None

    def mjpeg_stream(self, fps: float = 5.0, width: int | None = None) -> Iterator[bytes]:
        return iter(())

    def health(self) -> list[ComponentHealth]:
        return [ComponentHealth("sensors", False, "running without sensors")]

    def recompute_night(self, child_id: int, night_of: str) -> None:
        return None


def periodic(
    interval_s: float, fn: Callable[[], None], *, name: str, stop: threading.Event
) -> threading.Thread:
    """Run ``fn`` on a fixed interval in a daemon thread until ``stop`` is set.

    Exceptions are logged and swallowed: one failing sensor poll must not take
    the whole monitor down at three in the morning.
    """

    def loop() -> None:
        while not stop.wait(0):
            try:
                fn()
            except Exception:
                log.exception("periodic task %s failed", name)
            if stop.wait(interval_s):
                break

    thread = threading.Thread(target=loop, name=name, daemon=True)
    thread.start()
    return thread
