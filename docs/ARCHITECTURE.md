# Architecture

How babymon is put together, and why. Most of the decisions here exist because
of two hardware facts and one platform fact:

1. **A CSI camera can be opened exactly once.** Four things want the video.
2. **An ALSA capture device can be opened exactly once.** Two things want the
   microphone.
3. **HomeKit Secure Video is only properly implemented in one library**, and
   that library is JavaScript.

Everything else follows.

---

## The pieces

```
                                ┌──────────────────────────────────┐
                                │  MediaMTX  (systemd: babymon-    │
   Camera Module 3 NoIR ────────▶  mediamtx).  Opens libcamera     │
   (one libcamera open)         │  once; two streams out of it.    │
                                └───────┬──────────────────┬───────┘
                                        │                  │
                     rtsp://127.0.0.1:8554/babymon    .../babymon-lores
                     H.264 720p15, one hw encode      MJPEG 640x480@5
                                        │                  │
                    ┌───────────────────┘                  │
                    │                                      │
        ┌───────────▼─────────────┐          ┌─────────────▼──────────────────┐
        │  babymon-homekit        │          │  babymon-api                   │
        │  Node 22 + HAP-NodeJS   │          │  Python 3.11, one process      │
        │                         │◀── HTTP ─┤                                │
        │  • live stream (ffmpeg) │   + SSE  │  • FastAPI/uvicorn  (asyncio)  │
        │  • HKSV recording       │          │  • audio analyser   (thread)   │
        │  • prebuffer ring       │          │  • motion analyser  (thread)   │
        │  • sensors, tag switches│          │  • environment poll (thread)   │
        └───────────┬─────────────┘          │  • sleep state machine         │
                    │                        │  • nightly rollup + retention  │
              HAP over LAN                   └───────┬──────────────┬─────────┘
              mDNS via avahi                         │              │
                    │                          SQLite (WAL)    media files
              iPhone / Home hub                  babymon.db     snapshots, clips
                    │                                │              │
              iCloud (HKSV clips only)          ─────┴──────────────┴─────
                                                    paths.data_dir (SSD)

                                        ┌──────────────────────────┐
                                        │  dashboard (React/Vite)  │
                                        │  static files served by  │
                                        │  babymon-api at /        │
                                        └──────────────────────────┘

              microphone ──▶ ALSA dsnoop ──┬──▶ babymon-api (detector)
              (one hw open)                └──▶ ffmpeg in babymon-homekit
```

Three systemd units, deliberately. They fail independently: a crash in the
Python analysis does not take the video down, and a wedged ffmpeg in the bridge
does not stop the night from being recorded to the database.

---

## Why the camera is shared through MediaMTX

The naive design has the Python service open the camera with picamera2 and hand
frames to everyone who needs them. It falls apart immediately:

- The HomeKit bridge is a separate process in a different language. It cannot
  take a `picamera2` frame; it needs an H.264 elementary stream it can hand to
  ffmpeg or, better, copy straight through.
- Re-encoding for each consumer blows the encoder budget. The Pi 4's hardware
  H.264 encoder has a **total** capacity of roughly 1080p30 across all streams
  combined. Two independent encodes at anything like sensible quality do not
  fit.
- If Python owns the camera, every Python crash is a video outage, and the
  camera is the one thing you want up while you are debugging.

MediaMTX solves all three. It is a single static Go binary (ARM builds
available), it has a native `rpiCamera` source that talks to libcamera
directly, and it republishes over RTSP on the loopback. So:

**One encode, two consumers, zero re-encoding.** The `babymon` path is a single
hardware H.264 encode. The HomeKit bridge's live stream *copies* those packets
(`homekit.video.copy_video: true`); the HKSV recorder copies them too, remuxing
into fragmented MP4 rather than transcoding. The encoder does one job.

**A second stream for free.** The `babymon-lores` path sets
`rpiCameraSecondary: yes`, which is libcamera's dual-stream capability — a
second, scaled-down output from the *same camera open*. MediaMTX only offers
MJPEG for it, which turns out to be exactly right for analysis:

