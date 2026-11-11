setup_git_wrapper() {
  local persist_prefix="$1"
  mkdir -p "${persist_prefix}/bin" 2>/dev/null || true

  # Install a lightweight git wrapper at /usr/local/bin/git so:
  # 1. Switching between branches where `src/physics/core.wasm` is untracked+symlinked
  #    vs git-tracked never fails with "untracked working tree files would be overwritten".
  # 2. `git reset --hard` (which natively does not trigger post-checkout in Git)
  #    automatically invokes .git/hooks/post-checkout to restore tmpfs symlinks.
  if [ -x "/usr/bin/git" ]; then
    cat << 'EOF' > "${persist_prefix}/bin/git"
#!/usr/bin/env bash
case "$*" in
  *checkout*|*switch*|*reset*|*merge*|*pull*|*rebase*)
    TOP_DIR="$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$TOP_DIR" ] && [ -L "${TOP_DIR}/src/physics/core.wasm" ]; then
      if ! /usr/bin/git -C "$TOP_DIR" ls-files --error-unmatch "src/physics/core.wasm" >/dev/null 2>&1; then
        rm -f "${TOP_DIR}/src/physics/core.wasm" 2>/dev/null || true
      fi
    fi
    ;;
esac

/usr/bin/git "$@"
GIT_EXIT=$?
if [ $GIT_EXIT -eq 0 ]; then
  case "$*" in
    *reset*--hard*|*checkout*|*switch*|*merge*|*pull*|*rebase*)
      TOP_DIR="$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null || true)"
      if [ -n "$TOP_DIR" ] && [ -x "${TOP_DIR}/.git/hooks/post-checkout" ]; then
        "${TOP_DIR}/.git/hooks/post-checkout" HEAD HEAD 1 >/dev/null 2>&1 || true
      fi
      ;;
  esac
fi
exit $GIT_EXIT
EOF
    chmod +x "${persist_prefix}/bin/git"
  fi
}

cleanup_stale_submodules() {
  local repo_dir="$1"
  local active_paths=" "

  if [ -f "${repo_dir}/.gitmodules" ]; then
    local sub_keys
    sub_keys="$(git -C "$repo_dir" config --file .gitmodules --name-only --get-regexp '^submodule\..*\.path$' 2>/dev/null || true)"
    for key in $sub_keys; do
      local sp
      sp="$(git -C "$repo_dir" config --file .gitmodules --get "$key" 2>/dev/null || true)"
      [ -n "$sp" ] && active_paths="${active_paths}${sp} "
    done
  fi

  local cfg_keys
  cfg_keys="$(git -C "$repo_dir" config --local --name-only --get-regexp '^submodule\..*\.(url|active|update)$' 2>/dev/null || true)"
  for key in $cfg_keys; do
    local sname="${key#submodule.}"
    sname="${sname%.*}"
    if [[ "$active_paths" != *" ${sname} "* ]]; then
      git -C "$repo_dir" config --local --remove-section "submodule.${sname}" 2>/dev/null || true
      rm -rf "${repo_dir}/${sname}/.git" "${repo_dir}/.git/modules/${sname}" 2>/dev/null || true
      if [ -d "${repo_dir}/${sname}" ] && [ ! -L "${repo_dir}/${sname}" ]; then
        git -C "$repo_dir" clean -fd -- "${sname}" >/dev/null 2>&1 || true
        git -C "$repo_dir" checkout -f HEAD -- "${sname}" >/dev/null 2>&1 || true
      fi
    fi
  done

  if [ -d "${repo_dir}/.git/modules" ]; then
    local mod_git_dir
    while IFS= read -r mod_git_dir; do
      [ -z "$mod_git_dir" ] && continue
      local rel_mod="${mod_git_dir#${repo_dir}/.git/modules/}"
      if [[ "$active_paths" != *" ${rel_mod} "* ]]; then
        rm -rf "${repo_dir}/${rel_mod}/.git" "$mod_git_dir" 2>/dev/null || true
        if [ -d "${repo_dir}/${rel_mod}" ] && [ ! -L "${repo_dir}/${rel_mod}" ]; then
          git -C "$repo_dir" clean -fd -- "${rel_mod}" >/dev/null 2>&1 || true
          git -C "$repo_dir" checkout -f HEAD -- "${rel_mod}" >/dev/null 2>&1 || true
        fi
      fi
    done < <(find "${repo_dir}/.git/modules" -mindepth 1 -maxdepth 3 -name "HEAD" 2>/dev/null | sed 's|/HEAD$||')
  fi
}

