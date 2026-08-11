# Installation

Target: **Raspberry Pi OS Bookworm, 64-bit**, on a **Raspberry Pi 4**. Trixie
works. Other Debian-family systems probably work; other Pi models work with the
caveats in [HARDWARE.md](HARDWARE.md).

If you want to know *why* any particular step is the way it is, the reasoning
is in [ARCHITECTURE.md](ARCHITECTURE.md) and [HARDWARE.md](HARDWARE.md). This
document is the sequence.

---

## The short version

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/<you>/baby-monitor.git
cd baby-monitor
sudo deploy/install.sh --data-dir /mnt/ssd/babymon
```

Then edit `/etc/babymon/babymon.yaml`, restart `babymon-api`, and open
`http://<pi>:8080/`.

The rest of this page is what each step does, what it needs, and what to do
when one of them fails.

---

## 1. Before you start

**Flash Raspberry Pi OS Bookworm 64-bit.** Lite is fine and preferable — the
dashboard is served by babymon over HTTP, not by a desktop. Use the Raspberry
Pi Imager's settings gear to set the hostname, enable SSH, create your user and
configure Wi-Fi before writing the card.

**64-bit matters.** The YAMNet runtime (`ai-edge-litert`) has no armv7 wheel, so
a 32-bit userland falls back to the heuristic cry classifier. It still works;
it is just less accurate.

**Connect the camera with the Pi powered off.** On a Pi 4, the blue side of the
ribbon faces the Ethernet port; at the camera end, the contacts face the lens.

