# Privacy

There is a camera and a microphone in a child's bedroom. This document says
exactly what they record, where it goes, what leaves the device, and how to
delete it.

**The summary:** everything stays on the Pi. Two exceptions, both opt-in and
both off-able — HomeKit Secure Video clips go to your iCloud account, and a
notification webhook posts to whatever URL you configure. There is no telemetry,
no analytics, no crash reporting, no account, no cloud service, and no
component that phones home.

---

## What is recorded

### Continuously, to the database

One `samples` row every `sleep.sample_interval_s` (15 seconds by default), all
night, every night:

| Column | What it is |
|---|---|
| `sound_dbfs`, `sound_peak_dbfs` | Sound **level** over the interval. A number, not audio. |
| `noise_floor_dbfs` | The adaptive floor the detector was using. |
| `cry_score` | Highest cry-family classifier score, 0–1. |
| `motion` | Fraction-of-frame-changed score, 0–1. |
| `temp_c`, `humidity_pct`, `lux` | Environment. |
| `state` | What the sleep state machine believed at that instant. |

**No continuous audio is stored, and no continuous video is stored.** The
detector analyses audio in a rolling in-memory buffer and writes numbers. About
5,760 rows a day, ~2.1 million a year, a few hundred megabytes.

### Around detections, to disk

When an event opens, and only if the event is at or above
`audio.clips.min_severity` / `audio.snapshots.min_severity`:

- **an audio clip** — `clips.pre_s` (4 s) before and `clips.post_s` (6 s) after,
  Opus by default. Roughly ten seconds of actual sound.
- **a snapshot** — a single JPEG frame.

These are the only recordings of what the room actually sounded and looked
like, and they exist so you can check the classifier instead of trusting it.
They live under `paths.media_dir` with a row in `media`.

### Whenever you write it

Notes, tags and tag values — free text you typed, and switches you flipped.
This is the most personal data in the system, because it is the only part that
is *about your family* rather than about a room. It never leaves the Pi under
any configuration; there is no code path that sends notes anywhere.

### Operational

`system_log` and `events` of kind `system`: service starts and stops, camera
and microphone errors, HKSV recording start/stop, sensor failures. Plus the
systemd journal, which holds whatever the services logged at
`logging.level` (INFO by default — no note bodies, no audio, no images).

---

## Where it lives

Everything is under one directory, `paths.data_dir` (default
`/var/lib/babymon`, and it should be on your SSD):

```
babymon.db          SQLite: samples, events, notes, tags, nights, sleep_segments
babymon.db-wal      the write-ahead log
media/snapshots/    JPEG stills from events
media/clips/        Opus/AAC audio clips from events
media/video/        video clips, if any are configured
hap/                HomeKit pairing keys — the long-term keys of every paired iPhone
models/             YAMNet. Not personal data.
backups/            dated VACUUM INTO copies of the database
session.secret      signs dashboard cookies and media tokens
```

Permissions: the directory is `0750 babymon:babymon`, and
`/etc/babymon/babymon.env` (holding the dashboard password, the API token and
the HomeKit PIN) is `0640 root:babymon`.

**Full-disk encryption is not enabled by default and babymon does not encrypt
anything at rest.** If the Pi or the SSD is physically taken, the database and
the clips are readable. If that is in your threat model, put the data directory
on a LUKS volume — nothing in babymon cares, as long as it is mounted before
the services start.

---

## What leaves the device

### Nothing, by default, except your own LAN

The dashboard is served by the Pi over HTTP on your local network. The HomeKit
accessory is on your local network. The RTSP streams are bound to `127.0.0.1`
and are not reachable from off the Pi at all. No component contacts any
external service at runtime.

Things that *do* reach the internet, and only these:

| When | What |
|---|---|
| Install time | apt, npm, GitHub (MediaMTX), Kaggle (the YAMNet model). One-time. |
| HKSV, if enabled | Encrypted video fragments, to your Apple home hub, which uploads them to your iCloud. |
| A webhook, if configured | One JSON POST per qualifying event, to the URL you set. |
| Apple's own HomeKit traffic | Only if you have enabled remote access to your home. |