resolve_branch_for_commit() {
  local repo_dir="$1"
  local target_oid="$2"

  local default_remote_branch=""
  default_remote_branch="$(git -C "$repo_dir" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  default_remote_branch="${default_remote_branch#origin/}"

  local matched_remote=""
  local first_remote=""
  local cand
  while IFS= read -r cand; do
    [ -z "$cand" ] && continue
    [ "$cand" = "HEAD" ] && continue
    [ -z "$first_remote" ] && first_remote="$cand"
    if [ -n "$default_remote_branch" ] && [ "$cand" = "$default_remote_branch" ]; then
      matched_remote="$cand"
      break
    fi
    if [ "$cand" = "alpha" ] || [ "$cand" = "main" ] || [ "$cand" = "master" ]; then
      matched_remote="$cand"
    fi
  done < <(git -C "$repo_dir" for-each-ref --format='%(refname:lstrip=3)' --points-at "$target_oid" refs/remotes/origin/ 2>/dev/null || true)

  [ -z "$matched_remote" ] && matched_remote="$first_remote"
  if [ -n "$matched_remote" ]; then
    echo "remote:${matched_remote}"
    return 0
  fi

  local matched_local=""
  matched_local="$(git -C "$repo_dir" for-each-ref --format='%(refname:lstrip=2)' --points-at "$target_oid" refs/heads/ 2>/dev/null | head -n 1 || true)"
  if [ -n "$matched_local" ]; then
    echo "local:${matched_local}"
    return 0
  fi

  echo "auto:z/ref-${target_oid:0:7}"
}

ensure_attached_head() {
  local repo_dir="$1"
  if git -C "$repo_dir" symbolic-ref -q HEAD >/dev/null 2>&1; then
    return 0
  fi
  local head_oid
  head_oid="$(git -C "$repo_dir" rev-parse -q --verify "HEAD^{commit}" 2>/dev/null || true)"
  [ -z "$head_oid" ] && return 0

  local resolved
  resolved="$(resolve_branch_for_commit "$repo_dir" "$head_oid")"
  local kind="${resolved%%:*}"
  local branch_name="${resolved#*:}"
  git -C "$repo_dir" checkout -B "$branch_name" HEAD >/dev/null 2>&1 || true
  if [ "$kind" = "remote" ]; then
    git -C "$repo_dir" branch --set-upstream-to="origin/${branch_name}" "$branch_name" >/dev/null 2>&1 || true
  fi
}

checkout_target_ref() {
  local repo_dir="$1"
  local target_ref="$2"
  local new_branch="$3"

  if [ -n "$target_ref" ]; then
    # Remove any non-symlink submodule working directories before switching branches so
    # git checkout -f never warns "unable to rmdir" or leaves stale submodule files behind
    find "$repo_dir" -mindepth 2 -maxdepth 3 -name ".git" | while IFS= read -r sub_git; do
      local rel_sub="${sub_git#${repo_dir}/}"
      rel_sub="${rel_sub%/.git}"
      if [ ! -L "${repo_dir}/${rel_sub}" ]; then
        rm -rf "${repo_dir:?}/${rel_sub}" 2>/dev/null || true
      fi
    done

    if [ -L "${repo_dir}/src/physics/core.wasm" ] && ! git -C "$repo_dir" ls-files --error-unmatch "src/physics/core.wasm" >/dev/null 2>&1; then
      rm -f "${repo_dir}/src/physics/core.wasm" 2>/dev/null || true
    fi

    # Fetch remote ref or branch tips without pulling heavy tags unless needed
    if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/${target_ref}"; then
      git -C "$repo_dir" fetch --no-tags origin "+refs/heads/${target_ref}:refs/remotes/origin/${target_ref}" >/dev/null 2>&1 || true
    elif git -C "$repo_dir" fetch --no-tags origin "+refs/heads/${target_ref}:refs/remotes/origin/${target_ref}" >/dev/null 2>&1; then
      :
    elif git -C "$repo_dir" fetch --no-tags origin "$target_ref" >/dev/null 2>&1; then
      :
    else
      git -C "$repo_dir" fetch --no-tags --prune origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null 2>&1 || true
      if ! git -C "$repo_dir" rev-parse -q --verify "${target_ref}^{commit}" >/dev/null 2>&1; then
        git -C "$repo_dir" fetch --tags --prune origin >/dev/null 2>&1 || true
      fi
    fi

    if [ -n "$new_branch" ]; then
      if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/${target_ref}"; then
        git -C "$repo_dir" checkout -f -B "$new_branch" "origin/${target_ref}"
      elif git -C "$repo_dir" rev-parse -q --verify "${target_ref}^{commit}" >/dev/null 2>&1; then
        git -C "$repo_dir" checkout -f -B "$new_branch" "${target_ref}^{commit}"
      else
        git -C "$repo_dir" checkout -f -B "$new_branch" FETCH_HEAD
      fi
    elif git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/${target_ref}"; then
      git -C "$repo_dir" checkout -f -B "$target_ref" "origin/${target_ref}"
      git -C "$repo_dir" branch --set-upstream-to="origin/${target_ref}" "$target_ref" >/dev/null 2>&1 || true
    else
      local target_oid=""
      target_oid="$(git -C "$repo_dir" rev-parse -q --verify "${target_ref}^{commit}" 2>/dev/null || git -C "$repo_dir" rev-parse -q --verify "FETCH_HEAD^{commit}" 2>/dev/null || true)"
      if [ -n "$target_oid" ]; then
        local resolved
        resolved="$(resolve_branch_for_commit "$repo_dir" "$target_oid")"
        local kind="${resolved%%:*}"
        local branch_name="${resolved#*:}"
        if [ "$kind" = "remote" ]; then
          git -C "$repo_dir" checkout -f -B "$branch_name" "origin/${branch_name}"
          git -C "$repo_dir" branch --set-upstream-to="origin/${branch_name}" "$branch_name" >/dev/null 2>&1 || true
        else
          git -C "$repo_dir" checkout -f -B "$branch_name" "$target_oid"
        fi
      else
        git -C "$repo_dir" checkout -f "$target_ref"
      fi
    fi
  elif [ -n "$new_branch" ]; then
    git -C "$repo_dir" checkout -B "$new_branch"
  else
    ensure_attached_head "$repo_dir"
  fi

  cleanup_stale_submodules "$repo_dir"
  git -C "$repo_dir" prune --expire=now >/dev/null 2>&1 || true
}

install_git_submodule_hooks() {
  local repo_dir="$1"
  local tmp_dir="${2:-/tmp}"
  local hooks_dir="${repo_dir}/.git/hooks"
  mkdir -p "$hooks_dir"

  local hook_body
  read -r -d '' hook_body << HOOK_EOF || true
#!/usr/bin/env bash
# Auto-generated by envinit:
# 1. Restores tmpfs static submodule symlinks (e.g. public -> /tmp/<StaticsRepo>)
#    and re-applies --assume-unchanged whenever \`git reset --hard\` or \`git checkout -f\`
#    replaces the symlink with an empty directory on OverlayFS.
# 2. Restores dual-Rust tmpfs symlinks (crates/target, src-tauri/target, and untracked
#    src/physics/core.wasm) when switching across Rust/WASM or Tauri branches.
# 3. Cleans up stale submodule .git directories and locks code submodules to HEAD.
set -u

TMP_DIR="${tmp_dir}"
REPO_ROOT="\$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "\$REPO_ROOT" || exit 0

active_paths=" "
if [ -f ".gitmodules" ]; then
  sub_keys="\$(git config --file .gitmodules --name-only --get-regexp '^submodule\..*\.path\$' 2>/dev/null || true)"
  for key in \$sub_keys; do
    sub_name="\${key#submodule.}"
    sub_name="\${sub_name%.path}"
    sub_path="\$(git config --file .gitmodules --get "\$key" 2>/dev/null || true)"
    [ -z "\$sub_path" ] && continue
    active_paths="\${active_paths}\${sub_path} "

    sub_url="\$(git config --file .gitmodules --get "submodule.\${sub_name}.url" 2>/dev/null || true)"
    sub_update="\$(git config --get "submodule.\${sub_name}.update" 2>/dev/null || git config --file .gitmodules --get "submodule.\${sub_name}.update" 2>/dev/null || true)"

    if [ "\$sub_update" = "none" ] || [ "\$sub_path" = "public" ] || [[ "\$sub_url" == *Statics* ]] || [[ "\$sub_url" == *statics* ]]; then
      statics_base="\$(basename "\${sub_url%.git}")"
      [ -z "\$statics_base" ] && statics_base="\$sub_name"
      tmp_target="\${TMP_DIR}/\${statics_base}"
      mkdir -p "\$tmp_target" 2>/dev/null || true
      if [ ! -L "\$sub_path" ] || [ "\$(readlink "\$sub_path" 2>/dev/null || true)" != "\$tmp_target" ]; then
        rm -rf "\$sub_path"
        ln -sfn "\$tmp_target" "\$sub_path"
      fi
      git config "submodule.\${sub_name}.update" none 2>/dev/null || true
      git config "submodule.\${sub_name}.active" false 2>/dev/null || true
      git update-index --assume-unchanged "\$sub_path" 2>/dev/null || true
      continue
    fi

    pinned_sha="\$(git rev-parse -q --verify "HEAD:\${sub_path}" 2>/dev/null || true)"
    [ -z "\$pinned_sha" ] && continue
    [ -e "\${sub_path}/.git" ] || continue

    cur_sha="\$(git -C "\$sub_path" rev-parse HEAD 2>/dev/null || true)"
    if [ "\$cur_sha" != "\$pinned_sha" ]; then
      if git -C "\$sub_path" diff --quiet 2>/dev/null && git -C "\$sub_path" diff --cached --quiet 2>/dev/null; then
        if ! git -C "\$sub_path" cat-file -e "\${pinned_sha}^{commit}" 2>/dev/null; then
          git -C "\$sub_path" fetch --no-tags origin "\$pinned_sha" >/dev/null 2>&1 || git -C "\$sub_path" fetch --all --tags --prune >/dev/null 2>&1 || true
        fi
        git -C "\$sub_path" checkout --detach "\$pinned_sha" >/dev/null 2>&1 || true
      fi
    fi
  done
fi

if [ -d ".git/modules" ]; then
  while IFS= read -r mod_git_dir; do
    [ -z "\$mod_git_dir" ] && continue
    rel_mod="\${mod_git_dir#.git/modules/}"
    if [[ "\$active_paths" != *" \${rel_mod} "* ]]; then
      git config --local --remove-section "submodule.\${rel_mod}" 2>/dev/null || true
      rm -rf "\${rel_mod}/.git" "\$mod_git_dir" 2>/dev/null || true
      if [ -d "\$rel_mod" ] && [ ! -L "\$rel_mod" ]; then
        git clean -fd -- "\$rel_mod" >/dev/null 2>&1 || true
        git checkout -f HEAD -- "\$rel_mod" >/dev/null 2>&1 || true
      fi
    fi
  done < <(find ".git/modules" -mindepth 1 -maxdepth 3 -name "HEAD" 2>/dev/null | sed 's|/HEAD\$||')
fi

if [ -d "crates" ]; then
  wasm_target_dir="\${TMP_DIR}/rc-wasm-target"
  mkdir -p "\$wasm_target_dir" 2>/dev/null || true
  if [ ! -L "crates/target" ] || [ "\$(readlink "crates/target" 2>/dev/null || true)" != "\$wasm_target_dir" ]; then
    rm -rf "crates/target"
    ln -sfn "\$wasm_target_dir" "crates/target"
  fi
  if [ -d "src/physics" ] && ! git ls-files --error-unmatch "src/physics/core.wasm" >/dev/null 2>&1; then
    wasm_out_tmp="\${wasm_target_dir}/core.wasm"
    if [ -f "src/physics/core.wasm" ] && [ ! -L "src/physics/core.wasm" ]; then
      mv -f "src/physics/core.wasm" "\$wasm_out_tmp" 2>/dev/null || rm -f "src/physics/core.wasm"
    fi
    if [ ! -L "src/physics/core.wasm" ] || [ "\$(readlink "src/physics/core.wasm" 2>/dev/null || true)" != "\$wasm_out_tmp" ]; then
      rm -rf "src/physics/core.wasm"
      ln -sfn "\$wasm_out_tmp" "src/physics/core.wasm"
    fi
  fi
fi

if [ -d "src-tauri" ]; then
  repo_slug="\$(basename "\$REPO_ROOT" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  repo_slug="\${repo_slug#-}"
  repo_slug="\${repo_slug%-}"
  tauri_target_dir="\${TMP_DIR}/\${repo_slug:-rocketcompanion}-tauri-target"
  mkdir -p "\$tauri_target_dir" 2>/dev/null || true
  if [ ! -L "src-tauri/target" ] || [ "\$(readlink "src-tauri/target" 2>/dev/null || true)" != "\$tauri_target_dir" ]; then
    rm -rf "src-tauri/target"
    ln -sfn "\$tauri_target_dir" "src-tauri/target"
  fi
fi
HOOK_EOF

  cat > "${hooks_dir}/post-checkout" << EOF
#!/usr/bin/env bash
# Only run on branch/ref checkouts (\$3 == 1), skip single-file checkouts (\$3 == 0)
if [ "\${3:-1}" = "0" ]; then
  exit 0
fi
${hook_body#*$'\n'}
EOF

  printf '%s\n' "$hook_body" > "${hooks_dir}/post-merge"
  printf '%s\n' "$hook_body" > "${hooks_dir}/post-rewrite"
  chmod +x "${hooks_dir}/post-checkout" "${hooks_dir}/post-merge" "${hooks_dir}/post-rewrite" 2>/dev/null || true
}
