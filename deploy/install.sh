#!/usr/bin/env bash
#
# babymon installer for Raspberry Pi OS Bookworm (and Trixie).
#
# Idempotent by construction: every step checks for the state it is trying to
# create before creating it. Re-running this after `git pull` is the intended
# upgrade path.
#
# Three things are treated as sacred and are NEVER overwritten once they exist:
#   /etc/babymon/babymon.yaml     your configuration
#   /etc/babymon/babymon.env      your generated secrets
#   $DATA_DIR/babymon.db          your data
# Everything else (the venv, the built dashboard, the bridge, the units) is
# disposable and is rebuilt in place.

set -euo pipefail

# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

PREFIX="${BABYMON_PREFIX:-/opt/babymon}"
CONF_DIR="${BABYMON_CONF_DIR:-/etc/babymon}"
DATA_DIR="${BABYMON_DATA_DIR:-/var/lib/babymon}"
LOG_DIR="${BABYMON_LOG_DIR:-/var/log/babymon}"
SVC_USER="${BABYMON_USER:-babymon}"
SVC_GROUP="${BABYMON_GROUP:-babymon}"
NODE_MAJOR="${BABYMON_NODE_MAJOR:-22}"

VENV="$PREFIX/venv"
WEB_DIR="$PREFIX/web"
BRIDGE_DIR="$PREFIX/homekit"
UNIT_DIR=/etc/systemd/system
MEDIAMTX_BIN=/usr/local/bin/mediamtx

# The default set of paths the systemd units ship with. If the operator moves
# any of them, the units are rewritten on the way in.
DEFAULT_PREFIX=/opt/babymon
DEFAULT_CONF_DIR=/etc/babymon
DEFAULT_DATA_DIR=/var/lib/babymon
DEFAULT_LOG_DIR=/var/log/babymon
DEFAULT_USER=babymon

DO_APT=1
DO_NODE=1
DO_DASHBOARD=1
DO_BRIDGE=1
DO_MODELS=1
DO_MEDIAMTX=1
DO_ENABLE=1
DO_RESTART=1

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_GREEN=$'\033[32m'; C_BLUE=$'\033[34m'
else
    C_RESET=; C_BOLD=; C_DIM=; C_RED=; C_YELLOW=; C_GREEN=; C_BLUE=
fi

WARNINGS=()

step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
skip() { printf '    %sskip%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
ok()   { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '    %swarning:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; WARNINGS+=("$*"); }
die()  { printf '\n%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Usage: sudo deploy/install.sh [options]

Options:
  --skip-apt          Do not touch apt. Assumes the dependencies are present.
  --skip-node         Do not install or upgrade Node.js.
  --skip-dashboard    Do not build the web dashboard.
  --skip-homekit      Do not build the HomeKit bridge.
  --skip-models       Do not download the YAMNet model.
  --skip-mediamtx     Do not install MediaMTX.
  --no-enable         Install the systemd units but do not enable them.
  --no-restart        Do not (re)start services at the end.
  --prefix DIR        Install root                 (default /opt/babymon)
  --conf-dir DIR      Configuration directory      (default /etc/babymon)
  --data-dir DIR      Mutable state; point this at your SSD
                                                   (default /var/lib/babymon)
  --user NAME         System user to run as        (default babymon)
  -h, --help          This text.

Environment equivalents: BABYMON_PREFIX, BABYMON_CONF_DIR, BABYMON_DATA_DIR,
BABYMON_LOG_DIR, BABYMON_USER, BABYMON_NODE_MAJOR.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-apt)        DO_APT=0 ;;
        --skip-node)       DO_NODE=0 ;;
        --skip-dashboard)  DO_DASHBOARD=0 ;;
        --skip-homekit)    DO_BRIDGE=0 ;;
        --skip-models)     DO_MODELS=0 ;;
        --skip-mediamtx)   DO_MEDIAMTX=0 ;;
        --no-enable)       DO_ENABLE=0 ;;
        --no-restart)      DO_RESTART=0 ;;
        --prefix)          PREFIX="${2:?--prefix needs a directory}"; shift ;;
        --conf-dir)        CONF_DIR="${2:?--conf-dir needs a directory}"; shift ;;
        --data-dir)        DATA_DIR="${2:?--data-dir needs a directory}"; shift ;;
        --user)            SVC_USER="${2:?--user needs a name}"; SVC_GROUP="$SVC_USER"; shift ;;
        -h|--help)         usage; exit 0 ;;
        *)                 usage >&2; die "unknown option: $1" ;;
    esac
    shift
