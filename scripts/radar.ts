#!/usr/bin/env node
/**
 * scripts/radar.ts
 * Generation 3 Semantic Architecture & Boundary Radar for RocketCompanion.
 *
 * Runs in ~300ms via Node.js native type stripping (`node --experimental-strip-types scripts/radar.ts`):
 * 1. Zero-JS & Zero-Shim Guard: Forbids `.js`/`.mjs`/`.cjs` files under `src/` (except Emscripten `src/physics/core.js`), forbids relative `.js` import specifiers, and enforces inline `new Worker(new URL(..., import.meta.url))` bundling syntax.
 * 2. Unidirectional Layer, DAG & Zero Re-Export Guard: Enforces 0 circular dependencies, 0 broken relative imports, 0 engine->UI boundary leaks, 0 unreferenced orphan modules, and 0 cross-file value re-export facades (`export { ... } from '...'`).
 * 3. Anti-Gut-Sharing & In-Place Mutation Guard:
 *    - Pure Pipeline Zero-Mutation Guard (`[PIPELINE MUTATION VIOLATION]`): Blocks `*Pipeline.ts`, `*Math.ts`, and classless helper modules that mutate >3 distinct properties on passed-in state/domain objects.
 *    - Cross-Controller Gut-Sharing Guard (`[CROSS-CONTROLLER GUT-SHARING]` & `[WIDE-WAIST PORT VIOLATION]`): Blocks classes (`*SubController`, `*Controller`, `*Coordinator`, `*Session`, etc.) that mutate >5 properties or read >12 properties on external controllers, host ports, or state bags (including via local aliases `const ch = this.channel` or destructured `const { domain } = this.host`).
 * 4. Anti-Pass-Through Proxy Guard (`[PROXY BLOAT VIOLATION]`): Blocks classes/objects that define >8 pass-through `get xxx()` / `set xxx(v)` accessors (excluding zero-copy `Float32Array` view wrappers in `RocketSimStateViews.ts`).
 * 5. Bimodal Volume & Micro-Fragment Guard: Enforces 600-line / 16 KB soft waterline (`[WATERLINE ALERT]` / `[BYTE WATERLINE ALERT]`), 800-line / 22 KB hard ceiling (`[VOLUME OVERFLOW]` / `[BYTE VOLUME OVERFLOW]`), and <65-line single-reference logic fragment warning (`[OVER-FRAGMENTATION WARNING]`).
 * 6. Code Style, Terminology & Type Purity Guard: Enforces English-only & Zero-Emoji (`[NON-ENGLISH / EMOJI VIOLATION]`), neutral ball terminology forbidding `soccer`/`soccar` (`[TERMINOLOGY VIOLATION]`), and strict TypeScript boundary typing (`[UNTYPED ANY VIOLATION]` for boundary `any` or >5 `any` per file).
 * 7. UI Route & Floating Window Alignment + Repo Hygiene Guard: Enforces `menuRouteRegistry.tsx` `Layer*Recipe` purity, 1:1 `<PascalCaseId>FloatingWindow` naming without opaque abbreviations (`OB`), and single package manager lockfile hygiene.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT_DIR: string = process.cwd();
const SRC_DIR: string = path.join(ROOT_DIR, 'src');
const SCRIPTS_DIR: string = path.join(ROOT_DIR, 'scripts');

const SOFT_LINE_LIMIT = 600;
const HARD_LINE_LIMIT = 800;
const SOFT_BYTE_LIMIT = 16 * 1024; // 16 KB soft waterline
const HARD_BYTE_LIMIT = 22 * 1024; // 22 KB hard ceiling
const MICRO_FRAGMENT_LINE_FLOOR = 65;
const DELTA_LINE_WARNING = 140;

const PIPELINE_MUTATION_PROP_LIMIT = 3;
const CROSS_CONTROLLER_MUTATION_LIMIT = 5;
const WIDE_WAIST_PORT_READ_LIMIT = 12;
const PROXY_ACCESSOR_LIMIT = 8;
const FILE_ANY_LIMIT = 5;

const ALLOWED_LOCAL_BUFFER_NAMES: ReadonlySet<string> = new Set([
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

interface SubsystemCount {
  ts: number;
  js: number;
}

interface RadarScanResult {
  errors: string[];
  warnings: string[];
  tsCount: number;
  jsCount: number;
  subsystemStats: Map<string, SubsystemCount>;
}

function walkSourceFiles(dir: string, results: string[] = []): string[] {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
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

function toPosixRel(absPath: string): string {
  return path.relative(ROOT_DIR, absPath).split(path.sep).join('/');
}

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function resolveImportPath(fromFile: string, importSpec: string): string | false | null {
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

function kebabToPascalCase(kebab: string): string {
  return kebab
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function isGraphicsOrDomTarget(ident: string): boolean {
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

function checkLanguageAndEmoji(rel: string, content: string, errors: string[]): void {
  const cjkRegex = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/;
  const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
  const allowedTechnicalSymbols = /[±×÷→←↑↓↔↗↘↙↖⇒⇐⇔µαβγδθλμπσωΔΩ°✓✗✔✘⚠⚡]/g;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (cjkRegex.test(line)) {
      const sample = line.trim().slice(0, 80);
      errors.push(
        `[NON-ENGLISH / EMOJI VIOLATION] ${rel}:${i + 1} contains non-English CJK characters: "${sample}"`
      );
      break;
    }
    const sanitized = line.replace(allowedTechnicalSymbols, '');
    if (emojiRegex.test(sanitized)) {
      const sample = line.trim().slice(0, 80);
      errors.push(
        `[NON-ENGLISH / EMOJI VIOLATION] ${rel}:${i + 1} contains forbidden emoji character: "${sample}"`
      );
      break;
    }
  }
}

function checkValueReExports(rel: string, codeWithoutComments: string, errors: string[]): void {
  const reExportRegex = /\bexport\s+(type\s+)?(\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = reExportRegex.exec(codeWithoutComments)) !== null) {
    const isTypeExport = Boolean(match[1]);
    if (isTypeExport) continue;

    const clause = match[2];
    const fromSpec = match[3];
    if (clause === '*') {
      errors.push(
        `[RE-EXPORT FACADE VIOLATION] ${rel} re-exports wildcard values from "${fromSpec}". Import directly from the defining source module.`
      );
      continue;
    }

    const inner = clause.slice(1, -1);
    const specifiers = inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const valueSpecs = specifiers.filter((s) => !/^type\s+/.test(s));
    if (valueSpecs.length > 0) {
      errors.push(
        `[RE-EXPORT FACADE VIOLATION] ${rel} re-exports values { ${valueSpecs.slice(0, 4).join(', ')}${valueSpecs.length > 4 ? ', ...' : ''} } from "${fromSpec}". Import directly from the defining source module.`
      );
    }
  }
}

function checkAnyPurity(rel: string, codeWithoutComments: string, errors: string[]): void {
  const anyMatches =
    codeWithoutComments.match(/(?::\s*any\b|\bas\s+any\b|<any>|Record<[^,>]+,\s*any>)/g) || [];
  const boundaryAnyRegex =
    /\bexport\s+(?:async\s+)?function\s+\w+[^{]*:\s*any\b|\bexport\s+interface\s+\w+\s*\{[^}]*:\s*any\b/s;
  const hasBoundaryAny = boundaryAnyRegex.test(codeWithoutComments);

  if (anyMatches.length > FILE_ANY_LIMIT || hasBoundaryAny) {
    const reason =
      anyMatches.length > FILE_ANY_LIMIT
        ? `${anyMatches.length} untyped 'any' occurrences (limit: ${FILE_ANY_LIMIT})`
        : `untyped 'any' in exported module boundary signature/interface`;
    errors.push(
      `[UNTYPED ANY VIOLATION] ${rel} contains ${reason}. Declare explicit TypeScript interfaces across module boundaries.`
    );
  }
}

function checkProxyBloat(rel: string, codeWithoutComments: string, errors: string[]): void {
  if (rel.endsWith('RocketSimStateViews.ts')) return;

  const getterMatches =
    codeWithoutComments.match(
      /\bget\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*\(\s*\)[^{]*\{\s*return\s+(?:this|simulator|self)\.[a-zA-Z0-9_$.?]+\s*;\s*\}/g
    ) || [];
  const setterMatches =
    codeWithoutComments.match(
      /\bset\s+[a-zA-Z_$][a-zA-Z0-9_$]*\s*\([^)]*\)[^{]*\{\s*(?:this|simulator|self)\.[a-zA-Z0-9_$.]+(?:\([^)]*\)|\s*=\s*[^;]+);\s*\}/g
    ) || [];

  const totalProxies = getterMatches.length + setterMatches.length;
  if (totalProxies > PROXY_ACCESSOR_LIMIT) {
    errors.push(
      `[PROXY BLOAT VIOLATION] ${rel} defines ${totalProxies} pass-through getter/setter proxies (${getterMatches.length} getters, ${setterMatches.length} setters; limit: ${PROXY_ACCESSOR_LIMIT}). Expose narrow domain methods or sub-controller ports instead of wide-waist forwarding accessors.`
    );
  }
}

function checkAntiGutSharingAndMutations(
  rel: string,
  codeWithoutComments: string,
  errors: string[]
): void {
  if (rel.startsWith('src/ui-')) return;
  if (/(Types|Constants|Config)\.ts$/.test(rel)) return;

  const hasExportedClass = /\bexport\s+class\s+\w+/.test(codeWithoutComments);
  const isPipelineOrMath = /(Pipeline|Math)\.ts$/.test(rel);
  const isHelperNamed = /(Helper|Stepper|Runner)\.ts$/.test(rel);

  // 1A. Pure Pipeline / Math / Classless Module Zero-Mutation Guard
  if (isPipelineOrMath || isHelperNamed || !hasExportedClass) {
    // Identify locally allocated objects so we only flag mutations on external/passed-in objects
    const localAllocations = new Set<string>();
    const localAllocRegex =
      /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:new\s+|\{|\[|document\.|this\.|create|build|clone|make|Object\.create|Object\.assign\(\s*\{\s*\})/g;
    let allocMatch: RegExpExecArray | null;
    while ((allocMatch = localAllocRegex.exec(codeWithoutComments)) !== null) {
      localAllocations.add(allocMatch[1]);
    }

    const mutatedPropsByTarget = new Map<string, Set<string>>();
    const mutationRegex =
      /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=(?!=)|[+\-*/%&|^]=|\+\+|--)/g;
    let mutMatch: RegExpExecArray | null;
    while ((mutMatch = mutationRegex.exec(codeWithoutComments)) !== null) {
      const target = mutMatch[1];
      const prop = mutMatch[2];
      if (ALLOWED_LOCAL_BUFFER_NAMES.has(target)) continue;
      if (localAllocations.has(target)) continue;
      if (isGraphicsOrDomTarget(target)) continue;

      if (!mutatedPropsByTarget.has(target)) {
        mutatedPropsByTarget.set(target, new Set());
      }
      mutatedPropsByTarget.get(target)!.add(prop);
    }

    for (const [target, props] of mutatedPropsByTarget.entries()) {
      if (props.size > PIPELINE_MUTATION_PROP_LIMIT) {
        const sampleProps = [...props].sort().slice(0, 6).join(', ');
        errors.push(
          `[PIPELINE MUTATION VIOLATION] ${rel} mutates ${props.size} properties in-place on external object '${target}' (${sampleProps}${props.size > 6 ? ', ...' : ''}; limit: ${PIPELINE_MUTATION_PROP_LIMIT}). Pure pipelines must return a new state/patch object or encapsulate state transitions inside an owning SubController.`
        );
      }
    }
  }

  // 1B. SubController / Class Cross-Object Gut-Sharing & Wide-Waist Port Guard
  if (hasExportedClass && !isPipelineOrMath) {
    const aliasMap = new Map<string, string>();

    // Track `const ch = this.channel;` or `const d = this.host.domain;`
    const directAliasRegex =
      /\b(?:const|let)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*this\.([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)?)\s*;/g;
    let aliasMatch: RegExpExecArray | null;
    while ((aliasMatch = directAliasRegex.exec(codeWithoutComments)) !== null) {
      aliasMap.set(aliasMatch[1], `this.${aliasMatch[2]}`);
    }

    // Track destructured `const { domain, roster } = this.host;` or `const { sessionState } = this;`
    const destructAliasRegex =
      /\b(?:const|let)\s*\{([^}]+)\}\s*=\s*this(?:\.([a-zA-Z_$][a-zA-Z0-9_$]*))?\s*;/g;
    let destructMatch: RegExpExecArray | null;
    while ((destructMatch = destructAliasRegex.exec(codeWithoutComments)) !== null) {
      const prefix = destructMatch[2] ? `this.${destructMatch[2]}` : 'this';
      for (const rawItem of destructMatch[1].split(',')) {
        const parts = rawItem.split(':').map((s) => s.trim());
        const propName = parts[0];
        const localName = parts[parts.length - 1];
        if (propName && localName && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(localName)) {
          aliasMap.set(localName, `${prefix}.${propName}`);
        }
      }
    }

    const isExternalControllerOrStateTarget = (target: string): boolean => {
      const lower = target.toLowerCase();
      if (
        lower.startsWith('this._scratch') ||
        lower.startsWith('this.currentevent') ||
        lower.startsWith('this.controls') ||
        lower.startsWith('this.settings') ||
        lower.startsWith('this.primarypose') ||
        lower.startsWith('this._originalmethods')
      ) {
        return false;
      }
      return (
        lower.includes('ctrl') ||
        lower.includes('controller') ||
        lower.includes('coordinator') ||
        lower.includes('domain') ||
        lower.includes('channel') ||
        lower.includes('host') ||
        lower.includes('runtime') ||
        lower.includes('reconciler') ||
        lower.includes('sessionstate') ||
        lower.includes('directorcamerastate') ||
        lower.includes('mode') ||
        lower.includes('simulator') ||
        lower.includes('metrics') ||
        lower.includes('sampler') ||
        lower.includes('goalandtouch') ||
        lower.includes('directorpreview') ||
        lower.includes('latch')
      );
    };

    const classMutatedByTarget = new Map<string, Set<string>>();

    // Direct `this.sub.prop = ...` or `this.host.sub.prop = ...`
    const memberMutRegex =
      /\b(this\.[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)?)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=(?!=)|[+\-*/%&|^]=|\+\+|--)/g;
    let mMut: RegExpExecArray | null;
    while ((mMut = memberMutRegex.exec(codeWithoutComments)) !== null) {
      const target = mMut[1];
      const prop = mMut[2];
      if (isGraphicsOrDomTarget(target)) continue;
      if (!isExternalControllerOrStateTarget(target)) continue;
      if (!classMutatedByTarget.has(target)) {
        classMutatedByTarget.set(target, new Set());
      }
      classMutatedByTarget.get(target)!.add(prop);
    }

    // Identifier `ident.prop = ...` (either method parameter or alias of `this.sub`, excluding `this.ident.prop` already matched above)
    const identMutRegex =
      /(?<!\.)\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=(?!=)|[+\-*/%&|^]=|\+\+|--)/g;
    let iMut: RegExpExecArray | null;
    while ((iMut = identMutRegex.exec(codeWithoutComments)) !== null) {
      const ident = iMut[1];
      const prop = iMut[2];
      if (ident === 'this' || ALLOWED_LOCAL_BUFFER_NAMES.has(ident)) continue;
      const resolvedTarget = aliasMap.get(ident) || ident;
      if (isGraphicsOrDomTarget(resolvedTarget)) continue;
      if (!isExternalControllerOrStateTarget(resolvedTarget)) continue;
      if (!classMutatedByTarget.has(resolvedTarget)) {
        classMutatedByTarget.set(resolvedTarget, new Set());
      }
      classMutatedByTarget.get(resolvedTarget)!.add(prop);
    }

    for (const [target, props] of classMutatedByTarget.entries()) {
      if (props.size > CROSS_CONTROLLER_MUTATION_LIMIT) {
        const sampleProps = [...props].sort().slice(0, 6).join(', ');
        errors.push(
          `[CROSS-CONTROLLER GUT-SHARING] ${rel} directly mutates ${props.size} properties on '${target}' (${sampleProps}${props.size > 6 ? ', ...' : ''}; limit: ${CROSS_CONTROLLER_MUTATION_LIMIT}). Encapsulate state mutations inside the owning class via narrow domain methods.`
        );
      }
    }

    // Wide-Waist Port Access Guard (>12 properties read on an external host/controller/domain port)
    const classReadByTarget = new Map<string, Set<string>>();
    const isPortTarget = (target: string): boolean => {
      const lower = target.toLowerCase();
      return (
        lower === 'this.host' ||
        lower === 'this.runtime' ||
        lower === 'this.channel' ||
        lower === 'this.domain' ||
        lower.startsWith('this.host.') ||
        lower.startsWith('this.deps.') ||
        lower.endsWith('ctrl') ||
        lower.endsWith('controller')
      );
    };

    const memberReadRegex =
      /\b(this\.[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)?)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
    let mRead: RegExpExecArray | null;
    while ((mRead = memberReadRegex.exec(codeWithoutComments)) !== null) {
      const target = mRead[1];
      const prop = mRead[2];
      if (!isPortTarget(target)) continue;
      if (!classReadByTarget.has(target)) {
        classReadByTarget.set(target, new Set());
      }
      classReadByTarget.get(target)!.add(prop);
    }

    const identReadRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
    let iRead: RegExpExecArray | null;
    while ((iRead = identReadRegex.exec(codeWithoutComments)) !== null) {
      const ident = iRead[1];
      const prop = iRead[2];
      if (ident === 'this') continue;
      const resolvedTarget = aliasMap.get(ident) || ident;
      if (!isPortTarget(resolvedTarget)) continue;
      if (!classReadByTarget.has(resolvedTarget)) {
        classReadByTarget.set(resolvedTarget, new Set());
      }
      classReadByTarget.get(resolvedTarget)!.add(prop);
    }

    for (const [target, props] of classReadByTarget.entries()) {
      if (props.size > WIDE_WAIST_PORT_READ_LIMIT) {
        const sampleProps = [...props].sort().slice(0, 6).join(', ');
        errors.push(
          `[WIDE-WAIST PORT VIOLATION] ${rel} accesses ${props.size} distinct properties on external port '${target}' (${sampleProps}${props.size > 6 ? ', ...' : ''}; limit: ${WIDE_WAIST_PORT_READ_LIMIT}). Narrow the port contract or move cohesive domain logic into the owning controller.`
        );
      }
    }
  }
}

