# Troubleshooting

Roughly ordered by how often each one bites. Every command here is one you
would actually run on a Bookworm Pi.

## First, the four commands

```bash
systemctl status babymon-mediamtx babymon-api babymon-homekit
curl -s localhost:8080/api/health | python3 -m json.tool
journalctl -u babymon-api -n 100 --no-pager
journalctl -f -u babymon-mediamtx -u babymon-api -u babymon-homekit
```

`/api/health` is never authenticated and gives a per-component verdict
(`camera`, `audio`, `env`, `db`). It is the fastest way to find out which half
of the system is unhappy. `GET /api/system/log` and the dashboard's System page
show the same thing with history, including config warnings and any overnight
thermal throttling.

---

## Camera not found

**Symptom:** `camera: false` in `/api/health`; `babymon-mediamtx` restarting;
`rpicam-hello` prints nothing.

Work outward from the hardware.

```bash
rpicam-hello --list-cameras
```

**Nothing at all, "no cameras available":**

```bash
# 1. Is the ribbon in properly, and was the Pi off when you seated it?
#    Blue side toward the Ethernet port on a Pi 4; contacts toward the lens
#    at the camera end. This is the answer more often than anything else.

# 2. Does the firmware see it?
dmesg | grep -iE 'imx|unicam|csi|rp1-cfe'
vcgencmd get_camera            # supported=1 detected=1  (legacy-ish but useful)

# 3. Is the camera auto-detect on?
grep -E 'camera_auto_detect|dtoverlay=imx' /boot/firmware/config.txt
#    Should have: camera_auto_detect=1
#    A Camera Module 3 on an old firmware may need: dtoverlay=imx708

# 4. Firmware and kernel current?
sudo apt update && sudo apt full-upgrade && sudo reboot
```

A **Pi 5 uses a different, 22-pin ribbon** than the Pi 4's 15-pin. A Pi 4
ribbon physically will not seat properly in a Pi 5 and vice versa.

**`rpicam-hello` works but MediaMTX does not:** something else has the camera.
The device can only be opened once.

```bash
sudo fuser -v /dev/video*
ps aux | grep -E 'rpicam|libcamera|python.*babymon|ffmpeg'
```

The usual culprit is `babymon-api` with `camera.source: picamera2` still set,
fighting MediaMTX for the device. With MediaMTX in play the Python service must
be an RTSP *client*:

```bash
grep CAMERA /etc/babymon/babymon.env
# BABYMON_CAMERA__SOURCE=rtsp
# BABYMON_CAMERA__URL=rtsp://127.0.0.1:8554/babymon-lores
# BABYMON_CAMERA__RTSP_URL=rtsp://127.0.0.1:8554/babymon
```

**Permission denied / "failed to allocate buffers":** the service user is not
in the right groups, or the DMA heap is not accessible.

```bash
id babymon                                  # want: video, render
ls -l /dev/video0 /dev/vchiq /dev/dma_heap/
sudo cp deploy/udev/99-babymon.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo systemctl restart babymon-mediamtx
```

Note that `usermod -aG` only takes effect for **new** processes — restart the
unit, or reboot.

**MediaMTX starts but the path is empty:** run it in the foreground and read
what libcamera says.

```bash
sudo systemctl stop babymon-mediamtx
sudo -u babymon /usr/local/bin/mediamtx /etc/babymon/mediamtx.yml
```

`unknown parameter` on an `rpiCamera*` key means your MediaMTX is older or
newer than these option names. `rpiCameraSecondary` needs **v1.10.0 or later**.

```bash
mediamtx --version
```

**The tuning file does not exist:**

```bash
ls /usr/share/libcamera/ipa/rpi/*/
```

Pi 4 and earlier use `vc4/`; Pi 5 uses `pisp/`. Fix the path in
`/etc/babymon/mediamtx.yml`.

---

## The stream is 5 fps, or every frame is blurred

**Symptom:** it says 15 fps in the config, `ffprobe` disagrees, night recordings
are smears.

This is auto-exposure choosing a 200 ms exposure in a dark room. libcamera then
extends the frame duration to fit it, and nothing logs an error.

```bash
ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8554/babymon 2>&1 | grep -i fps
```

Fix in `/etc/babymon/mediamtx.yml`:

```yaml
rpiCameraFPS: 15
rpiCameraShutter: 33000     # µs; 33 ms = 1/30 s
```

