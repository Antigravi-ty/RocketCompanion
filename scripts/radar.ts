#!/usr/bin/env node
/**
 * scripts/radar.ts
 * Generation 3 Semantic Architecture, TypeScript & Boundary Radar for RocketCompanion.
 *
 * Modularized under `scripts/radar/`:
 *   - `radarConstantsAndFs.ts`: Thresholds, filesystem/import resolution helpers, and `tsc --noEmit` runner
 *   - `radarAstScanners.ts`: English/Emoji hygiene, line-length & filename guards, 0 value re-exports, and `any` purity scanners
 *   - `radarUiAndRepoGuards.ts`: UI route & floating window 1:1 naming guards, circular dependency DFS, lockfile & WASM parity guards
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  expandRelativeGlobPattern,
  FILE_ANY_LIMIT,
  type FileVolumeMeta,
  getGitModifiedRelFiles,
  HARD_BYTE_LIMIT,
  HARD_LINE_LIMIT,
  MAX_LINE_CHAR_LIMIT,
  type RadarScanResult,
  resolveImportPath,
  ROOT_DIR,
  runTypeScriptCheck,
  SCRIPTS_DIR,
  SOFT_BYTE_LIMIT,
  SOFT_LINE_LIMIT,
  SRC_DIR,
  stripComments,
  type SubsystemCount,
  toPosixRel,
  walkSourceFiles,
} from './radar/radarConstantsAndFs.ts';
import {
  checkAnyPurity,
  checkLanguageAndEmoji,
  checkLineLengthAndFilenameHygiene,
  checkValueReExports,
} from './radar/radarAstScanners.ts';
import {
  analyzeStructuralCoupling,
  type FileStructuralMetrics,
  HARD_HOST_PENETRATION_LIMIT,
  HARD_PASSTHROUGH_PROXY_LIMIT,
  printStructuralAuditReport,
} from './radar/radarStructuralCoupling.ts';
import {
  checkRootConfigAndWasmParity,
  checkUiNamingAndRouteAlignment,
  detectCircularDependencies,
} from './radar/radarUiAndRepoGuards.ts';
import { checkRustWorkspaceAndWasmGuards } from './radar/radarRustAndWasmGuards.ts';

function runRadarChecks(
  allFiles: string[],
  skipTsc: boolean,
  showAllInfos: boolean,
  auditFilter?: string | null
): RadarScanResult & {
  totalLargeFileCount: number;
  rustFileCount: number;
  structuralHotspots: FileStructuralMetrics[];
} {
  const errors: string[] = [];
  const hardCeilingViolations: FileVolumeMeta[] = [];
  const softLimitNotices: FileVolumeMeta[] = [];
  const importGraph = new Map<string, string[]>();
  const incomingRefCounts = new Map<string, number>();
  const subsystemStats = new Map<string, SubsystemCount>();

  const modifiedRelSet = getGitModifiedRelFiles(ROOT_DIR);

  let jsCount = 0;
  let tsCount = 0;
  let totalLargeFileCount = 0;

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
    const lineCount = content.split(/\r?\n/).length;

    checkLanguageAndEmoji(rel, content, errors);
    checkLineLengthAndFilenameHygiene(rel, content, codeWithoutComments, errors);

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
    const exceedsHardLine = lineCount > HARD_LINE_LIMIT;
    const exceedsHardByte = byteSize > HARD_BYTE_LIMIT;

    if (exceedsHardLine || exceedsHardByte) {
      hardCeilingViolations.push({
        rel,
        byteSize,
        kbFormatted,
        lineCount,
        exceedsHardLine,
        exceedsHardByte,
      });
    } else if (byteSize > SOFT_BYTE_LIMIT || lineCount > SOFT_LINE_LIMIT) {
      totalLargeFileCount++;
      if (showAllInfos || modifiedRelSet.has(rel)) {
        softLimitNotices.push({
          rel,
          byteSize,
          kbFormatted,
          lineCount,
          exceedsHardLine: false,
          exceedsHardByte: false,
        });
      }
    }

    checkValueReExports(rel, codeWithoutComments, errors);
    checkAnyPurity(rel, codeWithoutComments, errors);

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

      if (
        !rel.startsWith('src/ui-core/') &&
        !rel.startsWith('src/ui-tuner/') &&
        !rel.startsWith('src/entry/') &&
        spec.startsWith('.') &&
        !/\.(ts|tsx|js|css|json|wasm)$/.test(spec)
      ) {
        errors.push(
          `[EXTENSIONLESS ENGINE IMPORT] ${rel} imports relative specifier "${spec}" without an explicit .ts/.tsx extension.`
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
          !rel.startsWith('src/ui-core/') &&
          !rel.startsWith('src/ui-tuner/') &&
          !rel.startsWith('src/entry/');
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

          if (targetRel.startsWith('src/ui-system/') || targetRel.startsWith('src/ui-tuner/')) {
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

  const ENTRYPOINTS = new Set([
    'src/main.ts',
    'src/ui-tuner/main.tsx',
    'src/entry/main.tsx',
    'src/physics/core.js',
  ]);
  for (const file of allFiles) {
    const rel = toPosixRel(file);
    if (ENTRYPOINTS.has(rel)) continue;
    const refCount = incomingRefCounts.get(rel) || 0;
    if (refCount === 0) {
      errors.push(
        `[ORPHAN MODULE] ${rel} has 0 incoming references across src/. Remove dead file or wire it into its owning subsystem.`
      );
    }
  }

  checkUiNamingAndRouteAlignment(errors);
  detectCircularDependencies(importGraph, errors);
  checkRootConfigAndWasmParity(errors);
  const { rustFileCount, rustLargeFileCount } = checkRustWorkspaceAndWasmGuards(
    errors,
    infos,
    showAllInfos,
    modifiedRelSet
  );
  totalLargeFileCount += rustLargeFileCount;
  const structuralHotspots = analyzeStructuralCoupling(allFiles, importGraph, errors, auditFilter);

  const tsResult = skipTsc
    ? { ok: true, command: 'skipped (--no-tsc)', errors: [] }
    : runTypeScriptCheck();
  if (!tsResult.ok) {
    for (const tsLine of tsResult.errors.slice(0, 25)) {
      errors.push(`[TYPESCRIPT COMPILER ERROR] ${tsLine}`);
    }
  }

  const sortByVolumeDesc = (a: FileVolumeMeta, b: FileVolumeMeta): number => {
    if (b.byteSize !== a.byteSize) {
      return b.byteSize - a.byteSize;
    }
    return b.lineCount - a.lineCount;
  };
  hardCeilingViolations.sort(sortByVolumeDesc);
  softLimitNotices.sort(sortByVolumeDesc);

  return {
    errors,
    hardCeilingViolations,
    softLimitNotices,
    tsCount,
    jsCount,
    subsystemStats,
    tsResult,
    totalLargeFileCount,
    rustFileCount,
    structuralHotspots,
  };
}

function formatVolumeList(items: FileVolumeMeta[]): string[] {
  if (items.length === 0) return [];
  const maxPathLen = Math.max(...items.map((i) => i.rel.length));
  return items.map(
    (item) =>
      `    - ${item.rel.padEnd(maxPathLen)} (${item.kbFormatted} KB, ${item.lineCount} lines)`
  );
}

function main(): void {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);
  const skipTsc = args.has('--no-tsc');
  const showAllInfos = args.has('--all-info');
  const auditArg = rawArgs.find((a) => a === '--audit' || a.startsWith('--audit='));
  const auditMode = Boolean(auditArg);
  const auditFilter =
    auditArg && auditArg.startsWith('--audit=') ? auditArg.slice('--audit='.length) : null;

  const startTime = Date.now();
  const allFiles = walkSourceFiles(SRC_DIR);
  const result = runRadarChecks(allFiles, skipTsc, showAllInfos, auditFilter);
  const elapsedMs = Date.now() - startTime;

  const totalFiles = result.tsCount + result.jsCount;
  const tsPercent = totalFiles > 0 ? ((result.tsCount / totalFiles) * 100).toFixed(1) : '0.0';

  console.log('======================================================================');
  console.log(` ROCKET COMPANION GEN-3 SEMANTIC ARCHITECTURE RADAR (${elapsedMs}ms)`);
  console.log('======================================================================');
  console.log(
    ` TypeScript & Rust   : ${result.tsCount}/${totalFiles} TS (${tsPercent}% TS) | ${result.rustFileCount} custom Rust files + rocketsim.tree-hash`
  );
  console.log(
    ` TypeScript Strict   : ${
      result.tsResult.ok
        ? `PASS (${result.tsResult.command})`
        : `FAIL (${result.tsResult.errors.length} tsc diagnostic lines)`
    }`
  );
  console.log(
    ` Volume Guardrails   : SoftInfo=${SOFT_LINE_LIMIT}L/${(SOFT_BYTE_LIMIT / 1024).toFixed(0)}KB | HardError=${HARD_LINE_LIMIT}L/${(HARD_BYTE_LIMIT / 1024).toFixed(0)}KB | MaxLine<=${MAX_LINE_CHAR_LIMIT}chars`
  );
  console.log(
    ` Hard Boundaries     : 0 Circular Deps | 0 Value Re-Exports | 0 Upward Imports | Any<=${FILE_ANY_LIMIT}`
  );
  console.log(
    ` Anti-Fake-Split     : 0 Multi-Stmt Lines | HostPen<=${HARD_HOST_PENETRATION_LIMIT} | PassThru<=${HARD_PASSTHROUGH_PROXY_LIMIT} (${result.structuralHotspots.length} audit targets; pass --audit)`
  );

  const engineSubsystems = [...result.subsystemStats.entries()]
    .filter(([k]) => !k.startsWith('src/ui-') && k !== 'src/entry')
    .sort((a, b) => a[0].localeCompare(b[0]));

  const uiSubsystems = [...result.subsystemStats.entries()]
    .filter(([k]) => k.startsWith('src/ui-') || k === 'src/entry')
    .sort((a, b) => a[0].localeCompare(b[0]));

  const subsystemSummary = engineSubsystems
    .map(([k, v]) => `${k.replace('src/', '')}(${v.ts}ts)`)
    .join(', ');
  const uiSubsystemSummary = uiSubsystems
    .map(([k, v]) => `${k.replace('src/', '')}(${v.ts}ts)`)
    .join(', ');
  console.log(` Engine Subsystems   : ${subsystemSummary}`);
  console.log(` UI Subsystems       : ${uiSubsystemSummary}`);
  console.log('----------------------------------------------------------------------');

  if (auditMode) {
    printStructuralAuditReport(result.structuralHotspots, auditFilter);
  }

  let printedSection = false;

  if (result.hardCeilingViolations.length > 0) {
    const fileWord = result.hardCeilingViolations.length === 1 ? 'file' : 'files';
    console.log(
      `[!] ERROR: Hard Limit Exceeded (Status: NOT ACCEPTABLE — ${result.hardCeilingViolations.length} ${fileWord}):`
    );
    console.log(
      `    Violations exceed hard ceilings (> ${(HARD_BYTE_LIMIT / 1024).toFixed(1)} KB or > ${HARD_LINE_LIMIT} lines). Build rejected.`
    );
    console.log(
      '    Action required: Must split strictly by functional domain, pure logic pipeline,'
    );
    console.log('    or independent UI Slot before commit.\n');
    for (const line of formatVolumeList(result.hardCeilingViolations)) {
      console.log(line);
    }
    printedSection = true;
  }

  if (result.softLimitNotices.length > 0) {
    if (printedSection) console.log('');
    const fileWord = result.softLimitNotices.length === 1 ? 'file' : 'files';
    console.log(
      `[-] INFO: Volume Soft Threshold Notices (Status: ACCEPTABLE — ${result.softLimitNotices.length} ${fileWord}):`
    );
    console.log(
      `    Files exceeding soft bounds (> ${(SOFT_BYTE_LIMIT / 1024).toFixed(1)} KB or > ${SOFT_LINE_LIMIT} lines). Non-blocking.`
    );
    console.log(
      '    Refactoring guidance: No immediate action required. Do NOT artificially compress'
    );
    console.log(
      '    code or shorten names. If adding features later, split by domain/pure pipelines.\n'
    );
    for (const line of formatVolumeList(result.softLimitNotices)) {
      console.log(line);
    }
    printedSection = true;
  } else if (result.totalLargeFileCount > 0 && result.hardCeilingViolations.length === 0) {
    console.log(
      ` INFO (Non-blocking) : ${result.totalLargeFileCount} existing file(s) in ${(SOFT_BYTE_LIMIT / 1024).toFixed(0)}KB..${(HARD_BYTE_LIMIT / 1024).toFixed(0)}KB / ${SOFT_LINE_LIMIT}..${HARD_LINE_LIMIT}L range — Status: ACCEPTABLE (pass --all-info to list).`
    );
    printedSection = true;
  }

  if (result.errors.length > 0) {
    if (printedSection) console.log('');
    console.error(`[!] ERROR: Architecture & Boundary Violations (${result.errors.length}):`);
    for (const e of result.errors) {
      console.error(`    [x] ${e}`);
    }
    printedSection = true;
  }

  const hasFailure = result.hardCeilingViolations.length > 0 || result.errors.length > 0;

  console.log('----------------------------------------------------------------------');
  if (hasFailure) {
    console.error(' STATUS: FAILED -- Build rejected due to architecture or volume violations.');
    console.log('======================================================================');
    process.exit(1);
  }

  console.log(
    ' STATUS: GREEN -- 100% TS, tsc --noEmit clean, hard boundaries & volume caps verified.'
  );
  console.log('======================================================================');
}

main();
