# RocketCompanion Environment & E2E Tooling (`scripts/env/`)

One-click setup, diagnostics, and preflight helpers for running `pnpm run check`, `pnpm run test:multiplayer-suite`, and Headless Chrome WebGL E2E suites (`pnpm run repro:dev-broadcast-v2`, `pnpm run repro:dev-broadcast-v3`, `pnpm run repro:dev-extra-routes`).

## Quick Commands

- **Check environment & Headless WebGL**:
  ```bash
  pnpm run env:doctor
  ```
- **One-click setup / repair** (installs `pnpm` if missing, initializes `public/` submodule, installs `node_modules`, generates synthetic 3v3 `.rcreplay` fixture, verifies SwiftShader WebGL):
  ```bash
  pnpm run env:setup
  # or before pnpm is installed:
  bash scripts/env/setup.sh
  ```
- **Include optional Rust toolchain** (needed for `src-tauri` `cargo check` / `pnpm run tauri:build`):
  ```bash
  bash scripts/env/setup.sh --with-rust
  ```
- **Generate 3v3 `.rcreplay` fixture manually**:
  ```bash
  node --experimental-strip-types scripts/env/generateReplayFixture.ts
  ```

## Why E2E previously failed with `Timeout waiting for Host boot` / `ENOTEMPTY`

1. **Uninitialized `public/` git submodule**: Without `git submodule update --init --recursive`, Vite serves the SPA HTML fallback for microkernel assets, causing `Verify Camera Microkernel Integrity` (`preflight.camera_microkernel`) to throw a SHA-256 mismatch and halt boot.
2. **SwiftShader WebGL works in headless containers**: Google Chrome with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` provides WebGL2 without a physical GPU.
3. **`ENOTEMPTY` masking real errors**: Synchronous `fs.rmSync(userDataDir)` immediately after `chromeProc.kill('SIGKILL')` threw `ENOTEMPTY` in `finally`, hiding the underlying failure. `reproPreflight.mjs` (`safeCleanupChrome`) fixes this.
4. **Missing `.rcreplay` fixture**: If no external `.rcreplay` file is present, `reproPreflight.mjs` / `setup.sh` generates a valid V2 3v3 binary `.rcreplay` fixture using `RCReplayBinaryEncoder`.
