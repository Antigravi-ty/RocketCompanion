import React from 'react';
import { LogOut } from 'lucide-react';
import { useAppStore } from '../../ui-core/stores/appStore';
import { type AppState } from '../../ui-core/stores/appStoreTypes';
import { type ActiveMenuRoute } from '../../ui-core/config/uiConfig';
import { type MenuPanelId } from '../../ui-core/tokens/menuLayoutTokens';
import { useExperimentalMultiBotsStore } from '../../ui-core/stores/experimentalMultiBotsStore';
import { useStaticTrainingPackStore } from '../../ui-core/stores/staticTrainingPackStore';
import { Layer1MainMenuRecipe } from '../../ui-core/recipes/Layer1MainMenuRecipe';
import { Layer2PlayRecipe } from '../../ui-core/recipes/Layer2PlayRecipe';
import { Layer2GarageRecipe } from '../../ui-core/recipes/Layer2GarageRecipe';
import { Layer2SettingsRecipe } from '../../ui-core/recipes/Layer2SettingsRecipe';
import { Layer2ManageRoomRecipe } from '../../ui-core/recipes/Layer2ManageRoomRecipe';
import { Layer3AcousticsEqualizerRecipe } from '../../ui-core/recipes/Layer3AcousticsEqualizerRecipe';
import { Layer3BallTrajectoryRecipe } from '../../ui-core/recipes/Layer3BallTrajectoryRecipe';
import { Layer3ExhibitionRecipe } from '../../ui-core/recipes/Layer3ExhibitionRecipe';
import { Layer3CameraRecipe } from '../../ui-core/recipes/Layer3CameraRecipe';
import { Layer3KeybindingsRecipe } from '../../ui-core/recipes/Layer3KeybindingsRecipe';
import { Layer3TrainingConfigRecipe } from '../../ui-core/recipes/Layer3TrainingConfigRecipe';
import { Layer3HostMatchRecipe } from '../../ui-core/recipes/Layer3HostMatchRecipe';
import { Layer3JoinRoomRecipe } from '../../ui-core/recipes/Layer3JoinRoomRecipe';
import { Layer3HostTrainingRecipe } from '../../ui-core/recipes/Layer3HostTrainingRecipe';
import { Layer3CustomPlayRecipe } from '../../ui-core/recipes/Layer3CustomPlayRecipe';
import { Layer3KickoffTrainingRecipe } from '../../ui-core/recipes/Layer3KickoffTrainingRecipe';
import { Layer3SelfTrainingRecipe } from '../../ui-core/recipes/Layer3SelfTrainingRecipe';
import { Layer3ExpMultiBotsRecipe } from '../../ui-core/recipes/Layer3ExpMultiBotsRecipe';
import { Layer3ExpBotPackRecipe } from '../../ui-core/recipes/Layer3ExpBotPackRecipe';
import { Layer3DevSandboxesRecipe } from '../../ui-core/recipes/Layer3DevSandboxesRecipe';
import { Layer3DevActiveTunersRecipe } from '../../ui-core/recipes/Layer3DevActiveTunersRecipe';
import { Layer3DevCalibratedPresetsRecipe } from '../../ui-core/recipes/Layer3DevCalibratedPresetsRecipe';
import { Layer3DevQuickActionsRecipe } from '../../ui-core/recipes/Layer3DevQuickActionsRecipe';
import { Layer3DevSelfTestRecipe } from '../../ui-core/recipes/Layer3DevSelfTestRecipe';
import { Layer3DevUnderDevelopmentRecipe } from '../../ui-core/recipes/Layer3DevUnderDevelopmentRecipe';
import { Layer3DevRemoteProfileRecipe } from '../../ui-core/recipes/Layer3DevRemoteProfileRecipe';
import { Layer4ControllerSettingsRecipe } from '../../ui-core/recipes/Layer4ControllerSettingsRecipe';
import { Layer4AdvancedAudioRecipe } from '../../ui-core/recipes/Layer4AdvancedAudioRecipe';
import { Layer4EventTriggerRulesRecipe } from '../../ui-core/recipes/Layer4EventTriggerRulesRecipe';
import { Layer4StaticTrainingPackBrowseRecipe } from '../../ui-core/recipes/Layer4StaticTrainingPackBrowseRecipe';
import { Layer4DevSignalingLabRecipe } from '../../ui-core/recipes/Layer4DevSignalingLabRecipe';
import { openStaticTrainingExitConfirmDialogue as openPureStaticTrainingExitConfirmDialogue } from '../../ui-core/recipes/StaticTrainingShotInspectorDrawer';

function openStaticTrainingExitConfirmDialogue(
  onExitConfirmed?: (action: 'save' | 'ignore') => void | Promise<void>
): void {
  openPureStaticTrainingExitConfirmDialogue(async (action) => {
    if (action === 'save') {
      await useStaticTrainingPackStore.getState().commitEditSessionToMainDb();
    } else {
      await useStaticTrainingPackStore.getState().discardEditSessionChanges();
    }
    await onExitConfirmed?.(action);
  });
}