done

VENV="$PREFIX/venv"
WEB_DIR="$PREFIX/web"
BRIDGE_DIR="$PREFIX/homekit"

[[ $EUID -eq 0 ]] || die "run this with sudo — it creates a system user, writes to /etc and installs systemd units."

# ---------------------------------------------------------------------------
# 1. Host checks
# ---------------------------------------------------------------------------

step "Checking the host"

PI_MODEL="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo 'unknown')"
info "model:  $PI_MODEL"

OS_ID=; OS_CODENAME=; OS_PRETTY=
if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}"; OS_CODENAME="${VERSION_CODENAME:-}"; OS_PRETTY="${PRETTY_NAME:-}"
fi
info "os:     ${OS_PRETTY:-unknown}"
info "arch:   $(uname -m)"
info "kernel: $(uname -r)"

case "$OS_ID" in
    debian|raspbian) ;;
    *) warn "this installer targets Raspberry Pi OS / Debian; '$OS_ID' is untested." ;;
esac
case "$OS_CODENAME" in
    bookworm|trixie) ;;
    "") warn "could not determine the Debian release." ;;
    *) warn "tested on Bookworm and Trixie; '$OS_CODENAME' is untested." ;;
esac

case "$PI_MODEL" in
    *"Raspberry Pi 5"*)
        warn "Pi 5 removed the hardware H.264 encoder. Every stream is software-encoded"
        warn "  (roughly 1-1.5 cores at 1080p30) and the Active Cooler will run all night"
        warn "  in the nursery. A Pi 4 encodes in hardware, passively, at near-zero CPU."
        warn "  See docs/HARDWARE.md. Also: the DHT22 one-wire sensor does not work on a"
        warn "  Pi 5 — use an I2C sensor (SHT31/SHT4x/BME280)."
        ;;
    *"Raspberry Pi Zero 2"*)
        warn "Pi Zero 2 W is 720p live only. Do not enable HomeKit Secure Video on it."
        ;;
    *"Raspberry Pi 4"*|*"Raspberry Pi Compute Module 4"*|*"Raspberry Pi 400"*)
        ok "Pi 4 class: hardware H.264 encoder present, passively coolable."
        ;;
    *"Raspberry Pi 3"*)
        warn "Pi 3 can do 720p live but will struggle with HKSV alongside audio analysis."
        ;;
    *)
        warn "not a recognised Raspberry Pi. The camera and GPIO paths will not work."
        ;;
esac

if [[ "$(uname -m)" == "armv7l" ]]; then
    warn "32-bit userland detected. The YAMNet runtime (ai-edge-litert) has no armv7"
    warn "  wheel; the audio classifier will fall back to the heuristic backend."
fi

# ---------------------------------------------------------------------------
# 2. apt dependencies
# ---------------------------------------------------------------------------

# Required: the install is not usable without these, so a failure here is fatal.
APT_REQUIRED=(
    python3 python3-venv python3-dev python3-pip
    ffmpeg alsa-utils
    # HAP-NodeJS advertises through this daemon rather than fighting it for
    # UDP 5353 — see docs/HOMEKIT.md.
    avahi-daemon
    git curl ca-certificates tar rsync sqlite3
)

