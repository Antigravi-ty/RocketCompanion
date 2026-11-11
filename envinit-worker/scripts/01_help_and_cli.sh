print_help() {
  cat << 'HELP_EOF'
================================================================================
 Universal OverlayFS + tmpfs Sandbox Initializer (Vite / Rust WASM / Tauri)
================================================================================

PURPOSE & ARCHITECTURE (FOR AI AGENTS & DEVELOPERS)
  1. Persistent Source on OverlayFS (/work/<RepoName>):
     Keeps only git-tracked source code and small code submodules (e.g.
     src/ui-core) on OverlayFS (/work) so code edits survive container
     snapshot restores without exhausting the 100 MB OverlayFS quota.
  2. Ephemeral Artifacts, Toolchains & Dependencies on tmpfs (/tmp):
     Mounts ALL heavy binaries, toolchains, dependencies, and build outputs onto
     /tmp (RAM) and purges any accidental caches under /root:
       - pnpm binary (63MB) -> /tmp/pnpm-global (2KB wrapper at /usr/local/bin/pnpm)
       - Rust toolchain     -> /tmp/rustup & /tmp/cargo-home (2KB lazy-bootstrap
                               wrappers at /usr/local/bin/{cargo,rustc,rustup})
       - node_modules       -> /tmp/<slug>-node_modules
       - pnpm store/cache   -> /tmp/pnpm-store & /tmp/pnpm-cache
       - Vite build outDir  -> /tmp/<slug>-dist
       - Vite cache         -> /tmp/<slug>-vite
       - WASM Rust target   -> /tmp/rc-wasm-target       (if crates/ exists)
       - WASM binary output -> /tmp/rc-wasm-target/core.wasm (if untracked)
       - Tauri Rust target  -> /tmp/<slug>-tauri-target  (if src-tauri/ exists)
       - Static submodules  -> /tmp/<StaticsRepo>        (matching public,*Statics*)
  3. Zero-OverlayFS Self-Healing Wrappers (/usr/local/bin/{pnpm,pnpx,cargo,rustc,rustup}):
     - pnpm: Installs `@pnpm/linux-x64` into `/tmp/pnpm-global` and purges
       `/usr/local/lib/node_modules/pnpm`. Auto-reinstalls on `/tmp` reset.
     - cargo / rustc / rustup: Lazy-bootstraps minimal Rust `stable` +
       `wasm32-unknown-unknown` into `/tmp/rustup` and `/tmp/cargo-home` only
       when a Rust/WASM command is actually invoked (0s overhead for UI-only
       tasks, or pre-warmed eagerly via `--with-rust`).
     - Smart Dual-Rust `CARGO_TARGET_DIR` routing: Automatically routes
       `src-tauri` builds to `/tmp/<slug>-tauri-target` and `crates` WASM builds
       to `/tmp/rc-wasm-target` (100% shared cache between bare `cargo check`
       and `pnpm build:wasm:dev`).
  4. Zero-Copy Hardlinks & Dangling Symlink Prevention:
     - Always runs `mkdir -p` on /tmp targets BEFORE `ln -sfn` so pnpm v12
       (Rust) and Cargo never encounter dangling symlinks.
     - Both `pnpm` and `cargo` wrappers auto-heal dangling symlink targets
       (`public`, `dist`, `.vite`, `crates/target`, `src-tauri/target`,
       `src/physics/core.wasm`, `node_modules`) after container `/tmp` resets.
  5. Git Identity, Hook Self-Healing & Stale Submodule Cleanup:
     - Configures default Git identity (`user.name` & `user.email`) globally and
       per-repo so local `git merge`, `git rebase`, and `git cherry-pick` never
       fail under `GIT_TERMINAL_PROMPT=0`.
     - Supports branches, tags, full commit SHAs, or abbreviated commit hashes
       via `-b` / `--branch` / `--ref`, plus `--new-branch <z/name>`, without
       leaving the working tree in `detached HEAD` state.
     - Installs `post-checkout`, `post-merge`, and `post-rewrite` Git hooks (plus
       `/usr/local/bin/git` wrapper for `git reset --hard`) that automatically
       restore `/tmp` symlinks (`public`, `crates/target`, `src-tauri/target`,
       untracked `src/physics/core.wasm`) and lock code submodules to `HEAD`.

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
  --with-rust                   Eagerly bootstrap Rust + wasm32 toolchain into /tmp
                                during initialization (default: lazy on first cargo call).
  --no-check                    Skip post-install verification check.
  --radar-args <args>           Arguments passed to default `pnpm radar` check
                                (default: "--no-tsc").
  --check-cmd <command>         Custom verification command to run after install
                                (default: `pnpm radar <radar-args>` if defined in package.json).

EXAMPLES (MULTI-REPO, COMMIT CHECKOUT & SNAPSHOT RECOVERY)
  # 1. Default initialization (RocketCompanion in /work/RocketCompanion):
  /work/fix.sh

  # 2. Checkout a specific commit hash (or branch) and create a working branch:
  /work/fix.sh --ref 932af8b --new-branch z/my-feature --no-check

  # 3. Initialize via Worker URL query parameters:
  curl -fsSL "https://envinit.maboco-mark.workers.dev/?ref=932af8b&no_check=1" | bash

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
