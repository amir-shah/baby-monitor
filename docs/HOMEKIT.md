# HomeKit

babymon publishes a real HomeKit camera accessory: live video and audio in the
Home app, motion and sound sensors, temperature and humidity, a contact sensor
that tracks whether the child is awake, switches that log tags against tonight,
and HomeKit Secure Video.

The bridge is `homekit/`, Node 22 running `@homebridge/hap-nodejs` 2.x. It is
deliberately stateless — every characteristic it publishes is read from the
Python API — so the two processes restart independently. Why it is Node when
everything else is Python is answered in [ARCHITECTURE.md](ARCHITECTURE.md);
the short version is that HKSV is only properly implemented in HAP-NodeJS.

---

## What you get in the Home app

| Service | Behaviour |
|---|---|
| **Camera** | Live H.264 video from the RTSP hub. Audio if `homekit.audio.enabled`. Snapshot tiles come from `/api/snapshot.jpg`. |
| **Motion sensor** | Debounced motion from the frame differencer. Also a HKSV recording trigger. |
| **Occupancy sensor** ("sound detected") | Fires on a detection whose label is in `audio.detector.wake_labels` — cry, fuss, whimper, scream, talk. Also a HKSV trigger. |
| **Temperature** | From the I2C or GPIO sensor. |
| **Humidity** | Likewise. |
| **Contact sensor** | Reads **open** while the child is awake. The best automation trigger in the set: *"if the nursery contact opens after 06:00, turn on the hall light."* |
| **Switches** | One per entry in `homekit.tag_switches`. Flipping one logs that tag against tonight. |

Each of these can be turned off individually under `homekit.sensors`.

---

## Requirements

### For live video, audio, sensors and switches

An iPhone or iPad. That is all.

### For HomeKit Secure Video

All four, no exceptions:

1. **An iCloud+ subscription.**
   - 50 GB — **one** camera
   - 200 GB — up to **five** cameras
   - 2 TB or above — **unlimited** cameras

   Recorded footage does **not** count against your storage quota, and Apple
   keeps it for **ten days**.

2. **A home hub, at home, powered on.** An **Apple TV 4K** or a **HomePod**
   (full-size or mini). The hub is what actually receives the encrypted
   fragments from the Pi and uploads them; the Pi never talks to iCloud
   directly.

   **An iPad is no longer supported as a home hub.** If your setup relied on
   one, HKSV will not work until you add an Apple TV or HomePod.

3. **Two-factor authentication** on the Apple Account, and **iCloud Keychain**
   enabled.

4. **A standalone accessory, not a bridge.** Which babymon already is — see
   below.

---

## Two things that are not optional

### The camera is a standalone accessory

HKSV behind a HAP bridge ranges from unreliable to non-functional: recordings
that never start, hubs that stop selecting a recording configuration, cameras
that lose their recording setting when the bridge restarts. babymon therefore
publishes the camera as its **own accessory**, with its own pairing PIN, rather
than adding it to a bridge alongside the sensors.

Practical consequence: you pair *the camera*, and the sensors and switches come
with it as services on that one accessory. There is nothing else to add.

### Use avahi, not ciao

```yaml
homekit:
  advertiser: "avahi"
```

Raspberry Pi OS runs `avahi-daemon`, and avahi owns UDP 5353. HAP-NodeJS
defaults to its own built-in mDNS responder, `ciao`, which tries to bind the
same port. Both then answer for each other's records and neither is
authoritative.

The symptoms are distinctive and maddening:

- the accessory appears in "Add Accessory" and then vanishes a few seconds
  later;
- pairing gets to "Adding accessory…" and times out;
- the camera works for a while after a restart and then goes "No Response";
- it works on one iPhone and not another on the same network.

Setting `advertiser: avahi` makes HAP-NodeJS register its `_hap._tcp` record
*through* the system daemon instead of competing with it. The installer sets
this in `/etc/babymon/babymon.env`, and the systemd unit has
`Requires=avahi-daemon.service` so it cannot start before avahi is up.

The alternative — `sudo systemctl disable --now avahi-daemon` and letting ciao
have the port — also works, but you lose `.local` name resolution for the Pi
itself and anything else on the box that wanted mDNS.

---

## Pairing

1. Make sure the bridge is running and healthy:

   ```bash
   systemctl status babymon-homekit
   journalctl -u babymon-homekit -n 50
   curl -s localhost:8080/api/homekit/pairing | python3 -m json.tool
   ```

   The last one returns the pairing state, the setup code, the setup URI and
   the QR payload. The dashboard's System page renders the QR code.

