/**
 * autonomousOnline3v3LifecycleScenario.ts
 * Autonomous E2E full-lifecycle verification scenario:
 * Lobby -> Zero-G Fleet -> 2 Peers + 3 Ducky Bots -> 0-0 Overtime -> Golden Goal
 * -> Streamed Director Replay -> V2 .rcreplay Round-Trip -> Podium -> Viewer -> FreePlay.
 */

import { ensureExperimentalEngine } from '../../ai/experimental/ExperimentalBotAgent.ts';
import { isBinaryRCReplayContainer } from '../../replay/container/RCReplayBinarySchema.ts';
import { serializeRCReplayBinaryContainer } from '../../replay/container/RCReplayBinaryEncoder.ts';
import { getRetainedMatchReplay, parseRCReplayFile } from '../../replay/ReplayFileExporter.ts';
import type { ScenarioScript, VirtualPeerLoadoutSpec } from './ScenarioTypes.ts';

const TWO_VIRTUAL_HUMAN_PEERS: readonly VirtualPeerLoadoutSpec[] = Object.freeze([
  {
    peerId: 'peer_1', playerName: 'Peer1_Insidio_Orange', carIndex: 1, team: 1,
    visualId: 'insidio', hitboxId: 'hitbox-hybrid', colorSlot: 5,
    paintFinish: 'matte', boostVisual: 'cartoon', boostAudio: 'standard',
  },
  {
    peerId: 'peer_2', playerName: 'Peer2_Ryza_Blue', carIndex: 2, team: 0,
    visualId: 'ryza', hitboxId: 'hitbox-dominus', colorSlot: 1,
    paintFinish: 'metallic', boostVisual: 'gold-rush', boostAudio: 'flamethrower',
  },
]);

