/**
 * online3v3FullLifecycleScenario.ts — Automated WebGL2 & authoritative server baseline scenario
 * covering Stage A + Stage B of the 3v3 Online Lobby & Match full lifecycle.
 */

import { ensureExperimentalEngine } from '../../ai/experimental/ExperimentalBotAgent.ts';
import { INCIDENT_EVENT_TYPES as INC, MATCH_SIGNALS as SIG } from '../../physics/RocketSimConstants.ts';
import { eventStreamStore, hudStore } from '../runtimeUiPort.ts';
import type { ScenarioScript, ScenarioStepContext } from './ScenarioTypes.ts';

interface RosterEntry {
  sessionId: string; name: string; team: number; carIndex: number;
  isBot?: boolean; botType?: string; visualId: string; hitboxId: string;
}

interface OnlinePort {
  selectedPreset?: string; selectedHitbox?: string | null;
  podiumController?: { isActive?: boolean } | null;
  physics?: { setCarState?(i: number, s: Record<string, unknown>): void } | null;
  loadoutCoordinator?: {
    changePlayerVehicle(v: string, h?: string | null): void; setCarColor(i: number, c: number | string, b?: boolean): void;
  } | null;
  arena?: { isLobbyMode?: boolean; isHostLobby?: boolean; cars?: Array<{ visible?: boolean } | null> } | null;
  networkManager?: {
    setOnlineBotFillMode?(m: string, bt?: string): void; forceStartOnlineMatch?(sec?: number | null): void;
    diagnosticsProbe?: { lobbyGhostMode?: boolean } | null;
    sessionCoordinator?: {
      hostOnlineServer?(o: Record<string, unknown>): Promise<unknown>;
      stopOnlineServer?(o?: { rebindLoopback?: boolean }): Promise<void> | void;
    } | null;
  } | null;
  authoritativeServer?: {
    lastServerTick?: number; lastRoomState?: Record<string, unknown> | null;
    fallbackSim?: {
      setCarState?(i: number, s: Record<string, unknown>): void; saveCompactState?(): Float32Array;
      getCarStateView?(i: number): { isDemoed?: boolean | number } | null;
    } | null;
    botTunnelManager?: {
      registeredTunnels?: Map<string, { botType: string; carIndex: number }>; syncFromRoomState?(rs: Record<string, unknown> | null): void;
    } | null;
    fallbackPhysics?: {
      inputBuffer?: { maxReceivedTickByCar?: Map<number, number> } | null; lastAcknowledgedControls?: Map<number, Record<string, unknown>>;
    } | null;
    fallbackManager?: {
      destroy?(): void; domain?: { state?: string; isOvertime?: boolean; pendingMatchEndAfterGoal?: boolean } | null;
      roster?: { players?: Map<string, RosterEntry> } | null; commandQueue?: { replaySignalLog?: Array<{ signalType: number }> } | null;
    } | null;
  } | null;
  networkReconciler?: { reconcile?(now?: number): void; syncTimeline?(s: Float32Array | null, t: number, n?: number): void } | null;
  match?: {
    state?: { mode?: string; phase?: string; overtime?: boolean; winner?: string | null; blueScore?: number; score?: { blue?: number } } | null;
  } | null;
}

const port = (ctx: ScenarioStepContext): OnlinePort => ctx.runtime as unknown as OnlinePort;
const hasSig = (r: OnlinePort, t: number): boolean =>
  Boolean(r.authoritativeServer?.fallbackManager?.commandQueue?.replaySignalLog?.some((e) => e?.signalType === t));

