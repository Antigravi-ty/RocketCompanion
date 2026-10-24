import React, { useState, useEffect, useRef } from 'react';
import { useAppStore, type ActiveMenuRoute } from '../../stores/appStore';
import { MorphingShell } from '../navigation/MorphingShell';
import { FloatingStackIcon } from '../navigation/FloatingStackIcon';
import { FloatingWindowManager } from '../navigation/FloatingWindowManager';
import { HitboxReferenceOverlayLayer } from './HitboxReferenceOverlayLayer';
import { QuickNotificationSystem } from '../navigation/QuickNotificationSystem';
import { DialogueStackContainer } from '../primitives/dialogue/dialogueStore';
import { useQuickNotificationStore } from '../../stores/quickNotificationStore';
import '../../stores/cameraDeterminismStore';
import {
  DEFAULT_PANEL_SIZING,
  type MenuPanelId,
} from '../tokens/menuLayoutTokens';
import { Layer1MainMenuRecipe } from '../recipes/Layer1MainMenuRecipe';
import { Layer2PlayRecipe } from '../recipes/Layer2PlayRecipe';
import { Layer2GarageRecipe } from '../recipes/Layer2GarageRecipe';
import { Layer2SettingsRecipe } from '../recipes/settings/Layer2SettingsRecipe';
import { Layer3AudioDetailRecipe } from '../recipes/Layer3AudioDetailRecipe';
import { Layer3BallTrajectoryRecipe } from '../recipes/Layer3BallTrajectoryRecipe';
import { Layer3BotDifficultyRecipe } from '../recipes/Layer3BotDifficultyRecipe';
import { Layer3CameraRecipe } from '../recipes/Layer3CameraRecipe';
import { KeybindingRecipe } from '../recipes/KeybindingRecipe';
import { Layer4AdvancedControllerRecipe } from '../recipes/Layer4AdvancedControllerRecipe';
import { Layer3TrainingRecipe } from '../recipes/Layer3TrainingRecipe';
import { Layer4AdvancedAudioRecipe } from '../recipes/Layer4AdvancedAudioRecipe';
import { Layer4EventAndTriggererRecipe } from '../recipes/Layer4EventAndTriggererRecipe';
import { Layer3OnlineWarmupRecipe } from '../recipes/Layer3OnlineWarmupRecipe';
import { Layer2RoomHostControlRecipe } from '../recipes/Layer2RoomHostControlRecipe';
import { Layer3CustomTrainingRecipe } from '../recipes/Layer3CustomTrainingRecipe';
import { Layer3SelfTrainingRecipe } from '../recipes/Layer3SelfTrainingRecipe';
import { Layer3ExpMultiBotsRecipe } from '../recipes/Layer3ExpMultiBotsRecipe';
import { useExpMultiBotsStore } from '../../stores/expMultiBotsStore';
import { Layer3DevSubsystemIsolationRecipe } from '../recipes/Layer3DevSubsystemIsolationRecipe';
import { Layer3DevSandboxesRecipe } from '../recipes/Layer3DevSandboxesRecipe';
import { Layer3DevActiveTunersRecipe } from '../recipes/Layer3DevActiveTunersRecipe';
import { Layer3DevCalibratedPresetsRecipe } from '../recipes/Layer3DevCalibratedPresetsRecipe';
import { Layer3DevUnderDevelopmentRecipe } from '../recipes/Layer3DevUnderDevelopmentRecipe';
import { Layer4StaticTrainingPackBrowseRecipe } from '../recipes/Layer4StaticTrainingPackBrowseRecipe';
import { Layer5StaticTrainingPackEditRecipe } from '../recipes/Layer5StaticTrainingPackEditRecipe';
import { EdgeInspectorDrawer } from '../navigation/EdgeInspectorDrawer';
import { useStaticTrainingPackStore } from '../../stores/staticTrainingPackStore';
import { StaticTrainingPackHUD } from '../hud/StaticTrainingPackHUD';

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
  'bot-difficulty': 'layer3-bot-difficulty',
  'self-training': 'layer3-self-training',
  'custom-training': 'layer3-custom-training',
  'static-training-pack': 'layer4-static-training-pack',
  'static-training-pack-session': 'layer5-static-training-pack-session',
  'online-warmup': 'layer3-online-warmup',
  'room-host-control': 'layer2-room-host-control',
  'garage': 'layer2-garage',
  'settings': 'layer2-settings',
  'audio-eq': 'layer3-audio-detail',
  'trajectory': 'layer3-ball-trajectory',
  'camera': 'layer3-camera',
  'training': 'layer3-training',
  'keybindings': 'layer3-keybindings',
  'advanced-controller': 'layer4-advanced-controller',
  'advanced-audio': 'layer4-advanced-audio',
  'event-and-triggerer': 'layer4-event-and-triggerer',
  'exp-multi-bots-config': 'layer3-exp-multi-bots',
  'dev-subsystem-isolation': 'layer3-dev-subsystem-isolation',
  'dev-sandboxes': 'layer3-dev-sandboxes',
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

  const isLight = theme === 'light';
  const isLayer1 = activeRoute === 'main-menu';
  const activePanelId = ROUTE_TO_PANEL_ID[activeRoute] || 'layer1-main';
  const activeSizing = DEFAULT_PANEL_SIZING[activePanelId];
  const expConfigParentRef = useRef<ActiveMenuRoute>('settings');
  const botDifficultyParentRef = useRef<ActiveMenuRoute>('play');
  const [onlineWarmupInitialTab, setOnlineWarmupInitialTab] = useState<'host' | 'join'>('host');

  // Live Preview phased state machine (matches UIStorybook commit 108dde1)
  const [liveAnimPhase, setLiveAnimPhase] = useState<LivePreviewAnimPhase>(
    isLivePreviewCollapsed ? 'collapsed' : 'expanded'
  );

  const timersRef = useRef<NodeJS.Timeout[]>([]);
  const clearAllTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  };

  useEffect(() => {
    return () => clearAllTimers();
  }, []);

  // Sequenced transition: Content fade out -> Container resizes & docks to right edge -> Pill fades in
  const handleTriggerCollapse = () => {
    if (liveAnimPhase !== 'expanded') return;
    clearAllTimers();
    setLiveAnimPhase('collapsing_content');
    const t1 = setTimeout(() => {
      setLiveAnimPhase('collapsing_resize');
      // Inputs penetrate to Three.js canvas & simulation unpauses
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

  // Sequenced transition: Pill fades out -> Container resizes back to center -> Content fades in
  const handleTriggerExpand = () => {
    if (liveAnimPhase !== 'collapsed') return;
    clearAllTimers();
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

  const isLivePreviewRoute =
    activeRoute === 'trajectory' ||
    activeRoute === 'camera';

  const isEdgeInspectorRoute =
    activeRoute === 'static-training-pack-session';

  // Synchronize external isLivePreviewCollapsed changes (e.g. TAB shortcut)
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

  // Synchronize 3D input/pause bridge when EdgeInspectorDrawer collapses/expands (via TAB or button)
  useEffect(() => {
    if (!isOpen || !isEdgeInspectorRoute) return;
    if (isLivePreviewCollapsed) {
      bridge.onOverlayChange?.(false);
      bridge.onResume?.();
    } else {
      bridge.onOverlayChange?.(true);
    }
  }, [isOpen, isEdgeInspectorRoute, isLivePreviewCollapsed, bridge]);

  // Dock state: whether container is occupying or animating to/from the right edge dock
  const isDockState =
    isLivePreviewRoute &&
    (liveAnimPhase === 'collapsed' ||
      liveAnimPhase === 'collapsing_resize' ||
      liveAnimPhase === 'expanding_content');

  const isContentVisible = !isDockState && liveAnimPhase === 'expanded';
  const isPillContentVisible = liveAnimPhase === 'collapsed';

  // Apple Sheet Shake state (isolated to transient outer wrapper with 360ms auto-reset)
  const [isShaking, setIsShaking] = useState(false);
  const shakeTimerRef = useRef<NodeJS.Timeout | null>(null);

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

  // Persistent warning notification for signaling disconnect
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
      {/* 0. Quick Notification System (Top-Right Drawer, Ongoing Progress & Stack Tray) */}
      <QuickNotificationSystem isLight={isLight} />

      {/* 0.5. Hitbox Reference Image Overlay (Strict Layering: z-[4], above game arena & HUD, below FloatingWindowManager) */}
      <HitboxReferenceOverlayLayer />

      {/* 1. Floating Window Manager (Strict Layering: z-[5], above game arena, below backdrop mask) */}
      <FloatingWindowManager isLight={isLight} />

      {/* 1.5. Static Training Pack Top Floating HUD (Strict Layering: z-[35], visible above menu backdrop) */}
      {matchMode === 'static-training-pack' && <StaticTrainingPackHUD isLight={isLight} />}

      {/* 2. Floating Stack Icon (Strict Layering: z-50, top-right persistent tray) */}
      <FloatingStackIcon
        isLight={isLight}
        absolute={true}
        isMenuOpen={isOpen && !isDockState && !isEdgeInspectorRoute}
        blockedTooltipText={
          activeRoute === 'settings'
            ? 'Please close settings window first'
            : 'Please close active menu first'
        }
        onBlockedClick={() => {
          triggerShake();
        }}
      />

      {/* 2.5. Decoupled 6E Edge Inspector Drawer (Static Training Pack Edit Session, 0% backdrop darkening) */}
      <EdgeInspectorDrawer
        open={isOpen && isEdgeInspectorRoute}
        collapsed={isLivePreviewCollapsed}
        onCollapsedChange={(collapsed) => {
          setLivePreviewCollapsed(collapsed);
        }}
        position="right"
        topOffset={72}
        bottomOffset={184}
        expandedWidth={520}
        isLight={isLight}
      >
        <Layer5StaticTrainingPackEditRecipe
          isLight={isLight}
          transparent={true}
          onCollapseDrawer={() => setLivePreviewCollapsed(true)}
          onExitSession={() => {
            setLivePreviewCollapsed(false);
            goBack();
          }}
        />
      </EdgeInspectorDrawer>
      {isOpen && isEdgeInspectorRoute && inspectorSlot}

      {/* 3. Main Decoupled Stage Shell (z-30) */}
      <MorphingShell
        open={isOpen && !isEdgeInspectorRoute}
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
      >
        {/* Layer 1: Main Pause Menu */}
        {activeRoute === 'main-menu' && (
          <Layer1MainMenuRecipe
            isLight={isLight}
            matchMode={matchMode}
            onResume={closeMenu}
            onRestartMatch={bridge.onRestartMatch}
            onReturnToFreeplay={bridge.onReturnToFreeplay}
            onNavigatePlay={() => {
              navigate('play');
            }}
            onNavigateGarage={() => {
              navigate('garage');
            }}
            onNavigateSettings={(tab) => {
              if (tab) setSettingsTargetTab(tab);
              navigate('settings');
            }}
            onNavigateManageRoom={() => {
              navigate('room-host-control');
            }}
            onNavigateExpMultiBotsConfig={() => {
              if (useExpMultiBotsStore.getState().isExhibitionMode) {
                botDifficultyParentRef.current = 'main-menu';
                navigate('bot-difficulty');
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

        {/* Layer 2: Play Modes Selection */}
        {activeRoute === 'play' && (
          <Layer2PlayRecipe
            isLight={isLight}
            matchMode={matchMode}
            onBack={goBack}
            onSelectExhibition={() => {
              botDifficultyParentRef.current = 'play';
              navigate('bot-difficulty');
            }}
            onSelectHostMatch={() => {
              setOnlineWarmupInitialTab('host');
              useAppStore.getState().setOnlineSession({ roomType: 'match', gameMode: '1v1' });
              navigate('online-warmup');
            }}
            onSelectJoinRoom={() => {
              setOnlineWarmupInitialTab('join');
              useAppStore.getState().setOnlineSession({ roomType: 'match', gameMode: '1v1' });
              navigate('online-warmup');
            }}
            onSelectSelfTraining={() => {
              navigate('self-training');
            }}
            onReturnToFreeplay={bridge.onReturnToFreeplay}
          />
        )}

        {/* Layer 3: Self-Training Hub (Free Play, Static Training Pack, Kickoff Training, Replay Viewer) */}
        {activeRoute === 'self-training' && (
          <Layer3SelfTrainingRecipe
            isLight={isLight}
            matchMode={matchMode}
            onBack={goBack}
            onSelectFreeplay={() => {
              if (bridge.onReturnToFreeplay) {
                bridge.onReturnToFreeplay();
              } else {
                closeMenu();
              }
            }}
            onSelectStaticTrainingPack={() => navigate('static-training-pack')}
            onSelectKickoffTraining={() => navigate('custom-training')}
            onSelectReplayViewer={() => {
              if (matchMode !== 'freeplay' && bridge.onReturnToFreeplay) {
                bridge.onReturnToFreeplay();
              } else {
                closeMenu();
              }
            }}
          />
        )}

        {/* Layer 4: Static Training Pack Browser (2-Column List & Metadata) */}
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
              setLivePreviewCollapsed(false);
              navigate('static-training-pack-session');
            }}
          />
        )}

        {/* Layer 3: Custom Training (Kickoff Training PPO AI) */}
        {activeRoute === 'custom-training' && (
          <Layer3CustomTrainingRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}

        {/* Layer 3: Online Warmup Host/Join Setup */}
        {activeRoute === 'online-warmup' && (
          <Layer3OnlineWarmupRecipe
            isLight={isLight}
            initialTab={onlineWarmupInitialTab}
            onBack={() => {
              const s = useAppStore.getState().onlineSession;
              if (!s?.roomId && !s?.isHosting) {
                useAppStore.getState().setOnlineSession({ roomType: 'warmup' });
              }
              goBack();
            }}
            onHostSuccess={() => navigate('room-host-control')}
            onJoinSuccess={() => navigate('room-host-control')}
          />
        )}

        {/* Layer 2: Online Room Host Control Panel */}
        {activeRoute === 'room-host-control' && (
          <Layer2RoomHostControlRecipe
            isLight={isLight}
            onBack={goBack}
            onLeaveRoom={() => closeMenu()}
          />
        )}

        {/* Layer 3: Bot Difficulty & Solo Duel Setup */}
        {activeRoute === 'bot-difficulty' && (
          <Layer3BotDifficultyRecipe
            isLight={isLight}
            onBack={() => navigate(botDifficultyParentRef.current)}
          />
        )}

        {/* Layer 2: Garage & Vehicle Loadout */}
        {activeRoute === 'garage' && (
          <Layer2GarageRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}

        {/* Layer 2: Settings (3 Tabs: Gameplay, Graphics, Advanced) */}
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
            onNavigateKeybindingsDetail={() => {
              navigate('keybindings');
            }}
            onNavigateTrainingDetail={() => {
              navigate('training');
            }}
            onNavigateAdvancedAudio={() => {
              navigate('advanced-audio');
            }}
            onNavigateEventAndTriggerer={() => {
              navigate('event-and-triggerer');
            }}
            onNavigateExpMultiBots={() => {
              expConfigParentRef.current = 'settings';
              navigate('exp-multi-bots-config');
            }}
            onNavigateDevSandboxes={() => {
              navigate('dev-sandboxes');
            }}
            onNavigateDevActiveTuners={() => {
              navigate('dev-active-tuners');
            }}
            onNavigateDevCalibratedPresets={() => {
              navigate('dev-calibrated-presets');
            }}
            onNavigateDevUnderDevelopment={() => {
              navigate('dev-under-development');
            }}
          />
        )}

        {/* Layer 3: Developer Sandboxes & Isolation Labs */}
        {activeRoute === 'dev-sandboxes' && (
          <Layer3DevSandboxesRecipe
            isLight={isLight}
            onBack={goBack}
            onNavigateSubsystemIsolation={() => {
              navigate('dev-subsystem-isolation');
            }}
            onNavigateExpMultiBots={() => {
              expConfigParentRef.current = 'dev-sandboxes';
              navigate('exp-multi-bots-config');
            }}
          />
        )}

        {/* Layer 3: Subsystem Isolation Selection Menu */}
        {activeRoute === 'dev-subsystem-isolation' && (
          <Layer3DevSubsystemIsolationRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}

        {/* Layer 3: Developer Active Tuners, Audio & Diagnostics */}
        {activeRoute === 'dev-active-tuners' && (
          <Layer3DevActiveTunersRecipe
            isLight={isLight}
            onBack={goBack}
            onNavigateAdvancedAudio={() => navigate('advanced-audio')}
          />
        )}

        {/* Layer 3: Developer Calibrated Presets */}
        {activeRoute === 'dev-calibrated-presets' && (
          <Layer3DevCalibratedPresetsRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}

        {/* Layer 3: Developer 4th Category — Under Development (Unstable / WIP) */}
        {activeRoute === 'dev-under-development' && (
          <Layer3DevUnderDevelopmentRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}

        {/* Layer 3: Experimental Multiple Bots Configuration */}
        {activeRoute === 'exp-multi-bots-config' && (
          <Layer3ExpMultiBotsRecipe
            isLight={isLight}
            onBack={() => navigate(expConfigParentRef.current || 'settings')}
          />
        )}

        {/* Layer 3: Training Configuration */}
        {activeRoute === 'training' && (
          <Layer3TrainingRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}

        {/* Layer 3: Ball Trajectory Predictor & Live Preview Configurator */}
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

        {/* Layer 3: Camera Live Preview Configurator */}
        {activeRoute === 'camera' && (
          <Layer3CameraRecipe
            isLight={isLight}
            transparent={true}
            onBack={() => {
              setLiveAnimPhase('expanded');
              goBack();
            }}
            onCollapsePreview={handleTriggerCollapse}
          />
        )}

        {/* Layer 3: Audio Acoustics & 3-Band EQ */}
        {activeRoute === 'audio-eq' && (
          <Layer3AudioDetailRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}

        {/* Layer 3: Controls & Keybinding Remap */}
        {activeRoute === 'keybindings' && (
          <KeybindingRecipe
            isLight={isLight}
            onBack={goBack}
            onNavigateAdvanced={() => navigate('advanced-controller')}
          />
        )}

        {/* Layer 4: Advanced Controller Hardware & Analog Stick Roles */}
        {activeRoute === 'advanced-controller' && (
          <Layer4AdvancedControllerRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}

        {/* Layer 4: Advanced Audio Settings & Volume Matrix */}
        {activeRoute === 'advanced-audio' && (
          <Layer4AdvancedAudioRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}

        {/* Layer 4: Event & Triggerer (Audio Debounce & Collision Thresholds) */}
        {activeRoute === 'event-and-triggerer' && (
          <Layer4EventAndTriggererRecipe
            isLight={isLight}
            onBack={goBack}
          />
        )}
      </MorphingShell>

      {/* 4. Global Dialogue Stack Container (z-[800], Top-layer confirmations) */}
      <DialogueStackContainer isLight={isLight} />
    </>
  );
};
