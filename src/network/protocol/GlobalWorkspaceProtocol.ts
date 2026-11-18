/**
 * src/network/protocol/GlobalWorkspaceProtocol.ts
 * Global State Broadcast Packet (separated from Match Real-time Data Packet).
 * Carries menu route, floating window open/minimized manifest (without screen coords,
 * notifications, or telemetry), telestrator permission, and replay pause heartbeat state.
 */

export type SpectateMode = 'spectate_state_only' | 'spectate_mirror';
export type TelestratorDrawPermission = 'host_only' | 'everyone';

export const PAUSE_HEARTBEAT_MIN_HZ = 1;
export const PAUSE_HEARTBEAT_MAX_HZ = 10;
export const DEFAULT_PAUSE_HEARTBEAT_HZ = 2;

export interface FloatingWindowSyncEntry {
  id: string;
  isOpen: boolean;
  isMinimized: boolean;
}

export interface WorkspaceCameraSyncPayload {
  followHostCamera: boolean;
  isFreeCam: boolean;
  ballCam: boolean;
  focusedCarIndex: number;
  freeCamPosition?: [number, number, number];
  freeCamLookAt?: [number, number, number];
  cameraSyncSeq?: number;
  authorityEpoch?: number;
  authorityPeerId?: string;
}

export interface AuthorityCameraSyncPayload {
  type?: 'camera_state_sync';
  authorityEpoch: number;
  cameraSyncSeq: number;
  peerId: string;
  cameraSync: WorkspaceCameraSyncPayload;
}

export type InputAuthorityMode = 'explicit' | 'fpv_master_slave';

export interface WorkspaceReplayRosterEntry {
  carIndex: number;
  name: string;
  team: 0 | 1;
  isBot?: boolean;
}

export interface WorkspaceReplaySyncPayload {
  fileName?: string;
  totalFrames: number;
  currentFrame: number;
  playbackState: 'playing' | 'paused' | 'ended';
  flowPct?: number;
  focusedCarIndex?: number;
  roster?: WorkspaceReplayRosterEntry[];
}

export interface GlobalWorkspaceBroadcastPayload {
  epoch: number;
  tick: number;
  menuRoute: string | null;
  matchMode?: string;
  openFloatingWindows: FloatingWindowSyncEntry[];
  telestratorPermission: TelestratorDrawPermission;
  playbackPaused: boolean;
  pausedAtTick: number;
  pauseHeartbeatHz: number;
  pauseSeq?: number;
  clientInputEnabled: boolean;
  authorityEpoch?: number;
  activeInputPeerId?: string;
  authorityMode?: InputAuthorityMode;
  followHostWorkspace: boolean;
  menuStateIncluded?: boolean;
  arenaPreset?: 'standard' | 'throwback';
  cameraSync?: WorkspaceCameraSyncPayload;
  replaySync?: WorkspaceReplaySyncPayload;
}

export interface ClientAuthorityFramePayload {
  type?: 'client_authority_frame';
  authorityEpoch: number;
  tick: number;
  peerId: string;
  snapshot: number[];
  acknowledgedControls?: Array<{ carIndex: number; controls: Record<string, unknown> }>;
}

export interface PauseStateSyncPayload {
  type?: 'pause_state_sync';
  pauseSeq: number;
  paused: boolean;
  pausedAtTick: number;
  snapshotHash?: number;
  epoch?: number;
}

export interface PauseStateAckPayload {
  type?: 'pause_state_ack';
  pauseSeq: number;
  paused: boolean;
  pausedAtTick: number;
  peerId: string;
}

export interface PresencePingPayload {
  type: 'presence_ping';
  pauseSeq: number;
  paused: boolean;
  pausedAtTick: number;
  epoch?: number;
}

export function clampPauseHeartbeatHz(hz: number): number {
  if (!Number.isFinite(hz)) return DEFAULT_PAUSE_HEARTBEAT_HZ;
  return Math.max(PAUSE_HEARTBEAT_MIN_HZ, Math.min(PAUSE_HEARTBEAT_MAX_HZ, Math.round(hz)));
}

export function getPauseHeartbeatIntervalMs(hz: number): number {
  return Math.round(1000 / clampPauseHeartbeatHz(hz));
}

