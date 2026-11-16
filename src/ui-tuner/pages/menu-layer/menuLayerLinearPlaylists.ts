import { resolveCalibratedSurfaceSizing } from '../../../ui-core/manifest/surfaceCalibration';
import {
  LAYER1_CONTEXT_VARIATIONS,
  type Layer1MenuContextMode,
} from '../../../ui-core/recipes/layer1MenuContextSpecs';
import { GARAGE_SYNC_VARIANT_METAS } from '../../../ui-core/recipes/garage/garageSyncVariants';
import { SURFACE_META as REMOTE_PROFILE_SURFACE_META } from '../../../ui-core/recipes/Layer3DevRemoteProfileRecipe';
import type { PresetConfig } from '../../../ui-core/stores/floatingPresets';
import { floatingStore } from '../../../ui-core/stores/floatingStore';
import {
  appendFloatingWindowsToPlaylist,
  isFloatingWindowPlaylistUnit,
  type FloatingWindowPlaylistUnit,
} from '../floating-windows/floatingWindowsLinearPlaylists';
import {
  GARAGE_QUICK_TABS,
  MENU_ROUTE_CONFIG,
  MENU_SANDBOX_JUMP_ITEMS,
  normalizeMenuRoute,
  type ActiveMenuRoute,
  type Layer3StepProgressStatus,
  type LinearPlaylistStep,
  type MenuVisibilityTier,
} from './menuLayerRouteConfig';
import {
  HOST_MATCH_PLAYLIST_STEPS,
  HOST_TRAINING_PLAYLIST_STEPS,
  JOIN_ROOM_PLAYLIST_STEPS,
  MANAGE_ROOM_PLAYLIST_STEPS,
  matchesOnlineRoomPlaylistStep,
} from './menuLayerOnlineRoomSteps';
import {
  buildAutoExpandedMenuRecipeSteps,
  buildSettingsPlaylistSteps,
} from './menuLayerVariantPlaylistBuilder';

export type UnifiedApprovalPlaylistStep =
  | LinearPlaylistStep
  | FloatingWindowPlaylistUnit;

export type UnifiedPlaylistScope = 'all' | 'user' | 'developer';

const GARAGE_USER_PLAYLIST_STEPS: LinearPlaylistStep[] = GARAGE_QUICK_TABS.flatMap((t) => {
  if (t.id !== 'sync') {
    return [
      {
        id: `user-l2-garage-${t.id}`,
        variantId: t.id,
        tier: 'user' as const,
        route: 'garage' as const,
        subtab: t.id,
        layer: 2 as const,
        label: `L2 Garage · ${t.label} Tab`,
        breadcrumb: `Layer 1 → Garage → ${t.label}`,
      },
    ];
  }
  return GARAGE_SYNC_VARIANT_METAS.filter((v) => v.tier !== 'developer').map((v) => ({
    id: `user-l2-garage-${v.variantId}`,
    variantId: v.variantId,
    tier: 'user' as const,
    route: 'garage' as const,
    subtab: 'sync',
    profileTier: v.profileTier,
    storeOverrides: v.storeOverrides,
    layer: 2 as const,
    label: `L2 Garage · ${v.label}`,
    breadcrumb: `Layer 1 → Garage → ${v.label}`,
  }));
});

const GARAGE_DEV_PLAYLIST_STEPS: LinearPlaylistStep[] = GARAGE_SYNC_VARIANT_METAS.filter(
  (v) => v.tier === 'developer'
).map((v) => ({
  id: `dev-l2-garage-${v.variantId}`,
  variantId: v.variantId,
  tier: 'developer' as const,
  route: 'garage' as const,
  subtab: 'sync',
  profileTier: v.profileTier,
  storeOverrides: v.storeOverrides,
  layer: 2 as const,
  label: `L2 Garage · ${v.label}`,
  breadcrumb: `Layer 1 (Dev) → Garage → ${v.label}`,
}));

const DEV_REMOTE_PROFILE_PLAYLIST_STEPS: LinearPlaylistStep[] = (
  REMOTE_PROFILE_SURFACE_META.variants ?? []
).map((v) => ({
  id: `dev-l3-remote-profile-${v.variantId}`,
  variantId: v.variantId,
  tier: 'developer' as const,
  route: 'dev-remote-profile' as const,
  subtab: v.variantId === 'credentials-required' ? 'set-profile' : v.variantId,
  profileTier: v.profileTier,
  storeOverrides: v.storeOverrides,
  layer: 3 as const,
  label: `L3 Remote Profile · ${v.label}`,
  breadcrumb: `Developer → Remote Profile → ${v.label}`,
}));

