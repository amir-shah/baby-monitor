#!/usr/bin/env bash
#
# Download the YAMNet sound classifier used by the cry detector.
#
# YAMNet is a MobileNet-v1 audio classifier trained on AudioSet; it emits 521
# class scores per 0.975 s frame, of which "Baby cry, infant cry", "Crying,
# sobbing", "Whimper" and friends are what we care about. The TFLite build is
# about 4 MiB and runs in a few milliseconds per frame on a Pi 4, which is why
# the detector gates it behind a level threshold and leaves the CPU asleep for
# most of a quiet night.
#
# A partial download is worse than no download: a truncated .tflite loads far
# enough to produce garbage scores. Every artefact is therefore size- and
# content-checked, written to a temporary file, and only moved into place once
# it passes.

set -euo pipefail

DEST="${BABYMON_MODELS_DIR:-/var/lib/babymon/models}"
FORCE=0

YAMNET_URL="https://www.kaggle.com/api/v1/models/google/yamnet/tfLite/classification-tflite/1/download"
CLASSMAP_URL="https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv"

# The published TFLite model is 3.94 MiB. Bounds rather than an exact size or a
# checksum: Kaggle has re-exported this model before without changing the
# version number, and a hard hash would turn that into a failed install for
# everyone. These bounds still catch every truncation and every HTML error page.
YAMNET_MIN_BYTES=3500000
YAMNET_MAX_BYTES=5500000
# 521 AudioSet classes plus a header row.
CLASSMAP_EXPECTED_LINES=522
CLASSMAP_MIN_BYTES=10000

usage() {
    cat <<'EOF'
Usage: deploy/fetch-models.sh [--dest DIR] [--force]

  --dest DIR   Where to put yamnet.tflite and yamnet_class_map.csv.
               Default: $BABYMON_MODELS_DIR, else /var/lib/babymon/models.
               This must match audio.classifier.model_path in your config,
               which defaults to ${paths.models_dir}/yamnet.tflite.
  --force      Re-download even if the files are already present and valid.
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dest)  DEST="${2:?--dest needs a directory}"; shift ;;
        --force) FORCE=1 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

die() { printf 'fetch-models: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }

filesize() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }

command -v curl >/dev/null || die "curl is required"
command -v tar  >/dev/null || die "tar is required"

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# yamnet.tflite
# ---------------------------------------------------------------------------

if [[ -f "$DEST/yamnet.tflite" && $FORCE -eq 0 ]]; then
    size="$(filesize "$DEST/yamnet.tflite")"
    if (( size >= YAMNET_MIN_BYTES && size <= YAMNET_MAX_BYTES )); then
        info "yamnet.tflite already present ($size bytes)"
    else
        die "$DEST/yamnet.tflite is $size bytes, which is outside the expected
  range ($YAMNET_MIN_BYTES..$YAMNET_MAX_BYTES). That is a truncated or corrupt
  download. Delete it and re-run, or pass --force."
    fi
else
    info "downloading YAMNet from Kaggle"
    # Kaggle serves a redirect to a signed URL; -L follows it. --fail turns an
    # HTML error page into a non-zero exit instead of a 2 KB "model file".
    curl -fL --retry 3 --retry-delay 2 --max-time 300 \
        -o "$TMP/yamnet.tar.gz" "$YAMNET_URL" \
        || die "download failed. Kaggle occasionally requires accepting the model
  licence in a browser first: https://www.kaggle.com/models/google/yamnet"

    archive_size="$(filesize "$TMP/yamnet.tar.gz")"
    (( archive_size > 1000000 )) \
        || die "the downloaded archive is only $archive_size bytes — that is an error
  page, not a model. Check the URL in a browser."

    tar xzf "$TMP/yamnet.tar.gz" -C "$TMP" \
        || die "the archive is not a valid gzip tarball (partial download?)"

    # The archive contains a single file named '1.tflite'.
    src="$TMP/1.tflite"
    if [[ ! -f "$src" ]]; then
        src="$(find "$TMP" -name '*.tflite' -type f | head -n1)"
    fi
    [[ -n "$src" && -f "$src" ]] || die "no .tflite file inside the archive"

    size="$(filesize "$src")"
    (( size >= YAMNET_MIN_BYTES && size <= YAMNET_MAX_BYTES )) \
        || die "extracted model is $size bytes, expected roughly 4 MiB
  ($YAMNET_MIN_BYTES..$YAMNET_MAX_BYTES). Refusing to install a bad model."

    # Every TFLite flatbuffer carries the identifier "TFL3" at byte offset 4.
    magic="$(dd if="$src" bs=1 skip=4 count=4 2>/dev/null | tr -d '\0')"
    [[ "$magic" == "TFL3" ]] \
        || die "the extracted file is not a TFLite model (magic '$magic', expected 'TFL3')"

    mv -f "$src" "$DEST/yamnet.tflite"
    chmod 0644 "$DEST/yamnet.tflite"
    info "yamnet.tflite installed ($size bytes)"
fi

# ---------------------------------------------------------------------------
# yamnet_class_map.csv
# ---------------------------------------------------------------------------
#
# The model outputs 521 unnamed scores. This file is the only thing that maps
# index 20 to "Baby cry, infant cry"; without it the classifier cannot name
# anything and the detector falls back to level-only detection.

if [[ -f "$DEST/yamnet_class_map.csv" && $FORCE -eq 0 ]]; then
    lines="$(wc -l <"$DEST/yamnet_class_map.csv")"
    if (( lines == CLASSMAP_EXPECTED_LINES )); then
        info "yamnet_class_map.csv already present ($lines lines)"
    else
        die "$DEST/yamnet_class_map.csv has $lines lines, expected $CLASSMAP_EXPECTED_LINES.
  Delete it and re-run, or pass --force."
    fi
else
    info "downloading the AudioSet class map"
    curl -fL --retry 3 --retry-delay 2 --max-time 120 \
        -o "$TMP/yamnet_class_map.csv" "$CLASSMAP_URL" \
        || die "class map download failed: $CLASSMAP_URL"

    size="$(filesize "$TMP/yamnet_class_map.csv")"
    (( size >= CLASSMAP_MIN_BYTES )) \
        || die "the class map is only $size bytes; that is not the real file."

    lines="$(wc -l <"$TMP/yamnet_class_map.csv")"
    (( lines == CLASSMAP_EXPECTED_LINES )) \
        || die "the class map has $lines lines, expected $CLASSMAP_EXPECTED_LINES
  (521 AudioSet classes plus a header). Upstream may have changed; check
  $CLASSMAP_URL before overriding this."

    header="$(head -n1 "$TMP/yamnet_class_map.csv" | tr -d '\r')"
    [[ "$header" == "index,mid,display_name" ]] \
        || die "unexpected class map header: '$header'"

    grep -q 'Baby cry, infant cry' "$TMP/yamnet_class_map.csv" \
        || die "the class map does not contain the infant-cry class; wrong file."

    mv -f "$TMP/yamnet_class_map.csv" "$DEST/yamnet_class_map.csv"
    chmod 0644 "$DEST/yamnet_class_map.csv"
    info "yamnet_class_map.csv installed ($lines lines)"
fi

cat <<EOF

Models are in $DEST:
  $(ls -lh "$DEST/yamnet.tflite" | awk '{print $5, $9}')
  $(ls -lh "$DEST/yamnet_class_map.csv" | awk '{print $5, $9}')

Point audio.classifier at them if your paths.models_dir differs:
  audio:
    classifier:
      backend: yamnet
      model_path: "$DEST/yamnet.tflite"
      class_map_path: "$DEST/yamnet_class_map.csv"
EOF