- decoding 640×480 MJPEG at 5 fps costs almost nothing;
- every frame is a keyframe, so `/api/snapshot.jpg` never waits for one;
- there is no inter-frame prediction, so a frame-difference motion detector
  sees real pixel changes rather than codec artefacts.

**The keyframe interval is a contract.** Every HKSV fragment must begin with an
IDR frame. `homekit.hksv.fragment_ms` (4000) and `rpiCameraIDRPeriod` in
`deploy/mediamtx.yml` have to agree:

```
rpiCameraIDRPeriod = fragment_ms / 1000 × fps        # 4 × 15 = 60
```

Get this wrong and HKSV either stalls waiting for a keyframe that is not coming
or emits fragments longer than the negotiated maximum, which HomeKit silently
drops. Change one, change the other.

**Consequence for the config.** With MediaMTX in place, `camera.source` is
`rtsp` and `camera.url` points at the low-res path — the Python service is a
*client*, not the camera owner. `camera.rtsp_url` still names the H.264 path,
because `/api/config` is how the bridge learns where to pull from. The
installer sets all three in `/etc/babymon/babymon.env`.

If you are not using MediaMTX (a USB webcam, or a Pi where nothing else wants
the camera) set `camera.source: picamera2` or `v4l2` and the Python service
opens the device itself. The `babymon-api` unit already allows the camera
devices for exactly this case.

---

## Why the microphone is shared through ALSA dsnoop

Same problem, cruder tool. The detector holds the microphone continuously; the
bridge's ffmpeg wants it whenever you open the camera in the Home app or HKSV
starts recording. Whichever opens second gets `EBUSY`, and because the bridge's
is the one that opens second, the symptom presents as "HomeKit has no audio".

`dsnoop` is ALSA's capture-side mixer: it opens the hardware once and fans the
same PCM out to every client. Point both `audio.device` and
`homekit.audio.device` at the same dsnoop device and the problem disappears.
`deploy/asound.conf.example` has a working configuration, including the I2S
MEMS case (fixed 48 kHz / S32_LE / stereo, which dsnoop cannot convert, so it
needs a `plug` wrapper on top) and a `dmix` device for talkback.

The other microphone rule, which has nothing to do with sharing: **turn AGC
off**. Automatic gain control continuously renormalises the level, so the
adaptive noise floor tracks a moving target and every threshold in
`audio.detector` stops meaning anything.

---

## Why the HomeKit bridge is Node when everything else is Python

Because HomeKit Secure Video is only properly supported in HAP-NodeJS.

This is not a preference. HKSV is a substantial, fussy protocol on top of HAP —
a separate HomeKit Data Stream connection, a negotiated set of selected
recording configurations, a fragmented-MP4 packet generator with strict rules
about what the first packet is and how long a fragment may be, and
characteristics (`RecordingAudioActive`, `Active`, `SelectedCameraRecordingConfiguration`)
that must be honoured exactly or the Home hub quietly stops recording. The
Python HAP implementations do not implement it. HAP-NodeJS does, it is what
Homebridge and Scrypted are built on, and it is the only implementation with
real-world coverage across Apple TV and HomePod hub versions.

So the bridge is Node 22 (`@homebridge/hap-nodejs` 2.x declares
`^22 || ^24 || ^26`; Bookworm ships Node 18, hence the NodeSource repository in
the installer) and it is deliberately **stateless**. Every characteristic it
publishes is read from the Python API:

- `GET /api/homekit/state` on a timer, and
- the SSE stream at `/api/stream/events` for `motion` and `sound` pushes.

It writes back through `POST /api/homekit/tag` (a switch was flipped) and
`POST /api/homekit/recording` (HKSV started or stopped, logged so the clips
line up with the timeline). It owns no database and caches nothing that
matters, which is why the two processes restart independently: a restart of the
API shows "No Response" in the Home app for a few seconds and then recovers.

