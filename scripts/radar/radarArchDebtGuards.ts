import fs from 'node:fs';
import { stripComments, toPosixRel } from './radarConstantsAndFs.ts';

/**
 * Ratchet ceilings for architectural debt tracked by Wave 0.
 * Drop HARD_ENGINE_NAMETAG_SCATTER_LIMIT to 1 once MatchRosterProjection SSOT lands.
 */
export const HARD_ENGINE_NAMETAG_SCATTER_LIMIT = 1;
export const HARD_BOOLEAN_FLAG_CLUSTER_LIMIT = 15;
export const HARD_COMPOUND_FLAG_IF_LIMIT = 12;

export interface ArchDebtAuditReport {
  readonly nameTagScatterFiles: readonly string[];
  readonly booleanFlagHotspots: readonly {
    readonly rel: string;
    readonly distinctFlags: number;
    readonly compoundIfs: number;
  }[];
  readonly unscopedCacheFiles: readonly {
    readonly rel: string;
    readonly reason: string;
  }[];
}

export function analyzeArchDebtGuards(
  allFiles: readonly string[],
  errors: string[]
): ArchDebtAuditReport {
  const nameTagScatterFiles: string[] = [];
  const booleanFlagHotspots: {
    rel: string;
    distinctFlags: number;
    compoundIfs: number;
  }[] = [];
  const unscopedCacheFiles: { rel: string; reason: string }[] = [];

  for (const file of allFiles) {
    const rel = toPosixRel(file);
    const raw = fs.readFileSync(file, 'utf8');
    const clean = stripComments(raw);

    const isEngineFile =
      rel !== 'src/game/runtimeUiPort.ts' &&
      !rel.startsWith('src/ui-core/') &&
      !rel.startsWith('src/ui-tuner/') &&
      !rel.startsWith('src/ui-system/') &&
      !rel.startsWith('src/entry/');

    if (isEngineFile && /\bsetNameTagRuntimeState\s*(?:\?\.)?\(/.test(clean)) {
      nameTagScatterFiles.push(rel);
    }

    if (/^(?:src\/game\/|src\/network\/|src\/replay\/)/.test(rel)) {
      const ifMatches = clean.match(/\bif\s*\([^)]+\)/g) || [];
      const distinctFlags = new Set<string>();
      let compoundIfs = 0;
      for (const m of ifMatches) {
        const flags = m.match(/\b(?:is|should|has)[A-Z]\w*\b|\breplayPlaybackMode\b/g) || [];
        if (flags.length >= 2) compoundIfs++;
        for (const fl of flags) distinctFlags.add(fl);
      }

      if (distinctFlags.size > HARD_BOOLEAN_FLAG_CLUSTER_LIMIT) {
        errors.push(
          `[BOOLEAN FLAG EXPLOSION] ${rel} combines ${distinctFlags.size} distinct mode/state flags in conditionals (ceiling <= ${HARD_BOOLEAN_FLAG_CLUSTER_LIMIT}). Replace implicit boolean combinations with an explicit state-machine policy.`
        );
      }
      if (compoundIfs > HARD_COMPOUND_FLAG_IF_LIMIT) {
        errors.push(
          `[COMPOUND FLAG BRANCHING] ${rel} has ${compoundIfs} multi-flag conditional branches (ceiling <= ${HARD_COMPOUND_FLAG_IF_LIMIT}). Route through an explicit SimulationDrivePolicy.`
        );
      }
      if (distinctFlags.size >= 8 && compoundIfs >= 3) {
        booleanFlagHotspots.push({
          rel,
          distinctFlags: distinctFlags.size,
          compoundIfs,
        });
      }
    }

    if (/^(?:src\/ai\/|src\/entities\/|src\/replay\/)/.test(rel)) {
      const hasModuleCache =
        /^(?:const|let)\s+[a-zA-Z_$][\w$]*\s*=\s*new\s+(?:Map|Set)\s*\(/m.test(clean);
      const hasDisposeOrReset =
        /\b(?:dispose|clear[A-Z]\w*|reset[A-Z]\w*|reclaim[A-Z]\w*)\b/.test(clean);
      if (hasModuleCache && !hasDisposeOrReset) {
        unscopedCacheFiles.push({
          rel,
          reason: 'module-level Map/Set without dispose/clear/reset hook',
        });
      }
    }
  }

  if (nameTagScatterFiles.length > HARD_ENGINE_NAMETAG_SCATTER_LIMIT) {
    errors.push(
      `[SSOT SCATTER VIOLATION] ${nameTagScatterFiles.length} engine files call setNameTagRuntimeState(...) directly (ratchet ceiling <= ${HARD_ENGINE_NAMETAG_SCATTER_LIMIT}). Route roster/nametag updates through the single roster projection.`
    );
  }

  booleanFlagHotspots.sort((a, b) => b.compoundIfs - a.compoundIfs || b.distinctFlags - a.distinctFlags);

  return {
    nameTagScatterFiles,
    booleanFlagHotspots,
    unscopedCacheFiles,
  };
}

export function printArchDebtAuditReport(report: ArchDebtAuditReport): void {
  console.log(
    ` ARCH DEBT AUDIT: NameTagScatter=${report.nameTagScatterFiles.length}/${HARD_ENGINE_NAMETAG_SCATTER_LIMIT} | BoolHotspots=${report.booleanFlagHotspots.length} | UnscopedCaches=${report.unscopedCacheFiles.length}`
  );
  for (const h of report.booleanFlagHotspots) {
    console.log(
      `  [B] ${h.rel} | DistinctFlags=${h.distinctFlags} | CompoundIfs=${h.compoundIfs} | Rx: EXPLICIT_STATE_MACHINE_POLICY`
    );
  }
  for (const rel of report.nameTagScatterFiles) {
    console.log(`  [S] ${rel} | Direct setNameTagRuntimeState(...) | Rx: ROSTER_PROJECTION_SSOT`);
  }
  for (const c of report.unscopedCacheFiles.slice(0, 12)) {
    console.log(`  [C] ${c.rel} | ${c.reason} | Rx: DISPOSABLE_RESOURCE_REGISTRY`);
  }
  console.log('----------------------------------------------------------------------');
}
