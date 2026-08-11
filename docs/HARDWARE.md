# Hardware

Everything you need to buy, how to wire it, and — more usefully — the handful
of physical decisions that determine whether this thing works well or drives
you mad. The camera placement section and the IR section are the ones worth
reading twice; almost every false-positive problem people have with a nursery
camera comes from one of them.

---

## Bill of materials

| Part | Recommendation | Why this one | Approx. |
|---|---|---|---|
| Computer | **Raspberry Pi 4 Model B, 2 GB** | Hardware H.264 encoder, passively coolable. See below. | $45 |
| Camera | **Camera Module 3 NoIR** (IMX708, 12 MP, autofocus) | No IR-cut filter, so it sees 940 nm. Good low-light sensor. | $35 |
| IR illuminator | 940 nm LED board or ring, **mounted separately from the camera** | Invisible to the eye. Off-axis mounting is not optional. | $10–15 |
| Diffuser | A sheet of frosted acrylic, a ping-pong ball, baking parchment | Kills the hotspot. Costs nothing. | ~$0 |
| Microphone | USB: any with a mixer control for AGC you can switch off. I2S: SPH0645, ICS-43434, INMP441 | The mic matters more than the camera for this application. | $10–25 |
| Storage | **USB 3.0 SSD**, 120 GB | The SD card will die. See below. | $25 |
| Environment sensor | **SHT31, SHT4x, or BME280** (I2C) | Kernel-driven, works on every Pi. Not the DHT22. | $5–10 |
| Power | Official Raspberry Pi 5 V / 3 A USB-C supply | Undervoltage shows up as camera dropouts, not as a warning you notice. | $10 |
| Case | Passive, vented aluminium or a ventilated plastic case with heatsinks | **No fan.** It is a bedroom. | $10–15 |
| Cabling | Camera ribbon of the right length and type | Pi 4 uses the 15-pin ribbon; the Pi 5's 22-pin is different. | $5 |
| Mount | Anything that gets the camera 1.5–2.5 m from the cot, **out of reach** | A cable in a cot is a strangulation hazard. Full stop. | — |

Total: roughly $150–180 new, considerably less if the Pi and the SD card are
already in a drawer.

### Optional

- **Light sensor** (BH1750, TSL2591, I2C) — `samples.lux` has a column for it.
- **A second Pi** if you want to test upgrades without taking the nursery
  offline. `camera.source: synthetic` means you do not need one.
- **A UPS HAT** if your power is unreliable. `synchronous=NORMAL` on WAL is
  crash-safe but not power-cut-safe; you can lose the last few transactions.

---

## Choosing the Pi

| | Pi Zero 2 W | Pi 3B+ | **Pi 4 (2/4 GB)** | Pi 5 |
|---|---|---|---|---|
| Hardware H.264 encode | yes | yes | **yes** | **NO** |
| CPU for 1080p30 video | n/a | n/a | **~0%** | 100–150% (1–1.5 cores) |
| Cooling needed | passive | passive | **passive** | Active Cooler (fan) |
| Noise in the room | silent | silent | **silent** | audible fan, 24/7 |
| Live 720p | yes | yes | yes | yes |
| Live 1080p | no | marginal | yes | yes (software) |
| HKSV | **do not** | marginal | **yes** | yes, hot |
| DHT22 (one-wire) | works | works | works | **does not work** |
| Camera connector | 22-pin | 15-pin | 15-pin | 22-pin |
| Verdict | live view only | usable, tight | **recommended** | works, but noisy |

### The Pi 5 problem

**The Pi 5 removed the hardware H.264 encoder.** This is confirmed by Raspberry
Pi's engineers — it is a deliberate silicon decision, not a driver gap waiting
to be filled. Everything is software-encoded from now on.

For a device that encodes video continuously, forever, in a bedroom, that has
two consequences that compound:

1. **Roughly 1 to 1.5 cores at 1080p30, permanently.** Not a burst. All night,
   every night.
2. **Sustained load needs the Active Cooler.** Which is a fan. Which is
   audible. In the room where a child is trying to sleep. You will hear it
   before you hear the baby.

