import React, { useState, useEffect, useRef } from 'react';
import { LogOut } from 'lucide-react';
import { useAppStore } from '../../ui-core/stores/appStore';
import { useUIStore } from '../../ui-core/stores/uiStore';
import { type ActiveMenuRoute } from '../../ui-core/config/uiConfig';
import { floatingStore } from '../../ui-core/stores/floatingStore';
import { MorphingShell } from '../../ui-core/navigation/MorphingShell';
import { FloatingStackIcon } from '../../ui-core/navigation/FloatingStackIcon';
import { FloatingWindowManager } from '../../ui-core/navigation/FloatingWindowManager';
import {
  renderFloatingWindowContent,
  handleFloatingStackCloseWindow,
} from './floatingWindowRegistry';
import { HitboxReferenceOverlayLayer } from './HitboxReferenceOverlayLayer';
import { QuickNotificationSystem } from '../../ui-core/navigation/QuickNotificationSystem';
import { DialogueStackContainer } from '../../ui-core/compounds/dialogue/dialogueStore';
import { useQuickNotificationStore } from '../../ui-core/stores/quickNotificationStore';
import '../../ui-core/stores/cameraDeterminismStore';
import {
  useMenuLayoutStore,
  DEFAULT_PANEL_SIZING,
  type MenuPanelId,
} from '../../ui-core/stores/menuLayoutStore';
import { Layer1MainMenuRecipe } from '../../ui-core/recipes/Layer1MainMenuRecipe';
import { Layer2PlayRecipe } from '../../ui-core/recipes/Layer2PlayRecipe';
import { Layer2GarageRecipe } from '../../ui-core/recipes/Layer2GarageRecipe';
import { Layer2SettingsRecipe } from '../../ui-core/recipes/Layer2SettingsRecipe';
import { Layer3AudioEqRecipe } from '../../ui-core/recipes/Layer3AudioEqRecipe';
import { Layer3BallTrajectoryRecipe } from '../../ui-core/recipes/Layer3BallTrajectoryRecipe';
import { Layer3ExhibitionRecipe } from '../../ui-core/recipes/Layer3ExhibitionRecipe';
import { Layer3CameraRecipe } from '../../ui-core/recipes/Layer3CameraRecipe';
import { Layer3KeybindingsRecipe } from '../../ui-core/recipes/Layer3KeybindingsRecipe';
import { Layer4ControllerSettingsRecipe } from '../../ui-core/recipes/Layer4ControllerSettingsRecipe';
import { Layer3TrainingRecipe } from '../../ui-core/recipes/Layer3TrainingRecipe';
import { Layer4AdvancedAudioRecipe } from '../../ui-core/recipes/Layer4AdvancedAudioRecipe';
import { Layer4EventTriggerRulesRecipe } from '../../ui-core/recipes/Layer4EventTriggerRulesRecipe';
import { Layer3HostMatchRecipe } from '../../ui-core/recipes/Layer3HostMatchRecipe';
import { Layer3JoinRoomRecipe } from '../../ui-core/recipes/Layer3JoinRoomRecipe';
import { Layer3HostTrainingRecipe } from '../../ui-core/recipes/Layer3HostTrainingRecipe';
import { Layer3CustomPlayRecipe } from '../../ui-core/recipes/Layer3CustomPlayRecipe';
import { Layer2RoomHostControlRecipe } from '../../ui-core/recipes/Layer2RoomHostControlRecipe';
import { Layer3KickoffTrainingRecipe } from '../../ui-core/recipes/Layer3KickoffTrainingRecipe';
import { Layer3SelfTrainingRecipe } from '../../ui-core/recipes/Layer3SelfTrainingRecipe';
import { Layer3ExpMultiBotsRecipe } from '../../ui-core/recipes/Layer3ExpMultiBotsRecipe';
import { useExperimentalMultiBotsStore } from '../../ui-core/stores/experimentalMultiBotsStore';
import { Layer3DevSubsystemIsolationRecipe } from '../../ui-core/recipes/Layer3DevSubsystemIsolationRecipe';
import { Layer3DevActiveTunersRecipe } from '../../ui-core/recipes/Layer3DevActiveTunersRecipe';
import { Layer3DevCalibratedPresetsRecipe } from '../../ui-core/recipes/Layer3DevCalibratedPresetsRecipe';
import { Layer3DevUnderDevelopmentRecipe } from '../../ui-core/recipes/Layer3DevUnderDevelopmentRecipe';
import { Layer4StaticTrainingPackBrowseRecipe } from '../../ui-core/recipes/Layer4StaticTrainingPackBrowseRecipe';
import {
  Layer5StaticTrainingPackEditRecipe,
  openStaticTrainingExitConfirmDialogue as openPureStaticTrainingExitConfirmDialogue,
} from '../../ui-core/recipes/Layer5StaticTrainingPackEditRecipe';
import { EdgeInspectorDrawer } from '../../ui-core/navigation/EdgeInspectorDrawer';
import { useStaticTrainingPackStore } from '../../ui-core/stores/staticTrainingPackStore';
import { StaticTrainingPackHUD } from '../../ui-core/hud/StaticTrainingPackHUD';

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