const USER_AUTO_EXPANDED = buildAutoExpandedMenuRecipeSteps('user');
const DEV_AUTO_EXPANDED = buildAutoExpandedMenuRecipeSteps('developer');

/**
 * Complete Linear Playlist of all User-Only vs Developer-Only pages/variations/tabs/states
 * for the `< Prev Page | Next Page >` and ArrowLeft/ArrowRight rapid visual scanner.
 */
export const USER_LINEAR_PLAYLIST: LinearPlaylistStep[] = [
  { id: 'user-l0', variantId: 'user-l0', tier: 'user', route: 'layer-0', layer: 0, label: 'L0 Active Match Arena (0px)', breadcrumb: 'Layer 0 · Active Match' },
  {
    id: 'user-l0-edge-inspector',
    variantId: 'user-l0-edge-inspector',
    tier: 'user',
    route: 'layer-0',
    contextMode: 'static-training-edit',
    layer: 0,
    label: 'L0 Edge Inspector · Static Training Shot Drawer',
    breadcrumb: 'Layer 0 · Static Training Edit → Edge Inspector Drawer',
  },
  ...LAYER1_CONTEXT_VARIATIONS.filter((v) => v.tier === 'user').map((v) => ({
    id: `user-l1-${v.id}`, variantId: `user-l1-${v.id}`, tier: 'user' as const, route: 'main-menu' as const, contextMode: v.id,
    layer: 1 as const, label: `L1 Main Menu · ${v.label}`, breadcrumb: `Layer 1 · ${v.headerTitle} (${v.label})`,
  })),
  { id: 'user-l1-tauri-configurator', variantId: 'default', tier: 'user', route: 'tauri-configurator', layer: 1, label: 'L1 Tauri Pre-Launch Configurator', breadcrumb: 'Layer 1 · Tauri Pre-Launch Configurator' },
  ...USER_AUTO_EXPANDED.playSteps,
  ...GARAGE_USER_PLAYLIST_STEPS,
  ...buildSettingsPlaylistSteps('user'),
  ...MANAGE_ROOM_PLAYLIST_STEPS,
  ...HOST_MATCH_PLAYLIST_STEPS.filter((s) => s.tier === 'user'),
  ...HOST_TRAINING_PLAYLIST_STEPS.filter((s) => s.tier === 'user'),
  { id: 'user-l3-custom-play', tier: 'user', route: 'custom-play', layer: 3, label: 'L3 Custom Mode (In Development)', breadcrumb: 'Play → Custom' },
  ...JOIN_ROOM_PLAYLIST_STEPS,
  ...USER_AUTO_EXPANDED.exhibitionSteps,
  { id: 'user-l3-self-training', tier: 'user', route: 'self-training', layer: 3, label: 'L3 Self-Training Hub', breadcrumb: 'Play → Self-Training' },
  ...USER_AUTO_EXPANDED.kickoffSteps,
  ...USER_AUTO_EXPANDED.trainingConfigSteps,
  ...USER_AUTO_EXPANDED.cameraSteps,
  ...USER_AUTO_EXPANDED.keybindingSteps,
  ...USER_AUTO_EXPANDED.trajectorySteps,
  ...USER_AUTO_EXPANDED.staticPackSteps,
  ...USER_AUTO_EXPANDED.controllerSteps,
  ...USER_AUTO_EXPANDED.devQuickActionsSteps,
];