A Pi 4 does the same encode in dedicated hardware at effectively zero CPU,
stays cool enough for a passive aluminium case, and makes no sound at all. For
this specific job the older, cheaper board is straightforwardly the better one.

If you already own a Pi 5 and would rather use it: it works. Use the Active
Cooler (it is not optional at this load), consider dropping to 720p15, and
expect the fan. Also swap the DHT22 for an I2C sensor, because the DHT22 does
not work on a Pi 5 at all — see below.

### The Pi 4 encoder budget

The hardware encoder on the Pi 4 and earlier has a **total capacity of about
1080p30 across all streams combined**. Not per stream. This is the number that
catches people out:

- 1080p30 for HKSV **plus** 1080p30 live — ✗ does not fit.
- 1080p30 for HKSV **plus** 720p15 live, both separately encoded — ✗ marginal
  at best, and it will fall over when the CPU is also running inference.
- **One** encode at 720p15, copied to both consumers — ✓ trivially fine.
- **One** encode at 1080p30, copied to both consumers — ✓ fits, uses the whole
  budget. Nothing left over.

babymon's architecture is built around the last two: MediaMTX encodes exactly
once and both the live stream and the HKSV recorder copy those packets rather
than re-encoding. The shipped default is 720p15, which is a comfortable fit,
keeps HKSV clips small in iCloud, and is honestly plenty for watching a cot.
See [ARCHITECTURE.md](ARCHITECTURE.md) if you want to move to 1080p30.

**Do not attempt HKSV on a Pi Zero 2 W.** It will do 720p live and that is
where it stops.

---

## Storage: use an SSD

This is the single most common way a build like this dies.

babymon writes a `samples` row every fifteen seconds — about 5,760 rows a day,
2.1 million a year — plus WAL commits, snapshots, and audio clips. Consumer SD
cards are not built for continuous small writes, and they do not fail politely:
they wear out, start returning bad blocks, and the first symptom is usually a
SQLite database that will not open. Months, not years.

**Do this:** put `paths.data_dir` on a USB 3.0 SSD.

```bash
lsblk -f                                    # find the disk
sudo mkfs.ext4 -L babymon /dev/sda1
sudo mkdir -p /mnt/ssd
echo 'LABEL=babymon /mnt/ssd ext4 defaults,noatime 0 2' | sudo tee -a /etc/fstab
sudo mount -a
sudo install -d -o babymon -g babymon -m 0750 /mnt/ssd/babymon

sudo deploy/install.sh --data-dir /mnt/ssd/babymon
```

The installer rewrites `ReadWritePaths=` in the systemd units to match, which
matters because `ProtectSystem=strict` will otherwise give you `EROFS` on the
first write. It also warns you at install time if it notices the data directory
sitting on `/dev/mmcblk*`.

**Better:** boot from the SSD entirely and leave the SD card out. `raspi-config`
→ Advanced → Boot Order → USB Boot; the Pi 4 supports it natively with current
firmware. Then nothing writes to a card because there is no card.

**If you genuinely must keep the SD card**, you are buying time, not fixing
anything, but these help:

```bash
sudo apt install log2ram          # journald in RAM, flushed hourly
# /etc/fstab: reduce write amplification
#   PARTUUID=...  /  ext4  defaults,noatime,commit=900  0 1
#   tmpfs  /tmp      tmpfs  defaults,noatime,nosuid,size=100m  0 0
#   tmpfs  /var/tmp  tmpfs  defaults,noatime,nosuid,size=50m   0 0
```

And turn the retention windows down hard (`retention.samples_days: 60`,
`media_max_gb: 1.0`). Take the nightly `VACUUM INTO` backup seriously and copy
it off the Pi, because you will need it.

---

## Camera

### Which module

**Camera Module 3 NoIR.** "NoIR" means the infrared-cut filter has been left
out, which is what lets it see the 940 nm illuminator. A standard camera module
sees essentially nothing at 940 nm. The IMX708 sensor is also genuinely good in
low light, which matters more than the megapixel count.

The v2 NoIR (IMX219) works too and is cheaper. It has no autofocus at all,
which — see below — is arguably a feature here.

### Load the NoIR tuning file