2. **The iPhone must be on the same layer-2 network as the Pi.** Not a guest
   VLAN, not a different SSID that is isolated from the main one, and with
   client isolation ("AP isolation") off. mDNS does not cross subnets without
   a reflector.

3. Home app → **+** → **Add Accessory** → scan the QR code, or **More
   options…** and pick the accessory by name (`homekit.name`, default "Baby
   Monitor"), then enter the eight-digit PIN.

4. The PIN is `BABYMON_HOMEKIT__PIN` in `/etc/babymon/babymon.env`. The
   installer generated a random one and printed it once.

   ```bash
   sudo grep HOMEKIT__PIN /etc/babymon/babymon.env
   ```

5. Assign it to a room. Now go and enable recording — pairing does **not** turn
   HKSV on.

### Changing the PIN

Changing `homekit.pin` after pairing does nothing until you remove the
accessory from the Home app and re-add it. To start completely fresh:

```bash
sudo systemctl stop babymon-homekit
sudo rm -rf /var/lib/babymon/hap/*        # the HAP pairing keys
sudo systemctl start babymon-homekit
```

Remove the accessory in the Home app first, or it will sit there showing "No
Response" forever.

---

## Enabling HomeKit Secure Video

**This is per-camera and it is off by default.** Every "HKSV never records"
report starts here.

1. Home app → hold the camera tile → **⚙︎ (settings)**.
2. Under **Recording Options** (or "Stream & Recording"), choose when to
   record: **When Home**, **When Away**, or both. If you see no such section,
   your hub or iCloud+ requirement is not met — see the checklist above.
3. Choose the recording trigger: **Any Motion** at minimum. babymon reports
   both motion and sound; the Home app exposes motion.
4. Optionally set an **activity zone** — this happens on the Apple side, not on
   the Pi, and it is a good way to exclude a window or a doorway without
   touching `motion.masks`.
5. Toggle **Audio** on if you want sound in the recordings.

Then, on the Pi:

```yaml
homekit:
  hksv:
    enabled: true
    prebuffer_s: 6        # seconds kept before the trigger
    fragment_ms: 4000     # length of each fMP4 fragment
    max_width: 1920
    max_height: 1080
    max_fps: 30
    max_bitrate_kbps: 2000
    audio: true
    triggers: ["motion", "sound"]
```

**`prebuffer_s` is why a clip starts before the noise did.** HomeKit asks for
four seconds of pre-roll; the ring buffer holds six so there is slack. Below 4
the config loader warns you, because recordings will start after the event that
triggered them.

**`fragment_ms` must line up with the encoder's keyframe interval.** Every
fragment has to begin with an IDR frame:

```
rpiCameraIDRPeriod  =  fragment_ms / 1000 × fps        # 4 s × 15 fps = 60
```

That value lives in `deploy/mediamtx.yml`. If they disagree, HKSV either stalls
waiting for a keyframe or produces over-long fragments that HomeKit drops. This
is the single most common cause of "it records, but the clips are broken".

### Verifying it works

Walk in front of the camera and wait a minute or two — HKSV is not instant.
Then:

```bash
journalctl -u babymon-homekit -n 100 | grep -i record
curl -s "localhost:8080/api/events?kind=system&label=hksv_recording&limit=10" \
  | python3 -m json.tool
```

The bridge posts every start and stop to `/api/homekit/recording`, which logs
an `hksv_recording` system event — so HKSV clips line up with babymon's own
timeline and you can see from the Pi's side whether HomeKit ever asked.

In the Home app, clips appear in the camera's timeline at the bottom of the
detail view, with a coloured scrubber bar marking recorded periods.

---

## Audio

### Live audio: Opus, not AAC-ELD

HomeKit's preferred codec for live and two-way audio is **AAC-ELD**. Producing
it requires ffmpeg built with `libfdk_aac`, and **Debian does not ship that** —
the FDK licence is not compatible with the GPL terms Debian builds ffmpeg
under. There is no apt package that fixes this.

babymon handles it by probing rather than assuming.
`homekit/src/camera/ffmpeg.ts` runs `ffmpeg -encoders` at startup and only
advertises to HomeKit what the build can actually produce. This matters: a
camera that advertises AAC-ELD, pairs fine, streams video, and then dies the
instant audio is negotiated is a genuinely horrible thing to debug.

Your options:

**Accept Opus** (the default, `codec: libopus`). It works, it sounds fine, and
it is what babymon prefers. This is the right answer for almost everyone.

**Build ffmpeg with libfdk_aac** if you specifically want AAC-ELD or two-way
audio that misbehaves on Opus. Expect an hour of compilation on a Pi 4, and
note that the resulting binary is not redistributable. Roughly:

```bash
sudo apt install -y build-essential libfdk-aac-dev libopus-dev nasm \
                    libx264-dev pkg-config
# fetch ffmpeg source, then:
./configure --enable-gpl --enable-nonfree --enable-libfdk-aac \
            --enable-libopus --enable-libx264
make -j4 && sudo make install
```

Then set `homekit.audio.codec: libfdk_aac` and restart the bridge; the probe
will confirm it in the log.

**HKSV recording audio is unaffected.** Recordings use **AAC-LC**, which
ffmpeg's native `aac` encoder produces perfectly well. So HKSV works fully on a
stock Debian ffmpeg — this whole section is about the *live* stream only.

### Sharing the microphone

The detector holds the mic continuously; ffmpeg wants it whenever you open the
camera. One ALSA capture device, two openers, `EBUSY` — and because the bridge
opens second, the symptom looks like "HomeKit has no audio" rather than "the
mic is busy".

Install `deploy/asound.conf.example` as `/etc/asound.conf` and point both at
the shared `dsnoop` device:

```yaml
audio:
  device: "babymon_mic"
homekit:
  audio:
    device: "babymon_mic"
```

### Two-way audio (talkback)

```yaml
homekit:
  audio:
    two_way: true
    playback_device: "babymon_speaker"
```

Needs a speaker or a USB/I2S DAC on the Pi, and a `dmix` device so playback is
shared the same way capture is (also in `asound.conf.example`). Two-way audio
is the feature most sensitive to codec support — if it is one-way or silent,
this is where AAC-ELD actually matters.

---

## The tag switches

Switches in the Home app that log a tag against tonight, so you can say
*"Hey Siri, dessert before bed"* from the kitchen instead of finding your phone
and opening a dashboard.

```yaml
homekit:
  tag_switches:
    - slug: "dessert-before-bed"
      label: "Dessert Before Bed"
    - slug: "screen-before-bed"
      label: "Screen Before Bed"
    - slug: "late-nap"
      label: "Late Nap"
    - slug: "teething"
      label: "Teething"
```

Flipping one calls `POST /api/homekit/tag` with `{"slug": ..., "on": true}`,
which creates (or removes) tonight's note carrying that tag. The call is
idempotent, so a double-tap or a flaky network does not create two notes.

**They reset themselves at the day boundary** — `day_boundary_hour`, default
12:00 local. A switch you turned on last night is off again by lunchtime, ready
for tonight.

Slugs are created on the fly if `api.notes.autocreate_tags` is on (it is by
default), so adding a switch here is the only step needed; there is no separate
tag-setup dance. A new tag defaults to `value_type: bool`, which is exactly
what a switch is. Slugs must be lowercase letters, digits and hyphens — the
config loader rejects anything else.

Because these are real HomeKit switches they work in automations and scenes
too: a "Bedtime" scene can flip several at once, and a shortcut can set them
from the lock screen.

---

## Troubleshooting

### The accessory appears and then vanishes / will not pair

Almost always the mDNS conflict. Check:

```bash
grep ADVERTISER /etc/babymon/babymon.env      # want: avahi
systemctl is-active avahi-daemon
sudo ss -lunp | grep 5353                     # who owns it?
avahi-browse -rt _hap._tcp                    # is the accessory advertised?
```

`avahi-browse` should list the accessory with the Pi's address. If it lists
nothing, the bridge is not advertising; if it lists it but the phone cannot see
it, the problem is the network (guest VLAN, AP isolation, a mesh node not
forwarding multicast).

Also check the iPhone is on the same subnet, and try toggling its Wi-Fi off and
on — iOS caches Bonjour results aggressively.

### "Already paired" or the accessory will not add

The Pi still holds pairing state from a previous attempt.

```bash
sudo systemctl stop babymon-homekit
sudo rm -rf /var/lib/babymon/hap/*
sudo systemctl start babymon-homekit
```

Remove the accessory in the Home app first.

### HKSV never records

Work down this list in order; it is roughly ordered by how often each one is
the answer.

1. **Recording is not enabled in the Home app.** Per-camera, off by default.
   See above. This is the answer more than half the time.
2. **No home hub, or the hub is offline.** Home app → Home Settings → Home
   Hubs & Bridges. It must say "Connected". An iPad does not count any more.
3. **iCloud+ tier too small for the number of cameras.** 50 GB is one camera
   total, across your whole home.
4. **`homekit.hksv.enabled: false`** on the Pi.
5. **IDR period does not match `fragment_ms`.** See the arithmetic above. This
   is the usual cause of "it records but the clips are broken or empty".
6. **The camera is behind a bridge.** It should not be; babymon publishes it
   standalone.
7. **ffmpeg cannot produce what was negotiated.** Check the startup probe:
   ```bash
   journalctl -u babymon-homekit | grep -i -A5 'ffmpeg'
   ```
8. **The Pi cannot keep up.** On a Pi 5 (software encoding) or a Zero 2 W, HKSV
   at 1080p is not realistic. Drop to 720p15.

### Reading the HKSV debug log

HAP-NodeJS uses the `debug` package. The HKSV channel prints the whole
recording state machine: the configuration HomeKit selected, each fragment's
size, and why a stream was closed.

```bash
sudo systemctl edit babymon-homekit
```

```ini
[Service]
Environment=DEBUG=HAP-NodeJS:HKSV
```

```bash
sudo systemctl restart babymon-homekit
journalctl -u babymon-homekit -f
```

Useful channels:

| `DEBUG=` | Shows |
|---|---|
| `HAP-NodeJS:HKSV` | Recording negotiation, fragments, close reasons |
| `HAP-NodeJS:Camera` | Live streaming session setup, SRTP, ffmpeg arguments |
| `HAP-NodeJS:Accessory` | Pairing, characteristic reads and writes |
| `HAP-NodeJS:EventedHTTPServer` | The HAP transport itself |
| `HAP-NodeJS:*` | Everything. Very loud. |

What to look for:

- **`selected recording configuration`** — proof the hub asked to record. If
  this never appears, the problem is on the Apple side (hub, iCloud+, the
  per-camera setting), not on the Pi.
- **Fragment sizes and timings** — fragments should arrive at roughly
  `fragment_ms` intervals. Long gaps mean the encoder is not producing
  keyframes when expected: check `rpiCameraIDRPeriod`.
- **"closed by remote" / an `HDSProtocolSpecificErrorReason`** — the hub
  rejected the stream. Usually a codec or profile mismatch; compare what
  `hksv.max_*` advertises against what MediaMTX actually produces.
- **The first packet must be the initialization segment.** If you see a
  complaint about that, the fMP4 parser hit something unexpected — most often
  a source whose parameters changed mid-stream.

Turn it off again afterwards. It is extremely verbose and, left on, it will
fill the journal.

### No audio in the live stream

1. `ffmpeg -encoders | grep -E 'opus|fdk|aac'` — what can this build do?
2. Is another process holding the mic? `sudo fuser -v /dev/snd/*`
3. Are both `audio.device` and `homekit.audio.device` pointing at the dsnoop
   device?
4. `homekit.audio.enabled: true`?
5. If it is AAC-ELD you are after, see the ffmpeg section above — Debian's
   build cannot produce it and never will.

### Video is black, or the tile spins

`homekit.video.copy_video: true` passes the H.264 stream through untouched,
which is much cheaper than re-encoding but requires the source to be
HomeKit-compatible already. If the Home app shows a black frame, turn it off:

```yaml
homekit:
  video:
    copy_video: false
```

That forces a transcode — which costs CPU, and on a Pi 5 costs a lot of CPU.
Check the source first:

```bash
ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8554/babymon
```

You want H.264, Main or Baseline profile, level 4.0 or below. High profile is
refused by some Apple TV models acting as the recorder; `deploy/mediamtx.yml`
sets Main for that reason.

### "No Response"

The bridge is down, or the API it reads from is.

```bash
systemctl status babymon-homekit babymon-api
curl -s localhost:8080/api/health | python3 -m json.tool
journalctl -u babymon-homekit -n 100
```

A restart of `babymon-api` shows "No Response" for a few seconds and then
recovers on its own — the bridge polls and reconnects. If it does not recover,
check that `BABYMON_HOMEKIT__API_TOKEN` in the environment file still matches
an entry in `BABYMON_API__AUTH__TOKENS`; a mismatch gives 401s that look
exactly like the service being down.

### Sensors show the right values, but late

The bridge polls `/api/homekit/state` and additionally subscribes to the SSE
stream for `motion` and `sound`, which are pushed immediately. Temperature and
humidity move at `environment.poll_s` (60 s), and HomeKit itself coalesces
characteristic updates. Sub-minute latency on a temperature reading is not
something either side is trying to provide.