The one piece of state the bridge does own is the HAP pairing keys in
`paths.hap_dir`. Lose that directory and every iPhone has to re-pair.

**The camera is a standalone accessory, not a bridged one.** HKSV behind a HAP
bridge ranges from unreliable to non-functional, so babymon publishes the
camera on its own with its own PIN. See [HOMEKIT.md](HOMEKIT.md).

**ffmpeg's codec support is probed, not assumed.** `homekit/src/camera/ffmpeg.ts`
runs `ffmpeg -encoders` at startup and only advertises to HomeKit what the
build can actually produce. This matters because Debian's ffmpeg has no
`libfdk_aac` — so no AAC-ELD — and a camera that advertises AAC-ELD, pairs
fine, streams video, and then dies the instant audio is negotiated is a
miserable thing to debug. Opus is advertised instead. HKSV recording audio is
AAC-LC, which the native encoder handles, so recording is unaffected.

---

## The Python service

One process, several threads, one database. Splitting the sensing loops into
their own units was considered and rejected: it would mean a second writer on
SQLite and an IPC hop on every 15-second sample tick, to solve a problem that
does not exist.

### Threading model

| Thread | What it does | Cadence |
|---|---|---|
| asyncio loop (main) | FastAPI/uvicorn: HTTP, SSE, MJPEG | event-driven |
| audio capture | reads PCM, computes level, runs the classifier when gated | frames every `audio.hop_s` (0.5 s) |
| motion | pulls the low-res MJPEG stream, frame-differences it | ~5 fps |
| environment | polls the I2C or GPIO sensor | `environment.poll_s` (60 s) |
| sampler / state machine | assembles a `Sample`, advances the sleep state | `sleep.sample_interval_s` (15 s) |
| housekeeping | retention pruning, `VACUUM INTO` backup, night rollups | daily at `retention.run_at` / `backup.run_at` |
| SQLite thread pool | FastAPI's `run_in_threadpool` for query endpoints | per request |

Two mechanisms keep this from becoming a tangle:

**`babymon.bus.EventBus`** is the only channel between the sensing threads and
the serving loop. Producers call `publish()` from any thread; consumers
subscribe and get an async iterator with its own bounded queue. A slow consumer
drops *its own* oldest messages and never blocks a producer — a phone on a bad
hotel wifi must not be able to stall the cry detector. `Topic` is API surface:
the enum members are the SSE event names in [API.md](API.md).

**`babymon.storage.db.Database`** keeps one SQLite connection per thread in
thread-local storage. `sqlite3` connections are not safe to share across
threads, and the WAL journal is what lets the API read while the sampler
writes without either blocking. `synchronous=NORMAL` is durable against a
process crash — only a power cut can lose the last transactions — and removes
an fsync from every commit, which matters a great deal if the database ever
does end up on an SD card.

**`babymon.bus.Runtime`** is a protocol, not a class. The API layer is handed
one and never reaches into the sensing code directly, so the whole web layer is
testable with `NullRuntime` and no camera, microphone, or Raspberry Pi.

### Error policy

Stated once in `config.py` and followed throughout: **errors that would
silently corrupt data are raised; errors that only degrade a feature are logged
and reported through the health endpoint.**

An unknown timezone, a `day_boundary_hour` of 25, a bedtime window that does
not parse, a detector with no hysteresis — these produce wrong *data*, quietly
and permanently, so `load_config()` refuses to start. A missing YAMNet model, a
sensor that is not wired up, a session secret that could not be persisted —
these degrade a feature, so they become `Config.warnings()`, a `system_log`
row, and a `degraded` component in `GET /api/health`.

---

## Data flow: from sensor to score

