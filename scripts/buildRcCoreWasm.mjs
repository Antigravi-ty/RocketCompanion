#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const cacheRoot = process.env.RC_TMPFS_CACHE_DIR || '/tmp/rc-cache';

const cargoHome = process.env.CARGO_HOME || path.join(cacheRoot, 'cargo-home');
const rustupHome = process.env.RUSTUP_HOME || path.join(cacheRoot, 'rustup-home');
const targetDir = process.env.CARGO_TARGET_DIR || path.join(cacheRoot, 'cargo-target');
const profile = process.env.RC_WASM_PROFILE || 'dev-wasm';

const env = {
  ...process.env,
  CARGO_HOME: cargoHome,
  RUSTUP_HOME: rustupHome,
  CARGO_TARGET_DIR: targetDir,
  PATH: `${path.join(cargoHome, 'bin')}:${process.env.PATH || ''}`,
};

execFileSync(
  'cargo',
  [
    'build',
    '--manifest-path',
    path.join(rootDir, 'crates/Cargo.toml'),
    '-p',
    'rc_core_wasm',
    '--target',
    'wasm32-unknown-unknown',
    '--profile',
    profile,
  ],
  { stdio: 'inherit', env }
);

const profileDir = profile === 'release' ? 'release' : profile;
const builtWasm = path.join(targetDir, 'wasm32-unknown-unknown', profileDir, 'rc_core_wasm.wasm');
const outDir = path.join(rootDir, 'src', 'mvp1');
fs.mkdirSync(outDir, { recursive: true });
const outWasm = path.join(outDir, 'rc_core.wasm');
fs.copyFileSync(builtWasm, outWasm);
console.log(`[build:rc-core-wasm] Wrote ${outWasm} (${fs.statSync(outWasm).size} bytes)`);