# Optional: each one enables a feature, and its absence degrades that feature
# rather than the install. Names differ between Raspberry Pi OS and plain
# Debian, and between releases, so anything the archive does not offer is
# reported and skipped instead of aborting the run.
APT_OPTIONAL=(
    # python3-picamera2 is an apt package and is NOT pip-installable, which is
    # the entire reason the venv below is created with --system-site-packages.
    # Absent on plain Debian: then the camera has to come from MediaMTX, a USB
    # webcam or an RTSP source, which is the recommended setup anyway.
    python3-picamera2
    # Satisfies the numpy and pyyaml requirements from apt rather than building
    # wheels on the Pi.
    python3-numpy python3-yaml
    # GPIO and I2C. python3-libgpiod is what adafruit-circuitpython-dht wants on
    # Bookworm; i2c-tools gives you i2cdetect for wiring up a real sensor.
    python3-libgpiod python3-lgpio i2c-tools python3-smbus
    # PortAudio, for the sounddevice capture backend. Without it, capture falls
    # back to an arecord/ffmpeg subprocess.
    libportaudio2
    avahi-utils logrotate
)

if (( DO_APT )); then
    step "Installing apt packages"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq

    installed() {
        dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q '^install ok installed$'
    }
    available() {
        [[ -n "$(apt-cache policy "$1" 2>/dev/null | sed -n 's/^ *Candidate: *//p' \
                 | grep -v '^(none)$')" ]]
    }

    missing=()
    for pkg in "${APT_REQUIRED[@]}"; do
        installed "$pkg" || missing+=("$pkg")
    done
    if (( ${#missing[@]} )); then
        info "installing: ${missing[*]}"
        apt-get install -y --no-install-recommends "${missing[@]}"
    fi

    optional=()
    for pkg in "${APT_OPTIONAL[@]}"; do
        installed "$pkg" && continue
        if available "$pkg"; then
            optional+=("$pkg")
        else
            warn "$pkg is not in this archive; skipping (see docs/INSTALL.md)."
        fi
    done
    if (( ${#optional[@]} )); then
        info "installing (optional): ${optional[*]}"
        apt-get install -y --no-install-recommends "${optional[@]}" \
            || warn "one or more optional packages failed to install; continuing."
    fi
    ok "apt dependencies satisfied"
else
    step "Installing apt packages"
    skip "--skip-apt"
fi

# ---------------------------------------------------------------------------
# 3. Node.js
# ---------------------------------------------------------------------------

node_major() {
    command -v node >/dev/null 2>&1 || { echo 0; return; }
    node --version 2>/dev/null | sed -n 's/^v\([0-9]\+\).*/\1/p' | head -n1
}

if (( DO_NODE )); then
    step "Node.js ${NODE_MAJOR}.x"
    have="$(node_major)"; have="${have:-0}"
    # @homebridge/hap-nodejs 2.x declares ^22 || ^24 || ^26. Bookworm ships 18.
    if (( have == 22 || have == 24 || have == 26 )); then
        skip "node $(node --version) already satisfies the bridge's engine range"
    else
        (( have > 0 )) && info "found node v$have, which hap-nodejs 2.x will not run on"
        info "adding the NodeSource repository for node ${NODE_MAJOR}.x"
        install -d -m 0755 /usr/share/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
            | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
        chmod 0644 /usr/share/keyrings/nodesource.gpg
        printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' \
            "$NODE_MAJOR" >/etc/apt/sources.list.d/nodesource.list
        DEBIAN_FRONTEND=noninteractive apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
        ok "node $(node --version), npm $(npm --version)"
    fi
else
    step "Node.js"
    skip "--skip-node"
fi

# ---------------------------------------------------------------------------
# 4. Service user, groups and directories
# ---------------------------------------------------------------------------

step "Service user and directories"

if ! getent group "$SVC_GROUP" >/dev/null; then
    groupadd --system "$SVC_GROUP"
    ok "created group $SVC_GROUP"
fi
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    useradd --system --gid "$SVC_GROUP" --home-dir "$DATA_DIR" \
            --no-create-home --shell /usr/sbin/nologin \
            --comment "babymon baby monitor" "$SVC_USER"
    ok "created user $SVC_USER"
else
    skip "user $SVC_USER exists"
fi

# video: /dev/video*, /dev/media*, /dev/vchiq, /dev/dma_heap on Raspberry Pi OS.
# render: /dev/dri, which libcamera's software ISP path can want.
# audio:  /dev/snd. gpio: /dev/gpiomem. i2c: /dev/i2c-*.
for grp in video render audio gpio i2c plugdev; do
    if getent group "$grp" >/dev/null; then
        if id -nG "$SVC_USER" | tr ' ' '\n' | grep -qx "$grp"; then
            continue
        fi
        usermod -aG "$grp" "$SVC_USER"
        ok "added $SVC_USER to group $grp"
    fi
done

install -d -m 0755 -o root      -g root      "$PREFIX"
install -d -m 0755 -o root      -g root      "$CONF_DIR"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_GROUP" "$DATA_DIR"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_GROUP" "$DATA_DIR/media" "$DATA_DIR/models" \
                                                  "$DATA_DIR/hap" "$DATA_DIR/backups"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_GROUP" "$LOG_DIR"
ok "directories in place"

# The data directory is the one thing that must not live on the SD card:
# a sample row every 15 s plus media writes will wear one out in months.
DATA_SOURCE="$(findmnt -no SOURCE --target "$DATA_DIR" 2>/dev/null || true)"
if [[ "$DATA_SOURCE" == /dev/mmcblk* ]]; then
    warn "$DATA_DIR is on the SD card ($DATA_SOURCE). Continuous writes destroy SD"
    warn "  cards within months. Move it to a USB SSD and re-run with"
    warn "  --data-dir /mnt/ssd/babymon. See docs/HARDWARE.md."
fi

# ---------------------------------------------------------------------------
# 5. Python virtualenv
# ---------------------------------------------------------------------------

step "Python environment"

if [[ ! -x "$VENV/bin/python" ]]; then
    # --system-site-packages is mandatory, not a preference. Raspberry Pi OS
    # Bookworm is PEP 668 externally-managed so pip cannot install into the
    # system Python, and python3-picamera2 (with python3-libcamera and
    # python3-kms++) only exists as an apt package. The venv has to be able to
    # see them.
    python3 -m venv --system-site-packages "$VENV"
    ok "created $VENV (--system-site-packages)"
else
    skip "$VENV exists"
fi

"$VENV/bin/python" -m pip install --quiet --upgrade pip setuptools wheel
info "installing the babymon package"
"$VENV/bin/python" -m pip install --upgrade "$REPO_DIR/pi"

# Optional extras, each best-effort: the monitor degrades rather than fails
# when they are missing.
if ! "$VENV/bin/python" -m pip install --upgrade "$REPO_DIR/pi[audio]" >/dev/null 2>&1; then
    warn "sounddevice failed to install; audio capture will fall back to arecord/ffmpeg."
fi
if [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "x86_64" ]]; then
    if ! "$VENV/bin/python" -m pip install --upgrade "$REPO_DIR/pi[ml]" >/dev/null 2>&1; then
        warn "ai-edge-litert failed to install; the cry classifier will use the"
        warn "  heuristic backend instead of YAMNet (set audio.classifier.backend)."
    fi
fi

"$VENV/bin/python" - <<'PY' || die "the babymon package does not import inside the venv"
import babymon  # noqa: F401
PY
ok "babymon importable from $VENV"

if ! "$VENV/bin/python" -c "import picamera2" >/dev/null 2>&1; then
    warn "picamera2 is not visible inside the venv. If you installed"
    warn "  python3-picamera2 after creating the venv, delete $VENV and re-run."
fi

# ---------------------------------------------------------------------------
# 6. Dashboard
# ---------------------------------------------------------------------------

if (( DO_DASHBOARD )); then
    step "Web dashboard"
    if [[ ! -f "$REPO_DIR/dashboard/package.json" ]]; then
        warn "no dashboard/package.json; skipping."
    elif ! command -v npm >/dev/null 2>&1; then
        warn "npm not found; skipping the dashboard build."
    else
        (
            cd "$REPO_DIR/dashboard"
            if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund
            else npm install --no-audit --no-fund; fi
            npm run build
        )
        install -d -m 0755 "$WEB_DIR"
        rsync -a --delete "$REPO_DIR/dashboard/dist/" "$WEB_DIR/"
        chown -R root:root "$WEB_DIR"
        ok "dashboard built into $WEB_DIR"
    fi
else
    step "Web dashboard"; skip "--skip-dashboard"
fi

# ---------------------------------------------------------------------------
# 7. HomeKit bridge
# ---------------------------------------------------------------------------

if (( DO_BRIDGE )); then
    step "HomeKit bridge"
    if [[ ! -f "$REPO_DIR/homekit/package.json" ]]; then
        warn "no homekit/package.json; skipping."
    elif ! command -v npm >/dev/null 2>&1; then
        warn "npm not found; skipping the bridge build."
    else
        (
            cd "$REPO_DIR/homekit"
            if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund
            else npm install --no-audit --no-fund; fi
            npm run build
        )
        install -d -m 0755 "$BRIDGE_DIR"
        rsync -a --delete "$REPO_DIR/homekit/dist/" "$BRIDGE_DIR/dist/"
        install -m 0644 "$REPO_DIR/homekit/package.json" "$BRIDGE_DIR/package.json"
        [[ -f "$REPO_DIR/homekit/package-lock.json" ]] &&
            install -m 0644 "$REPO_DIR/homekit/package-lock.json" "$BRIDGE_DIR/package-lock.json"
        # A production-only tree next to the built JS, so the running service
        # does not depend on the source checkout still being there.
        (
            cd "$BRIDGE_DIR"
            if [[ -f package-lock.json ]]; then npm ci --omit=dev --no-audit --no-fund
            else npm install --omit=dev --no-audit --no-fund; fi
        )
        chown -R root:root "$BRIDGE_DIR"
        ok "bridge built into $BRIDGE_DIR"
    fi
else
    step "HomeKit bridge"; skip "--skip-homekit"
fi

# ---------------------------------------------------------------------------
# 8. Models
# ---------------------------------------------------------------------------

if (( DO_MODELS )); then
    step "Sound classification model"
    if [[ -f "$DATA_DIR/models/yamnet.tflite" && -f "$DATA_DIR/models/yamnet_class_map.csv" ]]; then
        skip "YAMNet already present in $DATA_DIR/models"
    elif ! "$REPO_DIR/deploy/fetch-models.sh" --dest "$DATA_DIR/models"; then
        warn "model download failed. The detector will fall back to the heuristic"
        warn "  classifier. Retry later with: sudo deploy/fetch-models.sh --dest $DATA_DIR/models"
    fi
    chown -R "$SVC_USER:$SVC_GROUP" "$DATA_DIR/models"
else
    step "Sound classification model"; skip "--skip-models"
fi

# ---------------------------------------------------------------------------
# 9. MediaMTX
# ---------------------------------------------------------------------------

# The camera device can only be opened once. MediaMTX owns it and republishes
# over RTSP on the loopback, so the bridge, the analyser and the snapshot
# endpoint are all just clients. See docs/ARCHITECTURE.md.
MEDIAMTX_FALLBACK_VERSION="${BABYMON_MEDIAMTX_VERSION:-v1.11.3}"

mediamtx_asset_arch() {
    case "$(uname -m)" in
        aarch64) echo linux_arm64v8 ;;
        armv7l|armv6l) echo linux_armv7 ;;
        x86_64) echo linux_amd64 ;;
        *) return 1 ;;
    esac
}

if (( DO_MEDIAMTX )); then
    step "MediaMTX"
    if ! arch_tag="$(mediamtx_asset_arch)"; then
        warn "no MediaMTX build for $(uname -m); skipping."
    elif [[ -x "$MEDIAMTX_BIN" ]]; then
        skip "$MEDIAMTX_BIN present ($("$MEDIAMTX_BIN" --version 2>/dev/null | head -n1 || echo 'version unknown'))"
    else
        # The pin below is only a fallback: rpiCameraSecondary (the second,
        # cheap MJPEG stream off the same camera open) needs >= v1.10.0, so an
        # old pin would quietly break the analysis path.
        url=""
        if api_json="$(curl -fsSL --max-time 20 \
                https://api.github.com/repos/bluenviron/mediamtx/releases/latest 2>/dev/null)"; then
            url="$(printf '%s' "$api_json" \
                | grep -o "https://[^\"]*_${arch_tag}\.tar\.gz" | head -n1 || true)"
        fi
        if [[ -z "$url" ]]; then
            warn "could not reach the GitHub API; falling back to $MEDIAMTX_FALLBACK_VERSION"
            url="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_FALLBACK_VERSION}/mediamtx_${MEDIAMTX_FALLBACK_VERSION}_${arch_tag}.tar.gz"
        fi
        tmp="$(mktemp -d)"
        trap 'rm -rf "$tmp"' EXIT
        info "downloading $(basename "$url")"
        curl -fL --retry 3 --retry-delay 2 -o "$tmp/mediamtx.tar.gz" "$url" \
            || die "MediaMTX download failed: $url"
        tar xzf "$tmp/mediamtx.tar.gz" -C "$tmp" \
            || die "MediaMTX archive is corrupt (partial download?)"
        [[ -f "$tmp/mediamtx" ]] || die "MediaMTX archive did not contain the binary"
        install -m 0755 -o root -g root "$tmp/mediamtx" "$MEDIAMTX_BIN"
        rm -rf "$tmp"; trap - EXIT
        ok "installed $("$MEDIAMTX_BIN" --version 2>/dev/null | head -n1 || echo mediamtx)"
    fi

    if [[ -f "$CONF_DIR/mediamtx.yml" ]]; then
        skip "$CONF_DIR/mediamtx.yml exists (not overwritten)"
    else
        install -m 0644 -o root -g root "$REPO_DIR/deploy/mediamtx.yml" "$CONF_DIR/mediamtx.yml"
        ok "wrote $CONF_DIR/mediamtx.yml"
    fi
else
    step "MediaMTX"; skip "--skip-mediamtx"
fi

# ---------------------------------------------------------------------------
# 10. Configuration
# ---------------------------------------------------------------------------

step "Configuration"

if [[ -f "$CONF_DIR/babymon.yaml" ]]; then
    skip "$CONF_DIR/babymon.yaml exists (never overwritten)"
else
    install -m 0640 -o root -g "$SVC_GROUP" \
        "$REPO_DIR/config/babymon.example.yaml" "$CONF_DIR/babymon.yaml"
    ok "wrote $CONF_DIR/babymon.yaml from the example"
    info "edit it: at minimum set site.timezone, the child's name and birthdate,"
    info "and paths.data_dir if it is not $DATA_DIR"
fi

# Secrets live in the environment file, never in the YAML. Generated once and
# then left alone, because regenerating the HomeKit PIN would unpair the
# accessory and regenerating the API password would lock out every browser.
ENV_FILE="$CONF_DIR/babymon.env"

# /dev/urandom throughout. $RANDOM is a 15-bit LCG seeded from the pid and the
# clock, which is fine for a shuffle and not fine for a pairing code that is
# the only thing standing between a stranger and the camera.
random_alnum() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
random_digits() { LC_ALL=C tr -dc '0-9' </dev/urandom | head -c "$1"; }
random_pin() {
    # Eight digits as NNN-NN-NNN. HomeKit rejects a handful of trivial codes;
    # babymon.config warns about the same list, so redraw until we miss it.
    local digits pin
    while :; do
        digits="$(random_digits 8)"
        pin="${digits:0:3}-${digits:3:2}-${digits:5:3}"
        case "$pin" in
            000-00-000|111-11-111|222-22-222|333-33-333|444-44-444|555-55-555|\
            666-66-666|777-77-777|888-88-888|999-99-999|123-45-678|876-54-321) ;;
            *) printf '%s' "$pin"; return ;;
        esac
    done
}