libcamera ships separate tuning files for the IR-cut and NoIR variants. If you
do not tell it which one you have, it applies the colour matrices for a camera
with an IR filter and your night image comes out pink, noisy, and with the
auto-exposure making bad decisions.

In `deploy/mediamtx.yml`:

```yaml
rpiCameraTuningFile: /usr/share/libcamera/ipa/rpi/vc4/imx708_noir.json
```

Pi 4 and earlier use the `vc4` pipeline; on a Pi 5 the same file is under
`.../ipa/rpi/pisp/`. For a v2 NoIR the file is `imx219_noir.json`. Check what
is actually installed:

```bash
ls /usr/share/libcamera/ipa/rpi/*/
```

With picamera2 instead of MediaMTX:

```python
Picamera2(tuning=Picamera2.load_tuning_file("imx708_noir.json"))
```

### Pin the focus manually

The Camera Module 3 has phase-detect autofocus, and under flat infrared
illumination there is almost no contrast for it to lock onto. It hunts —
continuously, quietly, all night. **Every hunt is a whole-frame change, and the
motion detector reads a whole-frame change as the child moving.** You get
motion events at 03:00 with nothing in the room but a lens racking back and
forth.

Manual focus is not a compromise here. The cot does not move.

```yaml
rpiCameraAfMode: manual
rpiCameraLensPosition: 0.5      # dioptres: 1/metres. 0.5 ≈ 2 m, 1.0 ≈ 1 m.
```

To find the right value, run once with autofocus on in daylight, let it settle
on the cot, and read back what it chose:

```bash
rpicam-still --autofocus-on-capture -o /tmp/focus.jpg -v 2>&1 | grep -i lens
# or, in Python:
#   picam2.capture_metadata()["LensPosition"]
```

Then hard-code that number and never think about it again.

### Cap the exposure time

Left to itself, auto-exposure in a dark room will happily choose a 200 ms
exposure. libcamera then extends the frame duration to fit it, and your "15 fps"
stream silently becomes 5 fps of motion-blurred frames. Nothing logs an error.
You find out when you look at a recording and everything is a smear.

This wrecks both jobs at once: the video is unwatchable and the motion detector
is comparing blurred frames to blurred frames.

The proper control is `FrameDurationLimits`, which bounds how long a frame may
take and therefore how long the exposure can be. MediaMTX derives it from
`rpiCameraFPS`. Belt and braces, pin the shutter as well:

```yaml
rpiCameraFPS: 15
rpiCameraShutter: 33000     # microseconds. 33 ms = 1/30 s.
rpiCameraGain: 0            # 0 = let the AE choose gain
```

With picamera2 directly:

```python
picam2.set_controls({
    "FrameDurationLimits": (33333, 66666),   # µs: 15–30 fps, never slower
    "ExposureTime": 33000,
    "AeEnable": True,
})
```

**If the picture is now too dark, the answer is more infrared or more gain — not
a longer shutter.** A dark, sharp, 15 fps image is useful. A bright, smeared,
5 fps image is not.

### Placement

- **1.5 to 2.5 m from the cot**, looking down at a slight angle. Close enough
  to see, far enough that the whole cot is in frame and the depth of field
  covers a rolling child.
- **Out of reach. Cable secured and out of reach.** A cable within reach of a
  cot is a strangulation hazard. Wall-mount it, route the cable along the wall,
  and check it again when the child learns to stand.
- **Avoid framing a window.** Passing headlights sweeping across the room is
  the single most reliable false-positive generator there is. If you cannot
  avoid it, mask that region with `motion.masks` (rectangles as fractions of
  the frame, `[x, y, w, h]`).
- **Avoid framing a door or a curtain** for the same reason. A curtain over a
  radiator moves all night.
- **Check the frame in the dark, not in daylight.** The IR illuminator's beam
  pattern is what determines what you can actually see, and it looks nothing
  like the daytime view.

---

## Infrared illumination

This section is short and it matters a lot.

### 940 nm, not 850 nm

Both are "invisible infrared". 850 nm is not, quite: the LEDs glow a dull red
that is clearly visible in a dark room. In a nursery that is a light source
pointed at a sleeping child all night, which is both bad for them and likely to
wake them.

