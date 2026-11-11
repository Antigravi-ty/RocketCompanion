# `envinit-worker` — Decoupled Universal OverlayFS + `tmpfs` Sandbox Initializer

Modular ES Module Cloudflare Worker and standalone script (`envinit.sh`) for initializing Vite, Rust WASM (`crates/`), Tauri (`src-tauri/`), and `pnpm`/`npm` repositories inside container sandboxes where `/work` lives on persistent OverlayFS and `/tmp` is an in-memory `tmpfs` mount.

## Decoupled Directory Structure

```text
envinit-worker/
├── README.md                    # Architecture, OverlayFS root-cause fixes & universal System Instruction
├── wrangler.toml                # Cloudflare Wrangler configuration (ES Module multi-file support)
├── deploy.mjs                   # Assembles scripts/*.sh -> envinit.sh, syncs src/, & deploys via CF REST API
├── envinit.sh                   # Assembled standalone executable Bash initializer
├── scripts/
│   ├── 01_help_and_cli.sh       # Help documentation & CLI flag parser
│   ├── 02_pnpm_tmpfs_wrapper.sh # Zero-OverlayFS tmpfs pnpm installer & 2KB self-healing wrapper
│   ├── 03_rust_tmpfs_wrapper.sh # Zero-OverlayFS tmpfs Rust/WASM/Tauri lazy-bootstrap & smart target wrappers
│   ├── 04_git_and_hooks.sh      # Git wrapper, ref checkout, stale submodule cleanup & self-healing hooks
│   └── 05_workspace_and_main.sh # Submodule SHA sync, dual-Rust tmpfs workspace links & main entrypoint
└── src/
    ├── index.js                 # Worker HTTP request entry point & route dispatcher
    ├── parseQueryArgs.js        # Query parameter parser, shell-quoting, and CLI preset injector
    ├── helpText.js              # Pure plain-text help documentation module (/help, ?help=1)
    └── initScript.js            # Generated Bash script payload module (synced from envinit.sh)
```

## Key Capabilities & OverlayFS Bloat Fixes (~19 MB Total OverlayFS Footprint)

1. **Zero-OverlayFS Self-Healing `pnpm` Wrapper (`scripts/02_pnpm_tmpfs_wrapper.sh`, saves 63 MB on `/`)**:
   - Installs the 63 MB `@pnpm/linux-x64` package into `/tmp/pnpm-global` (`tmpfs`) and purges `/usr/local/lib/node_modules/pnpm` from OverlayFS.
   - Writes a real ~2 KB Bash wrapper script (never a symlink!) at `/usr/local/bin/pnpm` and `/usr/local/bin/pnpx`.
   - When `/tmp` is wiped across container snapshot restores, running any `pnpm` command automatically reinstalls `pnpm` into `/tmp/pnpm-global`, heals `/tmp` symlink targets (`public`, `dist`, `.vite`, `crates/target`, `src-tauri/target`, `src/physics/core.wasm`, `node_modules`), and invokes `/work/fix.sh --no-check`.
2. **Zero-OverlayFS Lazy-Bootstrap Rust/WASM/Tauri Wrappers (`scripts/03_rust_tmpfs_wrapper.sh`, saves 1.3 GB on `/`)**:
   - Writes ~2 KB self-healing wrapper scripts at `/usr/local/bin/{cargo,rustc,rustup}` that enforce `CARGO_HOME=/tmp/cargo-home` and `RUSTUP_HOME=/tmp/rustup` while purging `/root/.cargo` and `/root/.rustup`.
   - **Lazy Bootstrap**: Avoids downloading the 800 MB Rust toolchain during `fix.sh` initialization (unless `--with-rust` is passed). Automatically installs minimal `stable` + `wasm32-unknown-unknown` into `/tmp` on the first `cargo`, `rustc`, `rustup`, or `pnpm build:wasm` invocation.
   - **Smart Dual-Rust `CARGO_TARGET_DIR` & Target Routing**: Routes `src-tauri` commands to `/tmp/<slug>-tauri-target` and `crates` WASM commands to `/tmp/rc-wasm-target` (100% shared incremental cache between bare `cargo check` and `pnpm build:wasm:dev`), and defaults `cargo check`/`build`/`clippy` in `crates/` (or repo root) to `--target wasm32-unknown-unknown`.