function sanitizeVec3Tuple(val: unknown): [number, number, number] | undefined {
  if (!Array.isArray(val) || val.length < 3) return undefined;
  const x = Number(val[0]);
  const y = Number(val[1]);
  const z = Number(val[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return undefined;
  return [x, y, z];
}

function sanitizeCameraSync(raw: unknown): WorkspaceCameraSyncPayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const focusedRaw = Number(src.focusedCarIndex);
  const focusedCarIndex =
    Number.isFinite(focusedRaw) && focusedRaw >= 0 ? Math.round(focusedRaw) : 0;
  const freeCamPosition = sanitizeVec3Tuple(src.freeCamPosition);
  const freeCamLookAt = sanitizeVec3Tuple(src.freeCamLookAt);
  const cameraSyncSeq =
    typeof src.cameraSyncSeq === 'number' && Number.isFinite(src.cameraSyncSeq)
      ? Math.max(0, Math.round(src.cameraSyncSeq))
      : undefined;
  const authorityEpoch =
    typeof src.authorityEpoch === 'number' && Number.isFinite(src.authorityEpoch)
      ? Math.max(0, Math.round(src.authorityEpoch))
      : undefined;
  const authorityPeerId =
    typeof src.authorityPeerId === 'string' && src.authorityPeerId.trim()
      ? src.authorityPeerId.trim()
      : undefined;
  return {
    followHostCamera: typeof src.followHostCamera === 'boolean' ? src.followHostCamera : true,
    isFreeCam: Boolean(src.isFreeCam),
    ballCam: typeof src.ballCam === 'boolean' ? src.ballCam : true,
    focusedCarIndex,
    ...(freeCamPosition ? { freeCamPosition } : {}),
    ...(freeCamLookAt ? { freeCamLookAt } : {}),
    ...(cameraSyncSeq !== undefined ? { cameraSyncSeq } : {}),
    ...(authorityEpoch !== undefined ? { authorityEpoch } : {}),
    ...(authorityPeerId !== undefined ? { authorityPeerId } : {}),
  };
}

function sanitizeReplaySync(raw: unknown): WorkspaceReplaySyncPayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const fileName =
    typeof src.fileName === 'string' && src.fileName.trim() ? src.fileName.trim() : undefined;
  const totalFrames =
    typeof src.totalFrames === 'number' && Number.isFinite(src.totalFrames)
      ? Math.max(0, Math.round(src.totalFrames))
      : 0;
  const currentFrame =
    typeof src.currentFrame === 'number' && Number.isFinite(src.currentFrame)
      ? Math.max(0, Math.round(src.currentFrame))
      : 0;
  const playbackState =
    src.playbackState === 'paused' || src.playbackState === 'ended' ? src.playbackState : 'playing';
  const flowPct =
    typeof src.flowPct === 'number' && Number.isFinite(src.flowPct)
      ? Math.max(1, Math.round(src.flowPct))
      : undefined;
  const focusedCarIndex =
    typeof src.focusedCarIndex === 'number' && Number.isFinite(src.focusedCarIndex)
      ? Math.max(0, Math.min(7, Math.round(src.focusedCarIndex)))
      : undefined;
  let roster: WorkspaceReplayRosterEntry[] | undefined;
  if (Array.isArray(src.roster)) {
    const out: WorkspaceReplayRosterEntry[] = [];
    for (let i = 0; i < src.roster.length && i < 8; i++) {
      const item = src.roster[i] as Record<string, unknown> | null | undefined;
      if (!item || typeof item !== 'object') continue;
      const carIndex =
        typeof item.carIndex === 'number' && Number.isFinite(item.carIndex)
          ? Math.max(0, Math.min(7, Math.round(item.carIndex)))
          : i;
      const name =
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim()
          : `Car ${carIndex + 1}`;
      const team: 0 | 1 = item.team === 1 ? 1 : 0;
      out.push({
        carIndex,
        name,
        team,
        ...(typeof item.isBot === 'boolean' ? { isBot: item.isBot } : {}),
      });
    }
    if (out.length > 0) roster = out;
  }
  return {
    ...(fileName !== undefined ? { fileName } : {}),
    totalFrames,
    currentFrame,
    playbackState,
    ...(flowPct !== undefined ? { flowPct } : {}),
    ...(focusedCarIndex !== undefined ? { focusedCarIndex } : {}),
    ...(roster ? { roster } : {}),
  };
}

