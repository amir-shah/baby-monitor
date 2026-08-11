# babymon

A baby sleep monitor that runs entirely on a Raspberry Pi in your nursery.
Camera and cry detection, an event log you can correct, notes and tags you can
attach to a night, statistics that try hard not to lie to you, and a real
HomeKit accessory with HomeKit Secure Video.

Everything runs on the Pi. Nothing is uploaded anywhere, there is no account,
there is no app store listing, and there is no company that can decide to
discontinue the service or start charging for the feed of your child's bedroom.
The single exception is HomeKit Secure Video, which by design stores clips in
your own iCloud account — and you can turn that off.

---

## ⚠️ Read this first

**babymon is not a medical device. It does not monitor breathing, heart rate,
or oxygen. It cannot detect that a baby is in distress, and it must never be
used to reduce the risk of SIDS.**

The American Academy of Pediatrics explicitly recommends *against* home
cardiorespiratory monitors as a strategy for reducing the risk of SIDS. Their
concern is not only that these devices do not work for that purpose — it is
that they create **false reassurance**, and that a parent who trusts a monitor
may relax the things that genuinely do reduce risk.

Those things are: the baby on their back, on a firm flat surface, in their own
sleep space, with nothing soft in it, in a room-sharing (not bed-sharing)
arrangement for the first six months. No camera changes any of that. Follow the
AAP's safe sleep guidance and your paediatrician, not this repository.

What babymon actually is: a well-built nursery camera with a decent cry
detector and an honest sleep diary. It answers "did he sleep through?", "what
time did she wake and for how long?", and "does dessert before bed actually
wreck bedtime, or does it just feel that way?" It does not answer "is my baby
okay right now". Go and look.

---

## What you get

**A camera you can actually see in the dark.** A NoIR sensor and an off-axis
940 nm illuminator: invisible to the eye, no red glow over the cot, no hotspot
glare off the bars. Focus is pinned manually, because autofocus hunts under
flat infrared and every hunt looks like movement.

**Cry detection that knows the difference between a cry and a lorry.** YAMNet,
Google's AudioSet classifier, running locally on the Pi, gated behind an
adaptive noise floor so it stays asleep through a quiet night and works in a
room with a white-noise machine running. Cries, fussing, whimpering, coughing,
talking, and doors are separate labels. Each detection saves a short audio clip
and a snapshot, so you can hear what it actually was instead of trusting a
score — and mark it wrong when it is wrong. The detector-tuning report reads
those corrections back.

**A night, reconstructed.** A hypnogram built from stillness and quiet, with
the four anchors a sleep diary cares about — in bed, asleep, final wake, out of
bed — and everything derived from them: time in bed, total sleep, how long it
took to go down, how much of the night was spent awake, how many real
awakenings (as opposed to stirrings), the longest unbroken stretch. Any anchor
the detector got wrong you can drag to the right place, and the whole night
recomputes.

**Notes and tags.** "Ice cream after dinner." "Two episodes." "Lights off
19:30." "Teething." Free text, tags with values (44 minutes of screen time,
lights off at 19:30), and a Siri-accessible switch in the Home app for the ones
you log every day, so you can say *"Hey Siri, dessert before bed"* from the
kitchen instead of opening a dashboard.

**Statistics that refuse to answer.** Point the factor analysis at a tag and it
will tell you what tended to happen on those nights — with a permutation test
whose null preserves the fact that both sleep and habits come in runs,
Benjamini-Hochberg across every test it ran (not every test it showed you),
empirical-Bayes shrinkage so a tag with eleven nights cannot top the list on
noise alone, a confound check for tags that co-occur, a drift check for tags
that only appear in one stretch of the record, and a reverse-causality check
for tags that line up with the *previous* night just as well. Below ten nights
per group it shows you a progress counter instead of a number. See
[docs/ANALYTICS.md](docs/ANALYTICS.md) — the honest section at the end is the
important one.

**A proper HomeKit accessory.** Live video and audio in the Home app, motion
and sound sensors, temperature and humidity, a contact sensor that reads "open"
while the child is awake (a good automation trigger), the tag switches, and
HomeKit Secure Video with a pre-roll buffer so a clip starts *before* the noise
that triggered it.

**A dashboard.** Live view, tonight's timeline, the event log, the night
history, trends, and the factor analysis. Served by the Pi itself over your
LAN, behind a password.

---

## Hardware

Full detail, including wiring and camera placement, is in
[docs/HARDWARE.md](docs/HARDWARE.md). The short version:

| Part | Recommendation | Approx. |
|---|---|---|
| Computer | **Raspberry Pi 4, 2 GB or 4 GB** | $45–55 |
| Camera | **Camera Module 3 NoIR** (12 MP, IMX708) | $35 |
| IR light | 940 nm illuminator, **mounted off-axis and diffused** | $10–15 |
| Microphone | Any USB mic with AGC that can be switched off; or an I2S MEMS mic | $10–25 |
| Storage | **USB SSD**, 120 GB is plenty. Not an SD card. | $20–30 |
| Environment | **SHT31, SHT4x or BME280 over I2C** | $5–10 |
| Power | Official 5 V 3 A USB-C supply | $10 |
| Case | Passive, vented. No fan. | $10 |

