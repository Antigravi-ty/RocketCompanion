import fs from 'node:fs';
import path from 'node:path';
import { SRC_DIR, stripComments } from './radarConstantsAndFs.ts';

const VALID_SETTINGS_TABS = new Set([
  'gameplay',
  'audio',
  'display',
  'advanced',
  'developer',
]);

/**
 * Verifies that Settings tab variants, playlist builders, and recipe routers stay aligned
 * so variant transitions (e.g. Gameplay -> Audio) never silently fall back to the default tab.
 */
export function checkPlaylistVariantSyncAlignment(errors: string[]): void {
  const settingsTabsDir = path.join(SRC_DIR, 'ui-core/recipes/settings/tabs');
  if (fs.existsSync(settingsTabsDir)) {
    const tabFiles = fs
      .readdirSync(settingsTabsDir)
      .filter((f) => f.endsWith('.tsx'))
      .sort();

    for (const fileName of tabFiles) {
      const fullPath = path.join(settingsTabsDir, fileName);
      const content = stripComments(fs.readFileSync(fullPath, 'utf8'));
      const variantRegex =
        /export\s+const\s+\w*VARIANT_META\s*:\s*SurfaceVariantMeta\s*=\s*\{([\s\S]*?)\n\};/g;
      let match: RegExpExecArray | null;
      while ((match = variantRegex.exec(content)) !== null) {
        const body = match[1];
        const variantIdMatch = body.match(/\bvariantId\s*:\s*['"]([^'"]+)['"]/);
        const targetTabMatch = body.match(/\bsettingsTargetTab\s*:\s*['"]([^'"]+)['"]/);
        const variantId = variantIdMatch?.[1] ?? '(unknown)';
        const targetTab = targetTabMatch?.[1];
        if (!targetTab || !VALID_SETTINGS_TABS.has(targetTab)) {
          errors.push(
            `[VARIANT SYNC VIOLATION] src/ui-core/recipes/settings/tabs/${fileName} variant '${variantId}' must define storeOverrides.appStore.settingsTargetTab as one of [${[...VALID_SETTINGS_TABS].join(', ')}] (found '${targetTab ?? 'missing'}').`
          );
        }
      }
    }
  }

  const builderPath = path.join(
    SRC_DIR,
    'ui-tuner/pages/menu-layer/menuLayerVariantPlaylistBuilder.ts'
  );
  if (fs.existsSync(builderPath)) {
    const builderContent = stripComments(fs.readFileSync(builderPath, 'utf8'));
    if (
      !/resolveSettingsSubtab/.test(builderContent) ||
      !/settingsTargetTab/.test(builderContent)
    ) {
      errors.push(
        `[VARIANT SYNC VIOLATION] src/ui-tuner/pages/menu-layer/menuLayerVariantPlaylistBuilder.ts must resolve Settings playlist subtabs from storeOverrides.appStore.settingsTargetTab (or strip the 'settings:' prefix) so Layer2SettingsRecipe.normalizeTab() never falls back to 'gameplay'.`
      );
    }
  }
}