export function sanitizeGlobalWorkspaceBroadcast(
  raw: Record<string, unknown> | Partial<GlobalWorkspaceBroadcastPayload> | null | undefined
): GlobalWorkspaceBroadcastPayload {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const windows: FloatingWindowSyncEntry[] = [];
  if (Array.isArray(src.openFloatingWindows)) {
    for (const item of src.openFloatingWindows) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const id = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!id) continue;
      windows.push({
        id,
        isOpen: Boolean(entry.isOpen),
        isMinimized: Boolean(entry.isMinimized),
      });
    }
  }

  const arenaPreset =
    src.arenaPreset === 'throwback'
      ? 'throwback'
      : src.arenaPreset === 'standard'
        ? 'standard'
        : undefined;
  const cameraSync = sanitizeCameraSync(src.cameraSync);
  const replaySync = sanitizeReplaySync(src.replaySync);

  const matchMode =
    typeof src.matchMode === 'string' && src.matchMode.trim() ? src.matchMode.trim() : undefined;

  return {
    epoch: typeof src.epoch === 'number' && Number.isFinite(src.epoch) ? src.epoch : 0,
    tick: typeof src.tick === 'number' && Number.isFinite(src.tick) ? src.tick : 0,
    menuRoute: typeof src.menuRoute === 'string' ? src.menuRoute : null,
    ...(matchMode !== undefined ? { matchMode } : {}),
    openFloatingWindows: windows,
    telestratorPermission: src.telestratorPermission === 'everyone' ? 'everyone' : 'host_only',
    playbackPaused: Boolean(src.playbackPaused),
    pausedAtTick:
      typeof src.pausedAtTick === 'number' && Number.isFinite(src.pausedAtTick)
        ? src.pausedAtTick
        : 0,
    pauseHeartbeatHz: clampPauseHeartbeatHz(
      typeof src.pauseHeartbeatHz === 'number' ? src.pauseHeartbeatHz : DEFAULT_PAUSE_HEARTBEAT_HZ
    ),
    ...(typeof src.pauseSeq === 'number' && Number.isFinite(src.pauseSeq)
      ? { pauseSeq: Math.max(0, Math.round(src.pauseSeq)) }
      : {}),
    clientInputEnabled: typeof src.clientInputEnabled === 'boolean' ? src.clientInputEnabled : true,
    ...(typeof src.authorityEpoch === 'number' && Number.isFinite(src.authorityEpoch)
      ? { authorityEpoch: Math.max(0, Math.round(src.authorityEpoch)) }
      : {}),
    ...(typeof src.activeInputPeerId === 'string' && src.activeInputPeerId.trim()
      ? { activeInputPeerId: src.activeInputPeerId.trim() }
      : {}),
    ...(src.authorityMode === 'explicit' || src.authorityMode === 'fpv_master_slave'
      ? { authorityMode: src.authorityMode }
      : {}),
    followHostWorkspace: Boolean(src.followHostWorkspace),
    menuStateIncluded: typeof src.menuStateIncluded === 'boolean' ? src.menuStateIncluded : true,
    ...(arenaPreset !== undefined ? { arenaPreset } : {}),
    ...(cameraSync !== undefined ? { cameraSync } : {}),
    ...(replaySync !== undefined ? { replaySync } : {}),
  };
}

export function sanitizePauseStateSync(
  raw: Record<string, unknown> | Partial<PauseStateSyncPayload> | null | undefined
): PauseStateSyncPayload {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    type: 'pause_state_sync',
    pauseSeq:
      typeof src.pauseSeq === 'number' && Number.isFinite(src.pauseSeq)
        ? Math.max(0, Math.round(src.pauseSeq))
        : 0,
    paused: Boolean(src.paused),
    pausedAtTick:
      typeof src.pausedAtTick === 'number' && Number.isFinite(src.pausedAtTick)
        ? Math.max(0, Math.round(src.pausedAtTick))
        : 0,
    ...(typeof src.snapshotHash === 'number' && Number.isFinite(src.snapshotHash)
      ? { snapshotHash: src.snapshotHash >>> 0 }
      : {}),
    ...(typeof src.epoch === 'number' && Number.isFinite(src.epoch)
      ? { epoch: Math.max(0, Math.round(src.epoch)) }
      : {}),
  };
}

export function sanitizePauseStateAck(
  raw: Record<string, unknown> | Partial<PauseStateAckPayload> | null | undefined,
  fallbackPeerId = 'peer'
): PauseStateAckPayload {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const peerIdRaw =
    typeof src.peerId === 'string' && src.peerId.trim() ? src.peerId.trim() : fallbackPeerId;
  return {
    type: 'pause_state_ack',
    pauseSeq:
      typeof src.pauseSeq === 'number' && Number.isFinite(src.pauseSeq)
        ? Math.max(0, Math.round(src.pauseSeq))
        : 0,
    paused: Boolean(src.paused),
    pausedAtTick:
      typeof src.pausedAtTick === 'number' && Number.isFinite(src.pausedAtTick)
        ? Math.max(0, Math.round(src.pausedAtTick))
        : 0,
    peerId: peerIdRaw,
  };
}

export function computeCompactSnapshotHash(snap: ArrayLike<number> | null | undefined): number {
  if (!snap || snap.length < 22) return 0;
  let hash = 2166136261;
  const indices = [0, 4, 5, 6, 22, 23, 24];
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx >= snap.length) continue;
    const val = Math.round(Number(snap[idx]) || 0);
    hash ^= val & 0xff;
    hash = Math.imul(hash, 16777619);
    hash ^= (val >> 8) & 0xff;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
