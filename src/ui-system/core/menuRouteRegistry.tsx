import React from 'react';
import { useAppStore } from '../../ui-core/stores/appStore.ts';
import { type AppState } from '../../ui-core/stores/appStoreTypes.ts';
import { type ActiveMenuRoute } from '../../ui-core/config/uiConfig.ts';
import { type MenuPanelId } from '../../ui-core/tokens/menuLayoutTokens.ts';
import { useExperimentalMultiBotsStore } from '../../ui-core/stores/experimentalMultiBotsStore.ts';
import { useStaticTrainingPackStore } from '../../ui-core/stores/staticTrainingPackStore.ts';
import { Layer1MainMenuRecipe } from '../../ui-core/recipes/Layer1MainMenuRecipe.tsx';
import { Layer2PlayRecipe } from '../../ui-core/recipes/Layer2PlayRecipe.tsx';
import { Layer2GarageRecipe } from '../../ui-core/recipes/Layer2GarageRecipe.tsx';
import { Layer2SettingsRecipe } from '../../ui-core/recipes/Layer2SettingsRecipe.tsx';
import { Layer2ManageRoomRecipe } from '../../ui-core/recipes/Layer2ManageRoomRecipe.tsx';
import { Layer3AcousticsEqualizerRecipe } from '../../ui-core/recipes/Layer3AcousticsEqualizerRecipe.tsx';
import { Layer3BallTrajectoryRecipe } from '../../ui-core/recipes/Layer3BallTrajectoryRecipe.tsx';
import { Layer3ExhibitionRecipe } from '../../ui-core/recipes/Layer3ExhibitionRecipe.tsx';
import { Layer3CameraRecipe } from '../../ui-core/recipes/Layer3CameraRecipe.tsx';
import { Layer3KeybindingsRecipe } from '../../ui-core/recipes/Layer3KeybindingsRecipe.tsx';
import { Layer3TrainingConfigRecipe } from '../../ui-core/recipes/Layer3TrainingConfigRecipe.tsx';
import { Layer3HostMatchRecipe } from '../../ui-core/recipes/Layer3HostMatchRecipe.tsx';
import { Layer3JoinRoomRecipe } from '../../ui-core/recipes/Layer3JoinRoomRecipe.tsx';
import { Layer3HostTrainingRecipe } from '../../ui-core/recipes/Layer3HostTrainingRecipe.tsx';
import { Layer3CustomPlayRecipe } from '../../ui-core/recipes/Layer3CustomPlayRecipe.tsx';
import { Layer3KickoffTrainingRecipe } from '../../ui-core/recipes/Layer3KickoffTrainingRecipe.tsx';
import { Layer3SelfTrainingRecipe } from '../../ui-core/recipes/Layer3SelfTrainingRecipe.tsx';
import { Layer3ExpMultiBotsRecipe } from '../../ui-core/recipes/Layer3ExpMultiBotsRecipe.tsx';
import { Layer3ExpBotPackRecipe } from '../../ui-core/recipes/Layer3ExpBotPackRecipe.tsx';
import { Layer3DevSandboxesRecipe } from '../../ui-core/recipes/Layer3DevSandboxesRecipe.tsx';
import { Layer3DevActiveTunersRecipe } from '../../ui-core/recipes/Layer3DevActiveTunersRecipe.tsx';
import { Layer3DevCalibratedPresetsRecipe } from '../../ui-core/recipes/Layer3DevCalibratedPresetsRecipe.tsx';
import { Layer3DevQuickActionsRecipe } from '../../ui-core/recipes/Layer3DevQuickActionsRecipe.tsx';
import { Layer3DevSelfTestRecipe } from '../../ui-core/recipes/Layer3DevSelfTestRecipe.tsx';
import { Layer3DevUnderDevelopmentRecipe } from '../../ui-core/recipes/Layer3DevUnderDevelopmentRecipe.tsx';
import { Layer3DevRemoteProfileRecipe } from '../../ui-core/recipes/Layer3DevRemoteProfileRecipe.tsx';
import { Layer4ControllerSettingsRecipe } from '../../ui-core/recipes/Layer4ControllerSettingsRecipe.tsx';
import { Layer4AdvancedAudioRecipe } from '../../ui-core/recipes/Layer4AdvancedAudioRecipe.tsx';
import { Layer4EventTriggerRulesRecipe } from '../../ui-core/recipes/Layer4EventTriggerRulesRecipe.tsx';
import { Layer4StaticTrainingPackBrowseRecipe } from '../../ui-core/recipes/Layer4StaticTrainingPackBrowseRecipe.tsx';
import { Layer4DevSignalingLabRecipe } from '../../ui-core/recipes/Layer4DevSignalingLabRecipe.tsx';
import { openStaticTrainingExitConfirmDialogue as openPureStaticTrainingExitConfirmDialogue } from '../../ui-core/recipes/StaticTrainingShotInspectorDrawer.tsx';

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
  play: 'layer2-play',
  exhibition: 'layer3-exhibition',
  'self-training': 'layer3-self-training',
  'kickoff-training': 'layer3-kickoff-training',
  'static-training-pack': 'layer4-static-training-pack',
  'host-match': 'layer3-host-match',
  'join-room': 'layer3-join-room',
  'host-training': 'layer3-host-training',
  'custom-play': 'layer3-custom-play',
  'manage-room': 'layer2-manage-room',
  garage: 'layer2-garage',
  settings: 'layer2-settings',
  'acoustics-equalizer': 'layer3-acoustics-equalizer',
  trajectory: 'layer3-ball-trajectory',
  camera: 'layer3-camera',
  'training-config': 'layer3-training-config',
  keybindings: 'layer3-keybindings',
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
      onBack={ctx.closeMenu}
      onTabChange={(target) => {
        if (target === 'play') {
          ctx.navigate('play');
        } else if (target === 'garage') {
          ctx.navigate('garage');
        } else if (target.startsWith('settings')) {
          const tab = target.split(':')[1];
          if (tab) ctx.setSettingsTargetTab(tab);
          ctx.navigate('settings');
        } else if (target === 'manage-room') {
          ctx.navigate('manage-room');
        } else if (target === 'exp-multi-bots') {
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
        } else if (target === 'restart-match') {
          ctx.bridge.onRestartMatch?.();
        } else if (target === 'return-freeplay') {
          ctx.setMatchMode('freeplay');
          ctx.closeMenu();
          ctx.bridge.onReturnToFreeplay?.();
        } else if (target === 'leave-room') {
          void (async () => {
            if (ctx.bridge.onLeaveOnlineServer) {
              await ctx.bridge.onLeaveOnlineServer();
            }
            ctx.setMatchMode('freeplay');
            ctx.closeMenu();
          })();
        } else if (target === 'exit-edit-mode') {
          openStaticTrainingExitConfirmDialogue(() => {
            ctx.closeMenu();
            ctx.bridge.onReturnToFreeplay?.();
          });
        }
      }}
    />
  ),

  play: (ctx) => (
    <Layer2PlayRecipe
      isLight={ctx.isLight}
      onBack={ctx.goBack}
      onTabChange={(modeId) => {
        if (modeId === 'exhibition') {
          ctx.exhibitionParentRef.current = 'play';
          ctx.navigate('exhibition');
        } else if (modeId === 'host-match') {
          useAppStore.getState().setOnlineSession({ roomType: 'match', gameMode: '1v1' });
          ctx.navigate('host-match');
        } else if (modeId === 'join-room') {
          useAppStore.getState().setOnlineSession({ roomType: 'match', gameMode: '1v1' });
          ctx.navigate('join-room');
        } else if (modeId === 'self-training') {
          ctx.navigate('self-training');
        } else if (modeId === 'online-training') {
          ctx.navigate('host-training');
        } else if (modeId === 'advanced') {
          ctx.navigate('custom-play');
        }
      }}
    />
  ),

  'self-training': (ctx) => <Layer3SelfTrainingRecipe isLight={ctx.isLight} onBack={ctx.goBack} />,

  'static-training-pack': (ctx) => (
    <Layer4StaticTrainingPackBrowseRecipe
      isLight={ctx.isLight}
      isDevMode={false}
      onBack={ctx.goBack}
    />
  ),

  'kickoff-training': (ctx) => (
    <Layer3KickoffTrainingRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'host-match': (ctx) => (
    <Layer3HostMatchRecipe isLight={ctx.isLight} roomType="match" onBack={ctx.goBack} />
  ),

  'join-room': (ctx) => <Layer3JoinRoomRecipe isLight={ctx.isLight} onBack={ctx.goBack} />,

  'host-training': (ctx) => <Layer3HostTrainingRecipe isLight={ctx.isLight} onBack={ctx.goBack} />,

  'custom-play': (ctx) => <Layer3CustomPlayRecipe isLight={ctx.isLight} onBack={ctx.goBack} />,

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

  exhibition: (ctx) => (
    <Layer3ExhibitionRecipe
      isLight={ctx.isLight}
      onBack={() => ctx.navigate(ctx.exhibitionParentRef.current)}
    />
  ),

  garage: (ctx) => <Layer2GarageRecipe isLight={ctx.isLight} onBack={ctx.goBack} />,

  settings: (ctx) => (
    <Layer2SettingsRecipe
      isLight={ctx.isLight}
      activeTab={ctx.settingsTargetTab}
      onTabChange={ctx.setSettingsTargetTab}
      onBack={ctx.goBack}
    />
  ),

  'dev-sandboxes': (ctx) => <Layer3DevSandboxesRecipe isLight={ctx.isLight} onBack={ctx.goBack} />,

  'dev-tem-pack-converter': (ctx) => (
    <Layer4StaticTrainingPackBrowseRecipe
      isLight={ctx.isLight}
      isDevMode={true}
      onBack={ctx.goBack}
    />
  ),

  'dev-active-tuners': (ctx) => (
    <Layer3DevActiveTunersRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'dev-calibrated-presets': (ctx) => (
    <Layer3DevCalibratedPresetsRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'dev-quick-actions': (ctx) => (
    <Layer3DevQuickActionsRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  'dev-self-test': (ctx) => <Layer3DevSelfTestRecipe isLight={ctx.isLight} onBack={ctx.goBack} />,

  'dev-under-development': (ctx) => (
    <Layer3DevUnderDevelopmentRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
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

  trajectory: (ctx) => (
    <Layer3BallTrajectoryRecipe
      isLight={ctx.isLight}
      onBack={() => {
        ctx.resetLivePreviewToExpanded();
        ctx.goBack();
      }}
    />
  ),

  camera: (ctx) => (
    <Layer3CameraRecipe
      isLight={ctx.isLight}
      onBack={() => {
        ctx.resetLivePreviewToExpanded();
        ctx.goBack();
      }}
    />
  ),

  'acoustics-equalizer': (ctx) => (
    <Layer3AcousticsEqualizerRecipe isLight={ctx.isLight} onBack={ctx.goBack} />
  ),

  keybindings: (ctx) => <Layer3KeybindingsRecipe isLight={ctx.isLight} onBack={ctx.goBack} />,

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
