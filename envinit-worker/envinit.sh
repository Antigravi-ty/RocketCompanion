#!/usr/bin/env bash
set -euo pipefail

print_help() {
  cat << 'HELP_EOF'
================================================================================
 Universal OverlayFS + tmpfs Sandbox Initializer (Vite / Tauri / pnpm / npm)
================================================================================

PURPOSE & ARCHITECTURE (FOR AI AGENTS & DEVELOPERS)
  1. Persistent Source on OverlayFS (/work/<RepoName>):
     Keeps only git-tracked source code and small code submodules (e.g.
     src/ui-core) on OverlayFS (/work) so code edits survive container
     snapshot restores without exhausting the 100 MB OverlayFS quota.
  2. Ephemeral Artifacts & Dependencies on tmpfs (/tmp):
     Mounts ALL heavy binaries, dependencies, and build outputs onto /tmp (RAM):
       - pnpm binary (63MB) -> /tmp/pnpm-global (with 2KB self-healing wrapper
                               at /usr/local/bin/pnpm & /usr/local/bin/pnpx)
       - node_modules       -> /tmp/<slug>-node_modules
       - pnpm store/cache   -> /tmp/pnpm-store & /tmp/pnpm-cache
       - Vite build outDir  -> /tmp/<slug>-dist
       - Vite cache         -> /tmp/<slug>-vite
       - Tauri Rust target  -> /tmp/<slug>-tauri-target (if src-tauri/ exists)
       - Cargo cache        -> /tmp/cargo-home          (if src-tauri/ exists)
       - Static submodules  -> /tmp/<StaticsRepo>       (matching public,*Statics*)
  3. Zero-OverlayFS Self-Healing pnpm Wrapper (/usr/local/bin/pnpm):
     - Writes a small (~2 KB) real Bash wrapper script at `/usr/local/bin/pnpm`
       (never a symlink!) while installing the 63 MB `@pnpm/linux-x64` binary into
       `/tmp/pnpm-global` (tmpfs) and purging `/usr/local/lib/node_modules/pnpm`.
     - If `/tmp` is wiped across container snapshot restores, running any `pnpm`
       command automatically reinstalls `pnpm` into `/tmp/pnpm-global`, restores
       missing `/tmp` symlink targets (`public`, `dist`, `.vite`, `node_modules`),
       and runs `/work/fix.sh --no-check` if needed.
  4. Zero-Copy Hardlinks & Dangling Symlink Prevention:
     - Always runs `mkdir -p` on /tmp targets BEFORE `ln -sfn` so pnpm v12
       (Rust) never encounters a dangling symlink (which otherwise triggers
       ERR_PNPM_PACKAGE_MANAGER_CREATE_SLOT_DIR / os error 17 EEXIST).
     - Because both /tmp/<slug>-node_modules and /tmp/pnpm-store live on the
       same /tmp mount point, pnpm uses zero-copy hardlinks instead of falling
       back to cross-device (EXDEV) physical file copies.
  5. Git Identity, Hook Self-Healing & Stale Submodule Cleanup:
     - Configures default Git identity (`user.name` & `user.email`) globally and
       per-repo so local `git merge`, `git rebase`, and `git cherry-pick` never
       fail with `unable to auto-detect email address` under `GIT_TERMINAL_PROMPT=0`.
     - Supports branches, tags, full commit SHAs, or abbreviated commit hashes
       via `-b` / `--branch` / `--ref`, plus `--new-branch <z/name>`. When `--ref`
       is a commit SHA and `--new-branch` is omitted, automatically attaches HEAD
       to the matching remote branch on `origin` (or `z/ref-<short_sha>`) so the
       working tree is never left in `detached HEAD` state.
     - Cleans up residual submodule `.git` metadata (e.g. `src/ui-core/.git` and
       `.git/modules/src/ui-core`) when switching from legacy submodule branches
       to branches where the directory is tracked as regular files (`alpha`).
     - Installs `post-checkout`, `post-merge`, and `post-rewrite` Git hooks that:
       (a) automatically recreate the `/tmp/<StaticsRepo>` symlink and reapply
           `--assume-unchanged` whenever `git reset --hard` or `git checkout -f`
           replaces a `tmpfs` static submodule (`public`) with an empty directory;
       (b) keep code submodules strictly locked to `HEAD:<sub_path>`.
     - Prunes unreachable loose git objects (`git prune`) to prevent `.git/objects`
       bloat on OverlayFS.

USAGE
  /work/fix.sh [OPTIONS]
  curl -fsSL https://envinit.maboco-mark.workers.dev/ | bash -s -- [OPTIONS]

OPTIONS
  -h, --help, help              Show this help guide and exit.
  --repo <url|Owner/Repo>       Repository URL or GitHub shorthand
                                (default: https://github.com/Antigravi-ty/RocketCompanion).
  -b, --branch, --ref <ref>     Branch, tag, or commit SHA (full or short) to checkout.
  --new-branch <branch-name>    Create/reset local branch (e.g. z/my-fix) at target ref.
  --name <dir-name>             Override target directory name under WORK_DIR.
  --root <path>                 Virtual root prefix for isolated sandbox testing
                                (default: /; sets WORK_DIR=<root>/work, TMP_DIR=<root>/tmp).
  --work-dir <path>             Explicit persistent source directory (default: /work).
  --tmp-dir <path>              Explicit tmpfs artifact directory (default: /tmp).
  --tmpfs-submodules <globs>    Comma-separated submodule path/name/url globs to
                                offload to tmpfs (default: "public,*Statics*,*statics*").
  --git-name <name>             Git user.name for local merges/commits (default: "Mark").
  --git-email <email>           Git user.email for local merges/commits
                                (default: "29165094+MaBoCoMark@users.noreply.github.com").
  --no-check                    Skip post-install verification check.
  --radar-args <args>           Arguments passed to default `pnpm radar` check
                                (default: "--no-tsc").
  --check-cmd <command>         Custom verification command to run after install
                                (default: `pnpm radar <radar-args>` if defined in package.json).

EXAMPLES (MULTI-REPO, COMMIT CHECKOUT & SNAPSHOT RECOVERY)
  # 1. Default initialization (RocketCompanion in /work/RocketCompanion):
  /work/fix.sh

  # 2. Checkout a specific commit hash (or branch) and create a working branch:
  /work/fix.sh --ref 77755f1e --new-branch z/my-feature --no-check

  # 3. Initialize via Worker URL query parameters:
  curl -fsSL "https://envinit.maboco-mark.workers.dev/?ref=77755f1e&no_check=1" | bash

  # 4. Recover after container snapshot restore (when /tmp was wiped):
  /work/fix.sh --no-check
================================================================================
HELP_EOF
}

parse_cli_args() {
  ROOT_PREFIX="/"
  WORK_DIR=""
  TMP_DIR=""
  REPO_URL="https://github.com/Antigravi-ty/RocketCompanion"
  REPO_NAME=""
  TARGET_REF=""
  NEW_BRANCH=""
  TMPFS_SUBMODULES="public,*Statics*,*statics*"
  GIT_USER_NAME="${GIT_AUTHOR_NAME:-Mark}"
  GIT_USER_EMAIL="${GIT_AUTHOR_EMAIL:-29165094+MaBoCoMark@users.noreply.github.com}"
  RUN_CHECK=1
  RADAR_ARGS="--no-tsc"
  CHECK_CMD=""
  SHOW_HELP=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help|help)
        SHOW_HELP=1
        return 0
        ;;
      --root)
        ROOT_PREFIX="${2%/}"
        [ -z "$ROOT_PREFIX" ] && ROOT_PREFIX="/"
        shift 2
        ;;
      --root=*)
        ROOT_PREFIX="${1#*=}"
        ROOT_PREFIX="${ROOT_PREFIX%/}"
        [ -z "$ROOT_PREFIX" ] && ROOT_PREFIX="/"
        shift 1
        ;;
      --work-dir)
        WORK_DIR="$2"
        shift 2
        ;;
      --work-dir=*)
        WORK_DIR="${1#*=}"
        shift 1
        ;;
      --tmp-dir)
        TMP_DIR="$2"
        shift 2
        ;;
      --tmp-dir=*)
        TMP_DIR="${1#*=}"
        shift 1
        ;;
      --repo)
        REPO_URL="$2"
        shift 2
        ;;
      --repo=*)
        REPO_URL="${1#*=}"
        shift 1
        ;;
      --name)
        REPO_NAME="$2"
        shift 2
        ;;
      --name=*)
        REPO_NAME="${1#*=}"
        shift 1
        ;;
      --branch|--ref|-b)
        TARGET_REF="$2"
        shift 2
        ;;
      --branch=*|--ref=*)
        TARGET_REF="${1#*=}"
        shift 1
        ;;
      --new-branch)
        NEW_BRANCH="$2"
        shift 2
        ;;
      --new-branch=*)
        NEW_BRANCH="${1#*=}"
        shift 1
        ;;
      --tmpfs-submodules)
        TMPFS_SUBMODULES="$2"
        shift 2
        ;;
      --tmpfs-submodules=*)
        TMPFS_SUBMODULES="${1#*=}"
        shift 1
        ;;
      --git-name)
        GIT_USER_NAME="$2"
        shift 2
        ;;
      --git-name=*)
        GIT_USER_NAME="${1#*=}"
        shift 1
        ;;
      --git-email)
        GIT_USER_EMAIL="$2"
        shift 2
        ;;
      --git-email=*)
        GIT_USER_EMAIL="${1#*=}"
        shift 1
        ;;
      --no-check)
        RUN_CHECK=0
        shift 1
        ;;
      --radar-args)
        RADAR_ARGS="$2"
        shift 2
        ;;
      --radar-args=*)
        RADAR_ARGS="${1#*=}"
        shift 1
        ;;
      --check-cmd)
        CHECK_CMD="$2"
        shift 2
        ;;
      --check-cmd=*)
        CHECK_CMD="${1#*=}"
        shift 1
        ;;
      *)
        shift 1
        ;;
    esac
  done
}