### HomeKit Secure Video → your iCloud

If `homekit.hksv.enabled` is true **and** you have turned recording on for the
camera in the Home app, clips leave the Pi.

The path is: Pi → your Apple TV or HomePod (the home hub, on your LAN) →
iCloud. The Pi never talks to Apple directly. Apple's design is
**end-to-end encrypted**: analysis happens on the home hub, and Apple states it
cannot view the footage.

- **Retention: 10 days**, then Apple deletes it. You cannot extend this.
- Footage does **not** count against your iCloud storage quota.
- Anyone you have shared your Home with can watch it.
- Deleting babymon, unpairing the accessory, or throwing the Pi in a lake does
  **not** delete clips already in iCloud. They age out on Apple's schedule.

**To turn it off:** in the Home app, camera settings → Recording Options →
Off. And/or on the Pi:

```yaml
homekit:
  hksv:
    enabled: false
```

Everything else — live view, sensors, tag switches, the entire dashboard and
all the analytics — works unchanged with HKSV off.

**To delete existing clips:** Home app → the camera → the timeline at the
bottom → select a clip → delete. Or delete the camera from the Home app, which
removes its stored recordings.

### Notification webhook → wherever you point it

```yaml
notifications:
  enabled: false                # off by default
  webhook_url: null
  webhook_headers: {}
  min_severity: "alert"
  quiet_hours: null
```

When enabled, a JSON POST goes to `webhook_url` for each event at or above
`min_severity`. The payload is the event object: timestamp, kind, label,
confidence, sound levels, and the child's ID. **This is data about your child
leaving your house, to a third party of your choosing** — ntfy.sh, a Slack
webhook, Home Assistant, a Pushover relay. Prefer a self-hosted endpoint, use
HTTPS, and if you use a public ntfy topic, remember that a public ntfy topic is
public: anyone who guesses the name receives your notifications.

The config loader refuses to start if `notifications.enabled` is true with no
URL, so this cannot be on by accident.

`GET /api/config` redacts `webhook_url` and `webhook_headers` along with the
password, tokens and PIN.

---

## Who can reach it

**The dashboard is password-protected by default** and `config.py` refuses to
start with `api.auth.enabled: true` and no password or token configured. It
will start with `api.auth.enabled: false`, but that means the live feed from
your child's bedroom is available to anything on your network — a guest, a
compromised smart plug, a neighbour on your Wi-Fi.

Two mechanisms: a session cookie (`POST /api/auth/login`, HttpOnly, 30 days)
for the dashboard, and bearer tokens for the bridge and scripting. Media
endpoints additionally accept a short-lived signed `?t=` query token so `<img>`
tags can work; it expires after `media_token_ttl_s` (1 hour).

**`GET /api/health` is always unauthenticated.** It reports status, uptime,
per-component booleans and a version string. No images, no levels, no data.

**The API binds `0.0.0.0:8080`** so you can reach it from your phone. It speaks
plain HTTP — a password over unencrypted HTTP on a LAN is weak, and you should
know that. If you want it encrypted, put a reverse proxy with TLS in front of
it; babymon does not terminate TLS itself.

**Do not port-forward this to the internet.** If you want access from outside,
use a VPN (WireGuard, Tailscale) or Apple's own remote access via your home
hub, which is end-to-end encrypted and does not involve opening a port. A
nursery camera on a public IP behind a password is how nursery cameras end up
on a website of nursery cameras.

**The RTSP streams have no authentication** because they are bound to
`127.0.0.1` and cannot be reached from elsewhere. If you edit
`deploy/mediamtx.yml` to bind a real interface, configure
`authInternalUsers` at the same time.

---

## Retention and deletion

### Automatic

