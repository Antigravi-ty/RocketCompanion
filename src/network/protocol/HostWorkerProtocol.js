/**
 * HostWorkerProtocol.js
 * Frozen message envelope and command protocol between the Main Thread (UI / Renderer)
 * and the Authoritative Server / Network Web Worker.
 *
 * Designed so parallel feature teams (Worker Server, Network Diagnostics, Replay/Podium, PPO Bot)
 * can communicate over a single unified schema without merge conflicts.
 */

export const HOST_WORKER_MSG_TYPES = Object.freeze({
  // Lifecycle & Room Control (Main <-> Worker)
  WORKER_INIT: 'WORKER_INIT',
  WORKER_READY: 'WORKER_READY',
  WORKER_DESTROY: 'WORKER_DESTROY',
  ROOM_CREATE: 'ROOM_CREATE',
  ROOM_JOIN: 'ROOM_JOIN',
  ROOM_LEAVE: 'ROOM_LEAVE',
  ROOM_STATE_SYNC: 'ROOM_STATE_SYNC',

  // Authoritative Simulation & Snapshot Streaming (Worker -> Main)
  PHYSICS_SNAPSHOT: 'PHYSICS_SNAPSHOT',
  SIGNAL_EVENT_BATCH: 'SIGNAL_EVENT_BATCH',
  INCIDENT_EVENT_BATCH: 'INCIDENT_EVENT_BATCH',

  // Client Input & Reliable Commands (Main -> Worker)
  LOCAL_INPUT_FRAME: 'LOCAL_INPUT_FRAME',
  RELIABLE_COMMAND: 'RELIABLE_COMMAND',
  SIGNAL_ACK: 'SIGNAL_ACK',

  // Lobby Ghost Car & Match Mode Transitions
  LOBBY_MODE_SET: 'LOBBY_MODE_SET',
  GHOST_CAR_CONFIG: 'GHOST_CAR_CONFIG',
  MATCH_START_REQUEST: 'MATCH_START_REQUEST',
  PODIUM_ENTER: 'PODIUM_ENTER',

  // Network Quality & 3-Car Zero-G Diagnostics
  NET_DIAG_CONFIG: 'NET_DIAG_CONFIG',
  NET_DIAG_METRICS: 'NET_DIAG_METRICS',
  NET_IMPAIRMENT_SET: 'NET_IMPAIRMENT_SET',

  // Replay & Timeline Scrubbing
  REPLAY_WINDOW_REQUEST: 'REPLAY_WINDOW_REQUEST',
  REPLAY_WINDOW_DATA: 'REPLAY_WINDOW_DATA',
  REPLAY_FULL_EXPORT_REQUEST: 'REPLAY_FULL_EXPORT_REQUEST',
  REPLAY_FULL_EXPORT_DATA: 'REPLAY_FULL_EXPORT_DATA'
});

/**
 * Create a standardized Worker message envelope.
 * @param {string} type - One of HOST_WORKER_MSG_TYPES
 * @param {Object} payload - Structured cloneable payload
 * @param {number} [seq=0] - Optional sequence number
 * @returns {{ type: string, seq: number, timestampMs: number, payload: Object }}
 */
export function createWorkerEnvelope(type, payload = {}, seq = 0) {
  return {
    type,
    seq: seq >>> 0,
    timestampMs: performance.now(),
    payload
  };
}