function expandRelativeGlobPattern(fromFileAbs: string, pattern: string): string[] {
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

function checkUiNamingAndRouteAlignment(errors: string[]): void {
  // 1. Route Registry Purity Guard: all route components in menuRouteRegistry.tsx must come from src/ui-core/recipes/Layer*Recipe.tsx
  const routeRegistryPath = path.join(SRC_DIR, 'ui-system/core/menuRouteRegistry.tsx');
  if (fs.existsSync(routeRegistryPath)) {
    const content = stripComments(fs.readFileSync(routeRegistryPath, 'utf8'));
    const importRegex = /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(content)) !== null) {
      const importedNames = m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const fromSpec = m[2];
      for (const rawName of importedNames) {
        if (rawName.startsWith('type ')) continue;
        const localName = rawName.split(/\s+as\s+/).pop()!.trim();
        // Check if used as JSX component <ComponentName ...
        if (new RegExp(`<${localName}\\b`).test(content) && localName !== 'LogOut') {
          const isLayerRecipeImport =
            /ui-core\/recipes\/Layer\d+\w+Recipe$/.test(fromSpec) &&
            /^Layer\d+\w+Recipe$/.test(localName);
          if (!isLayerRecipeImport) {
            errors.push(
              `[UI ROUTE ALIGNMENT VIOLATION] src/ui-system/core/menuRouteRegistry.tsx mounts non-recipe route component <${localName}> from "${fromSpec}". All menu route page components must reside in src/ui-core/recipes/Layer*Recipe.tsx.`
            );
          }
        }
      }
    }
  }

  // 2. Floating Window 1:1 Mapping & No-Opaque-Abbreviation Guard
  const presetFiles = [
    path.join(SRC_DIR, 'ui-core/stores/floatingPresets.ts'),
    path.join(SRC_DIR, 'ui-core/stores/devFloatingPresets.ts'),
  ];
  const registryPath = path.join(SRC_DIR, 'ui-core/panels/floatingWindowRegistry.tsx');
  const registryContent = fs.existsSync(registryPath)
    ? stripComments(fs.readFileSync(registryPath, 'utf8'))
    : '';
  const usesGlobAutoDiscovery =
    /\b(?:import\.meta\.glob|importMetaGlob|getDiscoveredFloatingSurfaces)\b/.test(registryContent);

  const presetBlockRegex = /export\s+const\s+\w+_PRESET\s*:\s*PresetConfig\s*=\s*\{([\s\S]*?)\n\};/g;
  for (const presetFile of presetFiles) {
    if (!fs.existsSync(presetFile)) continue;
    const rel = toPosixRel(presetFile);
    const content = stripComments(fs.readFileSync(presetFile, 'utf8'));
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = presetBlockRegex.exec(content)) !== null) {
      const body = blockMatch[1];
      const idMatch = body.match(/\bid\s*:\s*['"]([^'"]+)['"]/);
      const compMatch = body.match(/\bcomponent\s*:\s*['"]([^'"]+)['"]/);
      const sourceMatch = body.match(/\bsourcePath\s*:\s*['"]([^'"]+)['"]/);
      if (!idMatch) continue;

      const id = idMatch[1];
      const component = compMatch?.[1] || '';
      const sourcePath = sourceMatch?.[1] || '';
      const expectedComponent = `${kebabToPascalCase(id)}FloatingWindow`;

      if (/(?:^|-)ob(?:-|$)/i.test(id) || /OBFloatingWindow/.test(component)) {
        errors.push(
          `[UI NAMING VIOLATION] ${rel} preset '${id}' (${component}) uses unexpanded abbreviation 'OB'. Expand to full semantic name (e.g., 'event-stream-observer' / 'EventStreamObserverFloatingWindow').`
        );
      }

      if (component !== expectedComponent) {
        errors.push(
          `[UI NAMING VIOLATION] ${rel} preset '${id}' maps to component '${component}', expected strict 1:1 PascalCase '${expectedComponent}'.`
        );
      }

      if (!sourcePath.endsWith(`/${expectedComponent}.tsx`)) {
        errors.push(
          `[UI NAMING VIOLATION] ${rel} preset '${id}' has sourcePath '${sourcePath}', expected path ending with '/${expectedComponent}.tsx'.`
        );
      }

      if (usesGlobAutoDiscovery) {
        const absSourcePath = sourcePath.startsWith('src/')
          ? path.join(ROOT_DIR, sourcePath)
          : path.join(SRC_DIR, 'ui-core', sourcePath);
        if (!fs.existsSync(absSourcePath)) {
          errors.push(
            `[UI NAMING VIOLATION] ${rel} preset '${id}' points to missing floating window file '${sourcePath}'.`
          );
        } else {
          const winContent = stripComments(fs.readFileSync(absSourcePath, 'utf8'));
          const metaBlockMatch = winContent.match(
            /\bexport\s+const\s+SURFACE_META\b[\s\S]*?\bid\s*:\s*['"]([^'"]+)['"]/
          );
          if (!metaBlockMatch || metaBlockMatch[1] !== id) {
            errors.push(
              `[UI NAMING VIOLATION] ${sourcePath} must export SURFACE_META with id '${id}' (found '${metaBlockMatch?.[1] || 'missing'}') to match 1:1 filename '${expectedComponent}.tsx'.`
            );
          }
        }
      } else if (registryContent && !registryContent.includes(`<${expectedComponent}`)) {
        errors.push(
          `[UI NAMING VIOLATION] src/ui-core/panels/floatingWindowRegistry.tsx does not render expected 1:1 component <${expectedComponent}> for preset '${id}'.`
        );
      }
    }
  }
}

