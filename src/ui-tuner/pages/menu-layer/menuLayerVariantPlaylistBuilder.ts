import type {
  SurfaceMeta,
  SurfaceVariantMeta,
} from '../../../ui-core/manifest/surfaceMetaTypes';
import { SETTINGS_TAB_VARIANTS } from '../../../ui-core/recipes/Layer2SettingsRecipe';
import { SURFACE_META as PLAY_SURFACE_META } from '../../../ui-core/recipes/Layer2PlayRecipe';
import { SURFACE_META as ACOUSTICS_EQ_SURFACE_META } from '../../../ui-core/recipes/Layer3AcousticsEqualizerRecipe';
import { SURFACE_META as TRAJECTORY_SURFACE_META } from '../../../ui-core/recipes/Layer3BallTrajectoryRecipe';
import { SURFACE_META as CAMERA_SURFACE_META } from '../../../ui-core/recipes/Layer3CameraRecipe';
import { SURFACE_META as DEV_QUICK_ACTIONS_SURFACE_META } from '../../../ui-core/recipes/Layer3DevQuickActionsRecipe';
import { SURFACE_META as DEV_SANDBOXES_SURFACE_META } from '../../../ui-core/recipes/Layer3DevSandboxesRecipe';
import { SURFACE_META as DEV_SELF_TEST_SURFACE_META } from '../../../ui-core/recipes/Layer3DevSelfTestRecipe';
import { SURFACE_META as EXHIBITION_SURFACE_META } from '../../../ui-core/recipes/Layer3ExhibitionRecipe';
import { SURFACE_META as KEYBINDINGS_SURFACE_META } from '../../../ui-core/recipes/Layer3KeybindingsRecipe';
import { SURFACE_META as KICKOFF_SURFACE_META } from '../../../ui-core/recipes/Layer3KickoffTrainingRecipe';
import { SURFACE_META as TRAINING_CFG_SURFACE_META } from '../../../ui-core/recipes/Layer3TrainingConfigRecipe';
import { SURFACE_META as ADV_AUDIO_SURFACE_META } from '../../../ui-core/recipes/Layer4AdvancedAudioRecipe';
import { SURFACE_META as CONTROLLER_SURFACE_META } from '../../../ui-core/recipes/Layer4ControllerSettingsRecipe';
import { SURFACE_META as STATIC_PACK_SURFACE_META } from '../../../ui-core/recipes/Layer4StaticTrainingPackBrowseRecipe';
import type {
  ActiveMenuRoute,
  LinearPlaylistStep,
  MenuVisibilityTier,
} from './menuLayerRouteConfig';

function resolveVariantTier(
  variant: SurfaceVariantMeta,
  defaultTier: MenuVisibilityTier
): MenuVisibilityTier {
  if (variant.tier === 'developer' || variant.tier === 'user') {
    return variant.tier;
  }
  if (variant.profileTier === 'developer') return 'developer';
  const devFlag = variant.storeOverrides?.appStore?.developerMode;
  if (typeof devFlag === 'boolean') {
    return devFlag ? 'developer' : 'user';
  }
  return defaultTier;
}

function resolveSettingsSubtab(variant: SurfaceVariantMeta): string {
  const fromOverride = variant.storeOverrides?.appStore?.settingsTargetTab;
  if (typeof fromOverride === 'string' && fromOverride.length > 0) {
    return fromOverride;
  }
  const stripped = variant.variantId.replace(/^settings:/, '');
  if (stripped.startsWith('display')) return 'display';
  if (stripped.startsWith('advanced')) return 'advanced';
  return stripped;
}

export function buildSettingsPlaylistSteps(
  tier: MenuVisibilityTier
): LinearPlaylistStep[] {
  const prefix = tier === 'user' ? 'user-l2-settings' : 'dev-l2-settings';
  const rootLabel = tier === 'user' ? 'Layer 1 → Settings' : 'Settings → Developer';
  return SETTINGS_TAB_VARIANTS.filter(
    (v) => (v.tier === 'developer' ? 'developer' : 'user') === tier
  ).map((v) => ({
    id: `${prefix}-${v.variantId}`,
    variantId: v.variantId,
    tier,
    route: 'settings' as const,
    subtab: resolveSettingsSubtab(v),
    profileTier: v.profileTier,
    storeOverrides: v.storeOverrides,
    layer: 2 as const,
    label: `L2 Settings · ${v.label}`,
    breadcrumb: `${rootLabel} → ${v.label}`,
  }));
}