export const DEV_LINEAR_PLAYLIST: LinearPlaylistStep[] = [
  ...LAYER1_CONTEXT_VARIATIONS.filter((v) => v.tier === 'developer').map((v) => ({
    id: `dev-l1-${v.id}`, variantId: `dev-l1-${v.id}`, tier: 'developer' as const, route: 'main-menu' as const, contextMode: v.id,
    layer: 1 as const, label: `L1 Dev Menu · ${v.label}`, breadcrumb: `Layer 1 (Dev) · ${v.headerTitle} (${v.label})`,
  })),
  ...DEV_AUTO_EXPANDED.playSteps,
  ...GARAGE_DEV_PLAYLIST_STEPS,
  ...buildSettingsPlaylistSteps('developer'),
  ...HOST_MATCH_PLAYLIST_STEPS.filter((s) => s.tier === 'developer'),
  ...HOST_TRAINING_PLAYLIST_STEPS.filter((s) => s.tier === 'developer'),
  ...DEV_AUTO_EXPANDED.devSandboxesSteps,
  { id: 'dev-l3-multibots', tier: 'developer', route: 'exp-multi-bots', layer: 3, label: 'L3 Experimental Multi-Bots (3v3)', breadcrumb: 'Developer → Experimental Multi-Bots' },
  { id: 'dev-l3-botpack-9700488', tier: 'developer', route: 'exp-botpack-9700488', layer: 3, label: 'L3 BotPack_9700488 Showcase (8 Models)', breadcrumb: 'Developer → Sandboxes → BotPack #9700488' },
  { id: 'dev-l3-active-tuners', tier: 'developer', route: 'dev-active-tuners', layer: 3, label: 'L3 Active Tuners & Phase Matrix', breadcrumb: 'Developer → Active Tuners' },
  { id: 'dev-l3-calibrated-presets', tier: 'developer', route: 'dev-calibrated-presets', layer: 3, label: 'L3 Calibrated Presets & Tuners', breadcrumb: 'Developer → Calibrated Presets' },
  ...DEV_AUTO_EXPANDED.devSelfTestSteps,
  ...DEV_REMOTE_PROFILE_PLAYLIST_STEPS,
  ...DEV_AUTO_EXPANDED.devQuickActionsSteps,
  { id: 'dev-l3-under-dev', tier: 'developer', route: 'dev-under-development', layer: 3, label: 'L3 Under Development', breadcrumb: 'Developer → Under Development' },
  ...DEV_AUTO_EXPANDED.acousticsEqSteps,
  ...DEV_AUTO_EXPANDED.cameraSteps,
  ...DEV_AUTO_EXPANDED.trajectorySteps,
  ...DEV_AUTO_EXPANDED.controllerSteps,
  ...DEV_AUTO_EXPANDED.advAudioSteps,
  { id: 'dev-l4-event-trigger-rules', tier: 'developer', route: 'event-trigger-rules', layer: 4, label: 'L4 Event & Trigger Rules Engine', breadcrumb: 'Developer → Active Tuners → Event & Trigger Rules' },
  { id: 'dev-l4-signaling-lab', tier: 'developer', route: 'dev-signaling-lab', layer: 4, label: 'L4 4-Server Signaling & Dual Bridge Lab', breadcrumb: 'Developer → Self Test → 4-Server Signaling Lab' },
  ...DEV_AUTO_EXPANDED.staticPackSteps,
];

export const USER_UNIFIED_APPROVAL_PLAYLIST: UnifiedApprovalPlaylistStep[] =
  appendFloatingWindowsToPlaylist(USER_LINEAR_PLAYLIST, 'user');

export const DEV_UNIFIED_APPROVAL_PLAYLIST: UnifiedApprovalPlaylistStep[] =
  appendFloatingWindowsToPlaylist(DEV_LINEAR_PLAYLIST, 'developer');

export const ALL_UNIFIED_APPROVAL_PLAYLIST: UnifiedApprovalPlaylistStep[] = [
  ...USER_UNIFIED_APPROVAL_PLAYLIST,
  ...DEV_UNIFIED_APPROVAL_PLAYLIST,
];

export function resolveUnifiedPlaylistByScope(
  scope: UnifiedPlaylistScope
): UnifiedApprovalPlaylistStep[] {
  if (scope === 'user') return USER_UNIFIED_APPROVAL_PLAYLIST;
  if (scope === 'developer') return DEV_UNIFIED_APPROVAL_PLAYLIST;
  return ALL_UNIFIED_APPROVAL_PLAYLIST;
}

const DIRECT_STORE_ONLY_ROUTES = new Set<ActiveMenuRoute>([
  'host-training',
  'custom-play',
]);

