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
     snapshot restores without exhausting disk quota or snapshot bandwidth.
  2. Ephemeral Artifacts & Dependencies on tmpfs (/tmp):
     Mounts heavy build/dependency directories onto /tmp (tmpfs RAM disk):
       - node_modules      -> /tmp/<slug>-node_modules
       - pnpm store        -> /tmp/pnpm-store
       - pnpm global bin   -> /tmp/pnpm-global/bin (linked to /usr/local/bin)
       - Vite build outDir -> /tmp/<slug>-dist
       - Vite cache        -> /tmp/<slug>-vite
       - Tauri Rust target -> /tmp/<slug>-tauri-target (if src-tauri/ exists)
       - Cargo cache       -> /tmp/cargo-home          (if src-tauri/ exists)
       - Static submodules -> /tmp/<StaticsRepo>       (matching public,*Statics*)
  3. Zero-Copy Hardlinks & Dangling Symlink Prevention:
     - Always runs `mkdir -p` on /tmp targets BEFORE `ln -sfn` so pnpm v12
       (Rust) never encounters a dangling symlink (which otherwise triggers
       ERR_PNPM_PACKAGE_MANAGER_CREATE_SLOT_DIR / os error 17 EEXIST).
     - Because both /tmp/<slug>-node_modules and /tmp/pnpm-store live on the
       same /tmp mount point, pnpm uses zero-copy hardlinks instead of falling
       back to cross-device (EXDEV) physical file copies.
  4. Git Identity, Status Hygiene & Commit-Locked Submodule Sync:
     - Configures default Git identity (`user.name` & `user.email`) globally and
       per-repo so local `git merge` (including Octopus merges), `git rebase`,
       and `git cherry-pick` never fail with `unable to auto-detect email address`
       under `GIT_TERMINAL_PROMPT=0`.
     - Supports branches, tags, full commit SHAs, or abbreviated commit hashes
       via `-b` / `--branch` / `--ref`, plus `--new-branch <z/name>`.
     - Strictly extracts the exact submodule gitlink commit SHA from the parent
       commit (`git rev-parse "HEAD:<sub_path>"`) and checks out that exact SHA
       for both code submodules (`src/ui-core`) and `tmpfs` static submodules,
       preventing accidental branch drift or remote HEAD bumps.
     - Installs `post-checkout`, `post-merge`, and `post-rewrite` Git hooks so
       `src/ui-core` automatically syncs to `HEAD:src/ui-core` after any local
       `git checkout` or `git merge`.
     - Registers symlink names (without trailing slashes) in .git/info/exclude
       and marks static submodules with --assume-unchanged so `git status`
       remains 100% clean.
  5. Automatic Persistence to /work/fix.sh:
     - Even if invoked via `curl -fsSL https://envinit.maboco-mark.workers.dev/ | bash`,
       the script automatically saves a copy of itself to `/work/fix.sh` so
       subsequent snapshot recoveries only require `/work/fix.sh --no-check`.

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
  --check-cmd <command>         Custom verification command to run after install
                                (default: `pnpm radar --no-tsc` if defined in package.json).

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

