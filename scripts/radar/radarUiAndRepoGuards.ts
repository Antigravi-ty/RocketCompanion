import fs from 'node:fs';
import path from 'node:path';
import {
  kebabToPascalCase,
  ROOT_DIR,
  SRC_DIR,
  stripComments,
  toPosixRel,
} from './radarConstantsAndFs.ts';

export function checkUiNamingAndRouteAlignment(errors: string[]): void {
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
        const localName = rawName
          .split(/\s+as\s+/)
          .pop()!
          .trim();
        if (new RegExp(`<${localName}\\b`).test(content) && localName !== 'LogOut') {
          const isLayerRecipeImport =
            /ui-core\/recipes\/Layer\d+\w+Recipe(?:\.tsx)?$/.test(fromSpec) &&
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

  const presetBlockRegex =
    /export\s+const\s+\w+_PRESET\s*:\s*PresetConfig\s*=\s*(?:makeDevPreset\()?\s*\{([\s\S]*?)\n(?:\}\)|};)/g;
  for (const presetFile of presetFiles) {
    if (!fs.existsSync(presetFile)) continue;
    const rel = toPosixRel(presetFile);
    const content = stripComments(fs.readFileSync(presetFile, 'utf8'));
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = presetBlockRegex.exec(content)) !== null) {
      const body = blockMatch[1];
      const idMatch = body.match(/\bid\s*:\s*['"]([^'"]+)['"]/);
      const titleMatch = body.match(/\btitle\s*:\s*['"]([^'"]+)['"]/);
      const iconNameMatch = body.match(/\biconName\s*:\s*['"]([^'"]+)['"]/);
      const iconColorMatch = body.match(/\biconColor\s*:\s*['"]([^'"]+)['"]/);
      const compMatch = body.match(/\bcomponent\s*:\s*['"]([^'"]+)['"]/);
      const sourceMatch = body.match(/\bsourcePath\s*:\s*['"]([^'"]+)['"]/);
      if (!idMatch) continue;

      const id = idMatch[1];
      const title = titleMatch?.[1] || '';
      const iconName = iconNameMatch?.[1] || '';
      const iconColor = iconColorMatch?.[1] || '';
      const component = compMatch?.[1] || '';
      const sourcePath = sourceMatch?.[1] || (component ? `panels/dev/${component}.tsx` : '');
      const expectedComponent = `${kebabToPascalCase(id)}FloatingWindow`;

      if (!iconName || !iconColor) {
        errors.push(
          `[FLOATING WINDOW ICON VIOLATION] ${rel} preset '${id}' must define both 'iconName' and 'iconColor' as the single source of truth.`
        );
      }

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
          const surfaceMetaMatch = winContent.match(
            /\bexport\s+const\s+SURFACE_META\s*:\s*SurfaceMeta\s*=\s*\{([\s\S]*?)\n\};/
          );
          const metaBody = surfaceMetaMatch?.[1] || '';
          const metaIdMatch = metaBody.match(/\bid\s*:\s*['"]([^'"]+)['"]/);
          if (!metaIdMatch || metaIdMatch[1] !== id) {
            errors.push(
              `[UI NAMING VIOLATION] ${sourcePath} must export SURFACE_META with id '${id}' (found '${metaIdMatch?.[1] || 'missing'}') to match 1:1 filename '${expectedComponent}.tsx'.`
            );
          }
          const metaTitleMatch = metaBody.match(/\btitle\s*:\s*['"]([^'"]+)['"]/);
          if (title && (!metaTitleMatch || metaTitleMatch[1] !== title)) {
            errors.push(
              `[FLOATING WINDOW TITLE MISMATCH] ${sourcePath} SURFACE_META.title ('${metaTitleMatch?.[1] || 'missing'}') must match ${rel} preset '${id}' title ('${title}').`
            );
          }
          const metaIconMatch = metaBody.match(/\bicon\s*:\s*['"]([^'"]+)['"]/);
          if (iconName && (!metaIconMatch || metaIconMatch[1] !== iconName)) {
            errors.push(
              `[FLOATING WINDOW ICON MISMATCH] ${sourcePath} SURFACE_META.icon ('${metaIconMatch?.[1] || 'missing'}') must match ${rel} preset '${id}' iconName ('${iconName}').`
            );
          }
          const metaColorMatch = metaBody.match(/\biconColor\s*:\s*['"]([^'"]+)['"]/);
          if (iconColor && (!metaColorMatch || metaColorMatch[1] !== iconColor)) {
            errors.push(
              `[FLOATING WINDOW ICON COLOR MISMATCH] ${sourcePath} SURFACE_META.iconColor ('${metaColorMatch?.[1] || 'missing'}') must match ${rel} preset '${id}' iconColor ('${iconColor}').`
            );
          }
          const hideFooterMatch = metaBody.match(/\bhideFooter\s*:\s*(true|false)\b/);
          if (!hideFooterMatch) {
            errors.push(
              `[FLOATING WINDOW SCHEMA VIOLATION] ${sourcePath} SURFACE_META for '${id}' must explicitly set 'hideFooter: true' or 'hideFooter: false'.`
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

  checkRecipeProfileTierContracts(errors);
}

function checkRecipeProfileTierContracts(errors: string[]): void {
  const recipesDir = path.join(SRC_DIR, 'ui-core/recipes');
  if (!fs.existsSync(recipesDir)) return;

  const recipeFiles = fs
    .readdirSync(recipesDir)
    .filter(
      (name) =>
        (name.startsWith('Layer') && name.endsWith('Recipe.tsx')) ||
        name === 'StaticTrainingShotInspectorDrawer.tsx'
    )
    .map((name) => path.join(recipesDir, name));

  for (const recipeFile of recipeFiles) {
    const rel = toPosixRel(recipeFile);
    const raw = stripComments(fs.readFileSync(recipeFile, 'utf8'));
    if (!/\bexport\s+const\s+SURFACE_META\b/.test(raw)) continue;

    const policyMatch = raw.match(
      /\bprofileTierPolicy\s*:\s*['"](tier-invariant|user-dev-split|auth-triad)['"]/
    );
    if (!policyMatch) {
      errors.push(
        `[SURFACE SCHEMA VIOLATION] ${rel} SURFACE_META must explicitly declare 'profileTierPolicy' ('tier-invariant' | 'user-dev-split' | 'auth-triad').`
      );
      continue;
    }

    const policy = policyMatch[1];
    if (policy === 'tier-invariant') {
      const subtreeHits = scanRecipeSubtreeForTierStores(recipeFile);
      for (const hit of subtreeHits) {
        errors.push(
          `[SURFACE TIER CONTRACT VIOLATION] ${rel} declares profileTierPolicy: 'tier-invariant' but subtree '${hit.file}' references '${hit.symbol}'. Use 'user-dev-split' or 'auth-triad'.`
        );
      }
    }
    if (policy === 'auth-triad') {
      const hasVariants = /\bvariants\s*:/.test(raw);
      const hasProfileTier =
        /\bprofileTier\s*:/.test(raw) || /GARAGE_SYNC_VARIANT_METAS/.test(raw);
      if (!hasVariants || !hasProfileTier) {
        errors.push(
          `[SURFACE TIER CONTRACT VIOLATION] ${rel} declares profileTierPolicy: 'auth-triad' and must provide variants with 'profileTier' and 'storeOverrides'.`
        );
      }
    }
  }

  checkMenuPlaylistVariantCoverage(recipeFiles, errors);
}

function scanRecipeSubtreeForTierStores(
  entryFile: string
): Array<{ file: string; symbol: string }> {
  const visited = new Set<string>();
  const stack: string[] = [entryFile];
  const hits: Array<{ file: string; symbol: string }> = [];
  const patterns: Array<{ symbol: string; re: RegExp }> = [
    { symbol: 'developerMode', re: /\bdeveloperMode\b/ },
    { symbol: 'useCloudProfileSyncStore', re: /\buseCloudProfileSyncStore\b/ },
    { symbol: 'useSignalingProfileStore', re: /\buseSignalingProfileStore\b/ },
    { symbol: 'isTauriRuntime', re: /\bisTauriRuntime\b/ },
  ];

  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur) || !fs.existsSync(cur)) continue;
    visited.add(cur);
    const content = stripComments(fs.readFileSync(cur, 'utf8'));
    for (const pat of patterns) {
      if (pat.re.test(content)) {
        hits.push({ file: toPosixRel(cur), symbol: pat.symbol });
      }
    }
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content)) !== null) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const base = path.resolve(path.dirname(cur), spec);
      for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
        const candidate = fs.existsSync(base) ? base : `${base}${ext}`;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          if (toPosixRel(candidate).startsWith('src/ui-core/recipes/')) {
            stack.push(candidate);
          }
          break;
        }
      }
    }
  }
  return hits;
}

