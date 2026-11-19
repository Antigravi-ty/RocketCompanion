import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function resolveChromeBinary() {
  for (const candidate of DEFAULT_CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const resolved = execFileSync('which', [name], { encoding: 'utf8' }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {
      // Ignore
    }
  }
  return null;
}

export function isPublicSubmoduleReady(cwd = process.cwd()) {
  const publicDir = path.join(cwd, 'public');
  if (!fs.existsSync(publicDir)) return false;
  try {
    const entries = fs.readdirSync(publicDir);
    if (entries.length === 0) return false;
    // camera.wasm or wasm/ must exist inside public/
    const hasWasm =
      fs.existsSync(path.join(publicDir, 'camera.wasm')) ||
      fs.existsSync(path.join(publicDir, 'wasm')) ||
      entries.some((e) => e.endsWith('.wasm'));
    return hasWasm || entries.length > 2;
  } catch {
    return false;
  }
}

export function assertE2EEnvironmentReady(cwd = process.cwd()) {
  const missing = [];
  const chromeBin = resolveChromeBinary();
  if (!chromeBin) {
    missing.push('Headless Chrome/Chromium binary (set CHROME_BIN or install google-chrome)');
  }
  if (!fs.existsSync(path.join(cwd, 'node_modules'))) {
    missing.push('node_modules (dependencies not installed)');
  }
  if (!isPublicSubmoduleReady(cwd)) {
    missing.push('public/ git submodule (missing static/WASM assets such as camera.wasm)');
  }
  if (missing.length > 0) {
    throw new Error(
      [
        '[E2E Preflight] Environment is not ready:',
        ...missing.map((m) => `  - Missing: ${m}`),
        '',
        'Run the built-in bootstrap command to fix this automatically:',
        '  pnpm run env:setup',
        'Or run diagnostics first:',
        '  pnpm run env:check',
      ].join('\n')
    );
  }
  return { chromeBin };
}

export function buildHeadlessChromeArgs({
  url,
  userDataDir,
  windowSize = '1280,720',
  extraArgs = [],
}) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    // Critical in sandboxed/CI containers where HTTP_PROXY/HTTPS_PROXY is set:
    // prevent Chrome from routing 127.0.0.1 Vite traffic through the proxy.
    '--no-proxy-server',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${windowSize}`,
    ...extraArgs,
    url,
  ];
}

export function launchHeadlessChrome({
  url,
  userDataDirPrefix = 'rc-chrome-e2e',
  windowSize = '1280,720',
  extraArgs = [],
  cwd = process.cwd(),
}) {
  const { chromeBin } = assertE2EEnvironmentReady(cwd);
  const userDataDir = `/tmp/${userDataDirPrefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const args = buildHeadlessChromeArgs({ url, userDataDir, windowSize, extraArgs });
  const chromeProc = spawn(chromeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let cdpPort = null;
  const stderrTail = [];
  chromeProc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderrTail.push(text);
    if (stderrTail.length > 30) stderrTail.shift();
    const m = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) cdpPort = Number(m[1]);
  });

  return {
    chromeBin,
    chromeProc,
    userDataDir,
    getCdpPort: () => cdpPort,
    getStderrTail: () => stderrTail.join(''),
  };
}

export async function cleanupHeadlessChrome(chromeProc, userDataDir) {
  if (chromeProc) {
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      // Ignore
    }
  }
  await new Promise((r) => setTimeout(r, 150));
  if (userDataDir) {
    try {
      fs.rmSync(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } catch {
      // Best-effort cleanup; ignore ENOTEMPTY/EBUSY on tmpfs teardown
    }
  }
}
