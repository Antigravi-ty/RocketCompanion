import React from 'react';
import { Play, Gamepad2, Wrench, Settings, ArrowUpRight, RotateCcw, Router, LogOut, Bot } from 'lucide-react';
import { PanelContainer, PanelContent } from '../layout/Panel';
import { MenuContainer, MenuDivider } from '../navigation/MenuContainer';
import { MenuItem } from '../navigation/MenuItem';
import { Badge } from '../primitives/Badge';
import { KeycapBadge } from '../primitives/KeycapBadge';
import { UI_RADIUS, DEFAULT_PANEL_SIZING, DEFAULT_MENU_LAYOUT_TOKENS } from '../tokens';
import { useAppStore } from '../../stores/appStore';
import { useExpMultiBotsStore } from '../../stores/expMultiBotsStore';

export interface Layer1MainMenuRecipeProps {
  isLight?: boolean;
  matchMode?: 'freeplay' | 'match' | 'online-warmup' | 'kickoff-training' | 'dev-test-lab' | 'exp-multi-bots' | 'static-training-pack';
  onResume?: () => void;
  onRestartMatch?: () => void;
  onReturnToFreeplay?: () => void;
  onNavigatePlay?: () => void;
  onNavigateGarage?: () => void;
  onNavigateSettings?: (targetTab?: string) => void;
  onNavigateManageRoom?: () => void;
  onNavigateExpMultiBotsConfig?: () => void;
  onLeaveRoom?: () => void;
  /** Background render pause indicator status */
  backgroundRenderPaused?: boolean;
  className?: string;
}

/**
 * [Recipe] Layer 1 Main Menu (Root / Width: 420px)
 * Designed for instant in-game ESC menu overlay.
 */
