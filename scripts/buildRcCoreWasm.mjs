import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const cratesDir = resolve(rootDir, 'crates');
const cacheRoot = process.env.RC_TMPFS_CACHE_DIR || '/tmp/rc-cache';

const env = {
  ...process.env,
  RUSTUP_HOME: process.env.RUSTUP_HOME || `${cacheRoot}/rustup-home`,
  CARGO_HOME: process.env.CARGO_HOME || `${cacheRoot}/cargo-home`,
  CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || `${cacheRoot}/cargo-target`,
  PATH: `${cacheRoot}/cargo-home/bin:${process.env.PATH || ''}`,
};

const profile = process.argv.includes('--release') ? 'release' : 'dev-wasm';

execFileSync(
  'cargo',
  ['build', '-p', 'rc_core_wasm', '--target', 'wasm32-unknown-unknown', '--profile', profile],
  { cwd: cratesDir, env, stdio: 'inherit' }
);

const srcWasm = resolve(env.CARGO_TARGET_DIR, 'wasm32-unknown-unknown', profile, 'rc_core_wasm.wasm');
const dstWasm = resolve(rootDir, 'src/mvp1/rc_core.wasm');
mkdirSync(dirname(dstWasm), { recursive: true });
copyFileSync(srcWasm, dstWasm);
console.log(`[rc_core] Copied WASM to ${dstWasm}`);
