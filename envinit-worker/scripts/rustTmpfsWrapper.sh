setup_tmpfs_rust_wrappers() {
  local persist_prefix="$1"
  local tmp_dir="$2"
  local cargo_home_tmp="${tmp_dir}/cargo-home"
  local rustup_home_tmp="${tmp_dir}/rustup"
  local wasm_target_dir="${tmp_dir}/rc-wasm-target"

  # Purge any accidental Rust caches in /root (OverlayFS)
  rm -rf /root/.cargo /root/.rustup 2>/dev/null || true
  mkdir -p "${persist_prefix}/bin" 2>/dev/null || true

  for bin_name in cargo rustc rustup; do
    rm -f "${persist_prefix}/bin/${bin_name}" 2>/dev/null || true
  done

  cat << EOF > "${persist_prefix}/bin/rustup"
#!/usr/bin/env bash
export CARGO_HOME="${cargo_home_tmp}"
export RUSTUP_HOME="${rustup_home_tmp}"
rm -rf /root/.cargo /root/.rustup 2>/dev/null || true

REAL_RUSTUP="\${CARGO_HOME}/bin/rustup"
REAL_CARGO="\${CARGO_HOME}/bin/cargo"
REAL_RUSTC="\${CARGO_HOME}/bin/rustc"

if [ ! -x "\$REAL_RUSTUP" ] || [ ! -x "\$REAL_CARGO" ] || [ ! -x "\$REAL_RUSTC" ]; then
  echo "[rust-wrapper] Lazy-bootstrapping Rust (stable + wasm32-unknown-unknown) into ${tmp_dir} (tmpfs)..." >&2
  mkdir -p "\$CARGO_HOME" "\$RUSTUP_HOME" "${wasm_target_dir}" 2>/dev/null || true
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | \
    CARGO_HOME="\$CARGO_HOME" RUSTUP_HOME="\$RUSTUP_HOME" sh -s -- \
    -y --default-toolchain stable --profile minimal --target wasm32-unknown-unknown --no-modify-path >&2
  rm -rf /root/.cargo /root/.rustup /root/.wget-hsts 2>/dev/null || true
fi

if [ -x "${persist_prefix}/bin/heal-tmpfs-links" ]; then
  "${persist_prefix}/bin/heal-tmpfs-links" 2>/dev/null || true
fi

export PATH="\${CARGO_HOME}/bin:${persist_prefix}/bin:/usr/local/bin:\${PATH}"
exec "\$REAL_RUSTUP" "\$@"
EOF
  chmod +x "${persist_prefix}/bin/rustup"

  cat << EOF > "${persist_prefix}/bin/rustc"
#!/usr/bin/env bash
export CARGO_HOME="${cargo_home_tmp}"
export RUSTUP_HOME="${rustup_home_tmp}"
rm -rf /root/.cargo /root/.rustup 2>/dev/null || true

REAL_RUSTC="\${CARGO_HOME}/bin/rustc"
if [ ! -x "\$REAL_RUSTC" ]; then
  "${persist_prefix}/bin/rustup" --version >/dev/null 2>&1 || true
fi

if [ -x "${persist_prefix}/bin/heal-tmpfs-links" ]; then
  "${persist_prefix}/bin/heal-tmpfs-links" 2>/dev/null || true
fi

export PATH="\${CARGO_HOME}/bin:${persist_prefix}/bin:/usr/local/bin:\${PATH}"
exec "\$REAL_RUSTC" "\$@"
EOF
  chmod +x "${persist_prefix}/bin/rustc"

  cat << EOF > "${persist_prefix}/bin/cargo"
#!/usr/bin/env bash
export CARGO_HOME="${cargo_home_tmp}"
export RUSTUP_HOME="${rustup_home_tmp}"
rm -rf /root/.cargo /root/.rustup 2>/dev/null || true

REAL_CARGO="\${CARGO_HOME}/bin/cargo"
if [ ! -x "\$REAL_CARGO" ]; then
  "${persist_prefix}/bin/rustup" --version >/dev/null 2>&1 || true
fi

if [ -x "${persist_prefix}/bin/heal-tmpfs-links" ]; then
  "${persist_prefix}/bin/heal-tmpfs-links" 2>/dev/null || true
fi

TOP_DIR="\$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null || pwd)"

IS_TAURI_CTX=0
case "\$PWD" in
  */src-tauri|*/src-tauri/*) IS_TAURI_CTX=1 ;;
esac
case "\$*" in
  *src-tauri*) IS_TAURI_CTX=1 ;;
esac
if [ "\$IS_TAURI_CTX" -eq 0 ]; then
  if [ ! -f "\${PWD}/Cargo.toml" ] && [ ! -f "\${PWD}/crates/Cargo.toml" ] && [ -f "\${PWD}/src-tauri/Cargo.toml" ]; then
    IS_TAURI_CTX=1
  elif [ ! -f "\${TOP_DIR}/Cargo.toml" ] && [ ! -f "\${TOP_DIR}/crates/Cargo.toml" ] && [ -f "\${TOP_DIR}/src-tauri/Cargo.toml" ]; then
    IS_TAURI_CTX=1
  fi
fi

if [ -z "\${CARGO_TARGET_DIR:-}" ]; then
  if [ "\$IS_TAURI_CTX" -eq 1 ]; then
    REPO_SLUG="\$(basename "\$TOP_DIR" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
    REPO_SLUG="\${REPO_SLUG#-}"
    REPO_SLUG="\${REPO_SLUG%-}"
    export CARGO_TARGET_DIR="${tmp_dir}/\${REPO_SLUG:-rocketcompanion}-tauri-target"
  else
    export CARGO_TARGET_DIR="${wasm_target_dir}"
  fi
fi
mkdir -p "\$CARGO_TARGET_DIR" 2>/dev/null || true

export PATH="\${CARGO_HOME}/bin:${persist_prefix}/bin:/usr/local/bin:\${PATH}"

SUBCMD="\${1:-}"
if [ "\$IS_TAURI_CTX" -eq 1 ]; then
  case "\$SUBCMD" in
    check|build|test|run|clippy|metadata|clean|doc|bench)
      if ! command -v cc >/dev/null 2>&1; then
        echo "[rust-wrapper] Note: Native host C linker (cc) & WebKitGTK dev headers are not pre-installed in this sandbox (installing 400MB+ packages onto / would exceed the 100MB OverlayFS limit). For WASM crates verification, run 'pnpm build:wasm:check' or 'cargo check --target wasm32-unknown-unknown' in crates/." >&2
      fi
      if [ ! -f "\${PWD}/Cargo.toml" ] && [ -f "\${PWD}/src-tauri/Cargo.toml" ] && [[ "\$*" != *"--manifest-path"* ]]; then
        exec "\$REAL_CARGO" "\$SUBCMD" --manifest-path "\${PWD}/src-tauri/Cargo.toml" "\${@:2}"
      fi
      ;;
  esac
else
  case "\$SUBCMD" in
    check|build|clippy)
      if [ -z "\${CARGO_BUILD_TARGET:-}" ] && [[ "\$*" != *"--target"* ]]; then
        case "\$PWD" in
          */crates|*/crates/*) export CARGO_BUILD_TARGET="wasm32-unknown-unknown" ;;
          *)
            if [ -f "crates/Cargo.toml" ]; then
              export CARGO_BUILD_TARGET="wasm32-unknown-unknown"
            fi
            ;;
        esac
      fi
      if [ ! -f "Cargo.toml" ] && [ -f "crates/Cargo.toml" ] && [[ "\$*" != *"--manifest-path"* ]]; then
        exec "\$REAL_CARGO" "\$SUBCMD" --manifest-path crates/Cargo.toml "\${@:2}"
      fi
      ;;
  esac
fi

exec "\$REAL_CARGO" "\$@"
EOF
  chmod +x "${persist_prefix}/bin/cargo"
}
