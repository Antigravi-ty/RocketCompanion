setup_workspace_tmpfs_links() {
  local project_dir="$1"
  local nm_target="$2"
  local pnpm_store="$3"
  local dist_target="$4"
  local vite_target="$5"
  local wasm_target_dir="$6"
  local tauri_target="$7"
  local cargo_home_tmp="$8"
  local rustup_home_tmp="$9"
  local persist_prefix="${10:-/usr/local}"

  cd "$project_dir"

  mkdir -p "$nm_target" "$pnpm_store" "$dist_target" "$vite_target"
  if [ ! -L "node_modules" ] || [ ! -e "node_modules" ] || [ "$(readlink "node_modules")" != "$nm_target" ]; then
    rm -rf "node_modules"
    ln -sfn "$nm_target" "node_modules"
  fi
  if [ ! -L "dist" ] || [ ! -e "dist" ] || [ "$(readlink "dist")" != "$dist_target" ]; then
    rm -rf "dist"
    ln -sfn "$dist_target" "dist"
  fi
  if [ ! -L ".vite" ] || [ ! -e ".vite" ] || [ "$(readlink ".vite")" != "$vite_target" ]; then
    rm -rf ".vite"
    ln -sfn "$vite_target" ".vite"
  fi

  # 1. If crates/ (WASM Rust workspace) exists, symlink crates/target -> /tmp/rc-wasm-target
  if [ -d "crates" ]; then
    mkdir -p "$wasm_target_dir" "$cargo_home_tmp" "$rustup_home_tmp"
    if [ ! -L "crates/target" ] || [ ! -e "crates/target" ] || [ "$(readlink "crates/target")" != "$wasm_target_dir" ]; then
      rm -rf "crates/target"
      ln -sfn "$wasm_target_dir" "crates/target"
    fi
    if [ -d "src/physics" ] && ! git ls-files --error-unmatch "src/physics/core.wasm" >/dev/null 2>&1; then
      local wasm_out_tmp="${wasm_target_dir}/core.wasm"
      if [ -f "src/physics/core.wasm" ] && [ ! -L "src/physics/core.wasm" ]; then
        mv -f "src/physics/core.wasm" "$wasm_out_tmp" 2>/dev/null || rm -f "src/physics/core.wasm"
      fi
      if [ ! -L "src/physics/core.wasm" ] || [ "$(readlink "src/physics/core.wasm")" != "$wasm_out_tmp" ]; then
        rm -rf "src/physics/core.wasm"
        ln -sfn "$wasm_out_tmp" "src/physics/core.wasm"
      fi
    fi
  fi

  # 2. If src-tauri/ (Tauri desktop workspace) exists, symlink src-tauri/target -> /tmp/<slug>-tauri-target
  if [ -d "src-tauri" ]; then
    mkdir -p "$tauri_target" "$cargo_home_tmp" "$rustup_home_tmp"
    if [ ! -L "src-tauri/target" ] || [ ! -e "src-tauri/target" ] || [ "$(readlink "src-tauri/target")" != "$tauri_target" ]; then
      rm -rf "src-tauri/target"
      ln -sfn "$tauri_target" "src-tauri/target"
    fi
  fi

  mkdir -p .git/info
  for exc in "node_modules" "dist" ".vite" "crates/target" "src-tauri/target" "src/physics/core.wasm"; do
    grep -qxF "$exc" .git/info/exclude 2>/dev/null || echo "$exc" >> .git/info/exclude
  done

  if [ -x "${persist_prefix}/bin/heal-tmpfs-links" ]; then
    "${persist_prefix}/bin/heal-tmpfs-links" 2>/dev/null || true
  fi
}

