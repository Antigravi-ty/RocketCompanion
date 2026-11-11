# `envinit-worker` — Decoupled Universal OverlayFS + `tmpfs` Sandbox Initializer

Modular ES Module Cloudflare Worker and standalone script (`envinit.sh`) for initializing Vite, Tauri, and `pnpm`/`npm` repositories inside container sandboxes where `/work` lives on persistent OverlayFS and `/tmp` is an in-memory `tmpfs` mount.

## Decoupled Directory Structure

```text
envinit-worker/
├── README.md                  # Architecture, 4 OverlayFS root-cause fixes & universal System Instruction
├── wrangler.toml              # Cloudflare Wrangler configuration (ES Module multi-file support)
├── deploy.mjs                 # Assembles scripts/*.sh -> envinit.sh, syncs src/, & deploys via CF REST API
├── envinit.sh                 # Assembled standalone executable Bash initializer
├── scripts/
│   ├── 01_help_and_cli.sh     # Help documentation & CLI flag parser
│   ├── 02_pnpm_tmpfs_wrapper.sh # Zero-OverlayFS tmpfs pnpm installer & 2KB self-healing wrapper
│   ├── 03_git_and_hooks.sh    # Ref checkout, stale submodule cleanup & self-healing Git hooks
│   └── 04_workspace_and_main.sh # Submodule SHA sync, tmpfs workspace links & main entrypoint
└── src/
    ├── index.js               # Worker HTTP request entry point & route dispatcher
    ├── parseQueryArgs.js      # Query parameter parser, shell-quoting, and CLI preset injector
    ├── helpText.js            # Pure plain-text help documentation module (/help, ?help=1)
    └── initScript.js          # Generated Bash script payload module (synced from envinit.sh)
```

## Key Capabilities & 4 OverlayFS Bloat Fixes (~19 MB Total OverlayFS Footprint)

1. **Zero-OverlayFS Self-Healing `pnpm` Wrapper (`scripts/02_pnpm_tmpfs_wrapper.sh`, saves 63 MB on `/`)**:
   - Installs the 63 MB `@pnpm/linux-x64` package into `/tmp/pnpm-global` (`tmpfs`) and purges `/usr/local/lib/node_modules/pnpm` from OverlayFS.
   - Writes a real ~2 KB Bash wrapper script (never a symlink!) at `/usr/local/bin/pnpm` and `/usr/local/bin/pnpx`.
   - When `/tmp` is wiped across container snapshot restores, running any `pnpm` command automatically reinstalls `pnpm` into `/tmp/pnpm-global`, heals `/tmp` symlink targets (`public`, `dist`, `.vite`, `src-tauri/target`, `node_modules`), and invokes `/work/fix.sh --no-check`.
2. **Self-Healing `public` (`tmpfs` Submodule) Symlink in Git Hooks (`scripts/03_git_and_hooks.sh`, prevents 180 MB spike)**:
   - `git reset --hard` and `git checkout -f` clear `--assume-unchanged` and replace the `public` symlink with an empty directory on OverlayFS.
   - `.git/hooks/post-checkout`, `post-merge`, and `post-rewrite` now detect `tmpfs` submodules (`sub_update=none` or `public`/`*Statics*`) and immediately recreate `ln -sfn /tmp/<StaticsRepo> "$sub_path"` + `git update-index --assume-unchanged "$sub_path"`.
3. **Stale Submodule `.git` Cleanup Across Branch Switches (`scripts/03_git_and_hooks.sh`, saves 5~10 MB)**:
   - Switching between legacy submodule branches (`beabd26` where `src/ui-core` is a submodule) and `alpha` (where `src/ui-core` is a normal directory) automatically cleans up residual `src/ui-core/.git` and `.git/modules/src/ui-core`.
4. **Zero-Detached-HEAD Commit Checkout, On-Demand `--no-tags` Fetch & Loose Object Pruning (`scripts/03_git_and_hooks.sh`)**:
   - When `--ref <commit_sha>` is passed without `--new-branch`, automatically resolves the commit SHA to the matching remote branch on `origin` (preferring `origin/HEAD`, `alpha`, `main`, `master`, or the unique remote branch at that commit) or creates a local `z/ref-<short_sha>` branch so the working tree is never left in `detached HEAD` state.
   - Uses targeted `git fetch --no-tags` (refreshing remote branch tips without pulling heavy tags on short SHAs) and runs `git prune --expire=now` after ref switches to prevent `.git/objects` accumulation on OverlayFS.

## Universal System Instruction Template (Vite / TypeScript / Tauri)

```markdown
Step 1: Read the User Request to identify the target repository (`--repo`), base commit/branch (`--ref`), and working branch (`--new-branch`), then initialize or restore the sandbox environment:
`mkdir -p /work && curl -fsSL https://envinit.maboco-mark.workers.dev/ -o /work/fix.sh && chmod +x /work/fix.sh && /work/fix.sh --repo <Owner/Repo> [--ref <commit_or_branch>] [--new-branch <z/branch_name>] --no-check`
- Key `/work/fix.sh` options (run `/work/fix.sh --help` for full details):
  - `--repo <url|Owner/Repo>`: Target Git repository (defaults to `Antigravi-ty/RocketCompanion` if omitted)
  - `--ref <sha|branch|tag>`: Base commit SHA (full or short), branch, or tag to checkout
  - `--new-branch <name>`: Create/reset local working branch at `--ref`
  - `--no-check`: Skip initial radar check during bootstrap
- Snapshot & `/tmp` Auto-Recovery: Source code lives in `/work/<RepoName>` (persistent OverlayFS), while `pnpm` binaries, `node_modules`, `dist`, `.vite`, `src-tauri/target`, and static submodules (`public`) live on `/tmp` (`tmpfs`). If `/tmp` is wiped after a container reset, running any `pnpm` command auto-heals `/tmp` via the `/usr/local/bin/pnpm` wrapper, or you can run `/work/fix.sh --no-check` at any time.
Step 2: Proceed with the user's request inside `/work/<RepoName>`. Keep build artifacts, temporary branch comparisons (`/tmp/branches/`), and static assets strictly on `/tmp` (never on OverlayFS).
Step 3: Verify changes using the project's actual scripts in `package.json` / `src-tauri` (e.g., `pnpm check`, `pnpm radar`, `pnpm build`, or `cargo check`). If any dependency or symlink is missing, re-run `/work/fix.sh --no-check`.

Prefer editing existing files with `replace_file_content` rather than `write_to_file`.
Never run bare `git show` or `git diff` across the entire repository to stdout.
Always inspect change summaries with `git diff --stat` first, or extract specific conflicting files into `/tmp/branches/` (`git show <ref>:<path> > /tmp/branches/...` / `git merge-file`) and run `diff -u` on individual files.
```