# Re-point a path that has moved, without touching a single secret.
#
# The systemd units are rewritten on every install, so ReadWritePaths follows
# --data-dir. The env file was not, so re-installing to a new location left the
# service pointed at the old one — which ProtectSystem=strict then refuses to
# let it write. It fails at startup with a permission error naming a directory
# the operator did not choose, and nothing in the install output hints at why.
retarget_env_path() {
    local key="$1" want="$2" current
    current="$(sed -n "s|^${key}=||p" "$ENV_FILE" | head -1)"
    [[ -n "$current" && "$current" != "$want" ]] || return 0
    sed -i "s|^${key}=.*|${key}=${want}|" "$ENV_FILE"
    warn "$key moved: $current -> $want (updated in $ENV_FILE)"
}

if [[ -f "$ENV_FILE" ]]; then
    skip "$ENV_FILE exists (secrets left alone)"
    retarget_env_path BABYMON_PATHS__DATA_DIR "$DATA_DIR"
    retarget_env_path BABYMON_PATHS__STATIC_DIR "$WEB_DIR"
else
    api_password="$(random_alnum 24)"
    api_token="$(random_alnum 48)"
    hk_pin="$(random_pin)"
    # Created 0600 by the subshell's umask, then relaxed to 0640 for the group,
    # so there is no window in which it is world-readable.
    (
        umask 077
        sed -e "s|@API_PASSWORD@|$api_password|" \
            -e "s|@API_TOKEN@|$api_token|" \
            -e "s|@HOMEKIT_PIN@|$hk_pin|" \
            -e "s|@DATA_DIR@|$DATA_DIR|" \
            -e "s|@WEB_DIR@|$WEB_DIR|" \
            "$REPO_DIR/deploy/babymon.env.example" >"$ENV_FILE"
    )
    chown root:"$SVC_GROUP" "$ENV_FILE"
    chmod 0640 "$ENV_FILE"
    ok "generated $ENV_FILE (mode 0640, root:$SVC_GROUP)"
    GENERATED_PASSWORD="$api_password"
    GENERATED_PIN="$hk_pin"
