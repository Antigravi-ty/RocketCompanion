parse_cli_args() {
  ROOT_PREFIX="/"
  WORK_DIR=""
  TMP_DIR=""
  DEFAULT_REPO_URL="https://github.com/Antigravi-ty/RocketCompanion"
  REPO_URL=""
  REPO_EXPLICIT=0
  REPO_NAME=""
  TARGET_REF=""
  NEW_BRANCH=""
  AUTH_INPUT="${AGY_AUTH:-${AGY_REQUEST_ID:-${GITHUB_TOKEN:-${GH_TOKEN:-}}}}"
  AUTH_WORKER_URL="${AGY_TOKEN_WORKER_URL:-https://getgithubapptoken.maboco-mark.workers.dev/}"
  TMPFS_SUBMODULES="public,*Statics*,*statics*"
  GIT_USER_NAME="${GIT_AUTHOR_NAME:-Mark}"
  GIT_USER_EMAIL="${GIT_AUTHOR_EMAIL:-29165094+MaBoCoMark@users.noreply.github.com}"
  WITH_RUST=0
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
        REPO_EXPLICIT=1
        shift 2
        ;;
      --repo=*)
        REPO_URL="${1#*=}"
        REPO_EXPLICIT=1
        shift 1
        ;;
      --auth|--token|--request-id)
        AUTH_INPUT="$2"
        shift 2
        ;;
      --auth=*|--token=*|--request-id=*)
        AUTH_INPUT="${1#*=}"
        shift 1
        ;;
      --auth-url)
        AUTH_WORKER_URL="$2"
        shift 2
        ;;
      --auth-url=*)
        AUTH_WORKER_URL="${1#*=}"
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
      --with-rust)
        WITH_RUST=1
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

resolve_repo_and_state() {
  local work_dir="$1"
  local state_file="${work_dir}/.fix_state"

  if [ "${REPO_EXPLICIT:-0}" -eq 0 ] && [ -z "$REPO_URL" ]; then
    local pwd_top=""
    pwd_top="$(/usr/bin/git rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$pwd_top" ] && [[ "$pwd_top" == "${work_dir}/"* ]]; then
      local pwd_origin=""
      pwd_origin="$(/usr/bin/git -C "$pwd_top" config --get remote.origin.url 2>/dev/null || true)"
      if [ -n "$pwd_origin" ]; then
        REPO_URL="$pwd_origin"
        [ -z "$REPO_NAME" ] && REPO_NAME="$(basename "$pwd_top")"
      fi
    fi
  fi

  if [ -z "$REPO_URL" ] && [ -f "$state_file" ]; then
    # shellcheck disable=SC1090
    . "$state_file" 2>/dev/null || true
    [ -z "$REPO_URL" ] && [ -n "${LAST_REPO_URL:-}" ] && REPO_URL="$LAST_REPO_URL"
    [ -z "$REPO_NAME" ] && [ -n "${LAST_REPO_NAME:-}" ] && REPO_NAME="$LAST_REPO_NAME"
  fi

  if [ -z "$REPO_URL" ] && [ -d "$work_dir" ]; then
    local candidate_git
    for candidate_git in "${work_dir}"/*/.git; do
      [ -d "$candidate_git" ] || continue
      local cand_dir="${candidate_git%/.git}"
      local cand_origin=""
      cand_origin="$(/usr/bin/git -C "$cand_dir" config --get remote.origin.url 2>/dev/null || true)"
      if [ -n "$cand_origin" ]; then
        REPO_URL="$cand_origin"
        [ -z "$REPO_NAME" ] && REPO_NAME="$(basename "$cand_dir")"
        break
      fi
    done
  fi

  [ -z "$REPO_URL" ] && REPO_URL="$DEFAULT_REPO_URL"

  if [[ "$REPO_URL" != *"://"* && "$REPO_URL" != git@* ]]; then
    REPO_URL="https://github.com/${REPO_URL#.git}"
  fi

  if [ -z "$REPO_NAME" ]; then
    REPO_NAME="$(basename "${REPO_URL%.git}")"
  fi
}

save_fix_state() {
  local work_dir="$1"
  local repo_url="$2"
  local repo_name="$3"
  mkdir -p "$work_dir" 2>/dev/null || true
  cat << EOF > "${work_dir}/.fix_state"
LAST_REPO_URL='${repo_url}'
LAST_REPO_NAME='${repo_name}'
EOF
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
