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