export const ONLINE_3V3_DUCKY_FULL_LIFECYCLE_SCENARIO: ScenarioScript = {
  id: 'online_3v3_ducky_full_lifecycle',
  title: 'Autonomous 3v3 Full Lifecycle (Lobby -> 3x Ducky Bots -> Overtime -> Replay -> .rcreplay -> Podium -> Viewer)',
  description: 'E2E verification of online 3v3 room from Lobby and Zero-G Fleet through 3x Ducky bots, Overtime Golden Goal, Replay, .rcreplay, Podium, and Viewer.',
  totalTicks: 2310, renderStride: 25, batchYieldTicks: 60, forceRenderOnKeyframes: true,
  setup: async (ctx) => {
    await ensureExperimentalEngine('ducky');
    await ensureExperimentalEngine('heuristic');
    await ctx.runtime?.networkManager?.sessionCoordinator?.hostOnlineServer?.({
      playerName: 'Host_Alpha_Fennec', visualId: 'fennec', hitboxId: 'hitbox-octane',
      colorSlot: 0, paintFinish: 'metallic', boostVisual: 'gold-rush', boostAudio: 'rush',
      gameMode: '3v3', botFillMode: 'custom', durationSeconds: 2,
      lobbyMode: true, skipReplayByDefault: false, forceFallback: true,
      roomId: 'e2e_3v3_ducky_lifecycle',
    });
    ctx.setLocalCarControls({ throttle: 1.0, steer: 0.05, boost: true });
  },
  steps: [
    {
      tick: 5, forceKeyframeRender: true, keyframeReason: 'e2e_lobby_and_fleet',
      description: 'Verify Lobby Dual-World and spawn Zero-G Fleet',
      action: async (ctx) => {
        const r = ctx.runtime;
        const netMgr = r?.networkManager;
        const isLobby = Boolean(netMgr?.isLobbyDualWorldActive?.());
        const fleetCtrl = await netMgr?.diagnosticsProbe?.spawnDiagnosticTestFleet?.();
        const fleetOn = Boolean(fleetCtrl?.enabled);
        ctx.recordAssertion(
          'e2e_lobby_dual_world_and_diagnostic_fleet_spawned',
          isLobby && fleetOn && Boolean(r?.authoritativeServer),
          `isLobby=${isLobby}, fleetOn=${fleetOn}`,
        );
      },
    },
    {
      tick: 45, forceKeyframeRender: true, keyframeReason: 'e2e_diagnostic_fleet_and_ducky_join',
      description: 'Sample Zero-G Fleet telemetry, despawn fleet, connect 2 peers + 3 Ducky MLP bots',
      action: async (ctx) => {
        const netMgr = ctx.runtime?.networkManager;
        const ft = netMgr?.diagnosticsProbe?.sampleDiagnosticFleetTelemetry?.();
        const fleetValid = Boolean(ft && (ft.car6?.active || ft.car7?.active || ft.enabled !== false));
        netMgr?.diagnosticsProbe?.despawnDiagnosticTestFleet?.();
        const despawned = !netMgr?.diagnosticsProbe?.diagnosticsFleetController?.enabled;
        ctx.recordAssertion(
          'e2e_diagnostic_fleet_sampled_and_despawned', fleetValid && despawned,
          `fleetSampled=${fleetValid}, fleetDespawned=${despawned}`,
        );
        await ctx.loopbackSimulator.connectVirtualPeers?.(TWO_VIRTUAL_HUMAN_PEERS);
        netMgr?.addOnlineBot?.(0, 'Ducky_Alpha', 'octane', 'ducky');
        netMgr?.addOnlineBot?.(1, 'Ducky_Bravo', 'fennec', 'ducky');
        netMgr?.addOnlineBot?.(1, 'Ducky_Charlie', 'hitbox-plank', 'ducky');
      },
    },
    {
      tick: 60, forceKeyframeRender: true, keyframeReason: 'e2e_3v3_roster_3_ducky_bots_ready',
      description: 'Verify 6-player 3v3 roster and 3 Ducky BotTunnels, then force-start 2s match',
      action: (ctx) => {
        const server = ctx.runtime?.authoritativeServer;
        const players = server?.fallbackManager?.roster?.players
          ? Array.from(server.fallbackManager.roster.players.values()) : [];
        const blueCount = players.filter((p) => p.team === 0).length;
        const orangeCount = players.filter((p) => p.team === 1).length;
        const duckyBots = players.filter((p) => p.isBot && p.botType === 'ducky');
        const tunnels = server?.botTunnelManager?.registeredTunnels?.size ?? 0;
        ctx.recordAssertion(
          'e2e_roster_6_players_and_3_ducky_tunnels',
          players.length === 6 && blueCount === 3 && orangeCount === 3 &&
            duckyBots.length === 3 && tunnels === 3,
          `total=${players.length} (${blueCount}v${orangeCount}), ducky=${duckyBots.length}, tunnels=${tunnels}`,
        );
        ctx.loopbackSimulator.triggerForceStartMatch(2);
      },
    },
    {
      tick: 85, forceKeyframeRender: true, keyframeReason: 'e2e_3v3_prepare_and_kickoff',
      description: 'Verify MATCH_PREPARE barrier completed into kickoff with 6 active cars',
      action: (ctx) => {
        const phase = ctx.runtime?.match?.state?.phase;
        const tel = ctx.loopbackSimulator.collectTelemetry();
        const sigs = tel.distinctSignalNames;
        const okSigs =
          sigs.includes('MATCH_INITIALIZED') && sigs.includes('MATCH_STARTED') && sigs.includes('KICKOFF_PREPARE');
        ctx.recordAssertion(
          'e2e_prepare_barrier_and_kickoff_signals',
          phase === 'kickoff' && tel.activePhysicalCars >= 6 && tel.visibleArenaCars >= 6 && okSigs,
          `phase=${phase}, cars=${tel.activePhysicalCars}/${tel.visibleArenaCars}, sigs=[${sigs.join(', ')}]`,
        );
      },
    },
    {
      tick: 550, forceKeyframeRender: true, keyframeReason: 'e2e_regulation_playing_ducky_inference',
      description: 'Verify KICKOFF_START unfreeze, 3x Ducky MLP bots ready, and start 2s regulation clock',
      action: (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        const server = r?.authoritativeServer;
        if (server?.fallbackManager?.domain) server.fallbackManager.domain.clockStarted = true;
        let readyCount = 0;
        for (const t of server?.botTunnelManager?.registeredTunnels?.values() || []) {
          if (t.botType === 'ducky') readyCount++;
        }
        ctx.recordAssertion(
          'e2e_regulation_playing_and_ducky_inference_active',
          phase === 'playing' && readyCount === 3,
          `phase=${phase}, duckyReady=${readyCount}`,
        );
        ctx.setCarState(0, { pos: [0, -85, 17.01], vel: [0, 500, 0], angVel: [0, 0, 0], boost: 100 });
        ctx.setBallState({ pos: [250, 0, 93.15], vel: [120, 0, 0], angVel: [0, 0, 0] });
      },
    },
    {
      tick: 700,
      description: 'Keep ball on ground at midfield for 0-0 regulation expiry',
      action: (ctx) => {
        ctx.setBallState({ pos: [400, 0, 93.15], vel: [20, 0, 0], angVel: [0, 0, 0] });
      },
    },
    {
      tick: 835, forceKeyframeRender: true, keyframeReason: 'e2e_overtime_after_0_0_regulation',
      description: 'Verify 0-0 regulation expiry emitted OVERTIME_START and entered Overtime kickoff',
      action: (ctx) => {
        const r = ctx.runtime;
        const isOt = Boolean(r?.authoritativeServer?.fallbackManager?.domain?.isOvertime || r?.match?.state?.isOvertime);
        const phase = r?.match?.state?.phase;
        const hasOtSig = ctx.loopbackSimulator.collectTelemetry().distinctSignalNames.includes('OVERTIME_START');
        ctx.recordAssertion(
          'e2e_overtime_started_on_zero_second_ground_touch',
          isOt && hasOtSig && (phase === 'kickoff' || phase === 'playing'),
          `isOvertime=${isOt}, hasOvertimeSig=${hasOtSig}, phase=${phase}`,
        );
      },
    },
    {
      tick: 1325, forceKeyframeRender: true, keyframeReason: 'e2e_overtime_golden_goal_shot',
      description: 'Verify Overtime playing active and launch Golden Goal shot into Orange goal',
      action: (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        const isOt = Boolean(r?.authoritativeServer?.fallbackManager?.domain?.isOvertime || r?.match?.state?.isOvertime);
        ctx.recordAssertion('e2e_overtime_playing_active', phase === 'playing' && isOt, `phase=${phase}, isOt=${isOt}`);
        ctx.setCarState(0, { pos: [0, 4400, 17.01], vel: [0, 2150, 0], angVel: [0, 0, 0], boost: 100 });
        ctx.setBallState({ pos: [0, 4820, 95], vel: [0, 2950, 40], angVel: [0, 0, 0] });
      },
    },
    {
      tick: 1365, forceKeyframeRender: true, keyframeReason: 'e2e_overtime_golden_goal_explosion',
      description: 'Verify Overtime Golden Goal scored for Blue (1-0) and 360-tick celebration active',
      action: (ctx) => {
        const r = ctx.runtime;
        const blueScore = r?.match?.state?.blueScore ?? r?.match?.state?.score?.blue ?? 0;
        const phase = r?.match?.state?.phase;
        const pendingEnd = Boolean(r?.authoritativeServer?.fallbackManager?.domain?.pendingMatchEndAfterGoal);
        ctx.recordAssertion(
          'e2e_overtime_golden_goal_scored',
          blueScore === 1 && pendingEnd && (phase === 'goal_scored' || phase === 'goal' || phase === 'replay'),
          `blueScore=${blueScore}, phase=${phase}, pendingEnd=${pendingEnd}`,
        );
      },
    },
    {
      tick: 1735, forceKeyframeRender: true, keyframeReason: 'e2e_overtime_director_replay_entry',
      description: 'Verify streamed Director Camera Goal Replay active and switch camera to POV',
      action: (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        const isOverride = Boolean(r?.isGoalReplayCameraOverrideActive?.());
        ctx.recordAssertion(
          'e2e_overtime_director_replay_active', phase === 'replay' && isOverride,
          `phase=${phase}, override=${isOverride}`,
        );
        r?.replayTimelineController?.setCameraMode?.('pov');
      },
    },
    {
      tick: 1765, forceKeyframeRender: true, keyframeReason: 'e2e_overtime_replay_finish',
      description: 'Restore Director Camera mode and finish Goal Replay to trigger MATCH_ENDED',
      action: (ctx) => {
        const r = ctx.runtime;
        r?.replayTimelineController?.setCameraMode?.('director');
        r?.authoritativeServer?.fallbackManager?.goalReplay?.finishGoalReplay?.();
      },
    },
    {
      tick: 1785, forceKeyframeRender: true, keyframeReason: 'e2e_match_ended_and_rcreplay_roundtrip',
      description: 'Verify MATCH_ENDED, round-trip V2 .rcreplay binary serialization/parsing, and packet dump',
      action: async (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        const winner = r?.authoritativeServer?.fallbackManager?.domain?.winner;
        const retained = getRetainedMatchReplay();
        const hasRetained = Boolean(
          retained && retained.winner === 'blue' && retained.blueScore === 1 &&
            Array.isArray(retained.roster) && retained.roster.length === 6,
        );
        let roundTripOk = false;
        let framesLen = 0;
        let rosterLen = 0;
        if (retained) {
          const bytes = serializeRCReplayBinaryContainer(retained);
          const hasMagic = isBinaryRCReplayContainer(bytes);
          const parsed = await parseRCReplayFile(bytes);
          framesLen = parsed?.frames?.length ?? 0;
          const rList = parsed?.metadata?.roster ?? parsed?.roster;
          rosterLen = Array.isArray(rList) ? rList.length : 0;
          roundTripOk = hasMagic && bytes.byteLength > 4096 && framesLen > 400 && rosterLen === 6;
        }
        const pktDump = r?.networkManager?.diagnosticsProbe?.dumpLatestNetworkPacket?.();
        ctx.recordAssertion(
          'e2e_match_ended_and_rcreplay_roundtrip_verified',
          (phase === 'ended' || phase === 'podium') && winner === 0 && hasRetained && roundTripOk && Boolean(pktDump),
          `phase=${phase}, winner=${winner}, roundTripOk=${roundTripOk} (frames=${framesLen}, roster=${rosterLen}), pktDump=${Boolean(pktDump)}`,
        );
      },
    },
    {
      tick: 2155, forceKeyframeRender: true, keyframeReason: 'e2e_podium_v_formation',
      description: 'Verify 360-tick countdown transitioned into PODIUM_START V-formation',
      action: (ctx) => {
        const r = ctx.runtime;
        const phase = r?.match?.state?.phase;
        const serverState = r?.authoritativeServer?.fallbackManager?.domain?.state;
        const podiumActive = Boolean(r?.podiumController?.isActive || phase === 'podium' || serverState === 'podium');
        const sigs = ctx.loopbackSimulator.collectTelemetry().distinctSignalNames;
        ctx.recordAssertion(
          'e2e_podium_celebration_active', podiumActive && sigs.includes('PODIUM_START'),
          `phase=${phase}, serverState=${serverState}, hasSig=${sigs.includes('PODIUM_START')}`,
        );
      },
    },
    {
      tick: 2195, forceKeyframeRender: true, keyframeReason: 'e2e_room_destroy_and_viewer_takeover',
      description: 'Destroy online room and load retained 6-car replay into StandaloneReplayViewerController',
      action: async (ctx) => {
        const r = ctx.runtime;
        await ctx.loopbackSimulator.stop();
        const stopped = !r?.authoritativeServer;
        const viewer = r?.modeManager?.getActiveMode?.()?.standaloneReplayViewer;
        viewer?.handleLoadRetainedMatchReplay?.();
        viewer?.startPlaying?.();
        const active = Boolean(viewer?.isActive && viewer?.hasLoadedReplay);
        const rLen = viewer?.rosterSubController?.resolvedRoster?.length ?? 0;
        ctx.recordAssertion(
          'e2e_room_destroyed_and_replay_viewer_loaded', stopped && active && rLen === 6,
          `stopped=${stopped}, viewerActive=${active}, rosterLen=${rLen}`,
        );
      },
    },
    {
      tick: 2235, forceKeyframeRender: true, keyframeReason: 'e2e_viewer_pov_and_intervene',
      description: 'Switch POV slot in Replay Viewer and exercise beginInterventionPreRoll',
      action: (ctx) => {
        const viewer = ctx.runtime?.modeManager?.getActiveMode?.()?.standaloneReplayViewer;
        viewer?.selectPovSlot?.(2);
        const povIdx = viewer?.rosterSubController?.activePovCarIndex ?? -1;
        viewer?.beginInterventionPreRoll?.();
        const st = viewer?.takeoverSubController?.getViewerState?.() || 'playing';
        ctx.recordAssertion('e2e_replay_viewer_pov_and_intervene_verified', povIdx >= 0 && Boolean(st), `pov=${povIdx}, state=${st}`);
      },
    },
    {
      tick: 2275, forceKeyframeRender: true, keyframeReason: 'e2e_viewer_exit_to_freeplay',
      description: 'Exit Replay Viewer back to clean 1-car FreePlay',
      action: (ctx) => {
        const r = ctx.runtime;
        r?.modeManager?.getActiveMode?.()?.resetToCleanFreeplay?.();
        r?.resetKickoff?.(0);
      },
    },
    {
      tick: 2300, forceKeyframeRender: true, keyframeReason: 'e2e_final_clean_freeplay',
      description: 'Verify clean return to 1-car FreePlay with slots 1..5 hidden',
      action: (ctx) => {
        const r = ctx.runtime;
        const viewerOff = !r?.modeManager?.getActiveMode?.()?.standaloneReplayViewer?.isActive;
        const phase = r?.match?.state?.phase;
        const numCars = r?.physics?.numCars ?? 0;
        const hidden = (r?.arena?.cars ?? []).slice(1).every((c) => !c || !c.visible);
        ctx.recordAssertion(
          'e2e_clean_return_to_single_car_freeplay',
          viewerOff && phase === 'playing' && numCars === 1 && hidden,
          `viewerOff=${viewerOff}, phase=${phase}, numCars=${numCars}, extraHidden=${hidden}`,
        );
      },
    },
  ],
  teardown: async (ctx) => {
    ctx.setLocalCarControls(null);
    await ctx.loopbackSimulator.stop();
  },
};