export function resolveRouteAuditInfo(
  route: ActiveMenuRoute,
  tier: MenuVisibilityTier,
  contextMode?: Layer1MenuContextMode,
  activeStep?: UnifiedApprovalPlaylistStep
): {
  surfaceId: string;
  variantId: string;
  referenceCode: string;
  componentName: string;
  sourceFile: string;
  tunerStatus: 'dedicated-tuner' | 'direct-store';
  surfaceKindLabel: string;
} {
  if (isFloatingWindowPlaylistUnit(activeStep)) {
    return {
      surfaceId: activeStep.surfaceId,
      variantId: activeStep.variantId,
      referenceCode:
        activeStep.tier === 'user' ? 'Floating · User' : 'Floating · Dev',
      componentName: activeStep.componentName,
      sourceFile: activeStep.sourceFile,
      tunerStatus: 'dedicated-tuner',
      surfaceKindLabel: 'Floating Window',
    };
  }

  if (route === 'layer-0') {
    const isEdgeEdit =
      contextMode === 'static-training-edit' ||
      activeStep?.contextMode === 'static-training-edit';
    return {
      surfaceId: 'recipe:StaticTrainingShotInspectorDrawer',
      variantId: isEdgeEdit ? 'user-l0-edge-inspector' : 'user-l0',
      referenceCode: isEdgeEdit ? 'Edge Inspector' : 'Layer 0 HUD',
      componentName: 'StaticTrainingShotInspectorDrawer',
      sourceFile: 'src/ui-core/recipes/StaticTrainingShotInspectorDrawer.tsx',
      tunerStatus: 'dedicated-tuner',
      surfaceKindLabel: isEdgeEdit ? 'Edge Inspector Drawer' : 'Layer 0 Arena HUD',
    };
  }

  const canonicalRoute = normalizeMenuRoute(route) ?? route;
  const jumpEntry =
    MENU_SANDBOX_JUMP_ITEMS.find((j) => j.route === canonicalRoute && j.tier === tier) ||
    MENU_SANDBOX_JUMP_ITEMS.find((j) => j.route === canonicalRoute);
  const rawComp = (jumpEntry?.componentName || 'Layer1MainMenuRecipe').replace(
    /\s*\(Dev\)$/,
    ''
  );
  const layerNum = MENU_ROUTE_CONFIG[canonicalRoute]?.layer ?? 1;
  const isLivePreview = canonicalRoute === 'trajectory' || canonicalRoute === 'camera';
  const referenceCode = isLivePreview
    ? 'Live Preview'
    : `Menu L${layerNum}`;
  const sourceFile = `src/ui-core/recipes/${rawComp}.tsx`;
  const tunerStatus = DIRECT_STORE_ONLY_ROUTES.has(route)
    ? 'direct-store'
    : 'dedicated-tuner';
  return {
    surfaceId: `recipe:${rawComp}`,
    variantId: activeStep?.variantId || activeStep?.id || canonicalRoute,
    referenceCode,
    componentName: rawComp,
    sourceFile,
    tunerStatus,
    surfaceKindLabel: isLivePreview
      ? 'Live Preview Dock'
      : `Menu Layer L${layerNum}`,
  };
}

export function findPlaylistStepIndex(
  playlist: readonly UnifiedApprovalPlaylistStep[],
  currentRoute: ActiveMenuRoute,
  normalizedLayer1Ctx: Layer1MenuContextMode,
  settingsTab: string,
  garageTab: string,
  layer3Override?: {
    progressStatus?: Layer3StepProgressStatus;
    currentStep?: number;
    defaultEditingConfig?: boolean;
  },
  activeFloatingWindowId?: string | null,
  activeFloatingSubTab?: string
): number {
  const canonicalRoute = normalizeMenuRoute(currentRoute) ?? currentRoute;

  if (canonicalRoute === 'layer-0' && activeFloatingWindowId) {
    if (activeFloatingSubTab) {
      const exactFwIdx = playlist.findIndex(
        (step) =>
          isFloatingWindowPlaylistUnit(step) &&
          step.windowId === activeFloatingWindowId &&
          step.subtab === activeFloatingSubTab
      );
      if (exactFwIdx >= 0) return exactFwIdx;
    }
    const firstFwIdx = playlist.findIndex(
      (step) =>
        isFloatingWindowPlaylistUnit(step) &&
        step.windowId === activeFloatingWindowId
    );
    if (firstFwIdx >= 0) return firstFwIdx;
  }

  const exactIdx = playlist.findIndex((step) => {
    if (isFloatingWindowPlaylistUnit(step)) return false;
    if ((normalizeMenuRoute(step.route) ?? step.route) !== canonicalRoute) return false;
    if (canonicalRoute === 'layer-0') {
      if (normalizedLayer1Ctx === 'static-training-edit') {
        return step.contextMode === 'static-training-edit';
      }
      return !step.contextMode;
    }
    if (
      (currentRoute === 'main-menu' || currentRoute === 'manage-room') &&
      step.contextMode
    ) {
      return (
        step.contextMode === normalizedLayer1Ctx &&
        matchesOnlineRoomPlaylistStep(step, currentRoute, normalizedLayer1Ctx, layer3Override)
      );
    }
    if (currentRoute === 'settings' && step.subtab) {
      return step.subtab === settingsTab;
    }
    if (currentRoute === 'garage' && step.subtab) {
      return step.subtab === garageTab;
    }
    if (
      (currentRoute === 'host-match' ||
        currentRoute === 'host-training' ||
        currentRoute === 'join-room') &&
      step.progressStatus
    ) {
      return matchesOnlineRoomPlaylistStep(
        step,
        currentRoute,
        normalizedLayer1Ctx,
        layer3Override
      );
    }
    return true;
  });
  if (exactIdx >= 0) return exactIdx;
  const routeFallbackIdx = playlist.findIndex(
    (s) =>
      !isFloatingWindowPlaylistUnit(s) &&
      (normalizeMenuRoute(s.route) ?? s.route) === canonicalRoute
  );
  return Math.max(0, routeFallbackIdx);
}