If the image is now too dark, add infrared or raise `rpiCameraGain` — **not**
the shutter. Full explanation in [HARDWARE.md](HARDWARE.md#cap-the-exposure-time).

---

## Motion events all night with nothing in the room

In order of likelihood:

1. **The autofocus is hunting.** Under flat IR there is no contrast to lock
   onto, and every hunt is a whole-frame change. Pin it:
   `rpiCameraAfMode: manual`, `rpiCameraLensPosition: 0.5`.
2. **IR hotspot glare off the cot bars.** Co-mounted illuminators reflect
   straight back into the lens, and the flare *moves*. Move the illuminator
   30–50 cm off-axis and diffuse it. This is a physical fix, not a settings
   fix.
3. **A window in frame.** Passing headlights. Mask it:
   `motion.masks: [[0.0, 0.0, 0.35, 0.5]]` — `[x, y, w, h]` as fractions of the
   frame.
4. **Thresholds too tight for your room.** Watch the live `motion` value on the
   dashboard for an evening, then raise `motion.on_threshold` above the noise
   floor you observe. Keep `off_threshold` well below it; the loader rejects a
   configuration with no hysteresis.
5. **The IR illuminator is switching on and off.** A step change in scene
   brightness triggers every time. Leave it on.

---

## HKSV never records

See [HOMEKIT.md](HOMEKIT.md#hksv-never-records) for the full list. The four
that account for most of it:

1. **Recording is not enabled in the Home app.** Per-camera, off by default,
   and pairing does not turn it on. Home app → hold the camera tile → settings
   → Recording Options.
2. **No home hub.** Apple TV 4K or HomePod. **An iPad is no longer supported.**
   Home Settings → Home Hubs & Bridges must say "Connected".
3. **iCloud+ tier too small.** 50 GB = one camera in the whole home.
4. **IDR period does not match `fragment_ms`.** Every fragment must start with
   a keyframe:
   ```
   rpiCameraIDRPeriod = fragment_ms / 1000 × fps      # 4 × 15 = 60
   ```

Then check the Pi actually saw a request:

```bash
curl -s "localhost:8080/api/events?kind=system&label=hksv_recording&limit=10" \
  | python3 -m json.tool
```

Nothing there means HomeKit never asked, and the problem is on the Apple side.
For the recording state machine itself:

```bash
sudo systemctl edit babymon-homekit     # [Service] Environment=DEBUG=HAP-NodeJS:HKSV
sudo systemctl restart babymon-homekit
journalctl -u babymon-homekit -f
```

Look for `selected recording configuration` — that is proof the hub asked. Turn
the debug channel off afterwards; it is very loud.

---

## The accessory appears and then vanishes / will not pair

The avahi vs ciao fight over UDP 5353.

```bash
grep ADVERTISER /etc/babymon/babymon.env      # want: avahi
systemctl is-active avahi-daemon
sudo ss -lunp | grep 5353
avahi-browse -rt _hap._tcp
```

`avahi-browse` should list the accessory with the Pi's address. Fix:

```bash
echo 'BABYMON_HOMEKIT__ADVERTISER=avahi' | sudo tee -a /etc/babymon/babymon.env
sudo systemctl restart babymon-homekit
```

Also check the iPhone is on the **same layer-2 network** — not a guest VLAN,
with AP isolation off. mDNS does not cross subnets.

**"Already paired":**

```bash
sudo systemctl stop babymon-homekit
sudo rm -rf /var/lib/babymon/hap/*
sudo systemctl start babymon-homekit
```

Remove the accessory in the Home app first.

---

## No audio in HomeKit

**The camera works, the video is fine, there is no sound.**

```bash
# 1. What can this ffmpeg actually encode?
ffmpeg -hide_banner -encoders | grep -E 'opus|fdk|aac'
```

Debian's ffmpeg has **no `libfdk_aac`**, so it cannot produce **AAC-ELD**,
which is HomeKit's preferred live codec. babymon probes at startup and
advertises Opus instead, which works. If you set
`homekit.audio.codec: libfdk_aac` on a stock ffmpeg you get a camera that pairs,
streams video, and dies the instant audio is negotiated.

```yaml
homekit:
  audio:
    enabled: true
    codec: "libopus"
```

HKSV **recording** audio is AAC-LC, which native ffmpeg produces fine — so this
only affects the live stream.

```bash
# 2. Is something else holding the microphone?
sudo fuser -v /dev/snd/*
# 3. Are both consumers pointed at the shared device?
grep -A2 'audio:' /etc/babymon/babymon.yaml
```

If `homekit.audio.device` is `default` or `hw:1,0` while the detector already
has the mic, ffmpeg gets `EBUSY` and you get silence. See the next section.

---

## Microphone busy / "Device or resource busy"

An ALSA capture device can be opened once. The detector holds it continuously.

```bash
sudo fuser -v /dev/snd/*
arecord -l
arecord -L | head -40
```

Install the shared-capture config and point both consumers at it:

```bash
sudo cp deploy/asound.conf.example /etc/asound.conf
sudoedit /etc/asound.conf              # set your card in the `slave { pcm ... }` lines
```

```yaml
audio:
  device: "babymon_mic"
homekit:
  audio:
    device: "babymon_mic"
```

```bash
sudo systemctl restart babymon-api babymon-homekit

# Prove two readers can coexist — this is the whole point:
arecord -D babymon_mic -f S16_LE -r 16000 -c 1 -d 5 /tmp/a.wav &
arecord -D babymon_mic -f S16_LE -r 16000 -c 1 -d 5 /tmp/b.wav
```

**"Invalid argument" from every client** usually means the `dsnoop` slave block
does not match the hardware. dsnoop cannot resample or reformat — the rate,
format and channel count in `slave { }` must be exactly what the device runs
at. This bites hardest with I2S MEMS mics, which are fixed at 48 kHz / S32_LE
and usually report stereo:

```bash
arecord -D hw:0,0 --dump-hw-params -d 1 /dev/null 2>&1 | head -30
```

Then make the slave block match, and let the `plug` wrapper on top convert.

**The card number changed.** ALSA numbers cards in probe order, so plugging in a
USB DAC renumbers everything and the detector silently records from the wrong
device. Use the by-name form from `arecord -L` (`hw:CARD=Device,DEV=0`) instead
of `hw:1,0`, or pin the index in `/etc/modprobe.d/`.

---

## Cry detection is wrong

**Everything triggers.** The threshold is too close to the floor for your room.

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/api/state \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["sound_dbfs"], d["noise_floor_dbfs"], d["sound_above_floor_db"])'
```

Watch that for ten minutes with the room as it will actually be — white-noise
machine on, door shut. Then raise `audio.detector.on_db_above_floor` above the
peaks you see from nothing. Keep `off_db_above_floor` below it.

**Nothing triggers.** Either the level is too low for the classifier gate to
open (`audio.classifier.gate_db_above_floor`, 6 dB) or the mic is too quiet.
Raise `audio.gain_db`, or the hardware capture level:

```bash
amixer -c 1 set 'Mic' 70%
```

**Everything is labelled "noise" or "unknown".** The model is not loaded.

```bash
ls -l /var/lib/babymon/models/
curl -s localhost:8080/api/health | python3 -m json.tool
sudo deploy/fetch-models.sh --dest /var/lib/babymon/models
sudo systemctl restart babymon-api
```

babymon falls back to the heuristic classifier when the model or the runtime is
missing, and says so in the health output rather than failing.

**Detection is erratic and the floor drifts.** AGC is on.

```bash
amixer -c 1 set 'Auto Gain Control' off
sudo alsactl store
```

This is the single most common cause of a detector that works one hour and not
the next.

**A specific label is consistently wrong.** Correct it in the dashboard — the
event log has a "was this right?" control that writes `corrected_label`, and
`""` marks a false positive. Corrections are excluded from the night's tallies
and feed the detector-tuning report. Then adjust
`audio.detector.label_thresholds` for that label.

---

## DHT22 returns None

**This is the part, not a bug.** The DHT22 is a bit-banged one-wire protocol
with microsecond timing requirements, and a Pi running a video pipeline and a
neural network will interrupt that timing. Failure rates of 10–30% under load
are normal.

**On a Pi 5 it does not work at all.** The RP1 southbridge replaced the legacy
GPIO peripheral; `pigpio` has no RP1 backend and the `libgpiod`/`pulseio` path
does not meet the timing. There is no configuration that fixes this.

Things that help on a Pi 4:

```bash
# The pull-up is not optional: 4.7–10 kΩ from DATA to 3V3.
# Keep the wire short — under 20 cm. Long wires are the second most common cause.
grep -E 'gpio_pin|poll_s' /etc/babymon/babymon.yaml    # poll_s >= 5
```

**The actual fix is a five-dollar part swap.** An SHT31, SHT4x or BME280 speaks
I2C, which is kernel-driven and never fails for timing reasons:

```bash
sudo raspi-config nonint do_i2c 0 && sudo reboot
i2cdetect -y 1                    # 0x44 = SHT31/SHT4x, 0x76/0x77 = BME280
```

```yaml
environment:
  sensor: "sht4x"
  i2c_bus: 1
  i2c_address: null
```

babymon treats a failed read as a gap rather than an error: the environment
subscore is dropped for that night and the rest is renormalised, rather than a
made-up value being averaged in. So a flaky DHT22 degrades the data quietly —
which is exactly why it is worth replacing.

**I2C sensor not detected:** check it is on 3V3 not 5V (the Pi's GPIO is not
5 V tolerant), that SDA/SCL are on pins 3 and 5, and that
`dtparam=i2c_arm=on` is in `/boot/firmware/config.txt`. `i2cdetect -y 1`
showing nothing but `--` means the bus is up and the device is not answering.

---

## Database is locked

**Symptom:** `sqlite3.OperationalError: database is locked` in the journal.

WAL mode means readers do not block the writer and the writer does not block
readers, so this should not happen in normal operation. When it does, it is one
of these:

**A second writer.** Two `babymon` processes, or you left a `sqlite3` shell open
with an uncommitted transaction.

```bash
sudo fuser -v /var/lib/babymon/babymon.db
ps aux | grep babymon
systemctl list-units 'babymon*'
```

**The database is on a network filesystem.** SQLite locking over NFS or SMB is
broken and unfixable. It must be on local storage.

**The filesystem is read-only** — usually SD card failure, sometimes
`ProtectSystem=strict` with the data directory not in `ReadWritePaths`:

```bash
mount | grep -E ' / | /mnt/ssd '        # look for "ro"
dmesg | grep -iE 'ext4.*error|I/O error|mmc'
grep ReadWritePaths /etc/systemd/system/babymon-api.service
```

If you moved `paths.data_dir` by hand, the unit's `ReadWritePaths=` must move
with it, or every write gets `EROFS`. Re-run the installer with `--data-dir`
and it fixes the unit for you.

**Recovery:**

```bash
sudo systemctl stop babymon-api
sqlite3 /var/lib/babymon/babymon.db 'PRAGMA integrity_check;'
sqlite3 /var/lib/babymon/babymon.db 'PRAGMA wal_checkpoint(TRUNCATE);'
sudo systemctl start babymon-api
```

If `integrity_check` reports anything other than `ok`, restore the most recent
backup — `VACUUM INTO` copies are consistent by construction:

```bash
ls -lt /var/lib/babymon/backups/
sudo systemctl stop babymon-api
sudo -u babymon cp /var/lib/babymon/backups/babymon-YYYYMMDD-HHMMSS.db \
                   /var/lib/babymon/babymon.db
sudo rm -f /var/lib/babymon/babymon.db-wal /var/lib/babymon/babymon.db-shm
sudo systemctl start babymon-api
```

A corrupt database on an SD card is a strong signal the card is failing. Move
to an SSD; see [HARDWARE.md](HARDWARE.md#storage-use-an-ssd).

---

## Disk full

```bash
df -h /var/lib/babymon
du -sh /var/lib/babymon/*
du -sh /var/lib/babymon/media/*
sqlite3 /var/lib/babymon/babymon.db \
  "SELECT 'samples', COUNT(*) FROM samples
   UNION ALL SELECT 'events', COUNT(*) FROM events
   UNION ALL SELECT 'media',  COUNT(*) FROM media;"
```

Three things grow: `samples` (5,760 rows a day), media files, and — the one
people miss — **the journal**.

```bash
journalctl --disk-usage
sudo journalctl --vacuum-size=200M
# Make it permanent, in /etc/systemd/journald.conf:
#   SystemMaxUse=200M
sudo systemctl restart systemd-journald
```

Turn the retention windows down and let the pruner catch up:

```yaml
retention:
  samples_days: 180
  audio_clips_days: 14
  snapshots_days: 14
  media_max_gb: 2.0
  run_at: "03:30"
```

Reclaiming space from SQLite after a big delete needs a vacuum — deleted pages
go on the free list, they do not shrink the file:

```bash
sudo systemctl stop babymon-api
sudo -u babymon sqlite3 /var/lib/babymon/babymon.db 'VACUUM;'
sudo systemctl start babymon-api
```

That needs free space roughly equal to the database size while it runs. If
there is none, `VACUUM INTO` a copy on another volume, then move it back.

Old backups are also a candidate: `backup.keep` defaults to 7 whole database
copies.

---

## A service will not start

```bash
systemctl status babymon-api
journalctl -u babymon-api -n 100 --no-pager
```

**`ConfigError: invalid configuration`.** The loader is strict about anything
that would silently produce wrong data and lists exactly what is wrong. Common
ones: an unknown timezone, `off_db_above_floor` not below `on_db_above_floor`,
`motion.off_threshold` not below `on_threshold`, auth enabled with no password.

Validate without starting the service:

```bash
sudo -u babymon /opt/babymon/venv/bin/python -c \
  "from babymon.config import load_config; c=load_config('/etc/babymon/babymon.yaml'); \
   print('ok'); [print('warn:',w) for w in c.warnings()]"
```

**`ModuleNotFoundError: picamera2`.** The venv was created before
`python3-picamera2` was installed, or without `--system-site-packages`.

```bash
/opt/babymon/venv/bin/python -c 'import picamera2'
sudo rm -rf /opt/babymon/venv
sudo deploy/install.sh --skip-apt --skip-node --skip-models --skip-mediamtx
```

**`error: externally-managed-environment` from pip.** You are outside the venv.
Bookworm is PEP 668; use `/opt/babymon/venv/bin/pip`, never the system `pip`.

**Permission denied writing somewhere.** `ProtectSystem=strict` makes the whole
filesystem read-only except `ReadWritePaths`. Check the path you are writing to
is listed in the unit.

**Node "Unsupported engine".** `@homebridge/hap-nodejs` 2.x needs Node 22, 24
or 26; Bookworm ships 18.

```bash
node --version
sudo deploy/install.sh --skip-apt --skip-models --skip-mediamtx
```

**The unit exits immediately with status 203/EXEC.** The `ExecStart` binary is
not there — usually a partial install, or `--prefix` was used once and not
again. Check `ls -l /opt/babymon/venv/bin/babymon`.

**"start request repeated too quickly".** Ten restarts in five minutes hit
`StartLimitBurst`. Fix the underlying cause, then:

```bash
sudo systemctl reset-failed babymon-api
sudo systemctl start babymon-api
```

---

## The Pi is throttling

**Symptom:** dropped frames, stuttering video, general sluggishness overnight
with nothing in the logs.

```bash
vcgencmd measure_temp
vcgencmd get_throttled
```

**Bits 16–18 are sticky**: they record that something happened *since boot*,
even if everything looks fine now. That is exactly what you want for a problem
that only occurs at 3 a.m.

| Value | Meaning |
|---|---|
| `0x0` | Clean. |
| `0x50000` | Under-voltage **and** throttling have occurred. |
| `0x50005` | Both, and it is happening right now. |

**Bit 16 (under-voltage) means the power supply.** Not the SD card, not the
software. Use the official 5 V / 3 A USB-C supply; a phone charger and a thin
cable is the usual cause. Under-voltage on a Pi 4 presents as camera dropouts
and USB disconnects rather than an obvious error.

**Bit 18 (throttling) means heat.** Soft limit 80 °C, hard limit 85 °C, and
neither can be raised. Use a passive aluminium case or fit heatsinks. Do not
fit a fan — it is a bedroom.

On a **Pi 5**, sustained software encoding will throttle without the Active
Cooler, and the Active Cooler is audible. This is the reason
[HARDWARE.md](HARDWARE.md) recommends a Pi 4.

babymon reads the sticky bits on every health check and surfaces them in
`GET /api/system/info`, so overnight throttling shows up as a line in the log.

---

## Nights are wrong

**Sleep is attributed to the wrong date.** `night_of` names the *local* date a
night began, and where one night ends is `day_boundary_hour` (default 12:00
local). Everything from noon until 11:59:59 the next day belongs to that first
date. If nights are landing on the wrong day, check the child's timezone and
that boundary — not the system clock.

```bash
timedatectl
curl -s localhost:8080/api/config | python3 -m json.tool | grep -A3 timezone
```

**Bedtime or wake is off by an hour or so.** The state machine only looks for a
night to begin inside `sleep.bedtime_window` (17:00–23:59) and to end inside
`sleep.wake_window` (04:00–11:00). An early bedtime or a 05:30 riser outside
those windows will not be detected. Widen them.

**A specific night is simply wrong.** Fix it by hand; the anchors are editable
and everything downstream recomputes against the override:

```bash
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sleep_onset_ms": 1770001200000}' \
  localhost:8080/api/nights/2026-08-10
```

Or exclude it entirely — illness, travel, a night in a hotel:

```bash
curl -X PATCH ... -d '{"excluded": true, "exclude_reason": "away"}' \
  localhost:8080/api/nights/2026-08-10
```

**No quality score.** Three possible reasons, and the API tells you which in
`score_components.suppressed_reason`: under four months old (deliberate — see
[ANALYTICS.md](ANALYTICS.md#part-2--age-bands)); coverage below
`scoring.min_coverage` (0.6); or no sleep detected at all.

**Rebuild the rollups** after changing config that affects them:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"from":"2026-07-01","to":"2026-08-10","child_id":1}' \
  localhost:8080/api/system/recompute
```

`nights` is entirely derived from `samples`, `events` and `sleep_segments` — it
is always safe to delete and rebuild.

---

## The analytics say "not enough nights"

Working as designed. A tag needs **10 nights with it and 10 without**, and the
window needs **20 analysable nights** overall, before any comparison runs.
`insufficient` entries carry a countdown of how many more nights are needed.

Note also that "analysable" means not excluded, status `complete`, **and a
quality score exists** — so nights suppressed for age or low coverage never
enter the statistics regardless of which outcome metric you selected.

Lowering `min_nights_per_group` below 10 is possible and `config.py` will warn
you about it, because below that the only detectable effects are ones you would
have noticed anyway and whatever crosses the line is biased upward in
magnitude. [ANALYTICS.md](ANALYTICS.md#part-5--what-this-cannot-tell-you) has
the reasoning.

---

## Dashboard problems

**404 or a blank page.** The static files are not where the API is looking.

```bash
grep STATIC_DIR /etc/babymon/babymon.env
ls /opt/babymon/web/index.html
sudo deploy/install.sh --skip-apt --skip-node --skip-models --skip-mediamtx
```

**Cannot log in.** The password is in the environment file:

```bash
sudo grep AUTH__PASSWORD /etc/babymon/babymon.env
```

To change it, edit that line and `sudo systemctl restart babymon-api`. Existing
sessions survive — they are signed with `session.secret`, not the password.

**The live view is stuck / SSE keeps reconnecting.** The event stream sends a
`heartbeat` every `api.sse_heartbeat_s` (20 s). If you have a reverse proxy in
front of babymon, it must not buffer: `/api/stream/events` is Server-Sent
Events and `/api/stream/mjpeg` is a never-ending multipart response. For nginx,
`proxy_buffering off;` and `proxy_read_timeout 3600s;`.

**MJPEG preview is black.** The low-res path is down.

```bash
ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8554/babymon-lores
journalctl -u babymon-mediamtx -n 50
```

---

## Getting more detail

```bash
# Turn the Python service up
sudo systemctl edit babymon-api      # [Service] Environment=BABYMON_LOGGING__LEVEL=DEBUG
sudo systemctl restart babymon-api

# HAP-NodeJS channels
sudo systemctl edit babymon-homekit  # [Service] Environment=DEBUG=HAP-NodeJS:HKSV

# MediaMTX
sudoedit /etc/babymon/mediamtx.yml   # logLevel: debug

# Run something in the foreground, without systemd in the way
sudo systemctl stop babymon-api
sudo -u babymon BABYMON_CONFIG=/etc/babymon/babymon.yaml \
  /opt/babymon/venv/bin/babymon run
```

Turn them all back down afterwards. DEBUG on the API writes a line per sample
tick, and `DEBUG=HAP-NodeJS:*` will fill the journal in an evening.

### What to include if you are asking for help

```bash
curl -s localhost:8080/api/health
curl -s localhost:8080/api/system/info      # model, kernel, temps, versions
vcgencmd get_throttled
journalctl -u babymon-api -n 200 --no-pager
```

`GET /api/config` returns the effective configuration with the password, tokens,
PIN and webhook redacted — safe to paste. The raw `/etc/babymon/babymon.env` is
not.