checkout_target_ref() {
  local repo_dir="$1"
  local target_ref="$2"
  local new_branch="$3"

  if [ -n "$target_ref" ]; then
    if git -C "$repo_dir" fetch origin "$target_ref" >/dev/null 2>&1; then
      if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/${target_ref}"; then
        git -C "$repo_dir" checkout -B "$target_ref" "origin/${target_ref}"
      else
        git -C "$repo_dir" checkout --detach FETCH_HEAD
      fi
    else
      git -C "$repo_dir" fetch --all --tags --prune >/dev/null 2>&1 || true
      if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/${target_ref}"; then
        git -C "$repo_dir" checkout -B "$target_ref" "origin/${target_ref}"
      else
        git -C "$repo_dir" checkout "$target_ref"
      fi
    fi
  fi

  if [ -n "$new_branch" ]; then
    git -C "$repo_dir" checkout -B "$new_branch"
  fi
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

install_git_submodule_hooks() {
  local repo_dir="$1"
  local hooks_dir="${repo_dir}/.git/hooks"
  mkdir -p "$hooks_dir"

  local hook_body
  read -r -d '' hook_body << 'HOOK_EOF' || true
#!/usr/bin/env bash
# Auto-generated by envinit: keeps non-tmpfs code submodules (e.g. src/ui-core)
# strictly locked to the parent commit's gitlink SHA (HEAD:<sub_path>) across
# local `git checkout`, `git merge`, and `git rebase` operations.
set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT" || exit 0
[ -f ".gitmodules" ] || exit 0

sub_keys="$(git config --file .gitmodules --name-only --get-regexp '^submodule\..*\.path$' 2>/dev/null || true)"
for key in $sub_keys; do
  sub_name="${key#submodule.}"
  sub_name="${sub_name%.path}"
  sub_path="$(git config --file .gitmodules --get "$key" 2>/dev/null || true)"
  [ -z "$sub_path" ] && continue

  # Skip tmpfs symlinked static submodules (marked with update=none or symlink)
  sub_update="$(git config --get "submodule.${sub_name}.update" 2>/dev/null || true)"
  if [ "$sub_update" = "none" ] || [ -L "$sub_path" ]; then
    continue
  fi

  pinned_sha="$(git rev-parse -q --verify "HEAD:${sub_path}" 2>/dev/null || true)"
  [ -z "$pinned_sha" ] && continue
  [ -e "${sub_path}/.git" ] || continue

  cur_sha="$(git -C "$sub_path" rev-parse HEAD 2>/dev/null || true)"
  if [ "$cur_sha" != "$pinned_sha" ]; then
    if git -C "$sub_path" diff --quiet 2>/dev/null && git -C "$sub_path" diff --cached --quiet 2>/dev/null; then
      if ! git -C "$sub_path" cat-file -e "${pinned_sha}^{commit}" 2>/dev/null; then
        git -C "$sub_path" fetch origin "$pinned_sha" >/dev/null 2>&1 || git -C "$sub_path" fetch --all --tags --prune >/dev/null 2>&1 || true
      fi
      git -C "$sub_path" checkout --detach "$pinned_sha" >/dev/null 2>&1 || true
    fi
  fi
done
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

main() {
  export GIT_TERMINAL_PROMPT=0
  export PAGER=cat
  export CI=true
  export DEBIAN_FRONTEND=noninteractive

  local ROOT_PREFIX="/"
  local WORK_DIR=""
  local TMP_DIR=""
  local REPO_URL="https://github.com/Antigravi-ty/RocketCompanion"
  local REPO_NAME=""
  local TARGET_REF=""
  local NEW_BRANCH=""
  local TMPFS_SUBMODULES="public,*Statics*,*statics*"
  local GIT_USER_NAME="${GIT_AUTHOR_NAME:-Mark}"
  local GIT_USER_EMAIL="${GIT_AUTHOR_EMAIL:-29165094+MaBoCoMark@users.noreply.github.com}"
  local RUN_CHECK=1
  local CHECK_CMD=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help|help)
        print_help
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

  git config --global user.name "$GIT_USER_NAME" 2>/dev/null || true
  git config --global user.email "$GIT_USER_EMAIL" 2>/dev/null || true

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
  local NM_TARGET="${TMP_DIR}/${SLUG}-node_modules"
  local DIST_TARGET="${TMP_DIR}/${SLUG}-dist"
  local VITE_TARGET="${TMP_DIR}/${SLUG}-vite"
  local TAURI_TARGET="${TMP_DIR}/${SLUG}-tauri-target"
  local CARGO_HOME_TMP="${TMP_DIR}/cargo-home"

  mkdir -p "$WORK_DIR" "$TMP_DIR" "$PNPM_STORE" "$NM_TARGET" "$DIST_TARGET" "$VITE_TARGET"
  ensure_fix_sh_persisted "$WORK_DIR"

  local PNPM_GLOBAL_DIR="${TMP_DIR}/pnpm-global"
  export PATH="${PNPM_GLOBAL_DIR}/bin:/usr/local/bin:${PATH}"
  if [ ! -x "${PNPM_GLOBAL_DIR}/bin/pnpm" ] && ! command -v pnpm >/dev/null 2>&1; then
    mkdir -p "$PNPM_GLOBAL_DIR"
    npm install -g pnpm --prefix "$PNPM_GLOBAL_DIR" --force --no-audit --no-fund >/dev/null 2>&1 || npm install -g pnpm --force
  fi
  if [ -x "${PNPM_GLOBAL_DIR}/bin/pnpm" ]; then
    mkdir -p /usr/local/bin 2>/dev/null || true
    ln -sfn "${PNPM_GLOBAL_DIR}/bin/pnpm" /usr/local/bin/pnpm 2>/dev/null || true
    [ -e "${PNPM_GLOBAL_DIR}/bin/pnpx" ] && ln -sfn "${PNPM_GLOBAL_DIR}/bin/pnpx" /usr/local/bin/pnpx 2>/dev/null || true
  fi
  pnpm config set store-dir "$PNPM_STORE" --global >/dev/null 2>&1 || true

  if [ ! -d "${PROJECT_DIR}/.git" ] || ! git -C "$PROJECT_DIR" rev-parse HEAD >/dev/null 2>&1; then
    rm -rf "$PROJECT_DIR"
    git clone "$REPO_URL" "$PROJECT_DIR"
  fi

  git -C "$PROJECT_DIR" config user.name "$GIT_USER_NAME" 2>/dev/null || true
  git -C "$PROJECT_DIR" config user.email "$GIT_USER_EMAIL" 2>/dev/null || true

  if [ -n "$TARGET_REF" ] || [ -n "$NEW_BRANCH" ]; then
    checkout_target_ref "$PROJECT_DIR" "$TARGET_REF" "$NEW_BRANCH"
  fi

  cd "$PROJECT_DIR"

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
        repo_parent="$(dirname "$REPO_URL")"
        sub_url="${repo_parent}/${sub_url#../}"
      fi

      # Extract the exact gitlink commit SHA pinned in the parent commit tree
      local pinned_sha
      pinned_sha="$(git rev-parse -q --verify "HEAD:${sub_path}" 2>/dev/null || true)"

      local is_tmpfs_sub=0
      IFS=',' read -ra patterns <<< "$TMPFS_SUBMODULES"
      for pat in "${patterns[@]}"; do
        if [[ "$sub_path" == $pat || "$sub_name" == $pat || "$sub_url" == $pat ]]; then
          is_tmpfs_sub=1
          break
        fi
      done

      if [ "$is_tmpfs_sub" -eq 1 ]; then
        local statics_base
        statics_base="$(basename "${sub_url%.git}")"
        [ -z "$statics_base" ] && statics_base="${SLUG}-${sub_name}"
        local tmp_sub_dir="${TMP_DIR}/${statics_base}"
        if [ ! -d "${tmp_sub_dir}/.git" ] || ! git -C "$tmp_sub_dir" rev-parse HEAD >/dev/null 2>&1; then
          rm -rf "$tmp_sub_dir"
          git clone "$sub_url" "$tmp_sub_dir"
        fi
        if [ -n "$pinned_sha" ]; then
          if ! git -C "$tmp_sub_dir" cat-file -e "${pinned_sha}^{commit}" 2>/dev/null; then
            git -C "$tmp_sub_dir" fetch origin "$pinned_sha" >/dev/null 2>&1 || git -C "$tmp_sub_dir" fetch --all --tags --prune >/dev/null 2>&1 || true
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
            git -C "$sub_path" fetch origin "$pinned_sha" >/dev/null 2>&1 || git -C "$sub_path" fetch --all --tags --prune >/dev/null 2>&1 || true
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

        git -C "$sub_path" config user.name "$GIT_USER_NAME" 2>/dev/null || true
        git -C "$sub_path" config user.email "$GIT_USER_EMAIL" 2>/dev/null || true
      fi
    done
  fi

  install_git_submodule_hooks "$PROJECT_DIR"

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
      echo "[init-sandbox] Ready. Running quick radar check (--no-tsc)..."
      pnpm radar --no-tsc
    fi
  fi

  echo "[init-sandbox] Complete: source in ${PROJECT_DIR} (OverlayFS), artifacts linked to ${TMP_DIR} (tmpfs)."
}

main "$@"
