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
   - Always re-synchronizes code submodules (`git submodule update --init --recursive -- <sub_path>`) after checking out the target ref so `src/ui-core` never remains dirty (`M src/ui-core`) across branch/commit switches.
3. **Global Subshell `pnpm` & `pnpx` Availability**:
   - Automatically symlinks `/tmp/pnpm-global/bin/pnpm` and `/tmp/pnpm-global/bin/pnpx` into `/usr/local/bin/pnpm` and `/usr/local/bin/pnpx` so every subsequent non-interactive subshell tool call can invoke `pnpm` directly without losing `PATH`.
4. **Automatic `/work/fix.sh` Persistence**:
   - When executed via pipe (`curl -fsSL https://envinit.maboco-mark.workers.dev/ | bash`) or from another path, the script automatically persists itself to `/work/fix.sh` (`chmod +x`) so container snapshot restores (where `/tmp` is wiped) can always recover in one command: `/work/fix.sh --no-check`.
5. **Complete `tmpfs` Offloading (Zero OverlayFS Bloat)**:
   - Symlinks `node_modules` -> `/tmp/<slug>-node_modules`, `dist` -> `/tmp/<slug>-dist`, and `.vite` -> `/tmp/<slug>-vite` (plus `src-tauri/target` -> `/tmp/<slug>-tauri-target` when `src-tauri` is present).
   - Creates `/tmp` targets with `mkdir -p` **before** `ln -sfn` to prevent `pnpm` v12 Rust `EEXIST (os error 17)` on dangling symlinks, and keeps both `pnpm-store` and `node_modules` on `/tmp` for zero-copy hardlinks.
