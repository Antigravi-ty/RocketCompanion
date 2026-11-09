import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export const ROOT_DIR: string = process.cwd();
export const SRC_DIR: string = path.join(ROOT_DIR, 'src');
export const SCRIPTS_DIR: string = path.join(ROOT_DIR, 'scripts');

export const SOFT_LINE_LIMIT = 550;
export const HARD_LINE_LIMIT = 600;
export const SOFT_BYTE_LIMIT = 16 * 1024;
export const HARD_BYTE_LIMIT = 22 * 1024;
export const MICRO_FRAGMENT_LINE_FLOOR = 65;
export const DELTA_LINE_WARNING = 140;

export const PIPELINE_MUTATION_PROP_LIMIT = 3;
export const CROSS_CONTROLLER_MUTATION_LIMIT = 5;
export const WIDE_WAIST_PORT_READ_LIMIT = 12;
export const PROXY_ACCESSOR_LIMIT = 8;
export const FILE_ANY_LIMIT = 5;

export const ALLOWED_LOCAL_BUFFER_NAMES: ReadonlySet<string> = new Set([
  'this',
  'window',
  'document',
  'console',
  'Math',
  'Object',
  'Array',
  'Number',
  'String',
  'Boolean',
  'Promise',
  'localStorage',
  'sessionStorage',
  'ctx',
  'mat',
  'mesh',
  'uniforms',
  'dst',
  'out',
  'target',
  'res',
  'result',
  'next',
  'patch',
  'draft',
  'style',
]);

export interface SubsystemCount {
  ts: number;
  js: number;
}

export interface TypeScriptCheckResult {
  ok: boolean;
  command: string;
  errors: string[];
}

export interface RadarScanResult {
  errors: string[];
  warnings: string[];
  tsCount: number;
  jsCount: number;
  subsystemStats: Map<string, SubsystemCount>;
  tsResult: TypeScriptCheckResult;
}

export function walkSourceFiles(dir: string, results: string[] = []): string[] {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === '.git' ||
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'scripts'
    ) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(fullPath, results);
    } else if (
      /\.(js|mjs|cjs|ts|tsx)$/.test(entry.name) &&
      entry.name !== 'core.js' &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

export function toPosixRel(absPath: string): string {
  return path.relative(ROOT_DIR, absPath).split(path.sep).join('/');
}

export function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

export function resolveImportPath(fromFile: string, importSpec: string): string | false | null {
  let baseTarget: string;
  if (importSpec.startsWith('@/')) {
    baseTarget = path.join(SRC_DIR, importSpec.slice(2));
  } else if (importSpec.startsWith('.')) {
    baseTarget = path.resolve(path.dirname(fromFile), importSpec);
  } else {
    return null;
  }

  const candidates = [
    baseTarget,
    `${baseTarget}.ts`,
    `${baseTarget}.tsx`,
    `${baseTarget}.js`,
    path.join(baseTarget, 'index.ts'),
    path.join(baseTarget, 'index.tsx'),
    path.join(baseTarget, 'index.js'),
  ];

  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return cand;
    }
  }
  return false;
}

export function kebabToPascalCase(kebab: string): string {
  return kebab
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function isGraphicsOrDomTarget(ident: string): boolean {
  const lower = ident.toLowerCase();
  return (
    lower.includes('mat') ||
    lower.includes('mesh') ||
    lower.includes('uniform') ||
    lower.includes('tex') ||
    lower.includes('ramp') ||
    lower.includes('geom') ||
    lower.includes('light') ||
    lower.includes('pass') ||
    lower.includes('scene') ||
    lower.includes('renderer') ||
    lower.includes('panner') ||
    lower.includes('gain') ||
    lower.includes('filter') ||
    lower.includes('node') ||
    lower.includes('canvas') ||
    lower === 'dom' ||
    lower.endsWith('element')
  );
}

export function expandRelativeGlobPattern(fromFileAbs: string, pattern: string): string[] {
  if (!pattern.startsWith('.')) return [];
  const fromDir = path.dirname(fromFileAbs);
  const braceMatch = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  const subPatterns = braceMatch
    ? braceMatch[2].split(',').map((opt) => `${braceMatch[1]}${opt.trim()}${braceMatch[3]}`)
    : [pattern];

  const results: string[] = [];
  for (const sub of subPatterns) {
    const targetDir = path.resolve(fromDir, path.posix.dirname(sub));
    const filePattern = path.posix.basename(sub);
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) continue;
    const regexStr =
      '^' +
      filePattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*') +
      '$';
    const fileRe = new RegExp(regexStr);
    for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
      if (entry.isFile() && fileRe.test(entry.name)) {
        const absMatch = path.join(targetDir, entry.name);
        let relSpec = path.relative(fromDir, absMatch).split(path.sep).join('/');
        if (!relSpec.startsWith('.')) relSpec = `./${relSpec}`;
        results.push(relSpec);
      }
    }
  }
  return results;
}

function resolveTscCommand(): string | null {
  const binName = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const localTsc = path.join(ROOT_DIR, 'node_modules', '.bin', binName);
  if (fs.existsSync(localTsc)) {
    return `"${localTsc}" --noEmit`;
  }
  try {
    const versionOut = execSync('tsc --version', {
      cwd: ROOT_DIR,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    if (/Version\s+5\./.test(versionOut)) {
      return 'tsc --noEmit';
    }
  } catch {
    // Fall through
  }
  return null;
}

export function runTypeScriptCheck(): TypeScriptCheckResult {
  const cmd = resolveTscCommand();
  if (!cmd) {
    return {
      ok: false,
      command: 'tsc --noEmit (missing local node_modules/.bin/tsc)',
      errors: [
        'Local TypeScript 5.x compiler not found in node_modules/.bin/tsc. Run "npm install -g pnpm --force && pnpm install" first.',
      ],
    };
  }
  try {
    execSync(cmd, {
      cwd: ROOT_DIR,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { ok: true, command: cmd, errors: [] };
  } catch (err: unknown) {
    const execErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = execErr.stdout ? String(execErr.stdout) : '';
    const stderr = execErr.stderr ? String(execErr.stderr) : '';
    const combined = `${stdout}\n${stderr}`.trim();
    const lines = combined
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return { ok: false, command: cmd, errors: lines };
  }
}
