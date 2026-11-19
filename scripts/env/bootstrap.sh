#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

WITH_RUST=0
for arg in "$@"; do
  case "$arg" in
    --with-rust) WITH_RUST=1 ;;
  esac
done
if [ "${RC_INSTALL_RUST:-0}" = "1" ]; then
  WITH_RUST=1
fi

echo "[env:setup] Bootstrapping RocketCompanion E2E & WebGL environment in $ROOT_DIR..."

# 1. Ensure pnpm is available
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[env:setup] Installing pnpm globally..."
  npm install -g pnpm@10.28.2
fi

# 2. Initialize public/ git submodule (RocketCompanionStatics)
if [ ! -f "public/camera.wasm" ] && [ ! -d "public/wasm" ]; then
  echo "[env:setup] Initializing public/ git submodule..."
  GIT_TERMINAL_PROMPT=0 git submodule update --init --recursive
fi

# 3. Install JS dependencies if missing
if [ ! -d "node_modules" ]; then
  echo "[env:setup] Installing npm dependencies with pnpm..."
  pnpm install --no-frozen-lockfile --ignore-scripts
fi

# 4. Ensure Headless Chrome / Chromium is available
if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1 && [ -z "${CHROME_BIN:-}" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    echo "[env:setup] Chrome/Chromium not found. Installing chromium via apt-get..."
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y chromium || DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser || true
  else
    echo "[env:setup] WARNING: Chrome/Chromium not found and apt-get unavailable. Set CHROME_BIN to a Chrome executable." >&2
  fi
fi

# 5. Ensure synthetic 3v3 .rcreplay fixture exists for E2E replay tests
REPLAY_FIXTURE="/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay"
if [ ! -f "$REPLAY_FIXTURE" ]; then
  echo "[env:setup] Generating synthetic 3v3 .rcreplay fixture at $REPLAY_FIXTURE..."
  node scripts/env/generateSyntheticReplayFixture.mjs "$REPLAY_FIXTURE"
fi

# 6. Optional Rust/Cargo + Tauri C toolchain bootstrap (for Tauri C4 verification)
if [ "$WITH_RUST" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    if ! command -v cc >/dev/null 2>&1 || ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
      echo "[env:setup] Installing C/Tauri Linux build dependencies via apt-get..."
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        gcc libc6-dev pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev || true
    fi
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  if ! command -v cargo >/dev/null 2>&1; then
    echo "[env:setup] Installing Rust toolchain (minimal)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
fi

echo "[env:setup] Running verification probe..."
node scripts/env/checkEnv.mjs