**940 nm is genuinely invisible.** It costs a little sensitivity — the sensor's
quantum efficiency is lower up there, so you need a bit more power or a bit
more gain — and it is entirely worth it.

### Mount it OFF-AXIS and diffuse it

The illuminator boards sold with camera modules put the LEDs in a ring around
the lens. Do not use that arrangement here. Co-mounted illumination throws light
straight down the optical axis, and anything retroreflective in the frame —
**cot bars, in particular** — bounces a hard hotspot straight back into the
lens. That hotspot:

- blows out the auto-exposure, so the child goes dark while the bars glow;
- flares across the frame, and flare *moves* when anything at all changes;
- is a major source of motion false positives. Possibly the major source.

Instead:

- **Mount the illuminator 30–50 cm to one side of the camera**, angled at the
  cot. Separate mount, separate cable. Bounce it off a wall or the ceiling if
  you can — indirect IR is dramatically better than direct.
- **Diffuse it.** Frosted acrylic, a sheet of baking parchment, half a
  ping-pong ball over the LEDs. Anything that turns a point source into an area
  source. This costs nothing and improves the image more than any setting.
- **Do not point it at the mattress from directly above.** You get a bright
  patch in the middle and darkness at the edges.

### Switching it

If your illuminator has an enable pin, wire it to a GPIO and set
`camera.night_vision.ir_led_gpio`. Otherwise leave it on continuously — 940 nm
at nursery distances is a fraction of the IR you get from a warm radiator, and
switching it introduces a step change in scene brightness that the motion
detector will flag every single time.

`camera.night_vision.auto` (mean luma below `dark_threshold`, default 40)
relaxes the exposure and denoise settings for darkness; it does not require an
illuminator with a control pin.

---

## Microphone

For a baby monitor the microphone matters more than the camera. Cry detection
runs off it, sleep-onset detection runs off it, and the awakening logic runs off
it. A bad mic gives you a bad sleep diary.

### Options

**USB microphone** (easiest). Any of the cheap "USB conference mic" pucks
works. Requirements: it must appear in `arecord -l`, and it must have a mixer
control that lets you turn AGC off (see below). A lavalier or boundary mic
clipped near the cot beats a puck across the room.

**I2S MEMS microphone** (best signal, more work). SPH0645LM4H, ICS-43434,
INMP441. Digital output straight into the Pi's I2S pins — no USB audio jitter,
no analogue noise, very low self-noise. They are also rigid: **fixed 48 kHz,
S32_LE, and usually reported as stereo even when only one channel is wired**,
which is why `deploy/asound.conf.example` needs a `route` plug to pick the left
channel and a `plug` wrapper to convert down to the 16 kHz mono YAMNet wants.
Expect to set `audio.gain_db` to 20–30 dB, because the useful signal sits in
the top bits of a 32-bit sample.

Enable the overlay in `/boot/firmware/config.txt`:

```
dtoverlay=googlevoicehat-soundcard      # SPH0645 / Adafruit I2S breakout
```

Wiring for the common I2S breakouts:

| Mic pin | Pi pin (BCM) | Physical |
|---|---|---|
| 3V | 3V3 | 1 |
| GND | GND | 6 |
| BCLK | GPIO18 | 12 |
| LRCL / WS | GPIO19 | 35 |
| DOUT | GPIO20 | 38 |
| SEL | GND (left channel) | 9 |

**Do not use the Pi's 3.5 mm jack for input.** It is output only.

### Turn AGC off. Really.

```bash
amixer -c 1 controls | grep -i 'gain\|agc'
amixer -c 1 set 'Auto Gain Control' off
amixer -c 1 set 'Mic' 60%
sudo alsactl store            # survive a reboot
```

Automatic gain control continuously renormalises the input level. babymon's
detector works by comparing the current level against an adaptive noise floor
(`audio.noise_floor`, a rolling 20th percentile over five minutes) and firing
when the level exceeds floor + `on_db_above_floor`. With AGC on, the floor is
chasing a target that AGC is itself moving: a quiet room slowly gets amplified
until room tone crosses the threshold, and a real cry gets pulled back down
toward the floor. Every threshold in `audio.detector` stops meaning anything.

Most cheap USB microphones ship with AGC enabled.

