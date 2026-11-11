# `envinit-worker` — Decoupled Universal OverlayFS + `tmpfs` Sandbox Initializer

Modular ES + Text Module Cloudflare Worker for initializing Vite, Rust WASM (`crates/`), Tauri (`src-tauri/`), and `pnpm`/`npm` repositories (both public and private) inside container sandboxes where `/work` lives on persistent OverlayFS and `/tmp` is an in-memory `tmpfs` mount.

## Decoupled Directory Structure (Zero Redundant Generated Artifacts in Git)

```text
envinit-worker/
├── README.md                        # Architecture, OverlayFS root-cause fixes & Universal System Instruction
├── wrangler.toml                    # Cloudflare Wrangler configuration (ES + Text .sh module rules)
├── deploy.mjs                       # Verifies scripts/*.sh, writes /work/fix.sh, & deploys via CF REST API
├── scripts/
│   ├── helpBanner.sh                # Plain-text help documentation banner (HELP_EOF)
│   ├── cliAndRepoState.sh           # CLI flag parser, active repo auto-detection & /work/.fix_state persistence
│   ├── gitAuthAndWrapper.sh         # tmpfs Git auth (--auth/x-agy-request-id), heal-tmpfs-links & git wrapper
│   ├── pnpmTmpfsWrapper.sh          # Zero-OverlayFS tmpfs pnpm installer & repo-aware self-healing wrapper
│   ├── rustTmpfsWrapper.sh          # Zero-OverlayFS tmpfs Rust/WASM/Tauri lazy-bootstrap & root manifest routing
│   ├── gitRefCheckout.sh            # Zero-detached-HEAD commit/branch ref checkout & pruning
│   ├── gitSubmoduleHooks.sh         # Self-healing post-checkout/post-merge/post-rewrite Git hooks
│   ├── submoduleSync.sh             # Stale submodule cleanup & on-demand .gitmodules tmpfs/code sync
│   └── workspaceLinksAndMain.sh     # Dual-Rust/Vite tmpfs workspace symlinks & main entrypoint
└── src/
    ├── index.js                     # Worker HTTP request entry point & route dispatcher
    ├── parseQueryArgs.js            # Query parameter parser, shell-quoting, and CLI preset injector
    └── initScript.js                # Imports scripts/*.sh as native Text modules & extracts HELP_TEXT
```

## Key Capabilities & Multi-Repo / Private-Repo Fixes

1. **Active Repository Persistence (`/work/.fix_state`) & Multi-Repo Self-Healing (`scripts/cliAndRepoState.sh` & `scripts/pnpmTmpfsWrapper.sh`)**:
   - Persists `LAST_REPO_URL` and `LAST_REPO_NAME` into `/work/.fix_state` (~100B) whenever `fix.sh` initializes a repository.
   - When `/tmp` is wiped across container snapshot restores, running any `pnpm` command (or bare `/work/fix.sh --no-check`) automatically detects the active repository from `$PWD` (`git rev-parse --show-toplevel` + `remote.origin.url`) or `/work/.fix_state`, preventing accidental fallback clones of `RocketCompanion` or `RocketCompanionStatics`.
2. **Ephemeral `tmpfs` Git Authentication for Private Repositories (`scripts/gitAuthAndWrapper.sh`, `--auth` / `--token`)**:
   - Accepts a `x-agy-request-id` UUID, full `curl` auth command, or raw `ghs_...` / `ghp_...` token via `--auth <value>` (or `AGY_REQUEST_ID` / `GITHUB_TOKEN`).
   - Automatically exchanges `x-agy-request-id` with `https://getgithubapptoken.maboco-mark.workers.dev/` and writes `/tmp/.git-token` + `/tmp/git-askpass.sh` strictly in `tmpfs` (0 bytes written to `/root/.gitconfig` or `.git/config`), enabling one-command Step 1 cloning of private repositories (such as `Antigravi-ty/agyPreviewInstant`) and automatic `GITHUB_TOKEN` injection in `pnpm` prebuild scripts.
3. **Root-Aware Tauri & Dual-Rust `cargo` Wrapper (`scripts/rustTmpfsWrapper.sh`)**:
   - Lazy-bootstraps minimal `stable` + `wasm32-unknown-unknown` into `/tmp/rustup` and `/tmp/cargo-home` on first Rust invocation.
   - Detects `IS_TAURI_CTX=1` not only inside `src-tauri/`, but also when bare `cargo check` is run from the repository root of a Tauri project (`[ ! -f Cargo.toml ] && [ ! -f crates/Cargo.toml ] && [ -f src-tauri/Cargo.toml ]`), automatically routing `CARGO_TARGET_DIR` to `/tmp/<slug>-tauri-target` and injecting `--manifest-path src-tauri/Cargo.toml`.