export type LivePreviewAnimPhase =
  | 'expanded'
  | 'collapsing_content'
  | 'collapsing_resize'
  | 'collapsed'
  | 'expanding_content'
  | 'expanding_resize';

export const ROUTE_TO_PANEL_ID: Record<ActiveMenuRoute, MenuPanelId> = {
  'main-menu': 'layer1-main',
  'play': 'layer2-play',
  'exhibition': 'layer3-exhibition',
  'self-training': 'layer3-self-training',
  'kickoff-training': 'layer3-kickoff-training',
  'static-training-pack': 'layer4-static-training-pack',
  'online-warmup': 'layer3-online-warmup',
  'host-match': 'layer3-host-match',
  'join-room': 'layer3-join-room',
  'host-training': 'layer3-host-training',
  'custom-play': 'layer3-custom-play',
  'room-host-control': 'layer2-room-host-control',
  'garage': 'layer2-garage',
  'settings': 'layer2-settings',
  'audio-eq': 'layer3-audio-eq',
  'trajectory': 'layer3-ball-trajectory',
  'camera': 'layer3-camera',
  'training': 'layer3-training',
  'keybindings': 'layer3-keybindings',
  'advanced-controller': 'layer4-controller-settings',
  'advanced-audio': 'layer4-advanced-audio',
  'event-and-triggerer': 'layer4-event-trigger-rules',
  'exp-multi-bots-config': 'layer3-exp-multi-bots',
  'dev-subsystem-isolation': 'layer3-dev-subsystem-isolation',
  'dev-sandboxes': 'layer3-dev-subsystem-isolation',
  'dev-active-tuners': 'layer3-dev-active-tuners',
  'dev-calibrated-presets': 'layer3-dev-calibrated-presets',
  'dev-under-development': 'layer3-dev-under-development',
};

export interface MenuShellProps {
  inspectorSlot?: React.ReactNode;
}