export const ROUTE_TO_PANEL_ID: Record<ActiveMenuRoute, MenuPanelId> = {
  'main-menu': 'layer1-main',
  'play': 'layer2-play',
  'exhibition': 'layer3-exhibition',
  'self-training': 'layer3-self-training',
  'kickoff-training': 'layer3-kickoff-training',
  'static-training-pack': 'layer4-static-training-pack',
  'host-match': 'layer3-host-match',
  'join-room': 'layer3-join-room',
  'host-training': 'layer3-host-training',
  'custom-play': 'layer3-custom-play',
  'manage-room': 'layer2-manage-room',
  'garage': 'layer2-garage',
  'settings': 'layer2-settings',
  'acoustics-equalizer': 'layer3-acoustics-equalizer',
  'trajectory': 'layer3-ball-trajectory',
  'camera': 'layer3-camera',
  'training-config': 'layer3-training-config',
  'keybindings': 'layer3-keybindings',
  'controller-settings': 'layer4-controller-settings',
  'advanced-audio': 'layer4-advanced-audio',
  'event-trigger-rules': 'layer4-event-trigger-rules',
  'exp-multi-bots': 'layer3-exp-multi-bots',
  'exp-botpack-9700488': 'layer3-exp-botpack',
  'dev-sandboxes': 'layer3-dev-sandboxes',
  'dev-active-tuners': 'layer3-dev-active-tuners',
  'dev-calibrated-presets': 'layer3-dev-calibrated-presets',
  'dev-quick-actions': 'layer3-dev-quick-actions',
  'dev-self-test': 'layer3-dev-self-test',
  'dev-under-development': 'layer3-dev-under-development',
  'dev-remote-profile': 'layer3-dev-remote-profile',
  'dev-signaling-lab': 'layer4-dev-signaling-lab',
  'dev-tem-pack-converter': 'layer4-static-training-pack',
};

export interface MenuRouteRenderContext {
  activeRoute: ActiveMenuRoute;
  isLight: boolean;
  isStaticTrainingEditActive: boolean;
  settingsTargetTab: string;
  setSettingsTargetTab: (tab: string) => void;
  highlightSetting: string | null;
  clearHighlightSetting: () => void;
  bridge: AppState['bridge'];
  navigate: (route: ActiveMenuRoute) => void;
  goBack: () => void;
  closeMenu: () => void;
  setMatchMode: AppState['setMatchMode'];
  handleTriggerCollapse: () => void;
  resetLivePreviewToExpanded: () => void;
  expConfigParentRef: React.MutableRefObject<ActiveMenuRoute>;
  exhibitionParentRef: React.MutableRefObject<ActiveMenuRoute>;
}

export const MENU_ROUTE_RENDERERS: Record<
  ActiveMenuRoute,
  (ctx: MenuRouteRenderContext) => React.ReactNode