main() {
  export GIT_TERMINAL_PROMPT=0
  export PAGER=cat
  export CI=true
  export DEBIAN_FRONTEND=noninteractive

  parse_cli_args "$@"
  if [ "${SHOW_HELP:-0}" -eq 1 ]; then
    print_help
    return 0
  fi

  if [ "$ROOT_PREFIX" = "/" ]; then
    [ -z "$WORK_DIR" ] && WORK_DIR="/work"
    [ -z "$TMP_DIR" ] && TMP_DIR="/tmp"
  else
    [ -z "$WORK_DIR" ] && WORK_DIR="${ROOT_PREFIX}/work"
    [ -z "$TMP_DIR" ] && TMP_DIR="${ROOT_PREFIX}/tmp"
  fi

  resolve_repo_and_state "$WORK_DIR"

  local SLUG
  SLUG="$(echo "$REPO_NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  SLUG="${SLUG#-}"
  SLUG="${SLUG%-}"

  /usr/bin/git config --global user.name "$GIT_USER_NAME" 2>/dev/null || true
  /usr/bin/git config --global user.email "$GIT_USER_EMAIL" 2>/dev/null || true
  /usr/bin/git config --global advice.detachedHead false 2>/dev/null || true

  local PROJECT_DIR="${WORK_DIR}/${REPO_NAME}"
  local PNPM_STORE="${TMP_DIR}/pnpm-store"
  local PNPM_CACHE="${TMP_DIR}/pnpm-cache"
  local NPM_CACHE="${TMP_DIR}/npm-cache"
  local NM_TARGET="${TMP_DIR}/${SLUG}-node_modules"
  local DIST_TARGET="${TMP_DIR}/${SLUG}-dist"
  local VITE_TARGET="${TMP_DIR}/${SLUG}-vite"
  local WASM_TARGET_DIR="${TMP_DIR}/rc-wasm-target"
  local TAURI_TARGET="${TMP_DIR}/${SLUG}-tauri-target"
  local CARGO_HOME_TMP="${TMP_DIR}/cargo-home"
  local RUSTUP_HOME_TMP="${TMP_DIR}/rustup"

  mkdir -p "$WORK_DIR" "$TMP_DIR" "$PNPM_STORE" "$PNPM_CACHE" "$NPM_CACHE" "$NM_TARGET" "$DIST_TARGET" "$VITE_TARGET"
  ensure_fix_sh_persisted "$WORK_DIR"
  save_fix_state "$WORK_DIR" "$REPO_URL" "$REPO_NAME"

  local PNPM_PERSIST_PREFIX="/usr/local"
  if [ "$ROOT_PREFIX" != "/" ]; then
    PNPM_PERSIST_PREFIX="${ROOT_PREFIX}/usr/local"
  fi
  export PATH="${PNPM_PERSIST_PREFIX}/bin:/usr/local/bin:${PATH}"

  setup_tmpfs_git_auth "$TMP_DIR" "${AUTH_INPUT:-}" "${AUTH_WORKER_URL:-}"
  setup_tmpfs_link_healer "$PNPM_PERSIST_PREFIX" "$TMP_DIR" "$WORK_DIR"
  setup_tmpfs_pnpm_and_wrapper "$PNPM_PERSIST_PREFIX" "$TMP_DIR" "$WORK_DIR" "$PNPM_STORE" "$PNPM_CACHE" "$NPM_CACHE" "$ROOT_PREFIX"
  setup_tmpfs_rust_wrappers "$PNPM_PERSIST_PREFIX" "$TMP_DIR"
  setup_git_wrapper "$PNPM_PERSIST_PREFIX" "$TMP_DIR"

  if [ "${WITH_RUST:-0}" -eq 1 ]; then
    "${PNPM_PERSIST_PREFIX}/bin/rustup" --version >/dev/null
  fi

  if [ ! -d "${PROJECT_DIR}/.git" ] || ! git -C "$PROJECT_DIR" rev-parse HEAD >/dev/null 2>&1; then
    rm -rf "$PROJECT_DIR"
    git clone "$REPO_URL" "$PROJECT_DIR"
  fi

  git -C "$PROJECT_DIR" config user.name "$GIT_USER_NAME" 2>/dev/null || true
  git -C "$PROJECT_DIR" config user.email "$GIT_USER_EMAIL" 2>/dev/null || true
  git -C "$PROJECT_DIR" config advice.detachedHead false 2>/dev/null || true
  git -C "$PROJECT_DIR" config gc.auto 0 2>/dev/null || true

  install_git_submodule_hooks "$PROJECT_DIR" "$TMP_DIR"
  checkout_target_ref "$PROJECT_DIR" "$TARGET_REF" "$NEW_BRANCH"
  sync_submodules "$PROJECT_DIR" "$REPO_URL" "$TMP_DIR" "$SLUG" "$TMPFS_SUBMODULES" "$GIT_USER_NAME" "$GIT_USER_EMAIL"
  install_git_submodule_hooks "$PROJECT_DIR" "$TMP_DIR"

  setup_workspace_tmpfs_links \
    "$PROJECT_DIR" \
    "$NM_TARGET" \
    "$PNPM_STORE" \
    "$DIST_TARGET" \
    "$VITE_TARGET" \
    "$WASM_TARGET_DIR" \
    "$TAURI_TARGET" \
    "$CARGO_HOME_TMP" \
    "$RUSTUP_HOME_TMP" \
    "$PNPM_PERSIST_PREFIX"

  if [ -f "package.json" ]; then
    if [ ! -f "node_modules/.modules.yaml" ] || [ ! -d "node_modules/.bin" ]; then
      pnpm install --store-dir="$PNPM_STORE" --config.confirm-modules-purge=false
    fi
  fi

  if [ "$RUN_CHECK" -eq 1 ] && [ -f "package.json" ]; then
    if [ -n "$CHECK_CMD" ]; then
      eval "$CHECK_CMD"
    elif grep -q '"radar"' package.json 2>/dev/null; then
      echo "[init-sandbox] Ready. Running quick radar check (${RADAR_ARGS:---no-tsc})..."
      # shellcheck disable=SC2086
      pnpm radar ${RADAR_ARGS:---no-tsc}
    fi
  fi

  echo "[init-sandbox] Complete: source in ${PROJECT_DIR} (OverlayFS), artifacts linked to ${TMP_DIR} (tmpfs)."
}

main "$@"
