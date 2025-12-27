#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Builds the Python runner as a native sidecar executable using PyInstaller.
# Output: src-tauri/bin/cerebro_runner-<target-triple>

PYTHON_BIN="${PYTHON_BIN:-python3}"

TARGET_TRIPLE="${TAURI_ENV_TARGET_TRIPLE:-${TARGET:-}}"
if [[ -z "$TARGET_TRIPLE" ]]; then
  if command -v rustc >/dev/null 2>&1; then
    TARGET_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
  fi
fi

if [[ -z "$TARGET_TRIPLE" ]]; then
  echo "ERROR: Could not determine target triple. Set TAURI_ENV_TARGET_TRIPLE or TARGET." >&2
  exit 1
fi

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "ERROR: $PYTHON_BIN not found. Install Python 3 and retry." >&2
  exit 1
fi

RUNNER_SRC="$ROOT_DIR/src-tauri/py/cerebro_runner.py"
OUT_DIR="$ROOT_DIR/src-tauri/bin"
BUILD_DIR="$ROOT_DIR/src-tauri/.pyinstaller/build"
SPEC_DIR="$ROOT_DIR/src-tauri/.pyinstaller/spec"

if [[ ! -f "$RUNNER_SRC" ]]; then
  echo "ERROR: Runner not found at $RUNNER_SRC" >&2
  exit 1
fi

# Ensure PyInstaller exists (install to user site-packages by default)
if ! "$PYTHON_BIN" -m PyInstaller --version >/dev/null 2>&1; then
  echo "PyInstaller not found. Installing..." >&2
  "$PYTHON_BIN" -m pip install --user pyinstaller
fi

mkdir -p "$OUT_DIR" "$BUILD_DIR" "$SPEC_DIR"

# Note: packaging torch/transformers can be very large.
"$PYTHON_BIN" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name "cerebro_runner-$TARGET_TRIPLE" \
  --distpath "$OUT_DIR" \
  --workpath "$BUILD_DIR" \
  --specpath "$SPEC_DIR" \
  "$RUNNER_SRC"

# Convenience copy for dev/manual runs.
if [[ -f "$OUT_DIR/cerebro_runner-$TARGET_TRIPLE" ]]; then
  cp -f "$OUT_DIR/cerebro_runner-$TARGET_TRIPLE" "$OUT_DIR/cerebro_runner"
fi

echo "Built sidecar: $OUT_DIR/cerebro_runner-$TARGET_TRIPLE"