4. **Fast Idempotent `/tmp` Symlink Target Healer (`/usr/local/bin/heal-tmpfs-links`, `scripts/gitAuthAndWrapper.sh`)**:
   - Zero-network (~1ms) helper mounted across `/usr/local/bin/{git,pnpm,pnpx,cargo,rustc,rustup}` and `fix.sh` that ensures `/tmp` target directories (`node_modules`, `dist`, `.vite`, `crates/target`, `src-tauri/target`, `public`) exist for both `$PWD` and the `/work/.fix_state` repository so `find_by_name` (`fd`) and build tools never encounter dangling symlinks after `/tmp` resets.

## Universal System Instruction (Chinese — Public/Private Repo / Vite / TypeScript / Rust WASM / Tauri)

```markdown
Step 1: 先阅读 User Request 提取目标仓库 (`--repo`)、基准 Commit/分支 (`--ref`)、目标工作分支 (`--new-branch`) 与可选鉴权凭据 (`--auth`)，再下载并执行 `/work/fix.sh` 初始化或恢复沙盒环境：
`mkdir -p /work && curl -fsSL https://envinit.maboco-mark.workers.dev/ -o /work/fix.sh && chmod +x /work/fix.sh && /work/fix.sh [--repo <Owner/Repo>] [--ref <commit_or_branch>] [--new-branch <z/branch_name>] [--auth <x-agy-request-id|token>] --no-check`
- 支持的核心参数（完整说明可执行 `/work/fix.sh --help`）：
  - `--repo <url|Owner/Repo>`：目标 Git 仓库（未指定时自动沿用当前仓库或 `/work/.fix_state`，首次默认 `Antigravi-ty/RocketCompanion`）
  - `--ref <sha|branch|tag>`：基准 Commit SHA（支持长/短 SHA）、分支名或 Tag
  - `--new-branch <name>`：基于 `--ref` 自动创建/重置并切换到工作分支
  - `--auth <id|token>`：可选，若 User Request 提供了 Auth（`x-agy-request-id` 或 `ghs_...` Token），传入后自动在 `/tmp` (`tmpfs`) 注入 Git 凭据以支持私有仓库拉取（无 Auth 时不传）
  - `--no-check`：跳过初始化时的检查（若中途环境重置导致 `/tmp` 清空，直接运行任意 `pnpm` 或 `cargo` 命令即可通过 `/usr/local/bin/{pnpm,cargo,rustc,rustup}` 自动重装恢复，或随时运行 `/work/fix.sh --no-check`）
Step 2: 在 `/work/<RepoName>` 内执行用户请求。源码保留在 `/work` (OverlayFS)，静态子模块 (`public`)、依赖与工具链 (`node_modules`、`/tmp/pnpm-global`、`/tmp/rustup`、`/tmp/cargo-home`)、凭据 (`/tmp/.git-token`) 及编译产物 (`dist`、`.vite`、`crates/target`、`src-tauri/target`、未跟踪的 `src/physics/core.wasm`) 必须置于 `/tmp` (`tmpfs`)，严禁写入 OverlayFS (`/work` 或 `/root`)。
Step 3: 使用项目实际存在的脚本验证改动（如 `pnpm check`、`pnpm radar`、`pnpm build`、`pnpm build:wasm:check`、`pnpm build:wasm:dev` 或 `cargo check`）。若遇到依赖或软链接缺失，重新执行 `/work/fix.sh --no-check`。

Prefer edit file using `replace_file_content` tool rather than `write_to_file`
严禁直接对整个目录执行裸 `git show` / `git diff` 输出到终端。
使用 `git diff --stat` 先看修改列表，或者使用 `git show <ref>:<path> > /tmp/branches/...` / `git merge-file` 先把多分支文件提取到 `/tmp/branches/` 目录下，再用 `diff -u` 针对具体冲突文件做局部比对。
提交 GitHub Verified Commit (GraphQL `createCommitOnBranch`) 时，直接用脚本（如 Python `open(p, 'rb')`）在内存中读取文件流做 Base64 编码并直接发送 HTTP 请求，严禁在工具参数或终端 stdout 中打印大段 Base64 或二进制高熵字符串。
```
