#!/usr/bin/env node
/**
 * scripts/radar.ts
 * Generation 3 Semantic Architecture, TypeScript & Boundary Radar for RocketCompanion.
 *
 * Modularized under `scripts/radar/`:
 *   - `radarConstantsAndFs.ts`: Thresholds, filesystem/import resolution helpers, and `tsc --noEmit` runner
 *   - `radarAstScanners.ts`: English/Emoji hygiene, 0 value re-exports, `any` purity, proxy bloat, and anti-gut-sharing scanners
 *   - `radarUiAndRepoGuards.ts`: UI route & floating window 1:1 naming guards, circular dependency DFS, lockfile & WASM parity guards
 */

import fs from 'node:fs';
import {
  CROSS_CONTROLLER_MUTATION_LIMIT,
  expandRelativeGlobPattern,
  FILE_ANY_LIMIT,
  HARD_BYTE_LIMIT,
  HARD_LINE_LIMIT,
  MICRO_FRAGMENT_LINE_FLOOR,
  PIPELINE_MUTATION_PROP_LIMIT,
  PROXY_ACCESSOR_LIMIT,
  type RadarScanResult,
  resolveImportPath,
  runTypeScriptCheck,
  SCRIPTS_DIR,
  SOFT_BYTE_LIMIT,
  SOFT_LINE_LIMIT,
  SRC_DIR,
  stripComments,
  type SubsystemCount,
  toPosixRel,
  walkSourceFiles,
  WIDE_WAIST_PORT_READ_LIMIT,
} from './radar/radarConstantsAndFs.ts';
import {
  checkAntiGutSharingAndMutations,
  checkAnyPurity,
  checkLanguageAndEmoji,
  checkProxyBloat,
  checkValueReExports,
} from './radar/radarAstScanners.ts';
import {
  checkRootConfigAndWasmParity,
  checkUiNamingAndRouteAlignment,
  detectCircularDependencies,
} from './radar/radarUiAndRepoGuards.ts';

function runRadarChecks(allFiles: string[], skipTsc: boolean): RadarScanResult {
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

  const scriptFiles = walkSourceFiles(SCRIPTS_DIR);
  for (const sFile of scriptFiles) {
    const sRel = toPosixRel(sFile);
    if (sRel === 'scripts/radar.ts' || sRel.startsWith('scripts/radar/')) continue;
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
      errors.push(
        `[BYTE VOLUME OVERFLOW] ${rel} is ${kbFormatted} KB (${byteSize} bytes, ${lineCount} lines; exceeds hard ceiling of ${(HARD_BYTE_LIMIT / 1024).toFixed(0)} KB). Decompose into focused vertical modules.`
      );
    } else if (byteSize > SOFT_BYTE_LIMIT) {
      warnings.push(
        `[BYTE WATERLINE ALERT] ${rel} is at ${kbFormatted} KB (${byteSize} bytes, ${lineCount} lines; exceeds soft limit of ${(SOFT_BYTE_LIMIT / 1024).toFixed(0)} KB, approaching ${(HARD_BYTE_LIMIT / 1024).toFixed(0)} KB).`
      );
    }

    checkValueReExports(rel, codeWithoutComments, errors);
    checkAnyPurity(rel, codeWithoutComments, errors);
    checkProxyBloat(rel, codeWithoutComments, errors);
    checkAntiGutSharingAndMutations(rel, codeWithoutComments, errors);

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

  checkUiNamingAndRouteAlignment(errors);
  detectCircularDependencies(importGraph, errors);
  checkRootConfigAndWasmParity(errors, warnings);

  const tsResult = skipTsc
    ? { ok: true, command: 'skipped (--no-tsc)', errors: [] }
    : runTypeScriptCheck();
  if (!tsResult.ok) {
    for (const tsLine of tsResult.errors.slice(0, 25)) {
      errors.push(`[TYPESCRIPT COMPILER ERROR] ${tsLine}`);
    }
  }

  return { errors, warnings, tsCount, jsCount, subsystemStats, tsResult };
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const skipTsc = args.has('--no-tsc');
  const startTime = Date.now();
  const allFiles = walkSourceFiles(SRC_DIR);
  const result = runRadarChecks(allFiles, skipTsc);
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
    ` TypeScript Strict   : ${
      result.tsResult.ok
        ? `PASS (${result.tsResult.command})`
        : `FAIL (${result.tsResult.errors.length} tsc diagnostic lines)`
    }`
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
    ' STATUS: GREEN -- 100% TS, tsc --noEmit clean, 0 gut-sharing, 0 proxy bloat, 0 untyped boundaries.'
  );
  console.log('======================================================================');
}

main();