export interface ExpandRecipeVariantsOptions {
  meta: SurfaceMeta;
  route: ActiveMenuRoute;
  layer: 0 | 1 | 2 | 3 | 4;
  defaultTier: MenuVisibilityTier;
  idPrefix: string;
  labelPrefix: string;
  breadcrumbPrefix: string;
  filterTier?: MenuVisibilityTier;
  resolveSubtab?: (variant: SurfaceVariantMeta) => string | undefined;
}

export function expandSurfaceMetaVariants(
  options: ExpandRecipeVariantsOptions
): LinearPlaylistStep[] {
  const {
    meta,
    route,
    layer,
    defaultTier,
    idPrefix,
    labelPrefix,
    breadcrumbPrefix,
    filterTier,
    resolveSubtab,
  } = options;
  const variants = meta.variants ?? [];
  return variants
    .map((v): LinearPlaylistStep | null => {
      const stepTier = resolveVariantTier(v, defaultTier);
      if (filterTier && stepTier !== filterTier) return null;
      const cleanId = v.variantId.replace(/[^a-zA-Z0-9_-]+/g, '-');
      return {
        id: `${idPrefix}-${cleanId}`,
        variantId: v.variantId,
        tier: stepTier,
        route,
        subtab: resolveSubtab ? resolveSubtab(v) : undefined,
        profileTier: v.profileTier,
        storeOverrides: v.storeOverrides,
        layer,
        label: `${labelPrefix} · ${v.label}`,
        breadcrumb: `${breadcrumbPrefix} → ${v.label}`,
      };
    })
    .filter((step): step is LinearPlaylistStep => step !== null);
}