export function findUnifiedStepByLedgerKey(unitKey: string): UnifiedApprovalPlaylistStep | undefined {
  const [surfaceId, variantId = 'default'] = unitKey.split('::');
  if (surfaceId.startsWith('floating:')) {
    const fwId = surfaceId.replace(/^floating:/, '');
    if (variantId && variantId !== 'default') {
      const exactFw = ALL_UNIFIED_APPROVAL_PLAYLIST.find(
        (s) =>
          isFloatingWindowPlaylistUnit(s) &&
          s.windowId === fwId &&
          (s.variantId === variantId || s.subtab === variantId || s.id === variantId)
      );
      if (exactFw) return exactFw;
    }
    return ALL_UNIFIED_APPROVAL_PLAYLIST.find(
      (s) => isFloatingWindowPlaylistUnit(s) && s.windowId === fwId
    );
  }
  if (surfaceId === 'recipe:StaticTrainingShotInspectorDrawer') {
    const targetId = variantId === 'user-l0' ? 'user-l0' : 'user-l0-edge-inspector';
    return ALL_UNIFIED_APPROVAL_PLAYLIST.find((s) => s.id === targetId);
  }
  const compName = surfaceId.replace(/^recipe:/, '');
  if (variantId && variantId !== 'default') {
    const routesForComp = new Set(
      MENU_SANDBOX_JUMP_ITEMS.filter(
        (j) => (j.componentName ?? '').replace(/\s*\(Dev\)$/, '') === compName
      ).map((j) => j.route)
    );
    const byId = ALL_UNIFIED_APPROVAL_PLAYLIST.find(
      (s) =>
        !isFloatingWindowPlaylistUnit(s) &&
        routesForComp.has(s.route) &&
        (s.variantId === variantId || s.id === variantId)
    );
    if (byId) return byId;
  }
  const routes = new Set(
    MENU_SANDBOX_JUMP_ITEMS.filter(
      (j) => (j.componentName ?? '').replace(/\s*\(Dev\)$/, '') === compName
    ).map((j) => j.route)
  );
  return ALL_UNIFIED_APPROVAL_PLAYLIST.find(
    (s) => !isFloatingWindowPlaylistUnit(s) && routes.has(s.route)
  );
}

export function spawnFloatingPresetOnUnifiedStage(preset: PresetConfig): void {
  const cal = resolveCalibratedSurfaceSizing(`floating:${preset.id}`, {
    width: preset.width,
    height: preset.height,
    minWidth: preset.minWidth,
    minHeight: preset.minHeight,
    maxHeight: preset.maxHeight,
    mode: preset.autoFitHeight ? 'adaptive' : 'fixed',
  });
  floatingStore.clearAll();
  floatingStore.spawnWindow({
    id: preset.id,
    title: preset.title,
    subtitle: preset.summary,
    category: preset.category,
    width: cal.minWidth ?? cal.width ?? preset.width,
    height: typeof cal.height === 'number' ? cal.height : preset.height,
    minWidth: cal.minWidth ?? preset.minWidth,
    minHeight: cal.minHeight ?? preset.minHeight,
    maxWidth: preset.maxWidth,
    maxHeight: cal.maxHeight ?? preset.maxHeight,
    autoFitHeight: cal.mode === 'adaptive' ? true : preset.autoFitHeight,
    resizable: preset.resizable,
    singleton: true,
    hideFooter: preset.hideFooter,
    contentPadding: preset.contentPadding,
    startMinimized: false,
  });
}