```yaml
retention:
  samples_days: 400        # the telemetry series
  events_days: 400         # the event log
  audio_clips_days: 30     # actual recorded sound
  snapshots_days: 30       # actual recorded images
  video_clips_days: 14
  system_log_days: 30
  media_max_gb: 8.0        # hard cap; oldest media deleted first
  run_at: "03:30"
```

Set any of them to `0` to keep that class forever. The defaults keep sleep
history for over a year but keep **recordings** of the room for only a month —
that asymmetry is deliberate: the numbers are what the analytics need, and the
clips are only there so you can check a detection.

If you want the room never recorded at all:

```yaml
audio:
  clips:
    enabled: false
  snapshots:
    enabled: false
```

The detector still works; you just cannot listen back.

### By hand

```bash
# One night, everything about it
sqlite3 /var/lib/babymon/babymon.db \
  "DELETE FROM samples WHERE night_of='2026-08-10';
   DELETE FROM events  WHERE night_of='2026-08-10';
   DELETE FROM nights  WHERE night_of='2026-08-10';"
# then remove the matching files under media/, or let the pruner catch them
```

Deleting a child cascades — `notes`, `samples`, `events`, `media`,
`sleep_segments` and `nights` all have `ON DELETE CASCADE` on `child_id`. Note
that `DELETE /api/children/{id}` is a **soft** delete (`active=0`) and keeps
the history; a real delete is a SQL statement.

`DELETE /api/notes/{id}` is also soft (`deleted_ms` is set). To purge:

```sql
DELETE FROM notes WHERE deleted_ms IS NOT NULL;
```

### Everything

```bash
sudo deploy/uninstall.sh --purge-data --purge-config
```

It tells you how many nights it is about to destroy and requires you to type a
confirmation phrase. It cannot touch anything already in iCloud.

For a genuinely irrecoverable wipe on an SSD, `blkdiscard` the partition or use
the drive's secure-erase. Deleting files on flash does not overwrite them.

### Backups contain everything

`backup.dir` (default `$data_dir/backups`) holds up to `backup.keep` (7) dated
`VACUUM INTO` copies of the whole database. If you copy them off the Pi — and
you should — you have copied the notes, the events and the whole sleep history
to wherever you put them. Treat those files the same way you treat the
original.

---

## Exporting your own data

It is your data and it is in a plain SQLite file. No export API is required,
but there is one:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://pi:8080/api/analytics/export?format=csv&child_id=1" > nights.csv
```

That gives the full per-night factor matrix — every metric and every tag, one
row per night — for anyone who wants to do their own analysis in R or a
spreadsheet. Or just open `babymon.db` in any SQLite client; the schema is
documented in [ARCHITECTURE.md](ARCHITECTURE.md) and
`pi/babymon/storage/schema.sql`.

---

## Things worth thinking about

**A camera in a bedroom outlives the baby.** A toddler becomes a child becomes
someone with a reasonable expectation of privacy in their own room. Decide now
when it comes down, and tell them it is there when they are old enough to ask.

**Other people in the room are recorded too.** Every adult who settles the
child at 3 a.m. is on camera and in the audio clips. Tell them.

**The cry detector is not a listening device, but it uses a microphone.**
YAMNet runs locally, classifies into AudioSet categories, and no audio is
transmitted anywhere — but a microphone in a room is a microphone in a room,
and conversations near the cot end up in the ten-second clips saved around
detections. If that bothers you, `audio.clips.enabled: false`.

**Notes are a diary.** "Fed at 2, back to sleep by 2.30." "Bad day at daycare."
They are the most sensitive thing in the database and the least obviously so.

**Shared HomeKit access is full access.** Anyone you have shared your Apple
Home with can view the live camera and every HKSV clip. Check who is on that
list.

**This is not a medical device and its records are not medical records** — but
they are still health-adjacent information about a child. Think before you post
a screenshot of the analytics page in a parenting group; it contains bedtimes,
wake times and a location's name.