export const MenuShell: React.FC<MenuShellProps> = ({ inspectorSlot }) => {
  const isOpen = useAppStore((s) => s.isOpen);
  const closeMenu = useAppStore((s) => s.closeMenu);
  const activeRoute = useAppStore((s) => s.activeRoute);
  const navigate = useAppStore((s) => s.navigate);
  const goBack = useAppStore((s) => s.goBack);
  const theme = useAppStore((s) => s.theme);
  const matchMode = useAppStore((s) => s.matchMode);
  const bridge = useAppStore((s) => s.bridge);
  const isLivePreviewCollapsed = useAppStore((s) => s.isLivePreviewCollapsed);
  const setLivePreviewCollapsed = useAppStore((s) => s.setLivePreviewCollapsed);
  const settingsTargetTab = useAppStore((s) => s.settingsTargetTab);
  const setSettingsTargetTab = useAppStore((s) => s.setSettingsTargetTab);
  const highlightSetting = useAppStore((s) => s.highlightSetting);
  const clearHighlightSetting = useAppStore((s) => s.clearHighlightSetting);
  const onlineSession = useAppStore((s) => s.onlineSession);
  const setMatchMode = useAppStore((s) => s.setMatchMode);
  const uiScale = useUIStore((s) => s.uiScale ?? 100);
  const safeAreaMargin = useUIStore((s) => s.safeAreaMargin ?? 0);

  const staticSessionMode = useStaticTrainingPackStore((s) => s.sessionMode);
  const isEdgeInspectorExpanded = useStaticTrainingPackStore((s) => s.isEdgeInspectorExpanded);
  const setEdgeInspectorExpanded = useStaticTrainingPackStore((s) => s.setEdgeInspectorExpanded);

  const isStaticTrainingEditActive =
    matchMode === 'static-training-pack' && staticSessionMode === 'edit';
  const hasExtraMainMenuItem =
    matchMode === 'match' ||
    matchMode === 'online-warmup' ||
    Boolean(onlineSession?.roomId);

  const isLight = theme === 'light';
  const developerMode = useAppStore((s) => s.developerMode);
  const isLayer1 = activeRoute === 'main-menu';
  const activePanelId = ROUTE_TO_PANEL_ID[activeRoute] || 'layer1-main';
  const activeSizing = useMenuLayoutStore(
    (s) => s.panels?.[activePanelId] ?? DEFAULT_PANEL_SIZING[activePanelId]
  );
  const expConfigParentRef = useRef<ActiveMenuRoute>('settings');
  const botDifficultyParentRef = useRef<ActiveMenuRoute>('play');

  const [liveAnimPhase, setLiveAnimPhase] = useState<LivePreviewAnimPhase>(
    isLivePreviewCollapsed ? 'collapsed' : 'expanded'
  );

  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const clearAllTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  };

  useEffect(() => {
    return () => clearAllTimers();
  }, []);

  const handleTriggerCollapse = () => {
    if (liveAnimPhase !== 'expanded') return;
    clearAllTimers();
    setLiveAnimPhase('collapsing_content');
    const t1 = setTimeout(() => {
      setLiveAnimPhase('collapsing_resize');
      bridge.onOverlayChange?.(false);
      bridge.onResume?.();
      const t2 = setTimeout(() => {
        setLiveAnimPhase('collapsed');
        setLivePreviewCollapsed(true);
      }, 260);
      timersRef.current.push(t2);
    }, 100);
    timersRef.current.push(t1);
  };

  const handleTriggerExpand = () => {
    if (liveAnimPhase !== 'collapsed') return;
    clearAllTimers();
    floatingStore.triggerBatchMinimize();
    setLiveAnimPhase('expanding_content');
    const t1 = setTimeout(() => {
      setLiveAnimPhase('expanding_resize');
      const t2 = setTimeout(() => {
        setLiveAnimPhase('expanded');
        setLivePreviewCollapsed(false);
        bridge.onOverlayChange?.(true);
      }, 260);
      timersRef.current.push(t2);
    }, 80);
    timersRef.current.push(t1);
  };

  const isLivePreviewRoute = activeRoute === 'trajectory' || activeRoute === 'camera';

  useEffect(() => {
    if (isLivePreviewRoute) {
      if (isLivePreviewCollapsed && liveAnimPhase === 'expanded') {
        handleTriggerCollapse();
      } else if (!isLivePreviewCollapsed && liveAnimPhase === 'collapsed') {
        handleTriggerExpand();
      }
    } else {
      clearAllTimers();
      if (liveAnimPhase !== 'expanded') {
        setLiveAnimPhase('expanded');
      }
    }
  }, [isLivePreviewCollapsed, activeRoute, isLivePreviewRoute]);

  const isDockState =
    isLivePreviewRoute &&
    (liveAnimPhase === 'collapsed' ||
      liveAnimPhase === 'collapsing_resize' ||
      liveAnimPhase === 'expanding_content');

  const isContentVisible = !isDockState && liveAnimPhase === 'expanded';
  const isPillContentVisible = liveAnimPhase === 'collapsed';

  const [isShaking, setIsShaking] = useState(false);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerShake = () => {
    if (isShaking) return;
    setIsShaking(true);
    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    shakeTimerRef.current = setTimeout(() => {
      setIsShaking(false);
    }, 360);
  };

  useEffect(() => {
    return () => {
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (matchMode === 'online-warmup' && !onlineSession.signalingConnected) {
      useQuickNotificationStore.getState().pushNotification({
        id: 'signaling-disconnect',
        type: 'persistent',
        tone: 'warning',
        icon: 'wifi-off',
        duration: 0,
        content: 'Signaling server disconnected. Match continuing peer-to-peer.',
        buttons: [
          {
            label: 'Reconnect',
            color: 'amber',
            onClick: () => {
              useAppStore.getState().bridge.onReconnectSignaling?.();
            },
          },
        ],
      });
    } else {
      useQuickNotificationStore.getState().dismissNotification('signaling-disconnect');
    }
  }, [matchMode, onlineSession.signalingConnected]);

  return (
    <>
      <QuickNotificationSystem isLight={isLight} placement="bottom-right" />
      <HitboxReferenceOverlayLayer />
      <FloatingWindowManager
        isLight={isLight}
        renderWindowContent={renderFloatingWindowContent}
      />
      {matchMode === 'static-training-pack' && <StaticTrainingPackHUD isLight={isLight} />}
      <FloatingStackIcon
        isLight={isLight}
        absolute={true}
        isMenuOpen={isOpen && !isDockState}
        blockedTooltipText={
          activeRoute === 'settings'
            ? 'Please close settings window first'
            : 'Please close active menu first'
        }
        onBlockedClick={() => {
          triggerShake();
        }}
        onCloseWindowItem={handleFloatingStackCloseWindow}
      />

      {isStaticTrainingEditActive && (
        <EdgeInspectorDrawer
          isExpanded={isEdgeInspectorExpanded}
          onExpandedChange={(expanded) => {
            setEdgeInspectorExpanded(expanded);
          }}
          side="right"
          topOffset={72}
          bottomOffset={184}
          expandedWidth={520}
          enableHotkey={false}
          isLight={isLight}
        >
          <Layer5StaticTrainingPackEditRecipe
            isLight={isLight}
            transparent={true}
            onCollapseDrawer={() => setEdgeInspectorExpanded(false)}
          />
        </EdgeInspectorDrawer>
      )}
      {!isOpen && isStaticTrainingEditActive && inspectorSlot}

      <MorphingShell
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) closeMenu();
        }}
        width={activeSizing.width}
        height={activeSizing.targetHeight}
        sizing={activeSizing}
        currentKey={activeRoute}
        isLight={isLight}
        isLayer1={isLayer1}
        isDockState={isDockState}
        isContentVisible={isContentVisible}
        isPillContentVisible={isPillContentVisible}
        onExpandDock={handleTriggerExpand}
        isShaking={isShaking}
        onBack={goBack}
        inspectorSlot={inspectorSlot}
        uiScale={uiScale}
        safeAreaMargin={safeAreaMargin}
        hasExtraMainMenuItem={hasExtraMainMenuItem}
        developerMode={developerMode}
      >
        {activeRoute === 'main-menu' && (
          <Layer1MainMenuRecipe
            isLight={isLight}
            onResume={closeMenu}
            onRestartMatch={bridge.onRestartMatch}
            onReturnToFreeplay={bridge.onReturnToFreeplay}
            extraBottomAction={
              isStaticTrainingEditActive
                ? {
                    title: 'Exit Edit Mode',
                    subtitle: 'Save or discard training pack edits & leave editor',
                    icon: <LogOut className="h-5 w-5" />,
                    variant: 'danger',
                    onClick: () => {
                      openStaticTrainingExitConfirmDialogue(() => {
                        closeMenu();
                        bridge.onReturnToFreeplay?.();
                      });
                    },
                  }
                : undefined
            }
            onNavigatePlay={() => navigate('play')}
            onNavigateGarage={() => navigate('garage')}
            onNavigateSettings={(tab) => {
              if (tab) setSettingsTargetTab(tab);
              navigate('settings');
            }}
            onNavigateManageRoom={() => navigate('room-host-control')}
            onNavigateExpMultiBotsConfig={() => {
              if (useExperimentalMultiBotsStore.getState().isExhibitionMode) {
                botDifficultyParentRef.current = 'main-menu';
                navigate('exhibition');
              } else {
                expConfigParentRef.current = 'main-menu';
                navigate('exp-multi-bots-config');
              }
            }}
            onLeaveRoom={async () => {
              if (bridge.onLeaveOnlineServer) {
                await bridge.onLeaveOnlineServer();
              }
              setMatchMode('freeplay');
              closeMenu();
            }}
          />
        )}

        {activeRoute === 'play' && (
          <Layer2PlayRecipe
            isLight={isLight}
            onBack={goBack}
            onSelectExhibition={() => {
              botDifficultyParentRef.current = 'play';
              navigate('exhibition');
            }}
            onSelectHostMatch={() => {
              useAppStore.getState().setOnlineSession({ roomType: 'match', gameMode: '1v1' });
              navigate('host-match');
            }}
            onSelectJoinRoom={() => {
              useAppStore.getState().setOnlineSession({ roomType: 'match', gameMode: '1v1' });
              navigate('join-room');
            }}
            onSelectSelfTraining={() => navigate('self-training')}
          />
        )}

        {activeRoute === 'self-training' && (
          <Layer3SelfTrainingRecipe isLight={isLight} onBack={goBack} />
        )}

        {activeRoute === 'static-training-pack' && (
          <Layer4StaticTrainingPackBrowseRecipe
            isLight={isLight}
            onBack={goBack}
            onStartPlaySession={async (uuid) => {
              const store = useStaticTrainingPackStore.getState();
              await store.selectPack(uuid);
              store.setSessionMode('play');
              bridge.onStartStaticTrainingPack?.('play');
              closeMenu();
            }}
            onStartEditSession={async (uuid) => {
              const store = useStaticTrainingPackStore.getState();
              await store.beginEditSession(uuid);
              bridge.onStartStaticTrainingPack?.('edit');
              closeMenu();
            }}
          />
        )}

        {activeRoute === 'kickoff-training' && (
          <Layer3KickoffTrainingRecipe isLight={isLight} onBack={goBack} />
        )}

        {(activeRoute === 'host-match' || activeRoute === 'online-warmup') && (
          <Layer3HostMatchRecipe
            isLight={isLight}
            onBack={() => {
              if (activeRoute === 'online-warmup') {
                const s = useAppStore.getState().onlineSession;
                if (!s?.roomId && !s?.isHosting) {
                  useAppStore.getState().setOnlineSession({ roomType: 'warmup' });
                }
              }
              goBack();
            }}
          />
        )}

        {activeRoute === 'join-room' && (
          <Layer3JoinRoomRecipe isLight={isLight} onBack={goBack} />
        )}

        {activeRoute === 'host-training' && (
          <Layer3HostTrainingRecipe isLight={isLight} onBack={goBack} />
        )}

        {activeRoute === 'custom-play' && (
          <Layer3CustomPlayRecipe isLight={isLight} onBack={goBack} />
        )}

        {activeRoute === 'room-host-control' && (
          <Layer2RoomHostControlRecipe
            isLight={isLight}
            onBack={goBack}
            onCloseRoom={async () => {
              if (bridge.onLeaveOnlineServer) {
                await bridge.onLeaveOnlineServer();
              }
              setMatchMode('freeplay');
              closeMenu();
            }}
          />
        )}
        {activeRoute === 'exhibition' && (
          <Layer3ExhibitionRecipe
            isLight={isLight}
            onBack={() => navigate(botDifficultyParentRef.current)}
          />
        )}
        {activeRoute === 'garage' && (
          <Layer2GarageRecipe isLight={isLight} onBack={goBack} />
        )}
        {activeRoute === 'settings' && (
          <Layer2SettingsRecipe
            isLight={isLight}
            activeTab={settingsTargetTab}
            onTabChange={setSettingsTargetTab}
            highlightSetting={highlightSetting}
            onClearHighlight={clearHighlightSetting}
            onBack={goBack}
            onNavigateAudioDetail={() => navigate('audio-eq')}
            onNavigateTrajectoryDetail={() => {
              setLiveAnimPhase('expanded');
              navigate('trajectory');
            }}
            onNavigateCameraDetail={() => {
              setLiveAnimPhase('expanded');
              navigate('camera');
            }}
            onNavigateKeybindingsDetail={() => navigate('keybindings')}
            onNavigateTrainingDetail={() => navigate('training')}
            onNavigateAdvancedAudio={() => navigate('advanced-audio')}
            onNavigateEventAndTriggerer={() => navigate('event-and-triggerer')}
            onNavigateExpMultiBots={() => {
              expConfigParentRef.current = 'settings';
              navigate('exp-multi-bots-config');
            }}
            onNavigateDevSandboxes={() => navigate('dev-sandboxes')}
            onNavigateDevActiveTuners={() => navigate('dev-active-tuners')}
            onNavigateDevCalibratedPresets={() => navigate('dev-calibrated-presets')}
            onNavigateDevUnderDevelopment={() => navigate('dev-under-development')}
          />
        )}
        {(activeRoute === 'dev-sandboxes' || activeRoute === 'dev-subsystem-isolation') && (
          <Layer3DevSubsystemIsolationRecipe
            isLight={isLight}
            onBack={goBack}
            onNavigateExpMultiBots={() => {
              expConfigParentRef.current = activeRoute;
              navigate('exp-multi-bots-config');
            }}
          />
        )}
        {activeRoute === 'dev-active-tuners' && (
          <Layer3DevActiveTunersRecipe
            isLight={isLight}
            onBack={goBack}
            onNavigateAdvancedAudio={() => navigate('advanced-audio')}
            onNavigateEventAndTriggerer={() => navigate('event-and-triggerer')}
          />
        )}
        {activeRoute === 'dev-calibrated-presets' && (
          <Layer3DevCalibratedPresetsRecipe isLight={isLight} onBack={goBack} />
        )}
        {activeRoute === 'dev-under-development' && (
          <Layer3DevUnderDevelopmentRecipe isLight={isLight} onBack={goBack} />
        )}
        {activeRoute === 'exp-multi-bots-config' && (
          <Layer3ExpMultiBotsRecipe
            isLight={isLight}
            onBack={() => navigate(expConfigParentRef.current || 'settings')}
          />
        )}
        {activeRoute === 'training' && (
          <Layer3TrainingRecipe isLight={isLight} onBack={goBack} />
        )}
        {activeRoute === 'trajectory' && (
          <Layer3BallTrajectoryRecipe
            isLight={isLight}
            transparent={true}
            onBack={() => {
              setLiveAnimPhase('expanded');
              goBack();
            }}
            onCollapsePreview={handleTriggerCollapse}
          />
        )}
        {activeRoute === 'camera' && (
          <Layer3CameraRecipe
            isLight={isLight}
            onBack={() => {
              setLiveAnimPhase('expanded');
              goBack();
            }}
            onCollapsePreview={handleTriggerCollapse}
          />
        )}
        {activeRoute === 'audio-eq' && (
          <Layer3AudioEqRecipe isLight={isLight} onBack={goBack} />
        )}
        {activeRoute === 'keybindings' && (
          <Layer3KeybindingsRecipe
            isLight={isLight}
            onBack={goBack}
            onNavigateAdvanced={() => navigate('advanced-controller')}
          />
        )}
        {activeRoute === 'advanced-controller' && (
          <Layer4ControllerSettingsRecipe isLight={isLight} onBack={goBack} />
        )}
        {activeRoute === 'advanced-audio' && (
          <Layer4AdvancedAudioRecipe isLight={isLight} onBack={goBack} />
        )}
        {activeRoute === 'event-and-triggerer' && (
          <Layer4EventTriggerRulesRecipe isLight={isLight} onBack={goBack} />
        )}
      </MorphingShell>
      <DialogueStackContainer isLight={isLight} />
    </>
  );
};
