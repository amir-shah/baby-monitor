#!/usr/bin/env bash
#
# Remove babymon.
#
# The default is deliberately timid: it stops and removes the services and the
# installed code, and leaves your configuration, your recordings and your
# database exactly where they are. Months of a child's sleep history is not
# something an uninstall script should be able to destroy by accident, so
# deleting it takes an explicit flag AND typing the word.

set -euo pipefail

PREFIX="${BABYMON_PREFIX:-/opt/babymon}"
CONF_DIR="${BABYMON_CONF_DIR:-/etc/babymon}"
DATA_DIR="${BABYMON_DATA_DIR:-/var/lib/babymon}"
LOG_DIR="${BABYMON_LOG_DIR:-/var/log/babymon}"
SVC_USER="${BABYMON_USER:-babymon}"
UNIT_DIR=/etc/systemd/system

PURGE_CONFIG=0
PURGE_DATA=0
PURGE_USER=0
PURGE_MEDIAMTX=0
ASSUME_YES=0

UNITS=(babymon-homekit.service babymon-api.service babymon-mediamtx.service)

if [[ -t 1 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
    C_YELLOW=$'\033[33m'; C_GREEN=$'\033[32m'; C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'
else
    C_RESET=; C_BOLD=; C_RED=; C_YELLOW=; C_GREEN=; C_BLUE=; C_DIM=
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
skip() { printf '    %sskip%s %s\n' "$C_DIM" "$C_RESET" "$*"; }
warn() { printf '    %swarning:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '\n%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Usage: sudo deploy/uninstall.sh [options]

By default: stops and disables the services, removes the systemd units, the
virtualenv, the built dashboard and the HomeKit bridge. Keeps your config,
your database and your recordings.

Options:
  --purge-config    Also delete /etc/babymon (config AND the secrets file:
                    the HomeKit pairing PIN and the dashboard password).
  --purge-data      Also delete the data directory — the database, every
                    recording, every snapshot, and the HAP pairing keys.
                    This is not recoverable. Back up first:
                        make backup
  --purge-user      Also delete the babymon system user and group.
  --purge-mediamtx  Also remove /usr/local/bin/mediamtx.
  --all             All of the above.
  -y, --yes         Do not prompt. Required for scripted use; you still have
                    to pass --purge-data explicitly.
  -h, --help        This text.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --purge-config)   PURGE_CONFIG=1 ;;
        --purge-data)     PURGE_DATA=1 ;;
        --purge-user)     PURGE_USER=1 ;;
        --purge-mediamtx) PURGE_MEDIAMTX=1 ;;
        --all)            PURGE_CONFIG=1; PURGE_DATA=1; PURGE_USER=1; PURGE_MEDIAMTX=1 ;;
        -y|--yes)         ASSUME_YES=1 ;;
        -h|--help)        usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
done

[[ $EUID -eq 0 ]] || die "run this with sudo."

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

step "Stopping services"
for unit in "${UNITS[@]}"; do
    if systemctl list-unit-files "$unit" >/dev/null 2>&1 && \
       [[ -n "$(systemctl list-unit-files --no-legend "$unit" 2>/dev/null)" ]]; then
        systemctl stop "$unit" 2>/dev/null || true
        systemctl disable "$unit" 2>/dev/null || true
        ok "stopped and disabled $unit"
    else
        skip "$unit not installed"
    fi
done

step "Removing systemd units"
removed=0
for unit in "${UNITS[@]}"; do
    if [[ -f "$UNIT_DIR/$unit" ]]; then
        rm -f "$UNIT_DIR/$unit"
        removed=1
        ok "removed $UNIT_DIR/$unit"
    fi
done
if (( removed )); then
    systemctl daemon-reload
    systemctl reset-failed 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Installed code
# ---------------------------------------------------------------------------

step "Removing installed code"
for path in "$PREFIX/venv" "$PREFIX/web" "$PREFIX/homekit"; do
    if [[ -e "$path" ]]; then
        rm -rf "$path"
        ok "removed $path"
    else
        skip "$path absent"
    fi
done
# Only if we left it empty — the operator may keep other things under /opt.
rmdir "$PREFIX" 2>/dev/null && ok "removed $PREFIX" || true

for path in /etc/udev/rules.d/99-babymon.rules /etc/logrotate.d/babymon; do
    if [[ -f "$path" ]]; then
        rm -f "$path"
        ok "removed $path"
    fi