ensure_fix_sh_persisted() {
  local work_dir="$1"
  local fix_path="${work_dir}/fix.sh"
  mkdir -p "$work_dir"

  local self_path="${BASH_SOURCE[0]:-}"
  if [ -n "$self_path" ] && [ -f "$self_path" ]; then
    local abs_self abs_fix
    abs_self="$(readlink -f "$self_path" 2>/dev/null || echo "$self_path")"
    abs_fix="$(readlink -f "$fix_path" 2>/dev/null || echo "$fix_path")"
    if [ "$abs_self" != "$abs_fix" ]; then
      cp -f "$self_path" "$fix_path" 2>/dev/null || true
      chmod +x "$fix_path" 2>/dev/null || true
    else
      chmod +x "$fix_path" 2>/dev/null || true
    fi
  elif [ ! -f "$fix_path" ]; then
    curl -fsSL "https://envinit.maboco-mark.workers.dev/" -o "$fix_path" 2>/dev/null || true
    chmod +x "$fix_path" 2>/dev/null || true
  fi
}

setup_tmpfs_pnpm_and_wrapper() {
  local persist_prefix="$1"
  local tmp_dir="$2"
  local work_dir="$3"
  local pnpm_store="$4"
  local pnpm_cache="$5"
  local npm_cache="$6"

  local real_pnpm_prefix="${tmp_dir}/pnpm-global"
  local real_pnpm_bin="${real_pnpm_prefix}/bin/pnpm"
  local real_pnpx_bin="${real_pnpm_prefix}/bin/pnpx"

  # Purge any legacy 63MB pnpm installation on OverlayFS (/usr/local/lib/node_modules/pnpm)
  rm -rf "${persist_prefix}/lib/node_modules/pnpm" /root/.npm /root/.cache/pnpm /root/.local/share/pnpm 2>/dev/null || true

  # Install pnpm binary into tmpfs (/tmp/pnpm-global)
  if [ ! -x "$real_pnpm_bin" ]; then
    mkdir -p "$real_pnpm_prefix" "$npm_cache" 2>/dev/null || true
    NPM_CONFIG_CACHE="$npm_cache" npm install -g pnpm --prefix "$real_pnpm_prefix" --force --no-audit --no-fund --silent >/dev/null 2>&1 || \
      NPM_CONFIG_CACHE="$npm_cache" npm install -g pnpm --prefix "$real_pnpm_prefix" --force
    rm -rf /root/.npm "$npm_cache" 2>/dev/null || true
  fi

  mkdir -p "${persist_prefix}/etc/pnpm" "${persist_prefix}/bin" 2>/dev/null || true
  cat << EOF > "${persist_prefix}/etc/pnpm/config.yaml"
cacheDir: ${pnpm_cache}
storeDir: ${pnpm_store}
verifyDepsBeforeRun: false
confirmModulesPurge: false
EOF

  # Remove any symlinks in /usr/local/bin/{pnpm,pnpx,pn,pnx} so we write real 2KB scripts
  for bin_name in pnpm pnpx pn pnx; do
    rm -f "${persist_prefix}/bin/${bin_name}" 2>/dev/null || true
  done

  cat << EOF > "${persist_prefix}/bin/pnpm"
#!/usr/bin/env bash
export XDG_CONFIG_HOME="${persist_prefix}/etc"
export XDG_CACHE_HOME="${tmp_dir}"
export XDG_DATA_HOME="${tmp_dir}"
export XDG_STATE_HOME="${tmp_dir}"

REAL_PNPM_PREFIX="${real_pnpm_prefix}"
REAL_PNPM="\${REAL_PNPM_PREFIX}/bin/pnpm"

if [ ! -x "\$REAL_PNPM" ]; then
  echo "[pnpm-wrapper] /tmp reset detected. Reinstalling pnpm to tmpfs & healing workspace..." >&2
  mkdir -p "\$REAL_PNPM_PREFIX" "${pnpm_store}" "${pnpm_cache}" "${npm_cache}" 2>/dev/null || true
  NPM_CONFIG_CACHE="${npm_cache}" npm install -g pnpm --prefix "\$REAL_PNPM_PREFIX" --force --no-audit --no-fund --silent >/dev/null 2>&1 || \
    NPM_CONFIG_CACHE="${npm_cache}" npm install -g pnpm --prefix "\$REAL_PNPM_PREFIX" --force >&2
  rm -rf /root/.npm "${npm_cache}" 2>/dev/null || true
  if [ -x "${work_dir}/fix.sh" ] && [ -z "\${FIX_SH_RUNNING:-}" ]; then
    FIX_SH_RUNNING=1 "${work_dir}/fix.sh" --no-check >&2 || true
  fi
fi

for link_dir in dist .vite src-tauri/target public; do
  if [ -L "\$link_dir" ] && [ ! -e "\$link_dir" ]; then
    mkdir -p "\$(readlink "\$link_dir")" 2>/dev/null || true
  fi
done

if [ -L "node_modules" ] && [ -f "package.json" ]; then
  NM_TARGET="\$(readlink "node_modules")"
  if [ ! -e "node_modules" ] || [ ! -f "node_modules/.modules.yaml" ]; then
    mkdir -p "\$NM_TARGET" "${pnpm_store}" 2>/dev/null || true
    case "\${1:-}" in
      install|i|add|remove|config|--version|-v|--help|-h) ;;
      *) "\$REAL_PNPM" install --store-dir="${pnpm_store}" --config.confirm-modules-purge=false >&2 ;;
    esac
  fi
