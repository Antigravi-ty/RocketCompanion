#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

WITH_RUST=0
PNPM_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --with-rust) WITH_RUST=1 ;;
    --pnpm-only) PNPM_ONLY=1 ;;
    --help|-h)
      echo "Usage: bash scripts/env/bootstrap.sh [--with-rust] [--pnpm-only] [--help]"
      echo "  --with-rust   Also install Rust/Cargo and Tauri C dependencies into tmpfs"
      echo "  --pnpm-only   Only install pnpm and self-healing wrapper into tmpfs"
      exit 0
      ;;
  esac
done
if [ "${RC_INSTALL_RUST:-0}" = "1" ]; then
  WITH_RUST=1
fi

CACHE_ROOT="${RC_TMPFS_CACHE_DIR:-/tmp/rc-cache}"
export RC_TMPFS_CACHE_DIR="$CACHE_ROOT"
export npm_config_store_dir="${npm_config_store_dir:-${CACHE_ROOT}/pnpm-store}"
export npm_config_cache_dir="${npm_config_cache_dir:-${CACHE_ROOT}/pnpm-cache}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${CACHE_ROOT}/cargo-target}"
export CARGO_HOME="${CARGO_HOME:-${CACHE_ROOT}/cargo-home}"
export RUSTUP_HOME="${RUSTUP_HOME:-${CACHE_ROOT}/rustup-home}"
export npm_config_update_notifier="${npm_config_update_notifier:-false}"
export pnpm_config_update_notifier="${pnpm_config_update_notifier:-false}"
export NO_UPDATE_NOTIFIER="${NO_UPDATE_NOTIFIER:-1}"
export RC_SOFT_LIMIT_MS="${RC_SOFT_LIMIT_MS:-270000}"

SOFT_LIMIT_SEC=$(( (RC_SOFT_LIMIT_MS + 999) / 1000 ))
if [ "$SOFT_LIMIT_SEC" -lt 1 ]; then
  SOFT_LIMIT_SEC=1
fi
BOOTSTRAP_PID=$$
(
  sleep "$SOFT_LIMIT_SEC"
  if kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
    echo "[env:setup] Soft timeout watchdog reached (${RC_SOFT_LIMIT_MS}ms). Terminating bootstrap..." >&2
    kill -TERM "$BOOTSTRAP_PID" 2>/dev/null || true
    sleep 2
    kill -KILL "$BOOTSTRAP_PID" 2>/dev/null || true
  fi
) >/dev/null 2>&1 &
BOOTSTRAP_WATCHDOG_PID=$!

cleanup_bootstrap_watchdog() {
  if [ -n "${BOOTSTRAP_WATCHDOG_PID:-}" ]; then
    kill "$BOOTSTRAP_WATCHDOG_PID" 2>/dev/null || true
    wait "$BOOTSTRAP_WATCHDOG_PID" 2>/dev/null || true
  fi
}
trap cleanup_bootstrap_watchdog EXIT INT TERM

if [ -n "${NODE_OPTIONS:-}" ]; then
  CLEAN_NODE_OPTIONS="$(printf '%s' "$NODE_OPTIONS" | sed -E 's/(^|[[:space:]])(--require|-r)(=|[[:space:]]+)global-agent\/bootstrap([[:space:]]|$)/ /g; s/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  if [ -n "$CLEAN_NODE_OPTIONS" ]; then
    export NODE_OPTIONS="$CLEAN_NODE_OPTIONS"
  else
    unset NODE_OPTIONS
  fi
fi

echo "[env:setup] Bootstrapping RocketCompanion E2E & WebGL environment in $ROOT_DIR..."

# 0. Initialize tmpfs layout (/tmp/rc-cache), symlinks, and OverlayFS baseline
node scripts/env/tmpfsGuard.mjs --ensure

# 1. Ensure pnpm is available (installed into tmpfs via npm + self-healing wrapper)
if ! command -v pnpm >/dev/null 2>&1 || [ ! -x "${CACHE_ROOT}/pnpm-global/bin/pnpm" ] || [ "$PNPM_ONLY" = "1" ]; then
  node scripts/env/tmpfsGuard.mjs --install-pnpm
  export PATH="/usr/local/bin:${HOME}/.local/bin:${CACHE_ROOT}/pnpm-global/bin:${PATH}"
fi

if [ "$PNPM_ONLY" = "1" ]; then
  echo "[env:setup] pnpm installed to tmpfs: $(pnpm --version)"
  exit 0
fi

# 2. Initialize public/ git submodule into tmpfs (RocketCompanionStatics)
if [ ! -L "public" ] || { [ ! -f "public/camera.wasm" ] && [ ! -d "public/wasm" ]; }; then
  echo "[env:setup] Syncing public/ git submodule into tmpfs..."
  node scripts/env/tmpfsGuard.mjs --sync-public
fi

# 3. Install JS dependencies if missing (node_modules is symlinked to tmpfs)
if [ ! -f "node_modules/.modules.yaml" ] || [ ! -d "node_modules/.bin" ]; then
  echo "[env:setup] Installing npm dependencies with pnpm into tmpfs..."
  PNPM_REPORTER_ARGS=()
  if [ ! -t 1 ]; then
    PNPM_REPORTER_ARGS+=(--reporter=append-only)
  fi
  pnpm install --no-frozen-lockfile --ignore-scripts --store-dir="$npm_config_store_dir" "${PNPM_REPORTER_ARGS[@]}"
  node scripts/env/tmpfsGuard.mjs --ensure
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

# 5. Ensure 3v3 .rcreplay fixture exists on tmpfs for E2E replay tests (prefer real 6-Ducky WASM simulation)
REPLAY_FIXTURE="/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay"
if [ ! -f "$REPLAY_FIXTURE" ]; then
  if [ -f "public/arenamesh/manifest.json" ]; then
    echo "[env:setup] Simulating 6-Ducky 3v3 WASM match to generate $REPLAY_FIXTURE..."
    node --experimental-strip-types scripts/env/generateReplayFixture.ts "$REPLAY_FIXTURE"
  else
    echo "[env:setup] Generating synthetic 3v3 .rcreplay fixture at $REPLAY_FIXTURE..."
    node scripts/env/generateSyntheticReplayFixture.mjs "$REPLAY_FIXTURE"
  fi
fi

# 6. Optional Rust/Cargo + Tauri C toolchain bootstrap (CARGO_HOME/RUSTUP_HOME/CARGO_TARGET_DIR on tmpfs)
if [ "$WITH_RUST" = "1" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    if ! command -v cc >/dev/null 2>&1 || ! command -v pkg-config >/dev/null 2>&1 || ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
      echo "[env:setup] Installing C/Tauri Linux build dependencies via apt-get..."
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        gcc libc6-dev pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev || true
    fi
  fi
  export PATH="${CARGO_HOME}/bin:${HOME}/.cargo/bin:${PATH}"
  if ! command -v cargo >/dev/null 2>&1; then
    echo "[env:setup] Installing Rust toolchain (minimal) into ${CARGO_HOME} / ${RUSTUP_HOME}..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal --no-modify-path
    export PATH="${CARGO_HOME}/bin:${HOME}/.cargo/bin:${PATH}"
  fi
fi

# Refresh /tmp/.rc-env-sentinel after all assets are ready
node scripts/env/tmpfsGuard.mjs --ensure

echo "[env:setup] Running verification probe..."
node scripts/env/checkEnv.mjs