**Mount your SSD and put it in `/etc/fstab`** before installing, so the
installer can point everything at it from the start. See
[HARDWARE.md](HARDWARE.md#storage-use-an-ssd). This is the one thing that is
annoying to change later.

**Enable I2C** if you fitted a proper environment sensor:

```bash
sudo raspi-config nonint do_i2c 0
sudo reboot
i2cdetect -y 1        # 0x44 = SHT31/SHT4x, 0x76/0x77 = BME280
```

**Check the camera is seen:**

```bash
rpicam-hello --list-cameras
```

If that prints nothing, stop and fix it before going further — see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#camera-not-found).

---

## 2. Run the installer

```bash
git clone https://github.com/<you>/baby-monitor.git
cd baby-monitor
sudo deploy/install.sh --data-dir /mnt/ssd/babymon
```

`deploy/install.sh` is **idempotent**. Re-running it after a `git pull` is the
supported upgrade path, and it will never overwrite:

- `/etc/babymon/babymon.yaml` — your configuration
- `/etc/babymon/babymon.env` — your generated secrets
- the database or anything else under the data directory

Everything else — the venv, the built dashboard, the bridge, the systemd units
— is rebuilt in place every run.

### What it does, in order

| Step | Detail |
|---|---|
| 1. Host checks | Reads `/proc/device-tree/model` and `/etc/os-release`. Warns about a Pi 5 (no hardware encoder, fan), a Zero 2 W (no HKSV), or a 32-bit userland. |
| 2. apt | Installs Python, ffmpeg, ALSA utilities, avahi and the usual tools (required — a failure aborts), then `python3-picamera2`, the GPIO/I2C libraries, PortAudio and friends (optional — anything this archive does not offer is reported and skipped). Skips anything already present. |
| 3. Node | Checks for Node 22, 24 or 26. Bookworm ships 18, which `@homebridge/hap-nodejs` 2.x will not run on, so it adds the NodeSource repository and installs Node 22. |
| 4. User | Creates the `babymon` system user and adds it to `video`, `render`, `audio`, `gpio`, `i2c`. Creates and chowns the directories. Warns if the data directory is on the SD card. |
| 5. venv | `python3 -m venv --system-site-packages /opt/babymon/venv`, then installs the `babymon` package plus best-effort extras. |
| 6. Dashboard | `npm ci && npm run build` in `dashboard/`, output rsynced to `/opt/babymon/web`. |
| 7. Bridge | `npm ci && npm run build` in `homekit/`, output plus a production-only `node_modules` copied to `/opt/babymon/homekit`. |
| 8. Models | `deploy/fetch-models.sh` downloads YAMNet and the AudioSet class map, verifying sizes. |
| 9. MediaMTX | Resolves the latest release from the GitHub API, downloads the right ARM build, installs to `/usr/local/bin/mediamtx` and the config to `/etc/babymon/mediamtx.yml`. |
| 10. Config | Copies `config/babymon.example.yaml` to `/etc/babymon/babymon.yaml` if absent. Generates `/etc/babymon/babymon.env` with a random password, token and PIN if absent. |
| 11. udev, logrotate | Installs device permission rules and a rotation policy. |
| 12. systemd | Installs, enables and starts three units, rewriting paths if you passed `--prefix` or `--data-dir`. |
| 13. Summary | Prints the generated password and PIN **once**, plus what to do next. |

**Write down the password and PIN.** They are in
`/etc/babymon/babymon.env` if you lose them, but they are only printed once.

### Options

```
--skip-apt         --skip-node        --skip-dashboard
--skip-homekit     --skip-models      --skip-mediamtx
--no-enable        --no-restart
--prefix DIR       --conf-dir DIR     --data-dir DIR     --user NAME
```

A network-restricted rebuild, for instance:

```bash
sudo deploy/install.sh --skip-apt --skip-node --skip-models --skip-mediamtx
```

### If a step fails

The installer uses `set -euo pipefail`, so it stops at the first hard failure
and tells you which one. Optional things (the litert wheel, the model download,
a build with no npm) become warnings and are collected at the end. Fix the
cause and re-run — it will skip everything that already succeeded.

**apt fails.** Usually a stale index or a mirror hiccup:
`sudo apt update --fix-missing`. Note that only the required set aborts the
run; an optional package the archive does not carry produces a warning like
*"python3-lgpio is not in this archive; skipping"* and the install continues.
If `python3-picamera2` is one of them you are probably not on Raspberry Pi OS
— there is no equivalent on plain Debian, and the camera will have to come from
MediaMTX, a USB webcam or an RTSP source, which is the recommended arrangement
in any case.

**Node installation fails.** Install it yourself with `nvm`, `fnm` or your
preferred method, make sure `node --version` reports 22, 24 or 26, and re-run
with `--skip-node`.

**The model download fails.** Kaggle occasionally requires accepting the model
licence in a browser. Set `audio.classifier.backend: heuristic` and carry on;
retry later with `sudo deploy/fetch-models.sh --dest /mnt/ssd/babymon/models`.

**MediaMTX fails.** Download the ARM build yourself from
`github.com/bluenviron/mediamtx/releases`, `sudo install -m0755 mediamtx
/usr/local/bin/`, and re-run with `--skip-mediamtx`. You need **v1.10.0 or
newer** for `rpiCameraSecondary`.

**A service does not start.** `journalctl -u babymon-api -n 50` and see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## 3. Configure

```bash
sudoedit /etc/babymon/babymon.yaml
```

Every key is documented inline in `config/babymon.example.yaml`; the file you
just got is a copy of it, so all the defaults are already written down with
their reasoning. The minimum worth setting:

```yaml
site:
  name: "Nursery"
  timezone: "Europe/London"     # get this right — every "night" depends on it

children:
  - name: "Ada"
    birthdate: "2025-04-02"     # drives the age band and the quality score
    room: "Nursery"
    day_boundary_hour: 12
    target_bedtime: "19:00"
    target_waketime: "06:45"

paths:
  data_dir: "/mnt/ssd/babymon"  # must match --data-dir

environment:
  sensor: "sht4x"               # or bme280, sht31, dht22, none
```

Then:

```bash
sudo systemctl restart babymon-api
curl -s localhost:8080/api/health | python3 -m json.tool
```

`load_config()` is strict about anything that would silently produce wrong data
— an unknown timezone, a `day_boundary_hour` outside 0–23, a detector with no
hysteresis — and will refuse to start with a list of what is wrong. Things that
only degrade a feature (a missing model, an unwired sensor) become warnings and
appear in `GET /api/health` and on the dashboard's System page.

### Secrets go in the environment file

`/etc/babymon/babymon.env` (mode 0640, `root:babymon`) holds the dashboard
password, the bridge's bearer token, the HomeKit PIN and the camera URLs.
Anything in the YAML can be overridden there with `BABYMON_` + the dotted path,
uppercased, `__` between levels:

```
BABYMON_API__AUTH__PASSWORD=…
BABYMON_AUDIO__DEVICE=babymon_mic
BABYMON_ENVIRONMENT__SENSOR=sht4x
```

Values are parsed as YAML, so `true`, `12` and `['a','b']` arrive with the
right type. The idea is that the YAML is the file you could paste into a forum
post and the env file is everything you could not.

---

## 4. Audio

The two things that matter, in order of how much they matter:

**Turn AGC off.**

```bash
arecord -l                                       # find the card number
amixer -c 1 controls | grep -i 'gain\|agc'
amixer -c 1 set 'Auto Gain Control' off
amixer -c 1 set 'Mic' 60%
sudo alsactl store
```

AGC continuously moves the noise floor, which makes every threshold in the cry
detector meaningless. Most cheap USB mics ship with it on.

**Share the device**, if HomeKit audio is enabled — and it is by default. The
detector holds the mic continuously and the bridge's ffmpeg wants it too.

```bash
sudo cp deploy/asound.conf.example /etc/asound.conf
sudoedit /etc/asound.conf          # set your card in the slave pcm lines
```

Then in `/etc/babymon/babymon.yaml` (or the env file):

```yaml
audio:
  device: "babymon_mic"
homekit:
  audio:
    device: "babymon_mic"
```

Verify two readers can coexist, which is the entire point:

```bash
arecord -D babymon_mic -f S16_LE -r 16000 -c 1 -d 5 /tmp/a.wav &
arecord -D babymon_mic -f S16_LE -r 16000 -c 1 -d 5 /tmp/b.wav
```

Both must succeed.

---

## 5. Camera

The installer wrote `/etc/babymon/mediamtx.yml`, but three settings depend on
your physical setup and are worth going back for. All are explained in
[HARDWARE.md](HARDWARE.md):

```yaml
rpiCameraTuningFile: /usr/share/libcamera/ipa/rpi/vc4/imx708_noir.json
rpiCameraLensPosition: 0.5      # pin the focus; AF hunting reads as motion
rpiCameraShutter: 33000         # cap the exposure; otherwise 15 fps becomes 5
```

Check both streams:

```bash
ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8554/babymon         # H.264 720p15
ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8554/babymon-lores   # MJPEG 640x480
```

Grab a frame and actually look at it, in the dark:

```bash
ffmpeg -rtsp_transport tcp -i rtsp://127.0.0.1:8554/babymon-lores \
       -frames:v 1 -y /tmp/frame.jpg
```

You are checking for: the cot in frame, sharp focus, and **no hotspot glare off
the cot bars**. That last one is the biggest single source of motion false
positives, and the fix is physical — move the illuminator off-axis and diffuse
it.

---

## 6. HomeKit

Pairing, HKSV setup and the mDNS conflict are all in
[HOMEKIT.md](HOMEKIT.md). The two-line version:

```bash
sudo grep HOMEKIT__PIN /etc/babymon/babymon.env
curl -s localhost:8080/api/homekit/pairing | python3 -m json.tool
```

Home app → **+** → Add Accessory → scan the QR from the dashboard's System page
or pick the accessory by name and type the PIN.

**Pairing does not enable HKSV.** Recording is a per-camera setting inside the
Home app, and it is off by default.

---

## 7. Verify

```bash
systemctl status babymon-mediamtx babymon-api babymon-homekit
curl -s localhost:8080/api/health | python3 -m json.tool
curl -s localhost:8080/api/state  | python3 -m json.tool     # needs auth
journalctl -f -u babymon-mediamtx -u babymon-api -u babymon-homekit
```

`/api/health` reports `ok` or `degraded` with a per-component breakdown
(`camera`, `audio`, `env`, `db`). `degraded` with `env: false` and a DHT22
fitted is entirely normal — see [HARDWARE.md](HARDWARE.md).

Then open `http://<pi>:8080/`, log in with the generated password, and **watch
it for an evening before trusting any threshold.** The live view shows
`sound_dbfs`, `noise_floor_dbfs`, `sound_above_floor_db` and `motion` in real
time. Adjust `motion.on_threshold` and `audio.detector.on_db_above_floor` to
your actual room, with the white-noise machine on if you use one. The defaults
are reasonable starting points, not answers.

---

## Upgrading

```bash
cd baby-monitor
git pull
sudo deploy/install.sh
```

Rebuilds everything, leaves config and data alone, restarts the services.
Database migrations run automatically on the first connection after start
(`pi/babymon/storage/migrations.py`; `user_version` in the file is compared
against `SCHEMA_VERSION` on open).

Take a backup first if the release notes mention a migration:

```bash
make backup DATA_DIR=/mnt/ssd/babymon
```

`VACUUM INTO` produces a compacted single file with no WAL beside it, and is
safe to run while the service is live.

---

## Uninstalling

```bash
sudo deploy/uninstall.sh                 # services and code; keeps config and data
sudo deploy/uninstall.sh --purge-config  # also /etc/babymon
sudo deploy/uninstall.sh --purge-data    # also the database and every recording
sudo deploy/uninstall.sh --all
```

The data purge requires typing a confirmation phrase, and tells you how many
nights of history it is about to destroy. Remove the accessory in the Home app
too, or it sits there showing "No Response" forever.

---

## Development, without a Pi

```bash
make dev                       # venv, editable install, dev tools
make test
make lint typecheck

cp config/babymon.example.yaml config/babymon.yaml
pi/.venv/bin/python -m babymon --config config/babymon.yaml serve

cd dashboard && npm run dev    # :5173, proxies /api to :8080
cd homekit   && npm run dev
```

Set `camera.source: synthetic` and `audio.classifier.backend: heuristic` and
the whole thing runs on a laptop with no hardware attached. `make check` runs
what CI would.