export const Layer1MainMenuRecipe: React.FC<Layer1MainMenuRecipeProps> = ({
  isLight = false,
  matchMode = 'freeplay',
  onResume,
  onRestartMatch,
  onReturnToFreeplay,
  onNavigatePlay,
  onNavigateGarage,
  onNavigateSettings,
  onNavigateManageRoom,
  onNavigateExpMultiBotsConfig,
  onLeaveRoom,
  backgroundRenderPaused = true,
  className = '',
}) => {
  const onlineSession = useAppStore((s) => s.onlineSession);
  const isExhibitionMode = useExpMultiBotsStore((s) => s.isExhibitionMode);
  const isOnlineMatch = onlineSession?.roomType === 'match';
  const isInMatch = matchMode === 'match';
  const isDevTestLab = matchMode === 'dev-test-lab';
  const isExpMultiBots = matchMode === 'exp-multi-bots';
  const isKickoffTraining = matchMode === 'kickoff-training';
  const isStaticTrainingPack = matchMode === 'static-training-pack';
  const hasActiveOnlineRoom =
    matchMode === 'online-warmup' ||
    Boolean(onlineSession?.roomId);
  const isCustomMatch = isOnlineMatch && hasActiveOnlineRoom && !isInMatch && !isDevTestLab && !isExpMultiBots && !isKickoffTraining && !isStaticTrainingPack;
  const isOnlineWarmup =
    !isCustomMatch &&
    hasActiveOnlineRoom &&
    !isInMatch &&
    !isDevTestLab &&
    !isExpMultiBots &&
    !isKickoffTraining &&
    !isStaticTrainingPack;

  let headerTitle = 'MENU';
  if (isInMatch) {
    headerTitle = 'PAUSE';
  } else if (isDevTestLab) {
    headerTitle = 'DEVELOPER TEST LAB';
  } else if (isExpMultiBots) {
    headerTitle = isExhibitionMode ? 'EXHIBITION' : 'EXPERIMENTAL MULTI BOTS';
  } else if (isKickoffTraining) {
    headerTitle = 'KICKOFF TRAINING';
  } else if (isStaticTrainingPack) {
    headerTitle = 'STATIC TRAINING PACK';
  } else if (isCustomMatch) {
    headerTitle = 'CUSTOM MATCH';
  } else if (isOnlineWarmup) {
    headerTitle = 'ONLINE WARMUP';
  }

  const sizing = DEFAULT_PANEL_SIZING['layer1-main'];
  const panelContentPaddingY = DEFAULT_MENU_LAYOUT_TOKENS.panelContentPaddingY;

  return (
    <PanelContainer
      isLight={isLight}
      sizing={sizing}
      className={`w-full ${
        isLight
          ? 'shadow-[0_0_0_1px_rgba(0,0,0,0.12),0_0_24px_rgba(0,0,0,0.16),0_0_48px_rgba(0,0,0,0.10)]'
          : 'shadow-[0_0_0_1px_rgba(255,255,255,0.18),0_0_25px_rgba(0,0,0,0.85),0_0_35px_rgba(255,255,255,0.08)]'
      } ${className}`}
    >
      {/* 1. TOP HEADER: Large Centered "MENU", "PAUSE", "CUSTOM MATCH" or "ONLINE WARMUP" */}
      <div
        data-ui-element="panel-header"
        data-panel-section="header"
        className={`px-6 pt-5 pb-4 border-b select-none text-center transition-colors ${
          isLight
            ? 'border-neutral-200/90 bg-neutral-50/70 text-neutral-900'
            : 'border-neutral-800/80 bg-neutral-900/60 text-white'
        }`}
      >
        <h1 className="text-xl font-black tracking-widest uppercase">
          {headerTitle}
        </h1>
      </div>

      {/* 2. CENTER CONTENT: Resume, Manage Room / Play, Garage, Settings */}
      <PanelContent
        scrollable={true}
        className="px-6"
        style={{
          paddingTop: `${panelContentPaddingY}px`,
          paddingBottom: `${panelContentPaddingY}px`,
        }}
      >
        <MenuContainer ariaLabel="Main Game Menu">
          {/* Resume */}
          <MenuItem
            icon={<Play className="h-5 w-5" />}
            title="Resume Match"
            subtitle="Return to active arena gameplay"
            shortcut="ESC"
            variant="primary"
            autoFocus
            onClick={onResume}
            isLight={isLight}
          />

          <MenuDivider isLight={isLight} />

          {/* If in Custom Match Lobby vs Online Warmup vs Experimental Multi Bots vs Play */}
          {isCustomMatch ? (
            <MenuItem
              icon={<Router className="h-5 w-5 text-amber-400" />}
              title={onlineSession.isHosting ? "Configure Match" : "Inspect Match Details"}
              subtitle={
                onlineSession.isHosting
                  ? "Custom match setup, bot policies & connected players"
                  : "Inspect match settings, ping & connected players"
              }
              hasArrow
              onClick={onNavigateManageRoom}
              isLight={isLight}
            />
          ) : isOnlineWarmup ? (
            <MenuItem
              icon={<Router className="h-5 w-5 text-sky-400" />}
              title={onlineSession.isHosting ? "Configure Room" : "Inspect Room Info"}
              subtitle={
                onlineSession.isHosting
                  ? "Room configuration panel & connected players"
                  : "Inspect room details & connection status"
              }
              hasArrow
              onClick={onNavigateManageRoom}
              isLight={isLight}
            />
          ) : isExpMultiBots ? (
            <MenuItem
              icon={<Bot className="h-5 w-5 text-emerald-400" />}
              title="Configure Match"
              subtitle="Reconfigure team rosters, bot policies, match duration & restart"
              hasArrow
              onClick={onNavigateExpMultiBotsConfig}
              isLight={isLight}
            />
          ) : !isStaticTrainingPack ? (
            <MenuItem
              icon={<Gamepad2 className="h-5 w-5" />}
              title="Play"
              subtitle="Single player bot & multiplayer matches"
              hasArrow
              onClick={onNavigatePlay}
              isLight={isLight}
            />
          ) : null}

          {/* Garage */}
          <MenuItem
            icon={<Wrench className="h-5 w-5" />}
            title="Garage"
            subtitle="Vehicle models, colours & player anthem"
            hasArrow
            onClick={onNavigateGarage}
            isLight={isLight}
          />

          {/* Settings */}
          <MenuItem
            icon={<Settings className="h-5 w-5" />}
            title="Settings"
            subtitle="Gameplay, controls, video & sound"
            hasArrow
            onClick={() => onNavigateSettings?.()}
            isLight={isLight}
          />

          {/* Match Pause Mode or Experimental Multi Bots: Restart Match */}
          {(isInMatch || isExpMultiBots) && (
            <>
              <MenuDivider isLight={isLight} />
              <MenuItem
                icon={<RotateCcw className="h-5 w-5" />}
                title="Restart Match"
                subtitle="Reset score, clock and restart kickoff"
                variant="secondary"
                onClick={onRestartMatch}
                isLight={isLight}
              />
            </>
          )}

          {/* Online Match or Warmup Mode: Leave Room/Match at bottom */}
          {(isOnlineWarmup || isCustomMatch) && (
            <>
              <MenuDivider isLight={isLight} />
              <MenuItem
                icon={<LogOut className="h-5 w-5 text-rose-400" />}
                title={isCustomMatch ? "Leave Match" : "Leave Room"}
                subtitle={isCustomMatch ? "Abandon match session and return to Freeplay" : "Disconnect session and return to Freeplay"}
                variant="secondary"
                onClick={onLeaveRoom}
                isLight={isLight}
              />
            </>
          )}
          {/* Developer Test Lab, Exhibition, Experimental Multi Bots, or Kickoff Training: Return to Free Play at bottom */}
          {(isDevTestLab || isExpMultiBots || isKickoffTraining) && (
            <>
              <MenuDivider isLight={isLight} />
              <MenuItem
                icon={<LogOut className="h-5 w-5 text-amber-400" />}
                title="Exit to Free Play"
                subtitle={
                  isDevTestLab
                    ? "Close Developer Test Lab and return to Free Play"
                    : isExpMultiBots
                      ? isExhibitionMode
                        ? "Leave Exhibition match and return to Free Play"
                        : "Close Experimental Multiple Bots and return to Free Play"
                      : "Leave Kickoff Training and return to Free Play"
                }
                variant="secondary"
                onClick={onReturnToFreeplay}
                isLight={isLight}
              />
            </>
          )}
        </MenuContainer>
      </PanelContent>

      {/* 3. BOTTOM FOOTER: Render Pause Indicator + Settings Shortcut Link */}
      <div
        data-ui-element="panel-footer"
        data-panel-section="footer"
        className={`px-6 py-4 border-t text-xs select-none flex items-center justify-between transition-colors shrink-0 mt-auto relative z-10 ${
          isLight
            ? 'border-neutral-200/90 text-neutral-600 bg-neutral-50/90'
            : 'border-neutral-800/80 text-neutral-400 bg-neutral-900/90'
        }`}
      >
        {/* Left: Background render pause indicator synced with menu power save status */}
        {(() => {
          const powerSave = useAppStore.getState().graphics?.menuPowerSave ?? (backgroundRenderPaused ? 'freeze' : '30');
          let dotColor = 'bg-emerald-500';
          let label = 'Background: 30 FPS';
          if (powerSave === 'freeze') {
            dotColor = 'bg-amber-500 animate-pulse';
            label = 'Background: Freeze';
          } else if (powerSave === '15') {
            dotColor = 'bg-amber-400';
            label = 'Background: 15 FPS';
          } else if (powerSave === '30') {
            dotColor = 'bg-emerald-400';
            label = 'Background: 30 FPS';
          } else if (powerSave === 'match') {
            dotColor = 'bg-emerald-500';
            label = 'Background: Match';
          }

          return (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} />
              <span className="font-mono text-[11px] truncate">{label}</span>
            </div>
          );
        })()}

        {/* Right: Click to change settings navigation shortcut with highlight dispatch */}
        <button
          type="button"
          onClick={() => {
            useAppStore.getState().setHighlightSetting('menu-power-save');
            onNavigateSettings?.('graphics');
          }}
          className={`flex items-center gap-1 font-mono text-[11px] shrink-0 font-medium transition-colors cursor-pointer outline-none ${
            isLight
              ? 'text-neutral-500 hover:text-amber-600'
              : 'text-neutral-400 hover:text-amber-400'
          }`}
          title="Jump directly to Settings -> Graphics (Background Render Power Save)"
        >
          <span>click to change</span>
          <ArrowUpRight className="h-3 w-3 stroke-[2.5]" />
        </button>
      </div>
    </PanelContainer>
  );
};
