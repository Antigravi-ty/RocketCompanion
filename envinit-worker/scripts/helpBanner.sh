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
     Persists lightweight repository metadata (LAST_REPO_URL & LAST_REPO_NAME)
     in /work/.fix_state so cross-turn `/work/fix.sh --no-check` and wrapper
     self-healing always target the active repository.
  2. Ephemeral Artifacts, Credentials, Toolchains & Dependencies on tmpfs (/tmp):
     Mounts ALL heavy binaries, toolchains, dependencies, credentials, and build
     outputs onto /tmp (RAM) and purges any accidental caches under /root:
       - Git auth token     -> /tmp/.git-token & /tmp/git-askpass.sh (0B on /)
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
  3. Zero-OverlayFS Self-Healing Wrappers (/usr/local/bin/{pnpm,pnpx,cargo,rustc,rustup,git,heal-tmpfs-links}):
     - heal-tmpfs-links: Fast idempotent directory target healer (0 network calls)
       invoked across git/pnpm/cargo entrypoints so symlinks never dangle after
       container /tmp resets.
     - pnpm: Installs `@pnpm/linux-x64` into `/tmp/pnpm-global` and purges
       `/usr/local/lib/node_modules/pnpm`. Auto-reinstalls on `/tmp` reset and
       passes the active repository (`$PWD` git remote or `/work/.fix_state`) to
       `/work/fix.sh --no-check`.
     - cargo / rustc / rustup: Lazy-bootstraps minimal Rust `stable` +
       `wasm32-unknown-unknown` into `/tmp/rustup` and `/tmp/cargo-home` only
       when a Rust/WASM command is actually invoked.
     - Smart Dual-Rust `CARGO_TARGET_DIR` & Root Manifest Routing: Automatically
       routes `src-tauri` builds (including bare `cargo check` from repo root when
       only `src-tauri/Cargo.toml` exists) to `/tmp/<slug>-tauri-target` and
       `crates` WASM builds to `/tmp/rc-wasm-target`.
  4. Ephemeral Git Authentication (`--auth` / `--token`):
     - Accepts a `x-agy-request-id` UUID, full `curl` auth command, or raw
       `ghs_...` / `ghp_...` token.
     - Automatically exchanges `x-agy-request-id` with the token worker and
       injects `GIT_ASKPASS=/tmp/git-askpass.sh` + `/tmp/.git-token` in `tmpfs`
       so private repositories clone seamlessly without writing credentials to
       `/root/.gitconfig` or `.git/config`.

USAGE
  /work/fix.sh [OPTIONS]
  curl -fsSL https://envinit.maboco-mark.workers.dev/ | bash -s -- [OPTIONS]

OPTIONS
  -h, --help, help              Show this help guide and exit.
  --repo <url|Owner/Repo>       Repository URL or GitHub shorthand (defaults to
                                current repo / /work/.fix_state, or RocketCompanion).
  -b, --branch, --ref <ref>     Branch, tag, or commit SHA (full or short) to checkout.
  --new-branch <branch-name>    Create/reset local branch (e.g. z/my-fix) at target ref.
  --auth, --token <id|token>    Optional `x-agy-request-id` UUID, auth curl line, or
                                raw `ghs_...` token for private repo clone & API auth.
  --auth-url <url>              Token worker endpoint for `--auth` request IDs
                                (default: https://getgithubapptoken.maboco-mark.workers.dev/).
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

EXAMPLES (PUBLIC/PRIVATE REPO, COMMIT CHECKOUT & SNAPSHOT RECOVERY)
  # 1. Public repository initialization:
  /work/fix.sh --repo Antigravi-ty/RocketCompanion --ref aafd3dd --no-check

  # 2. Private repository initialization with x-agy-request-id (or token):
  /work/fix.sh --repo Antigravi-ty/agyPreviewInstant --auth bc5f56dc-b077-4a5c-843e-7e5fec21d66a --no-check

  # 3. Recover active repository after container snapshot restore (when /tmp was wiped):
  /work/fix.sh --no-check
================================================================================
HELP_EOF
}