```
  microphone ──▶ level (dBFS) ──▶ adaptive noise floor (rolling percentile)
                     │                        │
                     ├── above floor + gate_db_above_floor?
                     │        └── yes ──▶ YAMNet ──▶ 521 class scores
                     │                                    │
                     │                        smoothing (smoothing_frames)
                     │                                    │
                     │                        label_thresholds ──▶ label
                     ▼                                    ▼
              hysteresis + min_duration + merge_gap ──▶  EVENT (audio/cry)
                                                          │
  camera ──▶ frame difference ──▶ motion score ──────────┤──▶ media: clip + snapshot
                     │                                    │
  I2C/GPIO ──▶ temp, humidity ──────────────┐             │
                                            ▼             ▼
                             every 15 s:  SAMPLE row   EVENT row
                                            │             │
                                            ▼             │
                              sleep state machine         │
                              (absent/awake/settling/     │
                               restless/asleep)           │
                                            │             │
                                            ▼             │
                                     SLEEP_SEGMENTS ◀─────┘
                                            │
                       ┌────────────────────┴────────────────────┐
                       ▼                                          ▼
            compute_metrics(segments, samples, events)   analyse_factors(nights, tags)
                       │                                          │
                       ▼                                          ▼
                 NightMetrics                              FactorAnalysis
                       │                                   /api/analytics/factors
                       ▼
              score_night(metrics, age, weights, sri, ...)
                       │
                       ▼
                  NIGHTS row  ──▶ /api/nights, /api/analytics/*
```

The rollup in `nights` is **entirely derived** from `samples`, `events` and
`sleep_segments`. It is safe to delete and rebuild — that is what
`POST /api/system/recompute` and `POST /api/nights/{night_of}/recompute` do,
and it is what makes hand-correcting an anchor work: you `PATCH` the anchor,
the night recomputes against the override, and every downstream metric and the
quality score follow.

Formulas for every metric and for the score are in [ANALYTICS.md](ANALYTICS.md).

---

## The database

SQLite in WAL mode, one file, at `paths.db`. The schema lives in
`pi/babymon/storage/schema.sql`; migrations in
`pi/babymon/storage/migrations.py`.

Four conventions run through it and are treated as contracts:

- **Every timestamp column is `*_ms`: integer Unix epoch milliseconds, UTC.**
  Never local time, never TEXT dates.
- **`night_of` is TEXT `'YYYY-MM-DD'` and names the *local* date a night
  began.** It is the join key for everything the analytics layer does. It is
  local by necessity: a "night" is a local concept and can be 23 or 25 hours
  long across a DST boundary. `babymon.timeutil.night_of` is the only thing
  allowed to compute it, using the child's `day_boundary_hour` (default 12, so
  anything up to noon still belongs to the previous evening's night).
- **Durations are `_s` (seconds) or `_min` (minutes), REAL.**
- **JSON columns hold an object, never a bare scalar.**

### Tables

**`children`** — one row per child. `birthdate` drives the AASM age band and
therefore the duration subscore; `day_boundary_hour` defines where one night
ends and the next begins; `timezone` overrides the site default per room.

**`tags`** and **`notes`** / **`note_tags`** — the human annotation layer.
A tag has a `value_type` (`bool`, `number`, `time`, `duration`, `text`) which
determines both which column in `note_tags` carries its value and how the
factor analysis treats it. `time` values are stored as minutes after local
midnight and may exceed 1440 or go negative, so that "lights off at 00:15" and
"lights off at 23:45" are three hours apart rather than twenty-one. `text` tags
are display-only; the analysis will not compare them.

**`samples`** — the continuous record, one row per `sleep.sample_interval_s`.
`WITHOUT ROWID` with `PRIMARY KEY (child_id, ts_ms)`, because it is always read
as a range scan over one child's time and the rowid indirection buys nothing.
This is the largest table by far: at 15 s intervals it is ~5,760 rows a day,
~2.1 M a year, and it is why `retention.samples_days` exists and why the
database belongs on an SSD. It is what the night timeline chart is drawn from
and what lets a night's state-machine decisions be reconstructed after the fact.