fi

# ---------------------------------------------------------------------------
# 11. udev and logrotate
# ---------------------------------------------------------------------------

step "udev and logrotate"

if [[ -f "$REPO_DIR/deploy/udev/99-babymon.rules" ]]; then
    install -m 0644 -o root -g root \
        "$REPO_DIR/deploy/udev/99-babymon.rules" /etc/udev/rules.d/99-babymon.rules
    udevadm control --reload-rules >/dev/null 2>&1 || true
    udevadm trigger --subsystem-match=dma_heap >/dev/null 2>&1 || true
    ok "udev rules installed"
fi

if [[ -f "$REPO_DIR/deploy/logrotate/babymon" ]]; then
    sed -e "s|@LOG_DIR@|$LOG_DIR|g" -e "s|@USER@|$SVC_USER|g" -e "s|@GROUP@|$SVC_GROUP|g" \
        "$REPO_DIR/deploy/logrotate/babymon" >/etc/logrotate.d/babymon
    chmod 0644 /etc/logrotate.d/babymon
    ok "logrotate rule installed (only used if logging.file is set)"
fi

# ---------------------------------------------------------------------------
# 12. systemd units
# ---------------------------------------------------------------------------

step "systemd units"

UNITS=(babymon-mediamtx.service babymon-api.service babymon-homekit.service)
for unit in "${UNITS[@]}"; do
    src="$REPO_DIR/deploy/systemd/$unit"
    [[ -f "$src" ]] || die "missing unit file: $src"
    sed -e "s|$DEFAULT_PREFIX|$PREFIX|g" \
        -e "s|$DEFAULT_CONF_DIR|$CONF_DIR|g" \
        -e "s|$DEFAULT_DATA_DIR|$DATA_DIR|g" \
        -e "s|$DEFAULT_LOG_DIR|$LOG_DIR|g" \
        -e "s|^\(User=\)$DEFAULT_USER$|\1$SVC_USER|" \
        -e "s|^\(Group=\)$DEFAULT_USER$|\1$SVC_GROUP|" \
        "$src" >"$UNIT_DIR/$unit"
    chmod 0644 "$UNIT_DIR/$unit"