export function buildAutoExpandedMenuRecipeSteps(
  tier: MenuVisibilityTier
): {
  playSteps: LinearPlaylistStep[];
  exhibitionSteps: LinearPlaylistStep[];
  kickoffSteps: LinearPlaylistStep[];
  trainingConfigSteps: LinearPlaylistStep[];
  cameraSteps: LinearPlaylistStep[];
  keybindingSteps: LinearPlaylistStep[];
  trajectorySteps: LinearPlaylistStep[];
  staticPackSteps: LinearPlaylistStep[];
  controllerSteps: LinearPlaylistStep[];
  devSandboxesSteps: LinearPlaylistStep[];
  devSelfTestSteps: LinearPlaylistStep[];
  devQuickActionsSteps: LinearPlaylistStep[];
  acousticsEqSteps: LinearPlaylistStep[];
  advAudioSteps: LinearPlaylistStep[];
} {
  return {
    playSteps: expandSurfaceMetaVariants({
      meta: PLAY_SURFACE_META,
      route: 'play',
      layer: 2,
      defaultTier: 'user',
      filterTier: tier,
      idPrefix: `${tier === 'user' ? 'user' : 'dev'}-l2-play`,
      labelPrefix: 'L2 Play Modes',
      breadcrumbPrefix: 'Layer 1 → Play',
    }),
    exhibitionSteps: expandSurfaceMetaVariants({
      meta: EXHIBITION_SURFACE_META,
      route: 'exhibition',
      layer: 3,
      defaultTier: 'user',
      filterTier: tier,
      idPrefix: 'user-l3-exhibition',
      labelPrefix: 'L3 Exhibition',
      breadcrumbPrefix: 'Play → Exhibition Setup',
    }),
    kickoffSteps: expandSurfaceMetaVariants({
      meta: KICKOFF_SURFACE_META,
      route: 'kickoff-training',
      layer: 3,
      defaultTier: 'user',
      filterTier: tier,
      idPrefix: 'user-l3-kickoff',
      labelPrefix: 'L3 Kickoff Training',
      breadcrumbPrefix: 'Self-Training → Kickoff Training',
    }),
    trainingConfigSteps: expandSurfaceMetaVariants({
      meta: TRAINING_CFG_SURFACE_META,
      route: 'training-config',
      layer: 3,
      defaultTier: 'user',
      filterTier: tier,
      idPrefix: 'user-l3-training',
      labelPrefix: 'L3 Training Config',
      breadcrumbPrefix: 'Main Menu → Training Configuration',
    }),
    cameraSteps: expandSurfaceMetaVariants({
      meta: CAMERA_SURFACE_META,
      route: 'camera',
      layer: 3,
      defaultTier: 'user',
      filterTier: tier,
      idPrefix: `${tier === 'user' ? 'user' : 'dev'}-l3-camera`,
      labelPrefix: 'L3 Camera',
      breadcrumbPrefix: 'Settings → Gameplay → Camera Settings',
    }),
    keybindingSteps: expandSurfaceMetaVariants({
      meta: KEYBINDINGS_SURFACE_META,
      route: 'keybindings',
      layer: 3,
      defaultTier: 'user',
      filterTier: tier,
      idPrefix: 'user-l3-keybindings',
      labelPrefix: 'L3 Key Bindings',
      breadcrumbPrefix: 'Settings → Gameplay → Key Bindings',
      resolveSubtab: (v) => (v.variantId === 'all' ? 'All' : v.variantId),
    }),
    trajectorySteps: expandSurfaceMetaVariants({
      meta: TRAJECTORY_SURFACE_META,
      route: 'trajectory',
      layer: 3,
      defaultTier: 'user',
      filterTier: tier,
      idPrefix: `${tier === 'user' ? 'user' : 'dev'}-l3-trajectory`,
      labelPrefix: 'L3 Ball Trajectory',
      breadcrumbPrefix: 'Settings → Gameplay → Trajectory Live Preview',
    }),
    staticPackSteps: expandSurfaceMetaVariants({
      meta: STATIC_PACK_SURFACE_META,
      route: tier === 'user' ? 'static-training-pack' : 'dev-tem-pack-converter',
      layer: 4,
      defaultTier: 'user',
      filterTier: tier,
      idPrefix: tier === 'user' ? 'user-l4-rcspack' : 'dev-l4-tem-pack-converter',
      labelPrefix:
        tier === 'user' ? 'L4 Static Training Pack' : 'L4 Dev .tem Pack Converter',
      breadcrumbPrefix:
        tier === 'user'
          ? 'Self-Training → .RCSPack Browser'
          : 'Developer → Sandboxes → Dev .tem Pack Converter',
    }),
    controllerSteps: expandSurfaceMetaVariants({
      meta: CONTROLLER_SURFACE_META,
      route: 'controller-settings',
      layer: 4,
      defaultTier: 'user',
      filterTier: tier,
      idPrefix: `${tier === 'user' ? 'user' : 'dev'}-l4-controller`,
      labelPrefix: 'L4 Controller Settings',
      breadcrumbPrefix: 'Settings → Key Bindings → Controller Settings',
    }),
    devSandboxesSteps: expandSurfaceMetaVariants({
      meta: DEV_SANDBOXES_SURFACE_META,
      route: 'dev-sandboxes',
      layer: 3,
      defaultTier: 'developer',
      filterTier: tier,
      idPrefix: 'dev-l3-isolation',
      labelPrefix: 'L3 Sandboxes',
      breadcrumbPrefix: 'Developer → Sandboxes & Isolation Labs',
    }),
    devSelfTestSteps: expandSurfaceMetaVariants({
      meta: DEV_SELF_TEST_SURFACE_META,
      route: 'dev-self-test',
      layer: 3,
      defaultTier: 'developer',
      filterTier: tier,
      idPrefix: 'dev-l3-self-test',
      labelPrefix: 'L3 Self Test',
      breadcrumbPrefix: 'Developer → Self Test',
    }),
    devQuickActionsSteps: expandSurfaceMetaVariants({
      meta: DEV_QUICK_ACTIONS_SURFACE_META,
      route: 'dev-quick-actions',
      layer: 3,
      defaultTier: 'developer',
      filterTier: tier,
      idPrefix: `${tier === 'user' ? 'user' : 'dev'}-l3-quick-actions`,
      labelPrefix: 'L3 Quick Actions',
      breadcrumbPrefix: 'Developer → Quick Actions',
    }),
    acousticsEqSteps: expandSurfaceMetaVariants({
      meta: ACOUSTICS_EQ_SURFACE_META,
      route: 'acoustics-equalizer',
      layer: 3,
      defaultTier: 'developer',
      filterTier: tier,
      idPrefix: 'dev-l3-audio-eq',
      labelPrefix: 'L3 Acoustics & EQ',
      breadcrumbPrefix: 'Developer → Acoustics & EQ',
    }),
    advAudioSteps: expandSurfaceMetaVariants({
      meta: ADV_AUDIO_SURFACE_META,
      route: 'advanced-audio',
      layer: 4,
      defaultTier: 'developer',
      filterTier: tier,
      idPrefix: 'dev-l4-adv-audio',
      labelPrefix: 'L4 Advanced Audio',
      breadcrumbPrefix: 'Developer → Active Tuners → Advanced Audio',
    }),
  };
}
