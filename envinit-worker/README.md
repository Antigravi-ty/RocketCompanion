# `envinit-worker` — Decoupled Universal OverlayFS + `tmpfs` Sandbox Initializer

Modular ES Module Cloudflare Worker and standalone script (`envinit.sh`) for initializing Vite, Tauri, and `pnpm`/`npm` repositories inside container sandboxes where `/work` lives on persistent OverlayFS and `/tmp` is an in-memory `tmpfs` mount.

## Decoupled Directory Structure

```text
envinit-worker/
├── README.md                  # Architecture & usage guide
├── wrangler.toml              # Cloudflare Wrangler configuration (ES Module multi-file support)
├── deploy.mjs                 # Zero-dependency Cloudflare Workers REST API multipart deployer
├── envinit.sh                 # Standalone executable Bash initializer (source of truth)
└── src/
    ├── index.js               # Worker HTTP request entry point & route dispatcher
    ├── parseQueryArgs.js      # Query parameter parser, shell-quoting, and CLI preset injector
    ├── helpText.js            # Pure plain-text help documentation module (/help, ?help=1)
    └── initScript.js          # Generated Bash script payload module (synced from envinit.sh)
```

## Key Capabilities & Fixes

1. **Accurate `/help` Endpoint (`src/helpText.js`)**:
   - `GET /help`, `GET /--help`, and `GET /?help=1` return pure plain-text documentation (matching `envinit.sh --help`) without leaking or slicing raw Bash source code.
2. **Branch, Tag, Abbreviated Commit SHA, and `--new-branch` Support (`envinit.sh` & `src/parseQueryArgs.js`)**:
   - Supports `-b` / `--branch` / `--ref` (and `?branch=` / `?ref=`) with branch names, tags, full 40-char commit SHAs, or abbreviated commit hashes (e.g. `77755f1e`, `2b0cf7a3`).
   - Supports `--new-branch <name>` (and `?new_branch=<name>`) to automatically create/reset a working branch (such as `z/my-feature`) at the resolved target ref.
3. **Automatic Git Identity (`user.name` & `user.email`)**:
   - Configures default Git identity (`Mark <29165094+MaBoCoMark@users.noreply.github.com>`, overridable via `--git-name` / `--git-email` or `?git_name=` / `?git_email=`) globally and per-repository so local `git merge` (including Octopus merges), `git rebase`, and `git cherry-pick` never fail with `fatal: unable to auto-detect email address` in fresh containers under `GIT_TERMINAL_PROMPT=0`.
4. **Commit-Locked Submodule SHA Extraction & Auto-Sync Git Hooks (`HEAD:<sub_path>`)**:
   - Directly extracts the exact gitlink commit SHA pinned in the parent commit tree (`git rev-parse -q --verify "HEAD:<sub_path>"`) and explicitly fetches/checks out that exact commit for both code submodules (`src/ui-core`) and `tmpfs` static submodules (`public`), preventing remote default-branch (`a1`/`main`) drift or unpinned `git clone` bumps.
   - Installs `.git/hooks/post-checkout`, `.git/hooks/post-merge`, and `.git/hooks/post-rewrite` so `src/ui-core` automatically syncs to `HEAD:src/ui-core` whenever a local branch switch or merge updates the submodule pointer.
5. **Global Subshell `pnpm` & `pnpx` Availability**:
   - Automatically symlinks `/tmp/pnpm-global/bin/pnpm` and `/tmp/pnpm-global/bin/pnpx` into `/usr/local/bin/pnpm` and `/usr/local/bin/pnpx` so every subsequent non-interactive subshell tool call can invoke `pnpm` directly without losing `PATH`.
6. **Automatic `/work/fix.sh` Persistence**:
   - When executed via pipe (`curl -fsSL https://envinit.maboco-mark.workers.dev/ | bash`) or from another path, the script automatically persists itself to `/work/fix.sh` (`chmod +x`) so container snapshot restores (where `/tmp` is wiped) can always recover in one command: `/work/fix.sh --no-check`.
7. **Complete `tmpfs` Offloading (Zero OverlayFS Bloat)**:
   - Symlinks `node_modules` -> `/tmp/<slug>-node_modules`, `dist` -> `/tmp/<slug>-dist`, and `.vite` -> `/tmp/<slug>-vite` (plus `src-tauri/target` -> `/tmp/<slug>-tauri-target` when `src-tauri` is present).
   - Creates `/tmp` targets with `mkdir -p` **before** `ln -sfn` to prevent `pnpm` v12 Rust `EEXIST (os error 17)` on dangling symlinks, and keeps both `pnpm-store` and `node_modules` on `/tmp` for zero-copy hardlinks.