### Sharing it

The detector holds the microphone continuously. The HomeKit bridge's ffmpeg
wants it too, whenever you open the camera in the Home app or HKSV records. One
ALSA capture device, two openers, `EBUSY`. Install
`deploy/asound.conf.example` as `/etc/asound.conf` and point both
`audio.device` and `homekit.audio.device` at the `dsnoop` device it defines.

Verify it actually works, which is the whole point:

```bash
arecord -D babymon_mic -f S16_LE -r 16000 -c 1 -d 5 /tmp/a.wav &
arecord -D babymon_mic -f S16_LE -r 16000 -c 1 -d 5 /tmp/b.wav
# both must succeed
```

### Check the level

Room tone should sit somewhere around −60 to −50 dBFS with plenty of headroom
for a cry. Too quiet and the classifier gate never opens; too hot and
everything clips.

```bash
arecord -D babymon_mic -f S16_LE -r 16000 -c 1 -d 10 -V mono /dev/null
```

The dashboard shows `sound_dbfs`, `noise_floor_dbfs` and
`sound_above_floor_db` live, which is the better way to tune it — watch it for
ten minutes with the room as it will actually be, white-noise machine and all.

---

## Environment sensor

### Use I2C. Do not use the DHT22.

The DHT22 (AM2302) is what the original project used and babymon still supports
it, because it is probably what you have. It is a bad part for this job:

- **It is a bit-banged one-wire protocol with microsecond timing requirements.**
  There is no kernel driver; a userspace library has to toggle a GPIO and time
  the pulses itself. On a Pi running a video pipeline and a neural network, the
  scheduler will interrupt that timing, and a mistimed read returns nothing.
  Failure rates of 10–30% under load are normal. `environment.sensor: dht22`
  returning `None` is not a bug, it is the part.
- **It does not work on a Pi 5 at all.** The RP1 southbridge replaced the
  legacy GPIO peripheral. `pigpio`, which was the reliable way to do this, has
  no RP1 backend. The `pulseio`/`libgpiod` path that
  `adafruit-circuitpython-dht` falls back to does not meet the timing. There is
  no configuration that fixes this.
- It is slow (one reading every 2 s at best) and not very accurate (±0.5 °C,
  ±2–5% RH).

**An SHT31, SHT4x or BME280 speaks I2C**, which is a kernel-driven bus that
behaves identically on every Pi ever made, including the Pi 5. Reads never
fail for timing reasons. They are more accurate (SHT4x: ±0.2 °C, ±1.8% RH).
They cost about five dollars. This is the cheapest improvement in the whole
build.

| | DHT22 | SHT31 / SHT4x | BME280 |
|---|---|---|---|
| Bus | one-wire bit-bang | I2C | I2C |
| Works on Pi 5 | **no** | yes | yes |
| Read failures under load | common | none | none |
| Temperature accuracy | ±0.5 °C | ±0.2–0.3 °C | ±0.5 °C |
| Humidity accuracy | ±2–5% | ±1.8–2% | ±3% |
| Also measures | — | — | pressure |
| Default I2C address | — | 0x44 | 0x76 or 0x77 |

### I2C wiring

| Sensor | Pi (BCM) | Physical pin |
|---|---|---|
| VIN / VDD | 3V3 | 1 |
| GND | GND | 9 |
| SDA | GPIO2 (SDA1) | 3 |
| SCL | GPIO3 (SCL1) | 5 |

Most breakout boards have pull-ups fitted. **3.3 V, not 5 V** — the Pi's GPIO
is not 5 V tolerant.

```bash
sudo raspi-config nonint do_i2c 0        # or add dtparam=i2c_arm=on to config.txt
sudo reboot
i2cdetect -y 1                           # 0x44 = SHT31/SHT4x, 0x76/0x77 = BME280
```

Then:

```yaml
environment:
  sensor: "sht4x"       # or sht31, bme280
  i2c_bus: 1
  i2c_address: null     # null = the part's default
  poll_s: 60
```

### DHT22 wiring, if you insist

| DHT22 pin | Pi |
|---|---|
| 1 VCC | 3V3 (pin 1) |
| 2 DATA | GPIO4 (pin 7), with a 4.7–10 kΩ pull-up to 3V3 |
| 3 NC | — |
| 4 GND | GND (pin 9) |

