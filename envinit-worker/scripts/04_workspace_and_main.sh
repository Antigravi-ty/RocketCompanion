sync_submodules() {
  local project_dir="$1"
  local repo_url="$2"
  local tmp_dir="$3"
  local slug="$4"
  local tmpfs_submodules="$5"
  local git_user_name="$6"
  local git_user_email="$7"

  cd "$project_dir"
  cleanup_stale_submodules "$project_dir"

  if [ -f ".gitmodules" ]; then
    local sub_keys
    sub_keys="$(git config --file .gitmodules --name-only --get-regexp '^submodule\..*\.path$' || true)"
    for key in $sub_keys; do
      local sub_name="${key#submodule.}"
      sub_name="${sub_name%.path}"
      local sub_path
      sub_path="$(git config --file .gitmodules --get "$key")"
      local sub_url
      sub_url="$(git config --file .gitmodules --get "submodule.${sub_name}.url" || true)"

      if [[ "$sub_url" == ../* ]]; then
        local repo_parent
        repo_parent="$(dirname "$repo_url")"
        sub_url="${repo_parent}/${sub_url#../}"
      fi

      local pinned_sha
      pinned_sha="$(git rev-parse -q --verify "HEAD:${sub_path}" 2>/dev/null || true)"

      local is_tmpfs_sub=0
      IFS=',' read -ra patterns <<< "$tmpfs_submodules"
      for pat in "${patterns[@]}"; do
        if [[ "$sub_path" == $pat || "$sub_name" == $pat || "$sub_url" == $pat ]]; then
          is_tmpfs_sub=1
          break
        fi
      done

      if [ "$is_tmpfs_sub" -eq 1 ]; then
        local statics_base
        statics_base="$(basename "${sub_url%.git}")"
        [ -z "$statics_base" ] && statics_base="${slug}-${sub_name}"
        local tmp_sub_dir="${tmp_dir}/${statics_base}"
        if [ ! -d "${tmp_sub_dir}/.git" ] || ! git -C "$tmp_sub_dir" rev-parse HEAD >/dev/null 2>&1; then
          rm -rf "$tmp_sub_dir"
          git clone "$sub_url" "$tmp_sub_dir"
        fi
        if [ -n "$pinned_sha" ]; then
          if ! git -C "$tmp_sub_dir" cat-file -e "${pinned_sha}^{commit}" 2>/dev/null; then
            git -C "$tmp_sub_dir" fetch --no-tags origin "$pinned_sha" >/dev/null 2>&1 || git -C "$tmp_sub_dir" fetch --all --tags --prune >/dev/null 2>&1 || true
          fi
          if [ "$(git -C "$tmp_sub_dir" rev-parse HEAD 2>/dev/null || true)" != "$pinned_sha" ]; then
            git -C "$tmp_sub_dir" checkout --detach "$pinned_sha" >/dev/null 2>&1 || true
          fi
        fi
        if [ ! -L "$sub_path" ] || [ ! -e "$sub_path" ] || [ "$(readlink "$sub_path")" != "$tmp_sub_dir" ]; then
          rm -rf "$sub_path"
          ln -sfn "$tmp_sub_dir" "$sub_path"
        fi
        git config "submodule.${sub_name}.update" none 2>/dev/null || true
        git config "submodule.${sub_name}.active" false 2>/dev/null || true
        git update-index --assume-unchanged "$sub_path" 2>/dev/null || true
      else
        git submodule init -- "$sub_path" >/dev/null 2>&1 || true
        [ -n "$sub_url" ] && git config "submodule.${sub_name}.url" "$sub_url" 2>/dev/null || true
        git config "submodule.${sub_name}.active" true 2>/dev/null || true
        git config --unset "submodule.${sub_name}.update" 2>/dev/null || true

        if [ ! -e "${sub_path}/.git" ] || ! git -C "$sub_path" rev-parse HEAD >/dev/null 2>&1; then
          git submodule update --init --recursive -- "$sub_path" >/dev/null 2>&1 || true
        fi
        if [ ! -e "${sub_path}/.git" ] || ! git -C "$sub_path" rev-parse HEAD >/dev/null 2>&1; then
          rm -rf "$sub_path"
          git clone "$sub_url" "$sub_path"
        fi

        if [ -n "$pinned_sha" ]; then
          if ! git -C "$sub_path" cat-file -e "${pinned_sha}^{commit}" 2>/dev/null; then
            git -C "$sub_path" fetch --no-tags origin "$pinned_sha" >/dev/null 2>&1 || git -C "$sub_path" fetch --all --tags --prune >/dev/null 2>&1 || true
          fi
          local cur_sub_sha
          cur_sub_sha="$(git -C "$sub_path" rev-parse HEAD 2>/dev/null || true)"
          if [ "$cur_sub_sha" != "$pinned_sha" ]; then
            if git -C "$sub_path" diff --quiet 2>/dev/null && git -C "$sub_path" diff --cached --quiet 2>/dev/null; then
              git -C "$sub_path" checkout --detach "$pinned_sha" >/dev/null 2>&1 || git submodule update --init --recursive --force -- "$sub_path" >/dev/null 2>&1 || true
            else
              echo "[init-sandbox] Warning: submodule ${sub_path} has uncommitted local changes; keeping working tree (${cur_sub_sha:0:8} vs parent ${pinned_sha:0:8})." >&2
            fi
          fi
        fi

        git -C "$sub_path" config user.name "$git_user_name" 2>/dev/null || true
        git -C "$sub_path" config user.email "$git_user_email" 2>/dev/null || true
      fi
    done
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

  git config --global user.name "$GIT_USER_NAME" 2>/dev/null || true
  git config --global user.email "$GIT_USER_EMAIL" 2>/dev/null || true
  git config --global advice.detachedHead false 2>/dev/null || true

  if [[ "$REPO_URL" != *"://"* && "$REPO_URL" != git@* ]]; then
    REPO_URL="https://github.com/${REPO_URL#.git}"
  fi

  if [ -z "$REPO_NAME" ]; then
    REPO_NAME="$(basename "${REPO_URL%.git}")"
  fi

  local SLUG
  SLUG="$(echo "$REPO_NAME" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  SLUG="${SLUG#-}"
  SLUG="${SLUG%-}"

  if [ "$ROOT_PREFIX" = "/" ]; then
    [ -z "$WORK_DIR" ] && WORK_DIR="/work"
    [ -z "$TMP_DIR" ] && TMP_DIR="/tmp"
  else
    [ -z "$WORK_DIR" ] && WORK_DIR="${ROOT_PREFIX}/work"
    [ -z "$TMP_DIR" ] && TMP_DIR="${ROOT_PREFIX}/tmp"
  fi

  local PROJECT_DIR="${WORK_DIR}/${REPO_NAME}"
  local PNPM_STORE="${TMP_DIR}/pnpm-store"
  local PNPM_CACHE="${TMP_DIR}/pnpm-cache"
  local NPM_CACHE="${TMP_DIR}/npm-cache"
  local NM_TARGET="${TMP_DIR}/${SLUG}-node_modules"
  local DIST_TARGET="${TMP_DIR}/${SLUG}-dist"
  local VITE_TARGET="${TMP_DIR}/${SLUG}-vite"
  local TAURI_TARGET="${TMP_DIR}/${SLUG}-tauri-target"
  local CARGO_HOME_TMP="${TMP_DIR}/cargo-home"

  mkdir -p "$WORK_DIR" "$TMP_DIR" "$PNPM_STORE" "$PNPM_CACHE" "$NPM_CACHE" "$NM_TARGET" "$DIST_TARGET" "$VITE_TARGET"
  ensure_fix_sh_persisted "$WORK_DIR"

  local PNPM_PERSIST_PREFIX="/usr/local"
  if [ "$ROOT_PREFIX" != "/" ]; then
    PNPM_PERSIST_PREFIX="${ROOT_PREFIX}/usr/local"
  fi
  export PATH="${PNPM_PERSIST_PREFIX}/bin:/usr/local/bin:${PATH}"

  setup_tmpfs_pnpm_and_wrapper "$PNPM_PERSIST_PREFIX" "$TMP_DIR" "$WORK_DIR" "$PNPM_STORE" "$PNPM_CACHE" "$NPM_CACHE"

  if [ ! -d "${PROJECT_DIR}/.git" ] || ! git -C "$PROJECT_DIR" rev-parse HEAD >/dev/null 2>&1; then
    rm -rf "$PROJECT_DIR"
    git clone "$REPO_URL" "$PROJECT_DIR"
  fi

  git -C "$PROJECT_DIR" config user.name "$GIT_USER_NAME" 2>/dev/null || true
  git -C "$PROJECT_DIR" config user.email "$GIT_USER_EMAIL" 2>/dev/null || true
  git -C "$PROJECT_DIR" config advice.detachedHead false 2>/dev/null || true
  git -C "$PROJECT_DIR" config gc.auto 0 2>/dev/null || true

  # Install hooks before checkout so post-checkout runs with the updated logic
  install_git_submodule_hooks "$PROJECT_DIR" "$TMP_DIR"

  checkout_target_ref "$PROJECT_DIR" "$TARGET_REF" "$NEW_BRANCH"

  sync_submodules "$PROJECT_DIR" "$REPO_URL" "$TMP_DIR" "$SLUG" "$TMPFS_SUBMODULES" "$GIT_USER_NAME" "$GIT_USER_EMAIL"
  install_git_submodule_hooks "$PROJECT_DIR" "$TMP_DIR"

  cd "$PROJECT_DIR"

  mkdir -p "$NM_TARGET" "$PNPM_STORE" "$DIST_TARGET" "$VITE_TARGET"
  if [ ! -L "node_modules" ] || [ ! -e "node_modules" ] || [ "$(readlink "node_modules")" != "$NM_TARGET" ]; then
    rm -rf "node_modules"
    ln -sfn "$NM_TARGET" "node_modules"
  fi
  if [ ! -L "dist" ] || [ ! -e "dist" ] || [ "$(readlink "dist")" != "$DIST_TARGET" ]; then
    rm -rf "dist"
    ln -sfn "$DIST_TARGET" "dist"
  fi
  if [ ! -L ".vite" ] || [ ! -e ".vite" ] || [ "$(readlink ".vite")" != "$VITE_TARGET" ]; then
    rm -rf ".vite"
    ln -sfn "$VITE_TARGET" ".vite"
  fi

  if [ -d "src-tauri" ]; then
    mkdir -p "$TAURI_TARGET" "$CARGO_HOME_TMP"
    if [ ! -L "src-tauri/target" ] || [ ! -e "src-tauri/target" ] || [ "$(readlink "src-tauri/target")" != "$TAURI_TARGET" ]; then
      rm -rf "src-tauri/target"
      ln -sfn "$TAURI_TARGET" "src-tauri/target"
    fi
    export CARGO_TARGET_DIR="$TAURI_TARGET"
    export CARGO_HOME="$CARGO_HOME_TMP"
  fi

  mkdir -p .git/info
  for exc in "node_modules" "dist" ".vite" "src-tauri/target"; do
    grep -qxF "$exc" .git/info/exclude 2>/dev/null || echo "$exc" >> .git/info/exclude
  done

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