> = {
  'main-menu': (ctx) => (
    <Layer1MainMenuRecipe
      isLight={ctx.isLight}
      onResume={ctx.closeMenu}
      onRestartMatch={ctx.bridge.onRestartMatch}
      onReturnToFreeplay={ctx.bridge.onReturnToFreeplay}
      extraBottomAction={
        ctx.isStaticTrainingEditActive
          ? {
              title: 'Exit Edit Mode',
              subtitle: 'Save or discard training pack edits & leave editor',
              icon: <LogOut className="h-5 w-5" />,
              variant: 'danger',
              onClick: () => {
                openStaticTrainingExitConfirmDialogue(() => {
                  ctx.closeMenu();
                  ctx.bridge.onReturnToFreeplay?.();
                });
              },
            }
          : undefined
      }
      onNavigatePlay={() => ctx.navigate('play')}
      onNavigateGarage={() => ctx.navigate('garage')}
      onNavigateSettings={(tab) => {
        if (tab) ctx.setSettingsTargetTab(tab);
        ctx.navigate('settings');
      }}
      onNavigateManageRoom={() => ctx.navigate('manage-room')}
      onNavigateExpMultiBotsConfig={() => {
        const expState = useExperimentalMultiBotsStore.getState();
        if (expState.isExhibitionMode) {
          ctx.exhibitionParentRef.current = 'main-menu';
          ctx.navigate('exhibition');
        } else if (expState.activeSubMode === 'botpack') {
          ctx.expConfigParentRef.current = 'main-menu';
          ctx.navigate('exp-botpack-9700488');
        } else {
          ctx.expConfigParentRef.current = 'main-menu';
          ctx.navigate('exp-multi-bots');
        }
      }}
      onLeaveRoom={async () => {
        if (ctx.bridge.onLeaveOnlineServer) {
          await ctx.bridge.onLeaveOnlineServer();
        }
        ctx.setMatchMode('freeplay');
        ctx.closeMenu();
      }}
    />
  ),

  'play': (ctx) => (
    <Layer2PlayRecipe
      isLight={ctx.isLight}
      onBack={ctx.goBack}
      onSelectExhibition={() => {
        ctx.exhibitionParentRef.current = 'play';
        ctx.navigate('exhibition');
      }}
      onSelectHostMatch={() => {
        useAppStore.getState().setOnlineSession({ roomType: 'match', gameMode: '1v1' });
        ctx.navigate('host-match');
      }}
      onSelectJoinRoom={() => {
        useAppStore.getState().setOnlineSession({ roomType: 'match', gameMode: '1v1' });
        ctx.navigate('join-room');
      }}
      onSelectSelfTraining={() => ctx.navigate('self-training')}
    />
  ),

  'self-training': (ctx) => (
    <Layer3SelfTrainingRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'static-training-pack': (ctx) => (
    <Layer4StaticTrainingPackBrowseRecipe
      isLight={ctx.isLight}
      isDevMode={false}
      onBack={ctx.goBack}
      onStartPlaySession={async (uuid) => {
        const store = useStaticTrainingPackStore.getState();
        await store.selectPack(uuid, 'normal');
        store.setSessionMode('play');
        ctx.bridge.onStartStaticTrainingPack?.('play');
        ctx.closeMenu();
      }}
      onStartEditSession={async (uuid) => {
        const store = useStaticTrainingPackStore.getState();
        await store.beginEditSession(uuid, 'normal');
        ctx.bridge.onStartStaticTrainingPack?.('edit');
        ctx.closeMenu();
      }}
    />
  ),

  'kickoff-training': (ctx) => (
    <Layer3KickoffTrainingRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'host-match': (ctx) => (
    <Layer3HostMatchRecipe isLight={ctx.isLight} roomType="match" onBack={ctx.goBack} />
  ),

  'join-room': (ctx) => (
    <Layer3JoinRoomRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'host-training': (ctx) => (
    <Layer3HostTrainingRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'custom-play': (ctx) => (
    <Layer3CustomPlayRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'manage-room': (ctx) => (
    <Layer2ManageRoomRecipe
      isLight={ctx.isLight}
      onBack={ctx.goBack}
      onCloseRoom={async () => {
        if (ctx.bridge.onLeaveOnlineServer) {
          await ctx.bridge.onLeaveOnlineServer();
        }
        ctx.setMatchMode('freeplay');
        ctx.closeMenu();
      }}
    />
  ),

  'exhibition': (ctx) => (
    <Layer3ExhibitionRecipe
      isLight={ctx.isLight}
      onBack={() => ctx.navigate(ctx.exhibitionParentRef.current)}
    />
  ),

  'garage': (ctx) => (
    <Layer2GarageRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'settings': (ctx) => (
    <Layer2SettingsRecipe
      isLight={ctx.isLight}
      activeTab={ctx.settingsTargetTab}
      onTabChange={ctx.setSettingsTargetTab}
      highlightSetting={ctx.highlightSetting}
      onClearHighlight={ctx.clearHighlightSetting}
      onBack={ctx.goBack}
      onNavigateAcousticsEqualizer={() => ctx.navigate('acoustics-equalizer')}
      onNavigateTrajectoryDetail={() => {
        ctx.resetLivePreviewToExpanded();
        ctx.navigate('trajectory');
      }}
      onNavigateCameraDetail={() => {
        ctx.resetLivePreviewToExpanded();
        ctx.navigate('camera');
      }}
      onNavigateKeybindingsDetail={() => ctx.navigate('keybindings')}
      onNavigateTrainingDetail={() => ctx.navigate('training-config')}
      onNavigateAdvancedAudio={() => ctx.navigate('advanced-audio')}
      onNavigateEventTriggerRules={() => ctx.navigate('event-trigger-rules')}
      onNavigateExpMultiBots={() => {
        ctx.expConfigParentRef.current = 'settings';
        ctx.navigate('exp-multi-bots');
      }}
      onNavigateDevSandboxes={() => ctx.navigate('dev-sandboxes')}
      onNavigateDevActiveTuners={() => ctx.navigate('dev-active-tuners')}
      onNavigateDevCalibratedPresets={() => ctx.navigate('dev-calibrated-presets')}
      onNavigateDevQuickActions={() => ctx.navigate('dev-quick-actions')}
      onNavigateDevSelfTest={() => ctx.navigate('dev-self-test')}
      onNavigateDevUnderDevelopment={() => ctx.navigate('dev-under-development')}
    />
  ),

  'dev-sandboxes': (ctx) => (
    <Layer3DevSandboxesRecipe
      isLight={ctx.isLight}
      onBack={ctx.goBack}
      onNavigateExpMultiBots={() => {
        useExperimentalMultiBotsStore.getState().activateMultiBotsSubMode(false);
        ctx.expConfigParentRef.current = 'dev-sandboxes';
        ctx.navigate('exp-multi-bots');
      }}
      onNavigateExpBotpack9700488={() => {
        useExperimentalMultiBotsStore.getState().activateBotpackSubMode(undefined, false);
        ctx.expConfigParentRef.current = 'dev-sandboxes';
        ctx.navigate('exp-botpack-9700488');
      }}
      onNavigateTemPackConverter={() => {
        ctx.navigate('dev-tem-pack-converter');
      }}
    />
  ),

  'dev-tem-pack-converter': (ctx) => (
    <Layer4StaticTrainingPackBrowseRecipe
      isLight={ctx.isLight}
      isDevMode={true}
      onBack={ctx.goBack}
      onStartPlaySession={async (uuid) => {
        const store = useStaticTrainingPackStore.getState();
        await store.selectPack(uuid, 'dev');
        store.setSessionMode('play');
        ctx.bridge.onStartStaticTrainingPack?.('play');
        ctx.closeMenu();
      }}
      onStartEditSession={async (uuid) => {
        const store = useStaticTrainingPackStore.getState();
        await store.beginEditSession(uuid, 'dev');
        ctx.bridge.onStartStaticTrainingPack?.('edit');
        ctx.closeMenu();
      }}
    />
  ),

  'dev-active-tuners': (ctx) => (
    <Layer3DevActiveTunersRecipe
      isLight={ctx.isLight}
      onBack={ctx.goBack}
      onNavigateAdvancedAudio={() => ctx.navigate('advanced-audio')}
      onNavigateEventTriggerRules={() => ctx.navigate('event-trigger-rules')}
    />
  ),

  'dev-calibrated-presets': (ctx) => (
    <Layer3DevCalibratedPresetsRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'dev-quick-actions': (ctx) => (
    <Layer3DevQuickActionsRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'dev-self-test': (ctx) => (
    <Layer3DevSelfTestRecipe
      isLight={ctx.isLight}
      onBack={ctx.goBack}
      onNavigateSignalingLab={() => ctx.navigate('dev-signaling-lab')}
    />
  ),

  'dev-under-development': (ctx) => (
    <Layer3DevUnderDevelopmentRecipe
      isLight={ctx.isLight}
      onBack={ctx.goBack}
      onNavigateSignalingLab={() => ctx.navigate('dev-signaling-lab')}
    />
  ),

  'dev-remote-profile': (ctx) => (
    <Layer3DevRemoteProfileRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'dev-signaling-lab': (ctx) => (
    <Layer4DevSignalingLabRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'exp-multi-bots': (ctx) => (
    <Layer3ExpMultiBotsRecipe
      isLight={ctx.isLight}
      onBack={() => ctx.navigate(ctx.expConfigParentRef.current || 'dev-sandboxes')}
    />
  ),

  'exp-botpack-9700488': (ctx) => (
    <Layer3ExpBotPackRecipe
      isLight={ctx.isLight}
      onBack={() => ctx.navigate(ctx.expConfigParentRef.current || 'dev-sandboxes')}
    />
  ),

  'training-config': (ctx) => (
    <Layer3TrainingConfigRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'trajectory': (ctx) => (
    <Layer3BallTrajectoryRecipe
      isLight={ctx.isLight}
      transparent={true}
      onBack={() => {
        ctx.resetLivePreviewToExpanded();
        ctx.goBack();
      }}
      onCollapsePreview={ctx.handleTriggerCollapse}
    />
  ),

  'camera': (ctx) => (
    <Layer3CameraRecipe
      isLight={ctx.isLight}
      onBack={() => {
        ctx.resetLivePreviewToExpanded();
        ctx.goBack();
      }}
      onCollapsePreview={ctx.handleTriggerCollapse}
    />
  ),

  'acoustics-equalizer': (ctx) => (
    <Layer3AcousticsEqualizerRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'keybindings': (ctx) => (
    <Layer3KeybindingsRecipe
      standalone
      isLight={ctx.isLight}
      onBack={ctx.goBack}
      onNavigateAdvanced={() => ctx.navigate('controller-settings')}
    />
  ),

  'controller-settings': (ctx) => (
    <Layer4ControllerSettingsRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'advanced-audio': (ctx) => (
    <Layer4AdvancedAudioRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'event-trigger-rules': (ctx) => (
    <Layer4EventTriggerRulesRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),
};

export function renderActiveMenuRoute(ctx: MenuRouteRenderContext): React.ReactNode {
  const renderer = MENU_ROUTE_RENDERERS[ctx.activeRoute];
  return renderer ? renderer(ctx) : null;
}