function runRadarChecks(allFiles: string[]): RadarScanResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const importGraph = new Map<string, string[]>();
  const incomingRefCounts = new Map<string, number>();
  const subsystemStats = new Map<string, SubsystemCount>();

  let jsCount = 0;
  let tsCount = 0;

  for (const file of allFiles) {
    incomingRefCounts.set(toPosixRel(file), 0);
  }

  // Also scan scripts/ for English-only & Zero-Emoji compliance
  const scriptFiles = walkSourceFiles(SCRIPTS_DIR);
  for (const sFile of scriptFiles) {
    const sRel = toPosixRel(sFile);
    if (sRel === 'scripts/radar.ts') continue;
    const sContent = fs.readFileSync(sFile, 'utf8');
    checkLanguageAndEmoji(sRel, sContent, errors);
  }

  for (const file of allFiles) {
    const rel = toPosixRel(file);
    const isJs = /\.(js|mjs|cjs)$/.test(rel);
    if (isJs) {
      jsCount++;
      errors.push(
        `[ZERO-JS VIOLATION] ${rel} is a JavaScript file. All modules under src/ (except src/physics/core.js) must be written in TypeScript (.ts / .tsx).`
      );
    } else {
      tsCount++;
    }

    const parts = rel.split('/');
    const subsystem = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    if (!subsystemStats.has(subsystem)) {
      subsystemStats.set(subsystem, { ts: 0, js: 0 });
    }
    const stat = subsystemStats.get(subsystem)!;
    if (isJs) stat.js++;
    else stat.ts++;

    const content = fs.readFileSync(file, 'utf8');
    const codeWithoutComments = stripComments(content);
    const lineCount = content.split('\n').length;

    // Upgrade 4: English-Only & Zero-Emoji Guard + No-Soccer/No-Soccar Guard + Zero Re-Export Guard
    checkLanguageAndEmoji(rel, content, errors);

    const soccarMatch = content.match(/\b\w*socc[ae]r\w*\b/i);
    if (soccarMatch) {
      errors.push(
        `[TERMINOLOGY VIOLATION] ${rel} contains forbidden term "${soccarMatch[0]}". Never use "soccer" or "soccar"; use neutral "ball" / "carball" / "standard" terminology instead.`
      );
    }

    if (/broker\.emqx\.io/i.test(content)) {
      errors.push(
        `[HARDCODED ENDPOINT VIOLATION] ${rel} hardcodes real public broker hostname "broker.emqx.io". Use empty default or fictional placeholder "wss://relay.carball.dev".`
      );
    }

    if (/RocketCompanion_PrivateProfile|rc_7e2a4d/i.test(content)) {
      errors.push(
        `[PRIVATE PROFILE LEAK VIOLATION] ${rel} contains private profile repository name or topic namespace literal.`
      );
    }

    // Upgrade 3: Dual-Cap Bimodal Volume Waterline Guard (600L/16KB soft, 800L/22KB hard)
    const byteSize = Buffer.byteLength(content, 'utf8');
    const kbFormatted = (byteSize / 1024).toFixed(1);
    if (lineCount > HARD_LINE_LIMIT) {
      errors.push(
        `[VOLUME OVERFLOW] ${rel} has ${lineCount} lines (${kbFormatted} KB; exceeds hard ceiling of ${HARD_LINE_LIMIT} lines). Extract a pure narrow-waist pipeline or stateful SubController.`
      );
    } else if (lineCount > SOFT_LINE_LIMIT) {
      warnings.push(
        `[WATERLINE ALERT] ${rel} is at ${lineCount} lines (${kbFormatted} KB; exceeds soft limit of ${SOFT_LINE_LIMIT} lines, approaching ${HARD_LINE_LIMIT}). Avoid adding new state here; encapsulate new features in a SubController.ts.`
      );
    }

    if (byteSize > HARD_BYTE_LIMIT) {
      if (rel.startsWith('src/ui-core/')) {
        warnings.push(
          `[BYTE WATERLINE ALERT] ${rel} is ${kbFormatted} KB (${byteSize} bytes, ${lineCount} lines; exceeds ${(HARD_BYTE_LIMIT / 1024).toFixed(0)} KB ceiling, tracked under UI Phase 1 decomposition).`
        );
      } else {
        errors.push(
          `[BYTE VOLUME OVERFLOW] ${rel} is ${kbFormatted} KB (${byteSize} bytes, ${lineCount} lines; exceeds hard ceiling of ${(HARD_BYTE_LIMIT / 1024).toFixed(0)} KB). Decompose into focused vertical modules.`
        );
      }
    } else if (byteSize > SOFT_BYTE_LIMIT) {
      warnings.push(
        `[BYTE WATERLINE ALERT] ${rel} is at ${kbFormatted} KB (${byteSize} bytes, ${lineCount} lines; exceeds soft limit of ${(SOFT_BYTE_LIMIT / 1024).toFixed(0)} KB, approaching ${(HARD_BYTE_LIMIT / 1024).toFixed(0)} KB).`
      );
    }

    checkValueReExports(rel, codeWithoutComments, errors);

    // Upgrade 5: TypeScript Type Purity Guard (Anti-any Boundary Guard)
    checkAnyPurity(rel, codeWithoutComments, errors);

    // Upgrade 2: Anti-Pass-Through Proxy Guard
    checkProxyBloat(rel, codeWithoutComments, errors);

    // Upgrade 1: Anti-Gut-Sharing & In-Place Mutation Guard
    checkAntiGutSharingAndMutations(rel, codeWithoutComments, errors);

    // Extract static imports, dynamic imports, and Worker URL references
    const importRegex =
      /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]|new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
    const deps: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const spec = match[1] || match[2];
      if (!spec.startsWith('.') && !spec.startsWith('@/')) continue;

      if (spec.endsWith('.js') && !spec.endsWith('/core.js') && spec !== './core.js') {
        errors.push(
          `[ZERO-SHIM VIOLATION] ${rel} imports "${spec}" with a legacy .js extension. Use explicit .ts/.tsx or extensionless specifier.`
        );
      }

      const resolved = resolveImportPath(file, spec);
      if (resolved === false) {
        errors.push(`[BROKEN IMPORT] ${rel} imports unresolvable path "${spec}"`);
      } else if (resolved) {
        const targetRel = toPosixRel(resolved);
        deps.push(targetRel);
        incomingRefCounts.set(targetRel, (incomingRefCounts.get(targetRel) || 0) + 1);

        const isEngineFile =
          rel !== 'src/main.ts' &&
          !rel.startsWith('src/ui-system/') &&
          !rel.startsWith('src/ui-core/');
        if (isEngineFile) {
          const prefixBeforeFrom = content.slice(Math.max(0, match.index - 400), match.index);
          const lastImportIdx = prefixBeforeFrom.lastIndexOf('import');
          const importClause = lastImportIdx >= 0 ? prefixBeforeFrom.slice(lastImportIdx) : '';
          const isTypeOnlyImport =
            /^import\s+type\b/.test(importClause) ||
            (() => {
              const braceMatch = importClause.match(/^import\s*\{([^}]+)\}\s*$/);
              if (!braceMatch) return false;
              const items = braceMatch[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              return items.length > 0 && items.every((item) => /^type\s+\w/.test(item));
            })();
          const isAllowedGameStoreTypeImport =
            rel.startsWith('src/game/') &&
            targetRel.startsWith('src/ui-core/stores/') &&
            isTypeOnlyImport;

          if (targetRel.startsWith('src/ui-system/')) {
            errors.push(
              `[BOUNDARY VIOLATION] Engine module ${rel} directly imports UI presentation module ${targetRel}. Use src/game/runtimeUiPort instead.`
            );
          } else if (
            targetRel.startsWith('src/ui-core/') &&
            !targetRel.startsWith('src/ui-core/config/') &&
            !isAllowedGameStoreTypeImport
          ) {
            errors.push(
              `[BOUNDARY VIOLATION] Engine module ${rel} directly imports non-config UI module ${targetRel}. Route through src/game/runtimeUiPort (or use import type for src/ui-core/stores/ in src/game/).`
            );
          }
        }

        if (
          rel.startsWith('src/network/transport/') &&
          !targetRel.startsWith('src/network/') &&
          !targetRel.startsWith('src/ui-core/config/')
        ) {
          errors.push(
            `[TRANSPORT ISOLATION VIOLATION] Transport module ${rel} imports external module ${targetRel}. src/network/transport/ must remain self-contained within src/network/ or pure src/ui-core/config/.`
          );
        }
      }
    }

    // Expand Vite import.meta.glob / importMetaGlob patterns into the reference graph
    const globRegex =
      /\b(?:import\.meta\.glob|importMetaGlob)\s*(?:<[\s\S]*?>)?\s*\(\s*['"]([^'"]+)['"]/g;
    let globMatch: RegExpExecArray | null;
    while ((globMatch = globRegex.exec(content)) !== null) {
      const pattern = globMatch[1];
      for (const expanded of expandRelativeGlobPattern(file, pattern)) {
        const resolved = resolveImportPath(file, expanded);
        if (resolved) {
          const targetRel = toPosixRel(resolved);
          deps.push(targetRel);
          incomingRefCounts.set(targetRel, (incomingRefCounts.get(targetRel) || 0) + 1);
        }
      }
    }

    importGraph.set(rel, deps);

    // WebWorker Bundle Guard
    const workerCallRegex = /new\s+Worker\s*\(\s*([^,)]+)/g;
    let workerMatch: RegExpExecArray | null;
    while ((workerMatch = workerCallRegex.exec(content)) !== null) {
      const argExpr = workerMatch[1].trim();
      const isInlineNewUrl = /^new\s+URL\s*\(/.test(argExpr);
      const isBlobUrl = argExpr === 'url' && content.includes('URL.createObjectURL');
      if (!isInlineNewUrl && !isBlobUrl) {
        errors.push(
          `[WORKER BUNDLE VIOLATION] ${rel} instantiates new Worker(${argExpr}) via a detached variable. Inline new Worker(new URL('./...', import.meta.url), { type: 'module' }) so Vite bundles the worker for production.`
        );
      }
    }
  }

  // Orphan Module Guard + Upgrade 3: Micro-Fragment Guard (<65 lines with only 1 incoming reference)
  const ENTRYPOINTS = new Set(['src/main.ts', 'src/physics/core.js']);
  for (const file of allFiles) {
    const rel = toPosixRel(file);
    if (ENTRYPOINTS.has(rel)) continue;
    const refCount = incomingRefCounts.get(rel) || 0;
    if (refCount === 0) {
      errors.push(
        `[ORPHAN MODULE] ${rel} has 0 incoming references across src/. Remove dead file or wire it into its owning subsystem.`
      );
    } else if (refCount === 1) {
      const content = fs.readFileSync(file, 'utf8');
      const lineCount = content.split('\n').length;
      const isTypeOrConfigOnly =
        /(Types|Constants|Config|Tokens|Defaults|Presets|Schema)\.(ts|tsx)$/.test(rel) ||
        rel.includes('/config/') ||
        rel.includes('/tokens/');
      if (lineCount < MICRO_FRAGMENT_LINE_FLOOR && !isTypeOrConfigOnly) {
        warnings.push(
          `[OVER-FRAGMENTATION WARNING] ${rel} is only ${lineCount} lines (<${MICRO_FRAGMENT_LINE_FLOOR}) and has only 1 incoming reference. Consider inlining into its sole caller or merging into a cohesive module.`
        );
      }
    }
  }

  // Upgrade 6: UI Component Naming & Route Alignment Guard
  checkUiNamingAndRouteAlignment(errors);

  // Circular Dependency Detection (DFS)
  const visitState = new Map<string, number>();
  const cycles: string[][] = [];

  function dfs(node: string, stack: string[]): void {
    visitState.set(node, 1);
    const neighbors = importGraph.get(node) || [];
    for (const next of neighbors) {
      if (!importGraph.has(next)) continue;
      const state = visitState.get(next) || 0;
      if (state === 1) {
        const idx = stack.indexOf(next);
        cycles.push([...stack.slice(idx), next]);
      } else if (state === 0) {
        dfs(next, [...stack, next]);
      }
    }
    visitState.set(node, 2);
  }

  for (const node of importGraph.keys()) {
    if ((visitState.get(node) || 0) === 0) {
      dfs(node, [node]);
    }
  }

  for (const cycle of cycles) {
    errors.push(`[CIRCULAR DEPENDENCY] ${cycle.join(' -> ')}`);
  }

  // Upgrade 7: Root Config, Single Lockfile & WASM Declaration Hygiene Guard
  const forbiddenLegacyFiles = [
    'tsconfig.engine-check.json',
    'vite.config.js',
    'scripts/radar.mjs',
  ];
  for (const legacyRel of forbiddenLegacyFiles) {
    if (fs.existsSync(path.join(ROOT_DIR, legacyRel))) {
      errors.push(
        `[LEGACY CONFIG VIOLATION] ${legacyRel} must be removed in the Pure-TS architecture.`
      );
    }
  }

  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].filter((lf) =>
    fs.existsSync(path.join(ROOT_DIR, lf))
  );
  if (lockfiles.length > 1) {
    errors.push(
      `[DUPLICATE LOCKFILE VIOLATION] Multiple package manager lockfiles detected in repository root: ${lockfiles.join(', ')}. Keep a single canonical lockfile.`
    );
  }

  const coreJsPath = path.join(SRC_DIR, 'physics/core.js');
  const coreDtsPath = path.join(SRC_DIR, 'physics/core.d.ts');
  if (!fs.existsSync(coreDtsPath)) {
    errors.push(
      '[WASM TYPING VIOLATION] src/physics/core.d.ts is missing. Ambient TypeScript declarations for core.js are required.'
    );
  } else if (fs.existsSync(coreJsPath)) {
    const coreJsContent = fs.readFileSync(coreJsPath, 'utf8');
    const coreDtsContent = fs.readFileSync(coreDtsPath, 'utf8');

    const jsExportSet = new Set<string>();
    const jsExportRegex = /Module\[['"](_physics_[a-zA-Z0-9_]+)['"]\]\s*=/g;
    let jsMatch: RegExpExecArray | null;
    while ((jsMatch = jsExportRegex.exec(coreJsContent)) !== null) {
      jsExportSet.add(jsMatch[1]);
    }

    const dtsExportSet = new Set<string>();
    const dtsExportRegex = /^\s*(_physics_[a-zA-Z0-9_]+)\??\s*\(/gm;
    let dtsMatch: RegExpExecArray | null;
    while ((dtsMatch = dtsExportRegex.exec(coreDtsContent)) !== null) {
      dtsExportSet.add(dtsMatch[1]);
    }

    const missingInDts = [...jsExportSet].filter((fn) => !dtsExportSet.has(fn));
    const missingInJs = [...dtsExportSet].filter((fn) => !jsExportSet.has(fn));
    if (missingInDts.length > 0) {
      errors.push(
        `[WASM BRIDGE PARITY] Exported in src/physics/core.js but missing in src/physics/core.d.ts: ${missingInDts.join(', ')}`
      );
    }
    if (missingInJs.length > 0) {
      errors.push(
        `[WASM BRIDGE PARITY] Declared in src/physics/core.d.ts but not exported by src/physics/core.js: ${missingInJs.join(', ')}`
      );
    }
  }

  try {
    const tsconfigRaw = fs.readFileSync(path.join(ROOT_DIR, 'tsconfig.json'), 'utf8');
    if (/"allowJs"\s*:\s*true/.test(tsconfigRaw)) {
      errors.push(
        '[TSCONFIG VIOLATION] tsconfig.json must keep "allowJs": false now that 100% of source files are TypeScript and core.d.ts is present.'
      );
    }
  } catch {
    errors.push('[TSCONFIG VIOLATION] Unable to read tsconfig.json.');
  }

  // Git Diff Growth Delta Check
  try {
    const diffOut = execSync('git diff --numstat HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of diffOut.trim().split('\n')) {
      if (!line) continue;
      const [addedStr, deletedStr, fileRel] = line.split(/\s+/);
      const added = parseInt(addedStr, 10);
      const deleted = parseInt(deletedStr, 10);
      if (!Number.isNaN(added) && !Number.isNaN(deleted)) {
        const netGrowth = added - deleted;
        if (netGrowth >= DELTA_LINE_WARNING && fileRel.startsWith('src/')) {
          warnings.push(
            `[GROWTH DELTA] ${fileRel} grew by +${netGrowth} net lines in working tree. Verify if the new logic belongs in a dedicated SubController.ts.`
          );
        }
      }
    }
  } catch {
    // Ignore if git diff is unavailable
  }

  return { errors, warnings, tsCount, jsCount, subsystemStats };
}

function main(): void {
  const startTime = Date.now();
  const allFiles = walkSourceFiles(SRC_DIR);
  const result = runRadarChecks(allFiles);
  const elapsedMs = Date.now() - startTime;

  const totalFiles = result.tsCount + result.jsCount;
  const tsPercent = totalFiles > 0 ? ((result.tsCount / totalFiles) * 100).toFixed(1) : '0.0';

  console.log('======================================================================');
  console.log(` ROCKET COMPANION GEN-3 SEMANTIC ARCHITECTURE RADAR (${elapsedMs}ms)`);
  console.log('======================================================================');
  console.log(
    ` TypeScript Coverage : ${result.tsCount}/${totalFiles} files (${tsPercent}% TS | ${result.jsCount} Engine JS remaining)`
  );
  console.log(
    ` Volume Waterline    : Soft=${SOFT_LINE_LIMIT}L/${(SOFT_BYTE_LIMIT / 1024).toFixed(0)}KB | Hard=${HARD_LINE_LIMIT}L/${(HARD_BYTE_LIMIT / 1024).toFixed(0)}KB | MicroFloor=${MICRO_FRAGMENT_LINE_FLOOR}L`
  );
  console.log(
    ` Semantic Contracts  : PipelineMut<=${PIPELINE_MUTATION_PROP_LIMIT} | CrossCtrlMut<=${CROSS_CONTROLLER_MUTATION_LIMIT} | PortRead<=${WIDE_WAIST_PORT_READ_LIMIT} | Proxy<=${PROXY_ACCESSOR_LIMIT} | Any<=${FILE_ANY_LIMIT}`
  );

  const engineSubsystems = [...result.subsystemStats.entries()]
    .filter(([k]) => !k.startsWith('src/ui-'))
    .sort((a, b) => a[0].localeCompare(b[0]));

  const subsystemSummary = engineSubsystems
    .map(([k, v]) => `${k.replace('src/', '')}(${v.ts}ts)`)
    .join(', ');
  console.log(` Engine Subsystems   : ${subsystemSummary}`);
  console.log('----------------------------------------------------------------------');

  if (result.warnings.length > 0) {
    console.log(` WARNINGS (${result.warnings.length}):`);
    for (const w of result.warnings) {
      console.log(`  ! ${w}`);
    }
    console.log('----------------------------------------------------------------------');
  }

  if (result.errors.length > 0) {
    console.error(` ERRORS (${result.errors.length}):`);
    for (const e of result.errors) {
      console.error(`  [x] ${e}`);
    }
    console.log('======================================================================');
    process.exit(1);
  }

  console.log(
    ' STATUS: GREEN -- 100% TS, 0 gut-sharing, 0 proxy bloat, 0 untyped boundaries, 0 style/route leaks.'
  );
  console.log('======================================================================');
}

main();