### Why Pi 4 and not Pi 5

This is the one choice that is genuinely counterintuitive, so it is worth
spelling out.

**The Pi 5 removed the hardware H.264 encoder.** This is confirmed by Raspberry
Pi's own engineers; it is not a driver gap that will be fixed. Every frame a Pi
5 streams has to be encoded in software, which costs roughly 1 to 1.5 cores at
1080p30 — continuously, all night, forever. That heat needs the Active Cooler,
which means **an audible fan running twenty-four hours a day in the room where
a child is trying to sleep.**

A Pi 4 encodes H.264 in dedicated hardware at essentially zero CPU, runs cool
enough for a passive case, and makes no noise at all. For this particular job
the older board is simply the better board. It is also cheaper and easier to
find.

One real constraint comes with it: **the Pi 4's hardware encoder has a total
budget of about 1080p30 across all streams combined.** You cannot run a 1080p30
live stream *and* a separate 1080p30 HKSV recording on one. babymon's
architecture sidesteps this by encoding exactly once and letting both consumers
copy those packets — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

A **Pi Zero 2 W** will do 720p live and nothing more. Do not attempt HKSV on
one. A **Pi 5** will work if you already own one; expect the fan.

### Why an SSD and not the SD card

babymon writes a telemetry row every fifteen seconds, all night, every night,
plus snapshots and audio clips. That workload destroys consumer SD cards in
months, and it does it silently — the first symptom is usually a database that
will not open. Put `paths.data_dir` on a USB SSD. Better still, boot from the
SSD and leave the SD card out entirely. If you must keep the card, see the
mitigations in [docs/HARDWARE.md](docs/HARDWARE.md) (log2ram, tmpfs, `noatime`,
`commit=900`) and understand you are buying time, not a fix.

### Why an I2C sensor and not the DHT22

The DHT22 is what the original version of this project used, and it is
supported here because it is probably what you have in a drawer. It is also a
timing-critical one-wire protocol that has to be bit-banged from userspace, it
returns `None` on a fair fraction of reads on a busy Pi, and **on a Pi 5 it does
not work at all** — the RP1 southbridge replaced the old GPIO stack, pigpio has
no RP1 backend, and the `pulseio` path fails. An SHT31, SHT4x or BME280 speaks
I2C, which is kernel-driven and behaves identically on every Pi ever made. It is
a five-dollar part swap that deletes an entire category of failure.

---

## Quick start

On a fresh **Raspberry Pi OS Bookworm (64-bit)** install, with the camera ribbon
connected and the microphone plugged in:

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/<you>/baby-monitor.git
cd baby-monitor
sudo deploy/install.sh
```

The installer checks your Pi model and OS, installs the apt dependencies,
creates the `babymon` system user, builds the virtualenv (with
`--system-site-packages`, which is mandatory — see below), installs the Python
package, builds the dashboard and the HomeKit bridge, downloads the YAMNet
model, installs MediaMTX, generates a random dashboard password and HomeKit PIN,
and enables three systemd units. It is idempotent: re-running it after a
`git pull` is the upgrade path, and it will never overwrite your config, your
secrets or your database.

It prints the generated password and PIN once, at the end. Write them down.

Then:

```bash
sudoedit /etc/babymon/babymon.yaml     # timezone, child's name and birthdate
sudo systemctl restart babymon-api
```

and open `http://<pi>:8080/`.

<details>
<summary>Why the venv needs <code>--system-site-packages</code></summary>

Raspberry Pi OS Bookworm marks the system Python as PEP 668
externally-managed, so `pip install` into it is refused — a venv is mandatory.
But `picamera2` is an apt package (`python3-picamera2`, which drags in
`python3-libcamera` and `python3-kms++`) and is **not** pip-installable at all.
The only way to have both is a venv created with `--system-site-packages` so the
apt-installed camera stack is visible from inside it. If you create the venv
before installing `python3-picamera2`, delete it and start again.

</details>

<details>
<summary>Running it without installing (development)</summary>

```bash
make dev                       # venv + editable install + dev tools
make test
cp config/babymon.example.yaml config/babymon.yaml
pi/.venv/bin/python -m babymon run --config config/babymon.yaml
cd dashboard && npm run dev    # http://localhost:5173, proxies /api to :8080
```

`camera.source: synthetic` and `audio.classifier.backend: heuristic` let the
whole thing run on a laptop with no hardware at all.

</details>

---

## HomeKit

Live video, audio, sensors and the tag switches work with nothing but an
iPhone. **HomeKit Secure Video needs more:**

- an **iCloud+** subscription — 50 GB covers one camera, 200 GB up to five,
  2 TB unlimited;