**`events`** — discrete things worth a line in the log. The
`corrected_label` column is the feedback loop: `NULL` means untouched, a string
means "it was actually this", and the empty string means "that was not a real
event". `compute_metrics` skips false positives entirely, so the tallies
reflect the night rather than the detector's mistakes, and the detector-tuning
report reads the corrections back. There is a partial index on open events
(`WHERE end_ms IS NULL`) because "is anything happening right now" is asked
several times a second and would otherwise scan.

**`media`** — snapshots and clips. `rel_path` is relative to
`paths.media_dir`, never absolute, so the data directory stays relocatable when
you finally move it to the SSD. `expires_ms` is what the retention pruner scans.

**`sleep_segments`** — the hypnogram: contiguous, non-overlapping, one state
each. `source` is `detector` or `manual`, and a manual segment always wins.

**`nights`** — the rollup, one row per child per night, `WITHOUT ROWID` on
`(child_id, night_of)`. Fully derived; delete and rebuild at will.
`score_components` is a JSON object holding the four subscores, the weights
actually used after renormalisation, the notes the scorer attached, and the
metrics that did not earn a column of their own (`sleep_efficiency_spt`,
`stirrings`, `fragmentation_index`, `tasafa_min`, `spt_min`). `status` is
`in_progress` / `complete` / `partial` / `excluded`, and only `complete`,
not-excluded nights with a score enter the statistics — that is
`Night.analysable`.

**`settings`** and **`system_log`** — key/value state and the append-only
operational log behind the dashboard's System page and `/api/system/log`.

### Retention

`retention.*` prunes on a schedule (`run_at`, default 03:30): samples and
events at 400 days, audio clips and snapshots at 30, video clips at 14, the
system log at 30, and a hard cap on total media size (`media_max_gb`, oldest
first). Setting any of them to 0 disables that class. The nightly backup at
03:45 is a `VACUUM INTO` of a dated copy, keeping `backup.keep` of them —
`VACUUM INTO` produces a compacted single file with no WAL beside it, which is
exactly what you want to copy off the Pi, and it is safe to run while the
service is live.

---

## Configuration

Three layers, lowest precedence first: dataclass defaults →
`config/babymon.yaml` → `BABYMON_*` environment variables (`__` for nesting,
values parsed as YAML). Values can reference each other with `${dotted.path}`.

The split that matters operationally: **the YAML is the file you could paste
into a forum post, and `/etc/babymon/babymon.env` holds everything you could
not.** The dashboard password, the bridge's bearer token, the HomeKit PIN, and
the deployment-specific camera URLs all live in the environment file, which
systemd loads via `EnvironmentFile=` and which is mode 0640 root:babymon.
`GET /api/config` redacts all of it.

## Process supervision

| Unit | Runs | Ordering |
|---|---|---|
| `babymon-mediamtx` | MediaMTX, owns the camera | after `network-online` |
| `babymon-api` | the Python service | after `network-online`, `sound.target`, `babymon-mediamtx` |
| `babymon-homekit` | the Node bridge | after `avahi-daemon` (required), `babymon-api`, `babymon-mediamtx` |

All three are `Restart=always` with a five-second delay and a ten-restarts-in-
five-minutes limit. All three are hardened with `ProtectSystem=strict` and an
explicit `ReadWritePaths`, `NoNewPrivileges`, `PrivateTmp` and a
`DevicePolicy=closed` allow-list.

The one hardening flag deliberately **not** used is `PrivateDevices=yes`. It is
the obvious choice and it is exactly wrong here: it replaces `/dev` with a
minimal private tmpfs, so the camera, the sound card, I2C and GPIO all vanish.
`DevicePolicy=closed` plus per-device `DeviceAllow` lines gets the same benefit
without breaking the thing the service exists to do. `MemoryDenyWriteExecute`
is likewise absent — V8 and the TFLite runtime both JIT.

`avahi-daemon` is a hard `Requires=` for the bridge, not a nicety: it is what
`homekit.advertiser: avahi` advertises through, and the alternative is
HAP-NodeJS's own responder fighting avahi for UDP 5353.