```yaml
environment:
  sensor: "dht22"
  gpio_pin: 4          # BCM numbering
  poll_s: 60
```

The pull-up resistor is not optional; without it, reads fail. Expect `None`
values anyway. babymon treats a failed read as a gap, not an error — the
environment subscore is dropped for that night rather than filled in with a
guess — but a sensor that fails 30% of the time gives you a temperature series
with holes in it.

### Placement

At cot height, **away from the Pi**. The Pi's own heat will read 3–6 °C high if
the sensor is anywhere near it, and away from radiators, windows and draughts.
Twenty centimetres of wire and a bit of tape is fine; the point is that it
measures the room the child is in, not the box the computer is in.

The comfort band in `environment.comfort` defaults to 19.0–21.5 °C and 40–60%
RH, which is the range usually cited for infant sleep. `environment.alerts`
logs an event when you are outside it for `sustained_min` (15) minutes.

---

## Thermal management

The soft limit is **80 °C** (the ARM core starts throttling) and the hard limit
is **85 °C** (aggressive throttling). Neither can be raised; `temp_limit` in
`config.txt` can only be lowered.

A Pi 4 doing hardware H.264 and YAMNet inference in a ventilated passive case
sits around 55–65 °C, which is fine. A Pi 4 in a sealed plastic case with no
heatsink can reach the soft limit, and a throttled Pi drops frames.

**Do not fit a fan.** It is a bedroom. Use a passive aluminium case, or a
ventilated case with the standard heatsink kit. If you are on a Pi 5, you have
no choice; put it as far from the cot as the cables allow.

### Read the sticky throttle bits

This is the part people miss. `vcgencmd get_throttled` returns a bitmask where
the low bits are *currently* true and **bits 16–18 are sticky: they record that
something happened since boot, even if everything is fine right now.** That is
exactly what you want for a device that only misbehaves at 3 a.m.

```bash
vcgencmd get_throttled
vcgencmd measure_temp
```

| Bit | Meaning |
|---|---|
| 0 | under-voltage **right now** |
| 1 | ARM frequency capped now |
| 2 | currently throttled |
| 3 | soft temperature limit active now |
| **16** | under-voltage **has occurred** since boot |
| **17** | ARM frequency capping has occurred |
| **18** | throttling **has occurred** |
| 19 | soft temperature limit has occurred |

`throttled=0x0` is what you want. `0x50000` means it both under-volted and
throttled at some point overnight and you would never otherwise know.

babymon reads this on every health check and surfaces it in
`GET /api/system/info` and on the dashboard's System page, so overnight
throttling shows up as a line in the log rather than as mysterious dropped
frames. If you see bit 16 set, suspect the power supply before anything else —
undervoltage on a Pi 4 presents as camera dropouts and USB disconnects, not as
an obvious error.

---

## Assembly checklist

1. Flash **Raspberry Pi OS Bookworm 64-bit** (Lite is fine; the dashboard is
   served by babymon, not by a desktop). Enable SSH in the Imager.
2. Connect the camera ribbon with the Pi **powered off**. Blue side toward the
   Ethernet port on the Pi 4; contacts toward the lens at the camera end.
3. Wire the I2C sensor. Enable I2C, reboot, confirm with `i2cdetect -y 1`.
4. Plug in the microphone. Confirm with `arecord -l`. Turn AGC off.
5. Mount the SSD, add it to `/etc/fstab` with `noatime`.
6. `sudo deploy/install.sh --data-dir /mnt/ssd/babymon`
7. Check the camera before you mount anything permanently:
   ```bash
   rpicam-hello --list-cameras
   ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8554/babymon
   ```
8. Mount the camera and the illuminator. **In the dark**, check the frame, the
   focus and — importantly — that there is no hotspot on the cot bars.
9. Watch `sound_dbfs` and `motion` on the dashboard for an evening before you
   trust any of the thresholds. Adjust `motion.on_threshold` and
   `audio.detector.on_db_above_floor` to your actual room.
10. Read [PRIVACY.md](PRIVACY.md) and decide about HKSV before you pair.
