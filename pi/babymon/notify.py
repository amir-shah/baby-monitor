"""Outbound notifications.

A single webhook, deliberately. Everyone already has something that can receive
an HTTP POST — ntfy, Home Assistant, Slack, a shortcut — and building in one
provider's SDK would age badly and leak a token into the config file.

Two rules the code enforces rather than documents:

* Quiet hours are honoured, because a monitor that wakes you to tell you the
  child is awake has inverted its own purpose.
* Statistical findings are never notified. Pushing "dessert may be hurting his
  sleep" to a phone turns exploratory noise into anxiety; those live in a tab
  the parent chooses to open.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

from .config import Config
from .models import Child, Event, Severity
from .timeutil import from_ms, parse_hhmm

log = logging.getLogger(__name__)

__all__ = ["send_notification", "in_quiet_hours"]


def in_quiet_hours(config: Config, ts_ms: int) -> bool:
    window = config.notifications.quiet_hours
    if not window or len(window) != 2:
        return False
    local = from_ms(ts_ms, config.timezone).time()
    start, end = parse_hhmm(window[0]), parse_hhmm(window[1])
    if start <= end:
        return start <= local < end
    # A window that wraps past midnight, which is the normal case here.
    return local >= start or local < end


def send_notification(config: Config, event: Event, child: Child) -> bool:
    settings = config.notifications
    if not settings.enabled or not settings.webhook_url:
        return False
    if not Severity(event.severity).at_least(settings.min_severity):
        return False
    if in_quiet_hours(config, event.start_ms):
        log.debug("suppressing a notification during quiet hours")
        return False

    payload = {
        "title": f"{child.name}: {str(event.label).replace('_', ' ')}",
        "message": _describe(event, child, config),
        "priority": "high" if event.severity == Severity.ALERT else "default",
        "tags": [str(event.kind), str(event.label)],
        "event": {
            "id": event.id,
            "label": str(event.label),
            "severity": str(event.severity),
            "start_ms": event.start_ms,
            "duration_s": event.duration_s,
            "confidence": event.confidence,
            "night_of": event.night_of,
        },
    }
    request = urllib.request.Request(
        settings.webhook_url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **settings.webhook_headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status >= 400:
                log.warning("notification webhook returned HTTP %s", response.status)
                return False
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        log.warning("notification webhook failed: %s", exc)
        return False
    return True


def _describe(event: Event, child: Child, config: Config) -> str:
    when = from_ms(event.start_ms, child.timezone or config.timezone).strftime("%H:%M")
    duration = f" for {event.duration_s:.0f}s" if event.duration_s else ""
    confidence = f" ({event.confidence:.0%} confidence)" if event.confidence else ""
    return f"{str(event.label).replace('_', ' ').capitalize()} at {when}{duration}{confidence}"