done
udevadm control --reload-rules >/dev/null 2>&1 || true

if (( PURGE_MEDIAMTX )); then
    if [[ -e /usr/local/bin/mediamtx ]]; then
        rm -f /usr/local/bin/mediamtx
        ok "removed /usr/local/bin/mediamtx"
    fi
    [[ -f "$CONF_DIR/mediamtx.yml" && $PURGE_CONFIG -eq 0 ]] &&
        warn "$CONF_DIR/mediamtx.yml kept (pass --purge-config to remove it)"
else
    skip "/usr/local/bin/mediamtx kept (--purge-mediamtx to remove)"
fi

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

confirm() {
    local prompt="$1" want="$2" answer
    (( ASSUME_YES )) && return 0
    printf '\n%s%s%s\n' "$C_YELLOW" "$prompt" "$C_RESET"
    read -r -p "Type '$want' to continue: " answer
    [[ "$answer" == "$want" ]]
}

step "Configuration"
if (( PURGE_CONFIG )); then
    if [[ -d "$CONF_DIR" ]]; then
        if confirm "This deletes $CONF_DIR, including babymon.env — the dashboard password and the HomeKit pairing PIN." "delete config"; then
            rm -rf "$CONF_DIR"
            ok "removed $CONF_DIR"
        else
            warn "kept $CONF_DIR"
        fi
    else
        skip "$CONF_DIR absent"
    fi
else
    skip "$CONF_DIR kept (--purge-config to remove)"
fi

# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

step "Data"
if (( PURGE_DATA )); then
    if [[ -d "$DATA_DIR" ]]; then
        size="$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1 || echo '?')"
        nights='?'
        if [[ -f "$DATA_DIR/babymon.db" ]] && command -v sqlite3 >/dev/null 2>&1; then
            nights="$(sqlite3 "$DATA_DIR/babymon.db" 'SELECT COUNT(*) FROM nights' 2>/dev/null || echo '?')"
        fi
        if confirm "This permanently deletes $DATA_DIR ($size, $nights nights of sleep history), every recording, and the HomeKit pairing keys. There is no undo." "delete everything"; then
            rm -rf "$DATA_DIR"
            ok "removed $DATA_DIR"
        else
            warn "kept $DATA_DIR"
        fi
    else
        skip "$DATA_DIR absent"
    fi
else
    skip "$DATA_DIR kept (--purge-data to remove)"
fi

if [[ -d "$LOG_DIR" ]]; then
    rm -rf "$LOG_DIR"
    ok "removed $LOG_DIR"
fi

# ---------------------------------------------------------------------------
# User
# ---------------------------------------------------------------------------

step "System user"
if (( PURGE_USER )); then
    if id -u "$SVC_USER" >/dev/null 2>&1; then
        if [[ -d "$DATA_DIR" ]]; then
            warn "$DATA_DIR still exists and is owned by $SVC_USER; deleting the"
            warn "  user would leave it owned by a bare uid. Keeping the user."
        else
            userdel "$SVC_USER" 2>/dev/null || warn "userdel $SVC_USER failed"
            getent group "$SVC_USER" >/dev/null && groupdel "$SVC_USER" 2>/dev/null || true
            ok "removed user and group $SVC_USER"
        fi
    else
        skip "user $SVC_USER absent"
    fi
else
    skip "user $SVC_USER kept (--purge-user to remove)"
fi

# ---------------------------------------------------------------------------

cat <<EOF

${C_BOLD}babymon has been uninstalled.${C_RESET}

Left alone on purpose — remove by hand if you want them gone:
  apt packages       ffmpeg, avahi-daemon, python3-picamera2, nodejs, ...
                     (other things on this Pi almost certainly use them)
  NodeSource repo    /etc/apt/sources.list.d/nodesource.list
  ALSA config        /etc/asound.conf
$( [[ -d "$CONF_DIR" ]] && echo "  configuration      $CONF_DIR" )
$( [[ -d "$DATA_DIR" ]] && echo "  data               $DATA_DIR" )

If you paired the camera with HomeKit, remove the accessory in the Home app
too — otherwise it sits there showing "No Response" forever. Any HomeKit
Secure Video clips already in iCloud age out on Apple's own 10-day schedule;
deleting this Pi does not delete them, and neither does removing the
accessory. See docs/PRIVACY.md.
EOF