export const ONLINE_3V3_FULL_LIFECYCLE_SCENARIO: ScenarioScript = {
  id: 'online_3v3_full_lifecycle',
  title: 'Online Lobby Dual-World -> 3v3 Lightweight Bots (Heuristic & Ducky) -> Overtime -> Podium -> Destroy',
  description:
    'Validates 3v3 Lobby Ghost, live loadout switch, 3v3 bots (heuristic + ducky MLP), KICKOFF_PREPARE/GO, combat/movement incidents, OVERTIME_START, golden goal, MATCH_ENDED, PODIUM_START, and MATCH_DESTROYED.',
  totalTicks: 2140, renderStride: 20, batchYieldTicks: 60, forceRenderOnKeyframes: true,
  setup: async (ctx) => {
    const r = port(ctx);
    await ensureExperimentalEngine('ducky');
    if (r.authoritativeServer || r.networkReconciler) {
      await r.networkManager?.sessionCoordinator?.stopOnlineServer?.({ rebindLoopback: false });
    }
    await r.networkManager?.sessionCoordinator?.hostOnlineServer?.({
      gameMode: '3v3', botFillMode: 'no_bots', botType: 'heuristic', lobbyMode: true,
      durationSeconds: 2, skipReplayByDefault: true, roomId: 'bench_3v3_lifecycle', forceFallback: true,
    });
    ctx.setLocalCarControls({ throttle: 0.5, steer: 0.0, boost: false });
  },
  steps: [
    {
      tick: 5, forceKeyframeRender: true, keyframeReason: 'online_lobby_dual_world_ghost_active',
      description: 'Verify Online Room and Lobby Ghost active',
      action: (ctx) => {
        const r = port(ctx);
        const st = r.authoritativeServer?.fallbackManager?.domain?.state;
        const ok = Boolean(
          r.authoritativeServer && r.networkReconciler && r.arena?.isLobbyMode &&
          r.arena?.isHostLobby && r.networkManager?.diagnosticsProbe?.lobbyGhostMode && st === 'lobby'
        );
        ctx.recordAssertion('online_lobby_dual_world_ghost_active', ok, `isLobby=${r.arena?.isLobbyMode}, state=${st}`);
      },
    },
    {
      tick: 15, description: 'Switch player vehicle and color in Lobby',
      action: (ctx) => {
        const r = port(ctx);
        r.loadoutCoordinator?.changePlayerVehicle('insidio', 'hitbox-hybrid');
        r.loadoutCoordinator?.setCarColor(0, '#29b6f6', true);
      },
    },
    {
      tick: 25, forceKeyframeRender: true, keyframeReason: 'online_lobby_loadout_switched',
      description: 'Verify loadout switch synced to server roster',
      action: (ctx) => {
        const r = port(ctx);
        const hp = r.authoritativeServer?.fallbackManager?.roster?.players?.get('host');
        const ok = r.selectedPreset === 'insidio' && r.selectedHitbox === 'hitbox-hybrid' &&
          hp?.visualId === 'insidio' && hp?.hitboxId === 'hitbox-hybrid';
        ctx.recordAssertion('online_lobby_loadout_switched_and_synced', ok, `local=${r.selectedPreset}, host=${hp?.visualId}`);
      },
    },
    {
      tick: 30, description: 'Auto-Fill 3v3 Bots (heuristic + ducky) and force-start match',
      action: (ctx) => {
        const r = port(ctx);
        r.networkManager?.setOnlineBotFillMode?.('auto_fill', 'heuristic');
        r.networkManager?.forceStartOnlineMatch?.(2);
        const srv = r.authoritativeServer;
        const players = srv?.fallbackManager?.roster?.players;
        if (players) {
          for (const id of ['bot_fill_4', 'bot_fill_5']) {
            const b = players.get(id);
            if (b) { b.botType = 'ducky'; b.name = id === 'bot_fill_4' ? 'Ducky #4' : 'Ducky #5'; }
          }
          const rs = srv?.lastRoomState as { roster?: { players?: Array<Record<string, unknown>> } } | null;
          for (const rp of rs?.roster?.players || []) {
            if (rp.sessionId === 'bot_fill_4' || rp.sessionId === 'bot_fill_5') rp.botType = 'ducky';
          }
          srv?.botTunnelManager?.syncFromRoomState?.(srv?.lastRoomState ?? null);
        }
      },
    },
    {
      tick: 45, forceKeyframeRender: true, keyframeReason: 'online_3v3_kickoff_prepare',
      description: 'Verify 3v3 roster (host + heuristic + ducky) and KICKOFF_PREPARE',
      action: (ctx) => {
        const r = port(ctx);
        const list = Array.from(r.authoritativeServer?.fallbackManager?.roster?.players?.values() || []);
        const blue = list.filter((p) => p.team === 0).length;
        const orange = list.filter((p) => p.team === 1).length;
        const tunnels = r.authoritativeServer?.botTunnelManager?.registeredTunnels;
        const types = tunnels ? Array.from(tunnels.values()).map((t) => t.botType) : [];
        const visible = (r.arena?.cars || []).filter((c) => c?.visible).length;
        const ok =
          list.length === 6 && blue === 3 && orange === 3 && tunnels?.size === 5 &&
          types.includes('heuristic') && types.includes('ducky') && !r.arena?.isLobbyMode &&
          visible >= 6 && r.match?.state?.phase === 'kickoff' && hasSig(r, SIG.KICKOFF_WILL_START);
        ctx.recordAssertion('online_3v3_bots_mounted_and_kickoff_prepare', ok, `players=${list.length}, tunnels=${tunnels?.size}`);
      },
    },
    {
      tick: 520, forceKeyframeRender: true, keyframeReason: 'online_3v3_kickoff_go_and_bot_inference',
      description: 'Verify KICKOFF_GO, bot CarControls output, and trigger Car 0 Jump + Boost + Touch',
      action: (ctx) => {
        const r = port(ctx);
        const phase = r.match?.state?.phase;
        const hasGo = hasSig(r, SIG.KICKOFF_START);
        const fp = r.authoritativeServer?.fallbackPhysics;
        const hTick = fp?.inputBuffer?.maxReceivedTickByCar?.get?.(1) ?? 0;
        const dTick = fp?.inputBuffer?.maxReceivedTickByCar?.get?.(4) ?? 0;
        const ack = fp?.lastAcknowledgedControls;
        const valid = [1, 2, 3, 4, 5].every((s) => Boolean(ack?.get?.(s)) && Number.isFinite(Number(ack?.get?.(s)?.throttle ?? 0)));
        ctx.recordAssertion(
          'online_3v3_kickoff_go_and_lightweight_bots_active',
          phase === 'playing' && hasGo && hTick > 0 && dTick > 0 && valid,
          `phase=${phase}, go=${hasGo}, hTick=${hTick}, dTick=${dTick}`,
        );
        ctx.setCarState(0, { pos: [0, -140, 17.01], vel: [0, 1400, 0], angVel: [0, 0, 0], boost: 100 });
        ctx.setBallState({ pos: [0, 0, 93.15], vel: [0, 350, 0], angVel: [0, 0, 0] });
        ctx.setLocalCarControls({ throttle: 1.0, pitch: 0.0, jump: true, boost: true });
      },
    },
    {
      tick: 530, description: 'Release Jump while airborne',
      action: (ctx) => ctx.setLocalCarControls({ throttle: 1.0, pitch: 0.0, jump: false, boost: true }),
    },
    {
      tick: 540, description: 'Execute forward Dodge while boosting',
      action: (ctx) => ctx.setLocalCarControls({ throttle: 1.0, pitch: -1.0, jump: true, boost: true }),
    },
    {
      tick: 552, description: 'Launch Car 0 supersonic along +X into Car 4 for Demolition',
      action: (ctx) => {
        const r = port(ctx);
        ctx.setLocalCarControls({ throttle: 1.0, pitch: 0.0, jump: false, boost: true });
        const basis = { fwd: [1, 0, 0], right: [0, 1, 0], up: [0, 0, 1], angVel: [0, 0, 0], isOnGround: true, isFlipping: false };
        const victim = { ...basis, pos: [0, -1500, 17.01], vel: [0, 0, 0], boost: 33, isSupersonic: false };
        const attacker = { ...basis, pos: [-220, -1500, 17.01], vel: [2295, 0, 0], boost: 100, isSupersonic: true };
        const sim = r.authoritativeServer?.fallbackSim;
        sim?.setCarState?.(4, victim);
        sim?.setCarState?.(0, attacker);
        r.physics?.setCarState?.(4, victim);
        r.physics?.setCarState?.(0, attacker);
        const snap = sim?.saveCompactState?.() || null;
        if (snap) r.networkReconciler?.syncTimeline?.(snap, r.authoritativeServer?.lastServerTick ?? 0, ctx.virtualTimeMs);
      },
    },
    {
      tick: 585, forceKeyframeRender: true, keyframeReason: 'online_3v3_combat_and_movement_incidents',
      description: 'Verify Boost, Jump, Dodge, Ball-Hit, and Demolition incidents',
      action: (ctx) => {
        const r = port(ctx);
        const snap = eventStreamStore.getSnapshot?.() as { events?: Array<Record<string, unknown>> } | undefined;
        const evs = Array.isArray(snap?.events) ? snap.events : [];
        const hasJump = evs.some((e) => e.type === INC.CAR_JUMP);
        const hasDodge = evs.some((e) => e.type === INC.CAR_DODGE || e.type === INC.CAR_DOUBLE_JUMP);
        const hasBoost = evs.some((e) => e.type === INC.CAR_BOOST_START);
        const hasBallHit = evs.some((e) => e.type === INC.CAR_BALL_HIT);
        const hasDemo =
          evs.some((e) => e.type === INC.CAR_CAR_DEMO || e.type === SIG.DEMOLITION) ||
          hasSig(r, SIG.DEMOLITION) || Boolean(r.authoritativeServer?.fallbackSim?.getCarStateView?.(4)?.isDemoed);
        ctx.recordAssertion(
          'online_3v3_combat_and_movement_incidents_verified',
          hasJump && hasDodge && hasBoost && hasBallHit && hasDemo,
          `jump=${hasJump}, dodge=${hasDodge}, boost=${hasBoost}, hit=${hasBallHit}, demo=${hasDemo}`,
        );
        ctx.setLocalCarControls({ throttle: 0, boost: false, jump: false });
        ctx.setBallState({ pos: [1500, 0, 93.15], vel: [0, 0, 0], angVel: [0, 0, 0] });
      },
    },
    {
      tick: 635, description: 'Ground ball as regulation clock reaches 0:00',
      action: (ctx) => ctx.setBallState({ pos: [1500, 0, 93.15], vel: [0, 0, 0], angVel: [0, 0, 0] }),
    },
    {
      tick: 820, forceKeyframeRender: true, keyframeReason: 'online_3v3_overtime_kickoff',
      description: 'Verify OVERTIME_START + Overtime kickoff',
      action: (ctx) => {
        const r = port(ctx);
        const ot = Boolean(
          r.match?.state?.overtime || hudStore?.getState?.()?.isOvertime ||
          r.authoritativeServer?.fallbackManager?.domain?.isOvertime
        );
        const sig = hasSig(r, SIG.OVERTIME_START);
        const phase = r.match?.state?.phase;
        ctx.recordAssertion('online_3v3_overtime_started', ot && sig && phase === 'kickoff', `ot=${ot}, sig=${sig}, phase=${phase}`);
      },
    },
    {
      tick: 1310, description: 'Verify Overtime playing and launch golden goal',
      action: (ctx) => {
        const r = port(ctx);
        ctx.recordAssertion('online_3v3_overtime_playing_active', r.match?.state?.phase === 'playing', `phase=${r.match?.state?.phase}`);
        ctx.setBallState({ pos: [0, 5050, 100], vel: [0, 2900, 20], angVel: [0, 0, 0] });
      },
    },
    {
      tick: 1345, forceKeyframeRender: true, keyframeReason: 'online_3v3_overtime_golden_goal',
      description: 'Verify Overtime golden goal scored by Blue',
      action: (ctx) => {
        const r = port(ctx);
        const blue = r.match?.state?.blueScore ?? r.match?.state?.score?.blue ?? 0;
        const phase = r.match?.state?.phase;
        const pending = Boolean(r.authoritativeServer?.fallbackManager?.domain?.pendingMatchEndAfterGoal);
        const sig = hasSig(r, SIG.SCORE_UPDATED);
        ctx.recordAssertion(
          'online_3v3_overtime_golden_goal_scored',
          blue === 1 && (phase === 'goal' || phase === 'ended') && pending && sig,
          `blue=${blue}, phase=${phase}, pending=${pending}`,
        );
      },
    },
    {
      tick: 1720, forceKeyframeRender: true, keyframeReason: 'online_3v3_match_ended',
      description: 'Verify transition into MATCH_ENDED',
      action: (ctx) => {
        const r = port(ctx);
        const phase = r.match?.state?.phase;
        const winner = r.match?.state?.winner;
        const sig = hasSig(r, SIG.MATCH_ENDED);
        ctx.recordAssertion('online_3v3_match_ended', phase === 'ended' && winner === 'BLUE' && sig, `phase=${phase}, winner=${winner}`);
      },
    },
    {
      tick: 2090, forceKeyframeRender: true, keyframeReason: 'online_3v3_podium_started',
      description: 'Verify PODIUM_START with active PodiumController',
      action: (ctx) => {
        const r = port(ctx);
        const phase = r.match?.state?.phase;
        const active = Boolean(r.podiumController?.isActive);
        const sig = hasSig(r, SIG.PODIUM_START);
        ctx.recordAssertion('online_3v3_podium_started', phase === 'podium' && active && sig, `phase=${phase}, active=${active}`);
      },
    },
    {
      tick: 2120, forceKeyframeRender: true, keyframeReason: 'online_3v3_match_destroyed_and_freeplay_return',
      description: 'Dispatch MATCH_DESTROYED and verify return to Freeplay',
      action: async (ctx) => {
        const r = port(ctx);
        r.authoritativeServer?.fallbackManager?.destroy?.();
        r.networkReconciler?.reconcile?.(ctx.virtualTimeMs);
        const podiumExited = !r.podiumController?.isActive;
        await r.networkManager?.sessionCoordinator?.stopOnlineServer?.({ rebindLoopback: false });
        const mode = r.match?.state?.mode;
        const cleared = !r.authoritativeServer;
        ctx.recordAssertion('online_3v3_match_destroyed_and_returned_to_freeplay', podiumExited && mode === 'freeplay' && cleared, `mode=${mode}`);
      },
    },
  ],
  teardown: async (ctx) => {
    ctx.setLocalCarControls(null);
    const r = port(ctx);
    if (r.authoritativeServer || r.networkReconciler) {
      await r.networkManager?.sessionCoordinator?.stopOnlineServer?.({ rebindLoopback: false });
    }
  },
};