- a **home hub**: an Apple TV 4K or a HomePod. An iPad is **no longer**
  supported as a hub;
- two-factor authentication and iCloud Keychain enabled on the account.

Recorded footage does **not** count against your iCloud storage quota, and
Apple keeps it for ten days.

Two things about this build that are not optional and will cost you an evening
if you get them wrong:

- **The camera is published as a standalone accessory, not behind a bridge.**
  HKSV on bridged cameras ranges from unreliable to non-functional. babymon
  therefore pairs as its own accessory, with its own PIN.
- **Set `homekit.advertiser: avahi` on a Pi.** Raspberry Pi OS runs
  `avahi-daemon`, which already owns UDP 5353. HAP-NodeJS's built-in `ciao`
  responder tries to bind it too and the two answer for each other's records.
  The symptom is an accessory that appears in the Home app and then vanishes,
  or that will not finish pairing. The installer sets this for you.

Full walkthrough, including how to enable recording per-camera in the Home app
and how to read `DEBUG=HAP-NodeJS:HKSV` output when it goes wrong:
[docs/HOMEKIT.md](docs/HOMEKIT.md).

---

## Honest limitations

Things that are genuinely true and that you should know before you build this.

**It infers sleep from stillness and quiet.** That is what actigraphy does, and
it is a real, useful, well-studied signal — and it is not polysomnography. A
child lying perfectly still awake in the dark reads as asleep. A child who
thrashes in their sleep reads as restless or awake. There are no sleep stages
here because a camera and a microphone cannot see them; the weight other
trackers spend on stage composition goes to timing regularity instead.

**No score under four months.** The AASM declined to publish a recommended
sleep range below four months on the grounds that normal variation is too wide
and the evidence too thin. babymon follows that: under four months you get the
raw measurements and no quality score, because a number there would be
confidently wrong.

**Statistics need patience.** The factor analysis will not compare a tag until
it has ten nights with it and ten without, and twenty analysable nights in the
window overall. That is roughly a month of consistent logging before your first
real answer. It is a hard floor for a reason: below it, the only detectable
effects are ones you would have noticed anyway, and whatever does cross the
significance line is biased upward in magnitude. And even above it, everything
you get is an **association in your own data**, never a cause.

**AAC-ELD live audio needs an ffmpeg you have to build yourself.** HomeKit's
preferred codec for live and two-way audio is AAC-ELD, which requires
`libfdk_aac`, which is not in Debian's ffmpeg because of its licence. Two
options: accept Opus for live audio (which works fine, and is what babymon
prefers by default), or build ffmpeg with `--enable-libfdk-aac` yourself.
HKSV *recordings* use AAC-LC, which stock ffmpeg produces perfectly well, so
**HKSV works out of the box** — this only affects the live stream's audio codec.

**One camera, one microphone, several consumers.** Both devices can only be
opened once. babymon solves the camera with MediaMTX and the microphone with an
ALSA `dsnoop` device. Both are set up for you, but if you go off-script — a
stray `arecord`, a second ffmpeg — you will get "Device or resource busy" and it
will not be obvious why.

**Motion detection is a frame differencer, not a person detector.** A curtain,
a shadow from passing headlights, or a badly aimed IR illuminator glaring off
the cot bars will all trigger it. The masks in `motion.masks` and off-axis IR
mounting exist to deal with exactly that.

**Turn AGC off on the microphone.** Automatic gain control moves the noise
floor continuously, which makes every threshold in the detector meaningless.
Most cheap USB mics ship with it on. `amixer set 'Auto Gain Control' off`.

**HKSV footage goes to Apple.** If you enable it, clips leave the Pi and are
stored in your iCloud account, end-to-end encrypted, for ten days. If that is
not acceptable, set `homekit.hksv.enabled: false` and everything else still
works. Nothing else leaves the device unless you configure a webhook. See
[docs/PRIVACY.md](docs/PRIVACY.md).

---

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Step-by-step install, and what to do when a step fails |
| [docs/HARDWARE.md](docs/HARDWARE.md) | Bill of materials, wiring, camera and IR placement, model comparison |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, the threading model, the schema |
| [docs/API.md](docs/API.md) | The HTTP API contract |
| [docs/HOMEKIT.md](docs/HOMEKIT.md) | Pairing, HKSV, the tag switches, mDNS troubleshooting |
| [docs/ANALYTICS.md](docs/ANALYTICS.md) | Every metric and formula, and what the statistics cannot tell you |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What is recorded, what leaves the device, how to delete it |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | The failure modes, in the order you will hit them |

## Layout

```
config/    babymon.example.yaml — every setting, documented inline
pi/        the Python service: capture, detection, analytics, HTTP API
homekit/   the HomeKit accessory (Node + HAP-NodeJS; HKSV lives here)
dashboard/ the web UI (React + Vite)
deploy/    installer, systemd units, MediaMTX and ALSA configuration
docs/      the above
```

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
