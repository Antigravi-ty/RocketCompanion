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
        mkdir -p "$tmp_sub_dir" 2>/dev/null || true
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