done
systemctl daemon-reload
ok "installed: ${UNITS[*]}"

if (( DO_ENABLE )); then
    systemctl enable "${UNITS[@]}" >/dev/null
    ok "enabled at boot"
    # avahi is what the bridge advertises through; without it the accessory
    # appears in the Home app and then vanishes.
    systemctl enable --now avahi-daemon >/dev/null 2>&1 || \
        warn "could not enable avahi-daemon; HomeKit discovery will be unreliable."
fi

if (( DO_RESTART )); then
    for unit in "${UNITS[@]}"; do
        systemctl restart "$unit" || warn "$unit failed to start; see: journalctl -u $unit -n 50"
    done
    sleep 3
    for unit in "${UNITS[@]}"; do
        if systemctl is-active --quiet "$unit"; then
            ok "$unit running"
        else
            warn "$unit is not running — journalctl -u $unit -n 50"
        fi
    done
fi

# ---------------------------------------------------------------------------
# 13. What to do next
# ---------------------------------------------------------------------------

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-<pi-address>}"

cat <<EOF

${C_BOLD}babymon is installed.${C_RESET}

  config        $CONF_DIR/babymon.yaml
  secrets       $CONF_DIR/babymon.env      (mode 0640, root:$SVC_GROUP)
  data          $DATA_DIR
  code          $PREFIX
  dashboard     http://$IP:8080/