fi

exec "\$REAL_PNPM" "\$@"
EOF
  chmod +x "${persist_prefix}/bin/pnpm"

  cat << EOF > "${persist_prefix}/bin/pnpx"
#!/usr/bin/env bash
if [ ! -x "${real_pnpx_bin}" ]; then
  "${persist_prefix}/bin/pnpm" --version >/dev/null 2>&1 || true
fi
exec "${real_pnpx_bin}" "\$@"
EOF
  chmod +x "${persist_prefix}/bin/pnpx"

  # Install a lightweight git wrapper at /usr/local/bin/git so `git reset --hard`
  # (which natively does not trigger post-checkout in Git) automatically invokes
  # .git/hooks/post-checkout to restore tmpfs submodule symlinks (e.g. public -> /tmp/...)
  if [ -x "/usr/bin/git" ]; then
    cat << 'EOF' > "${persist_prefix}/bin/git"
#!/usr/bin/env bash
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
    fi
  done

  if [ -d "${repo_dir}/.git/modules" ]; then
    local mod_git_dir
    while IFS= read -r mod_git_dir; do
      [ -z "$mod_git_dir" ] && continue
      local rel_mod="${mod_git_dir#${repo_dir}/.git/modules/}"
      if [[ "$active_paths" != *" ${rel_mod} "* ]]; then
        rm -rf "${repo_dir}/${rel_mod}/.git" "$mod_git_dir" 2>/dev/null || true
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
    # Remove any residual .git inside former submodule directories before switching branches
    find "$repo_dir" -mindepth 2 -maxdepth 3 -name ".git" | while IFS= read -r sub_git; do
      local rel_sub="${sub_git#${repo_dir}/}"
      rel_sub="${rel_sub%/.git}"
      if [ ! -L "${repo_dir}/${rel_sub}" ]; then
        rm -rf "$sub_git" 2>/dev/null || true
      fi
    done

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
# 2. Cleans up stale submodule .git directories when switching to branches (like alpha)
#    where former submodules (e.g. src/ui-core) are tracked as regular files.
# 3. Locks active non-tmpfs code submodules strictly to HEAD:<sub_path>.
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
    fi
  done < <(find ".git/modules" -mindepth 1 -maxdepth 3 -name "HEAD" 2>/dev/null | sed 's|/HEAD\$||')
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