3. **Dual-Rust Workspace & Untracked WASM Symlinks (`scripts/05_workspace_and_main.sh` & `scripts/04_git_and_hooks.sh`)**:
   - Mounts `crates/target -> /tmp/rc-wasm-target`, `src-tauri/target -> /tmp/<slug>-tauri-target`, and untracked `src/physics/core.wasm -> /tmp/rc-wasm-target/core.wasm` (so `fs.copyFileSync` in `buildPhysicsWasm.mjs` writes the 650 KB WASM binary directly to `tmpfs` without touching OverlayFS).
4. **Self-Healing `public` (`tmpfs` Submodule) & Dual-Rust Symlinks in Git Hooks (`scripts/04_git_and_hooks.sh`, prevents 180 MB spike)**:
   - `.git/hooks/post-checkout`, `post-merge`, and `post-rewrite` (triggered on `git reset --hard` via `/usr/local/bin/git`) automatically recreate `public -> /tmp/<StaticsRepo>` (`--assume-unchanged`), `crates/target`, `src-tauri/target`, and untracked `src/physics/core.wasm` symlinks, and clean up residual `.git/modules/*` when switching branches.
5. **Zero-Detached-HEAD Commit Checkout, On-Demand `--no-tags` Fetch & Loose Object Pruning (`scripts/04_git_and_hooks.sh`)**:
   - Resolves commit SHAs to matching remote branches on `origin` (or `z/ref-<short_sha>`) so the working tree is never left in `detached HEAD` state, and runs `git prune --expire=now` to keep `.git/objects` compact on OverlayFS.

## Universal System Instruction (Chinese — Vite / TypeScript / Rust WASM / Tauri)

```markdown
Step 1: 先阅读 User Request 提取目标仓库 (`--repo`)、基准 Commit/分支 (`--ref`) 与目标工作分支 (`--new-branch`)，再下载并执行 `/work/fix.sh` 初始化或恢复沙盒环境：
`mkdir -p /work && curl -fsSL https://envinit.maboco-mark.workers.dev/ -o /work/fix.sh && chmod +x /work/fix.sh && /work/fix.sh [--repo <Owner/Repo>] [--ref <commit_or_branch>] [--new-branch <z/branch_name>] --no-check`
- 支持的核心参数（完整说明可执行 `/work/fix.sh --help`）：
  - `--repo <url|Owner/Repo>`：目标 Git 仓库（未指定时默认 `Antigravi-ty/RocketCompanion`）
  - `--ref <sha|branch|tag>`：基准 Commit SHA（支持长/短 SHA）、分支名或 Tag
  - `--new-branch <name>`：基于 `--ref` 自动创建/重置并切换到工作分支
  - `--no-check`：跳过初始化时的检查（若中途环境重置导致 `/tmp` 清空，直接运行任意 `pnpm` 或 `cargo` 命令即可通过 `/usr/local/bin/{pnpm,cargo,rustc,rustup}` 自动重装恢复，或随时运行 `/work/fix.sh --no-check`）
Step 2: 在 `/work/<RepoName>` 内执行用户请求。源码保留在 `/work` (OverlayFS)，静态子模块 (`public`)、依赖与工具链 (`node_modules`、`/tmp/pnpm-global`、`/tmp/rustup`、`/tmp/cargo-home`) 及编译产物 (`dist`、`.vite`、`crates/target`、`src-tauri/target`、未跟踪的 `src/physics/core.wasm`) 必须置于 `/tmp` (`tmpfs`)，严禁写入 OverlayFS (`/work` 或 `/root`)。
Step 3: 使用项目实际存在的脚本验证改动（如 `pnpm check`、`pnpm radar`、`pnpm build`、`pnpm build:wasm:check`、`pnpm build:wasm:dev` 或 `cargo check`）。若遇到依赖或软链接缺失，重新执行 `/work/fix.sh --no-check`。

Prefer edit file using `replace_file_content` tool rather than `write_to_file`
严禁直接对整个目录执行裸 `git show` / `git diff` 输出到终端。
使用 `git diff --stat` 先看修改列表，或者使用 `git show <ref>:<path> > /tmp/branches/...` / `git merge-file` 先把多分支文件提取到 `/tmp/branches/` 目录下，再用 `diff -u` 针对具体冲突文件做局部比对。
提交 GitHub Verified Commit (GraphQL `createCommitOnBranch`) 时，直接用脚本（如 Python `open(p, 'rb')`）在内存中读取文件流做 Base64 编码并直接发送 HTTP 请求，严禁在工具参数或终端 stdout 中打印大段 Base64 或二进制高熵字符串。
```