function checkMenuPlaylistVariantCoverage(
  recipeFiles: string[],
  errors: string[]
): void {
  const linearPlaylistsPath = path.join(SRC_DIR, 'ui-tuner/pages/menu-layer/menuLayerLinearPlaylists.ts');
  const builderPath = path.join(SRC_DIR, 'ui-tuner/pages/menu-layer/menuLayerVariantPlaylistBuilder.ts');
  const onlineStepsPath = path.join(SRC_DIR, 'ui-tuner/pages/menu-layer/menuLayerOnlineRoomSteps.ts');
  const playlistFiles = [linearPlaylistsPath, builderPath, onlineStepsPath];
  const combinedPlaylistSrc = playlistFiles
    .filter((f) => fs.existsSync(f))
    .map((f) => stripComments(fs.readFileSync(f, 'utf8')))
    .join('\n');

  const linearSrc = fs.existsSync(linearPlaylistsPath)
    ? stripComments(fs.readFileSync(linearPlaylistsPath, 'utf8'))
    : '';
  if (
    !linearSrc.includes("buildSettingsPlaylistSteps('user')") ||
    !linearSrc.includes("buildSettingsPlaylistSteps('developer')")
  ) {
    errors.push(
      "[PLAYLIST COVERAGE VIOLATION] menuLayerLinearPlaylists.ts must expand buildSettingsPlaylistSteps('user') and buildSettingsPlaylistSteps('developer')."
    );
  }

  for (const recipeFile of recipeFiles) {
    const baseName = path.basename(recipeFile, '.tsx');
    if (baseName === 'StaticTrainingShotInspectorDrawer') continue;
    const raw = stripComments(fs.readFileSync(recipeFile, 'utf8'));
    if (!/\bvariants\s*:/.test(raw)) continue;

    const isOnlineStepRecipe =
      baseName === 'Layer1MainMenuRecipe' ||
      baseName === 'Layer2ManageRoomRecipe' ||
      baseName === 'Layer3HostMatchRecipe' ||
      baseName === 'Layer3HostTrainingRecipe' ||
      baseName === 'Layer3JoinRoomRecipe';
    if (isOnlineStepRecipe) continue;

    const importedInPlaylist =
      new RegExp(`recipes/${baseName}['"]`).test(combinedPlaylistSrc) ||
      (baseName === 'Layer2GarageRecipe' &&
        /\bGARAGE_SYNC_VARIANT_METAS\b/.test(combinedPlaylistSrc));
    if (!importedInPlaylist) {
      errors.push(
        `[PLAYLIST COVERAGE VIOLATION] ${toPosixRel(recipeFile)} declares SURFACE_META.variants but is not consumed by menuLayerVariantPlaylistBuilder.ts or menuLayerLinearPlaylists.ts.`
      );
    }
  }
}

export function detectCircularDependencies(
  importGraph: Map<string, string[]>,
  errors: string[]
): void {
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
}

export function checkRootConfigAndWasmParity(errors: string[]): void {
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

  const forbiddenLockfiles = ['package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock'].filter(
    (lf) => fs.existsSync(path.join(ROOT_DIR, lf))
  );
  if (forbiddenLockfiles.length > 0) {
    errors.push(
      `[LOCKFILE HYGIENE VIOLATION] Non-pnpm lockfile(s) detected in repository root: ${forbiddenLockfiles.join(', ')}. Use pnpm and maintain pnpm-lock.yaml only.`
    );
  }
  if (!fs.existsSync(path.join(ROOT_DIR, 'pnpm-lock.yaml'))) {
    errors.push(
      '[LOCKFILE HYGIENE VIOLATION] Missing pnpm-lock.yaml in repository root. Maintain canonical pnpm lockfile hygiene.'
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
}
