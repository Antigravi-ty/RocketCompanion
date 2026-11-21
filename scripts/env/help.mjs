#!/usr/bin/env node
/**
 * scripts/env/help.mjs
 *
 * Concise reference for RocketCompanion's tmpfs-offloaded, self-healing dev/E2E environment.
 * Usage: pnpm run env:help  |  node scripts/env/help.mjs
 */

console.log(`=== RocketCompanion Environment & Self-Healing Help ===

1. Quick Commands
   pnpm run env:help             Show this help
   pnpm run env:check            Fast status check (OverlayFS size, tmpfs sentinel, WebGL2)
   pnpm run env:doctor           Full diagnostics (symlinks, public/, Chrome WebGL2, Rust)
   pnpm run env:setup            One-click setup / repair (pnpm, public/, node_modules, .rcreplay)
   pnpm run env:setup:rust       Same as env:setup + Rust/Cargo & Tauri C deps

2. Self-Healing & /tmp (tmpfs) Reset Recovery
   Large artifacts (node_modules, public/, .vite, dist, src-tauri/target, .rcreplay)
   live in /tmp/rc-cache via symlinks to keep OverlayFS <= 100 MB.

   - Silent auto-heal: Running any \`pnpm ...\` command auto-reinstalls pnpm into tmpfs
     and recreates base symlinks if /tmp was wiped by a container snapshot restore.
   - Full auto-restore (when node_modules, public/, or .rcreplay are missing):
       node scripts/env/doctor.mjs --auto-restore
       # or if pnpm is not installed yet:
       bash scripts/env/bootstrap.sh
   - After \`git reset --hard\` or \`git checkout -f\` (which replaces public/ symlink):
       node scripts/env/tmpfsGuard.mjs --sync-public

3. Verification Suites
   pnpm run check                Architecture radar + tsc --noEmit
   pnpm run test:multiplayer-suite
   pnpm run repro:dev-broadcast-v3
`);