EOF

if [[ -n "${GENERATED_PASSWORD:-}" ]]; then
    cat <<EOF

  ${C_BOLD}Dashboard password:${C_RESET}  $GENERATED_PASSWORD
  ${C_BOLD}HomeKit pairing PIN:${C_RESET} $GENERATED_PIN

  These were generated just now and are stored in $CONF_DIR/babymon.env.
  Write them down; this is the only time they are printed.
EOF
fi

cat <<EOF

${C_BOLD}Next:${C_RESET}

  1. Edit $CONF_DIR/babymon.yaml — site.timezone, the child's name and
     birthdate (the age band and the quality score depend on it), and
     environment.sensor if you fitted an I2C sensor instead of a DHT22.

  2. Check the camera is up:
         ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8554/babymon
     and that the low-res analysis stream exists:
         ffprobe -rtsp_transport tcp rtsp://127.0.0.1:8554/babymon-lores

  3. If the microphone is shared between Python and the HomeKit bridge, install
     the dsnoop config so both can open it:
         sudo cp deploy/asound.conf.example /etc/asound.conf
         amixer -c 1 set 'Auto Gain Control' off     # AGC ruins every threshold

  4. Pair HomeKit: Home app → Add Accessory → More options, and pick the
     accessory named by homekit.name in the config (default "Baby Monitor").
     The PIN is BABYMON_HOMEKIT__PIN in $CONF_DIR/babymon.env, and the
     dashboard shows a QR code at /system.
     HomeKit Secure Video additionally needs iCloud+ and a home hub
     (Apple TV 4K or HomePod) — see docs/HOMEKIT.md.

  5. Logs:
         journalctl -u babymon-api -f
         journalctl -u babymon-homekit -f
         journalctl -u babymon-mediamtx -f
EOF

if (( ${#WARNINGS[@]} )); then
    printf '\n%s%d warning(s) above:%s\n' "$C_YELLOW" "${#WARNINGS[@]}" "$C_RESET"
    printf '  - %s\n' "${WARNINGS[@]}"
fi

echo
