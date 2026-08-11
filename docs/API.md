# babymon HTTP API contract

The Python service (`babymon.api`) is the **only** component that touches the
database. The HomeKit bridge and the dashboard are both clients of this API.
This document is the contract they are written against; the live OpenAPI
schema at `/api/openapi.json` (Swagger UI at `/api/docs`) is generated from
the implementation and must stay consistent with it.

Base URL: `http://<pi>:8080`. All JSON, UTF-8.

## Conventions

* Timestamps in JSON are **integer Unix epoch milliseconds, UTC**, on fields
  suffixed `_ms`. The API additionally emits `*_iso` (RFC 3339, with the
  child's local offset) on the handful of fields a human reads directly.
* `night_of` is `"YYYY-MM-DD"`, the local date a night began.
* Durations are minutes (`_min`) or seconds (`_s`), always as JSON numbers.
* List endpoints return `{"items": [...], "total": N, "limit": L, "offset": O}`.
* Errors return `{"error": {"code": "...", "message": "...", "detail": {...}}}`
  with a conventional HTTP status.
* Every mutating endpoint accepts an optional `Idempotency-Key` header.

## Authentication

Two mechanisms, both optional-but-on-by-default (`api.auth.enabled`):

1. **Session cookie** — `POST /api/auth/login` with `{"password": "..."}`
   sets an HttpOnly `babymon_session` cookie. Used by the dashboard.
2. **Bearer token** — `Authorization: Bearer <token>` against tokens in
   `api.auth.tokens`. Used by the HomeKit bridge and any scripting.

`GET /api/health` and the static dashboard assets are always unauthenticated.
The MJPEG/snapshot endpoints accept a short-lived signed `?t=` query token so
they can be used from `<img>` tags that cannot set headers.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/auth/login` | `{"password": "..."}` — sets the `babymon_session` cookie. |
| `POST` | `/api/auth/logout` | Clears the cookie. |
| `GET` | `/api/auth/me` | `{authenticated, auth_required, principal, media_token, media_token_ttl_s}`. Requires auth — a signed-out caller gets 401, which is the dashboard's cue to show the login page. With `api.auth.enabled: false` it returns `authenticated: true, auth_required: false, principal: "anonymous"` and a null `media_token`. |
| `GET` | `/api/auth/media-token` | Mints the signed `?t=` token for `<img>`/`<video>` sources. Same body as `/api/auth/me`; the token is in `media_token`, good for `media_token_ttl_s` seconds (3600). |

---

## System

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | `{"status":"ok"\|"degraded", "uptime_s":…, "version":"…", "components":{…}}`. Each component is an object — `{name, ok, detail, last_ok_ms, …}` — not a status string, and carries subsystem-specific extras (the camera entry has its resolution and motion stats, the audio entry its noise floor). Never authenticated; used by systemd and the bridge. |
| `GET` | `/api/system/info` | `{host:{hostname,system,release,machine,model,cpu_count,load_avg,uptime_s}, temperatures_c:{}, disk:{}, media:{}, database:{}, versions:{}, config_source, warnings:[]}`. Host facts are nested under `host`; temperatures are `temperatures_c`. |
| `GET` | `/api/system/log` | Recent `system_log` rows. |
| `GET` | `/api/metrics` | Prometheus text exposition. |
| `GET` | `/api/config` | Effective config, secrets redacted. |
| `POST` | `/api/system/recompute` | `{"from":"YYYY-MM-DD","to":"…","child_id":…}` — rebuild night rollups. |

## Children

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/children` | |
| `POST` | `/api/children` | `{name, birthdate?, room?, timezone?, target_bedtime?, target_waketime?, day_boundary_hour?}` |
| `PATCH` | `/api/children/{id}` | |
| `DELETE` | `/api/children/{id}` | Soft delete (`active=0`). |

## Live state

`GET /api/state?child_id=1`

```jsonc
{
  "ts_ms": 1770000000000,
  "ts_iso": "2026-08-10T20:00:00-07:00",
  "child_id": 1,
  "night_of": "2026-08-10",
  "state": "asleep",              // absent|awake|settling|restless|asleep|unknown
  "state_since_ms": 1769998800000,
  "asleep_for_min": 92.5,
  "sound_dbfs": -54.2,
  "noise_floor_dbfs": -58.0,
  "sound_above_floor_db": 3.8,
  "cry_score": 0.02,
  "motion": 0.004,
  "temp_c": 20.8,
  "humidity_pct": 47.0,
  "camera_online": true,
  "audio_online": true,
  "env_online": true,
  "night_so_far": { "tst_min": 88.0, "waso_min": 12.0, "awakenings": 1,
                    "cry_events": 1, "quality_score": 82.4 }
}
```

`GET /api/stream/events` — **Server-Sent Events**, the push channel used by
both the dashboard and the HomeKit bridge. Named events:

| SSE event | Payload |
|---|---|
| `state` | The `/api/state` body, emitted on every sample tick (default 15 s) and immediately on any state change. |
| `event.open` | An `Event` object whose `end_ms` is null. |
| `event.close` | The same `Event`, now closed. |
| `note` | `{"action": "created"\|"updated"\|"deleted"\|"homekit_tag", "note": {…}}`. The `Note` is wrapped so a client can tell a deletion from an edit; on `deleted` the object carries only `id`. |
| `night` | A `Night` rollup, when recomputed. |
| `motion` | `{"active": true\|false, "score": 0.12, "ts_ms": …}` — debounced motion, what the bridge maps onto the HomeKit motion sensor and uses to trigger HKSV. |
| `sound` | `{"active": true\|false, "label":"cry", "confidence":0.87, "peak_dbfs":-21.0, "ts_ms": …}` — the bridge maps this onto the HomeKit occupancy/"sound detected" sensor. |
| `system` | `{"event": "hksv_recording", …}` — service-level happenings worth showing on the timeline. Currently emitted by `POST /api/homekit/recording`. |
| `heartbeat` | `{"ts_ms": …}` every `api.sse_heartbeat_s` seconds (default 20) so clients can detect a dead link. The first frame on a new connection also carries `"subscribed": true`. |

Query params: `?child_id=`, `?types=state,motion,sound` to subscribe selectively.

## Media / camera

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/snapshot.jpg` | Current frame as JPEG. `?width=&height=&max_age_s=`. This is what the HomeKit bridge serves for snapshot requests. |
| `GET` | `/api/stream/mjpeg` | `multipart/x-mixed-replace` preview for the dashboard. `?fps=&width=`. |
| `GET` | `/api/media/{id}` | The stored file, correct `Content-Type`, supports `Range`. |
| `GET` | `/api/media/{id}/meta` | Row metadata. |
| `GET` | `/api/media?night_of=&kind=&event_id=` | List. |

The **live H.264/RTSP** feed the HomeKit bridge transcodes from is *not* served
by this API; it is published by the capture service to a local RTSP URL
(`camera.rtsp_url`, default `rtsp://127.0.0.1:8554/babymon`). `GET /api/config`
exposes that URL so the bridge does not need its own copy of the config.

## Events

`GET /api/events` — `?child_id=&night_of=&night_from=&night_to=&from_ms=&to_ms=&kind=&label=&min_confidence=&acknowledged=&exclude_false_positives=&limit=&offset=&order=`

`night_from`/`night_to` are an inclusive range of night keys and are the right
way to ask for "the last week". Resolving a night range into instants requires
the child's timezone and day-boundary hour, so a client that computes
`from_ms`/`to_ms` itself will use the browser's zone and return the wrong
events near the boundary to anyone away from home.

```jsonc
{
  "id": 4211, "child_id": 1, "night_of": "2026-08-10",
  "start_ms": 1770001200000, "end_ms": 1770001260000, "duration_s": 60.0,
  "kind": "audio", "label": "cry", "confidence": 0.87, "severity": "notice",
  "peak_dbfs": -18.3, "mean_dbfs": -27.9, "motion_peak": 0.31,
  "source": "detector", "corrected_label": null, "acknowledged_ms": null,
  "meta": {"classes": {"Baby cry, infant cry": 0.81, "Whimper": 0.22}},
  "media": [{"id": 990, "kind": "audio_clip", "duration_s": 12.0}]
}
```

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/events` | Manual event. `{child_id, start_ms, end_ms?, kind, label, meta?}` |
| `PATCH` | `/api/events/{id}` | `{corrected_label?, acknowledged?, severity?}`. Setting `corrected_label: ""` marks it a false positive; the detector-tuning report reads these. |
| `DELETE` | `/api/events/{id}` | Manual events only. |

## Notes and tags

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/notes` | `?child_id=&night_of=&from=&to=&tag=&q=&limit=&offset=` |
| `POST` | `/api/notes` | `{child_id, night_of?, ts_ms?, body, tags: [{slug, value_num?, value_min_local?, value_text?}]}`. If `night_of` is omitted it is derived from `ts_ms` (or now). Unknown tag slugs are **created on the fly** when `api.notes.autocreate_tags` is on — this is what lets the HomeKit bridge and a shortcut post `{"slug":"dessert-before-bed"}` without a setup step. |
| `PATCH` | `/api/notes/{id}` | Same body; `tags` replaces the whole set. |
| `DELETE` | `/api/notes/{id}` | Soft delete. |
| `GET` | `/api/tags` | `?include_archived=&with_stats=` — with stats, each tag carries `nights_applied`, `first_ms`, `last_ms`. |
| `POST` | `/api/tags` | |
| `PATCH` | `/api/tags/{id}` | |
| `DELETE` | `/api/tags/{id}` | Archives; never destroys history. |

A `Note`:

```jsonc
{
  "id": 77, "child_id": 1, "night_of": "2026-08-10",
  "ts_ms": 1769995800000, "ts_iso": "2026-08-10T19:30:00-07:00",
  "body": "ice cream after dinner, then two episodes",
  "source": "dashboard",
  "tags": [
    {"slug": "dessert-before-bed", "label": "Dessert before bedtime",
     "category": "food", "value_type": "bool"},
    {"slug": "screen-before-bed", "label": "Screen time before bed",
     "category": "screen", "value_type": "duration", "value_num": 44},
    {"slug": "lights-off", "label": "Lights off",
     "category": "routine", "value_type": "time", "value_min_local": 1170,
     "value_display": "19:30"}
  ],
  "created_ms": …, "updated_ms": …
}
```

## Nights

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/nights` | `?child_id=&from=&to=&limit=&include_excluded=` — the rollup rows. |
| `GET` | `/api/nights/{night_of}` | `?child_id=` — rollup **plus** `segments`, `events`, `notes`, and a downsampled `series` for the timeline chart. `?series_bucket_s=60` controls resolution. |
| `PATCH` | `/api/nights/{night_of}` | `{excluded?, exclude_reason?, bedtime_ms?, sleep_onset_ms?, final_wake_ms?, out_of_bed_ms?}` — manual correction of the anchors; triggers a recompute that respects the overrides. |
| `POST` | `/api/nights/{night_of}/recompute` | |
| `GET` | `/api/nights/{night_of}/series` | Just the time series, for charting. |

## Analytics

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/analytics/summary` | `?child_id=&days=30` — headline metrics, deltas vs the previous window, the age-appropriate target band, and the count of analysable nights. |
| `GET` | `/api/analytics/trends` | `?child_id=&metric=tst_min&days=90&bucket=night\|week` — series plus a fitted trend (Theil-Sen slope with a CI) and a rolling median. Weekly buckets carry `{week_of, value, median, n, min, max, p25, p75}`; `p25`/`p75` are null for a week with fewer than four nights, because an interpolated quartile over three points is noise drawn as a band. |
| `GET` | `/api/analytics/factors` | **The correlation engine.** `?child_id=&metric=quality_score&days=180&min_n=5`. |
| `GET` | `/api/analytics/regularity` | Sleep Regularity Index, bedtime/waketime variability, actogram raster data. |
| `GET` | `/api/analytics/patterns` | Awakening clock-time histogram, day-of-week effects, environment (temp/noise) vs outcome binning. |
| `GET` | `/api/analytics/export` | `?format=csv\|json` — the full per-night factor matrix, for anyone who wants to do their own analysis. |

`/api/analytics/factors` response, per tag:

```jsonc
{
  "metric": "quality_score", "window_days": 180,
  "nights_total": 142, "nights_analysable": 131,
  "method": {"test": "permutation", "iterations": 10000,
             "correction": "benjamini-hochberg", "alpha": 0.05},
  "factors": [
    {
      "slug": "dessert-before-bed", "label": "Dessert before bedtime",
      "value_type": "bool",
      "n_with": 23, "n_without": 108,
      "mean_with": 68.4, "mean_without": 79.1, "diff": -10.7,
      "diff_ci95": [-16.2, -5.1],
      "effect_size": {"name": "hedges_g", "value": -0.71,
                      "ci95": [-1.14, -0.28], "magnitude": "medium"},
      "cliffs_delta": -0.44,
      "p_value": 0.0031, "q_value": 0.019, "significant": true,
      "confounders": [{"slug": "screen-before-bed", "phi": 0.61}],
      "caveats": ["co-occurs with screen-before-bed on 17 of 23 nights"],
      "verdict": "worse"          // worse | better | inconclusive | insufficient_data
    }
  ],
  "insufficient": [{"slug": "travel", "n_with": 2, "reason": "n_with < min_n"}],
  "disclaimer": "Associations only. …"
}
```

For `value_type` `number`/`duration`/`time` the factor entry instead carries
`spearman_rho`, `rho_ci95`, `slope_per_unit`, `n`, and the same
`p_value`/`q_value` pair.

## HomeKit bridge support

These exist purely so the Node bridge can stay stateless.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/homekit/state` | Everything the bridge maps onto characteristics in one call: temp, humidity, motion, sound-detected, occupancy, current sleep state, and the tag-switch states for tonight. |
| `POST` | `/api/homekit/tag` | `{"slug":"dessert-before-bed","on":true,"child_id":1}` — a HomeKit switch was flipped; creates or removes tonight's note for that tag. Idempotent. |
| `POST` | `/api/homekit/recording` | `{"state":"started"\|"stopped","reason":"motion","stream_id":3}` — logs an `hksv_recording` system event so HKSV clips line up with the timeline. |
| `GET` | `/api/homekit/pairing` | Pairing state, setup code/URI and QR payload, so the dashboard can show the pairing card. |
