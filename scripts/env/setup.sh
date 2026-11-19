#!/usr/bin/env bash
# scripts/env/setup.sh
# One-click idempotent environment setup & repair for RocketCompanion.
# Ensures:
#   1. pnpm is installed
#   2. public/ git submodule is initialized (required for CameraMicrokernel integrity & Vite assets)
#   3. node_modules dependencies are installed
#   4. 3v3 .rcreplay E2E fixture is present (generated if missing)
#   5. Chrome / SwiftShader WebGL is verified (optionally installs Chromium/Chrome with --with-chrome)
#   6. Optional Rust toolchain (cargo/rustc) when --with-rust is passed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${ROOT_DIR}"

WITH_RUST=0
WITH_CHROME=0

for arg in "$@"; do
  case "$arg" in
    --with-rust) WITH_RUST=1 ;;
    --with-chrome) WITH_CHROME=1 ;;
    -h|--help)
      echo "Usage: bash scripts/env/setup.sh [--with-rust] [--with-chrome]"
      exit 0
      ;;
    *)
      echo "[env:setup] Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

echo "[env:setup] Root directory: ${ROOT_DIR}"

# 1. Ensure pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[env:setup] pnpm not found; installing pnpm@10.28.2 globally via npm..."
  npm install -g pnpm@10.28.2
else
  echo "[env:setup] pnpm already installed: $(pnpm -v)"
fi

# 2. Ensure public/ submodule is initialized
if [ ! -d "${ROOT_DIR}/public" ] || [ -z "$(ls -A "${ROOT_DIR}/public" 2>/dev/null || true)" ]; then
  echo "[env:setup] Initializing git submodule 'public'..."
  GIT_TERMINAL_PROMPT=0 git submodule update --init --recursive
else
  echo "[env:setup] public/ submodule already initialized."
fi

# 3. Ensure node_modules
if [ ! -d "${ROOT_DIR}/node_modules" ]; then
  echo "[env:setup] Installing dependencies via pnpm..."
  pnpm install --no-frozen-lockfile --ignore-scripts
else
  echo "[env:setup] node_modules already present."
fi

# 4. Ensure 3v3 .rcreplay E2E fixture
DEFAULT_REPLAY="/tmp/rc-replay-3v3-1-0-2026-11-13T07-26-58.rcreplay"
if [ ! -f "${DEFAULT_REPLAY}" ]; then
  echo "[env:setup] Generating synthetic 3v3 .rcreplay E2E fixture..."
  node --experimental-strip-types "${SCRIPT_DIR}/generateReplayFixture.ts" "${DEFAULT_REPLAY}"
else
  echo "[env:setup] 3v3 .rcreplay fixture already exists at ${DEFAULT_REPLAY}"
fi

# 5. Optional Chrome install if missing and --with-chrome passed
if [ "${WITH_CHROME}" -eq 1 ] && ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  echo "[env:setup] Installing Google Chrome (non-interactive)..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y wget gnupg ca-certificates libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 || true
  wget -q -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg -i /tmp/google-chrome.deb || apt-get install -f -y
  rm -f /tmp/google-chrome.deb
fi

# 6. Optional Rust toolchain
if [ "${WITH_RUST}" -eq 1 ]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "[env:setup] Installing Rust toolchain via rustup (non-interactive)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
    if [ -f "${HOME}/.cargo/env" ]; then
      # shellcheck disable=SC1091
      source "${HOME}/.cargo/env"
    fi
  else
    echo "[env:setup] Rust already installed: $(rustc --version)"
  fi
fi

# 7. Run built-in doctor to verify WebGL + all checks
node "${SCRIPT_DIR}/doctor.mjs"
