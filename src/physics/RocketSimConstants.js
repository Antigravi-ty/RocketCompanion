/**
 * RocketSimConstants.js
 * Comprehensive constants, linear memory offsets, and unified 3-category hexadecimal event table
 * for RocketSim WebAssembly physics simulation and authoritative networking.
 * Reference: https://github.com/zealanL/rocketsim (RLConst.h, CarConfig.h, CarControls.h, PhysState.h)
 */

/**
 * Global RocketSim arena shared-memory buffer offsets
 */
export const SIM_OFFSETS = Object.freeze({
  TICK: 0,        // uint32 current physics simulation tick
  GOAL: 1,        // Goal scored event flag (0: none, 1: blue goal, 2: orange goal)
  NUM_CARS: 2,    // Number of active cars in the arena (1 in freeplay, 2+ in match/multiplayer)
  NUM_PADS: 3,    // Number of boost pads (34 in standard stadium)
  BALL: 4,        // Ball state data start offset (18 Float32 values)
  CARS: 22        // First car state data start offset (each car has CAR_STATE_STRIDE floats)
});

/**
 * Extended telemetry & 8-car internal jump/airTime offsets in GameStateBufferPod (floats 410..447)
 */
export const EXTENDED_STATE_OFFSETS = Object.freeze({
  IS_BALL_SLEEPING: 410,
  IS_SIMULATION_FROZEN: 411,
  POSSESSION_STATE: 412,
  POSSESSION_BLUE_POINTS: 413,
  POSSESSION_ORANGE_POINTS: 414,
  POSSESSION_DURATION: 415,
  CAR_JUMP_AIR_BASE: 416,
  CAR_JUMP_AIR_STRIDE: 4,
  CAR_IS_JUMPING_OFFSET: 0,
  CAR_AIR_TIME_OFFSET: 1,
  CAR_JUMP_TIME_OFFSET: 2,
  CAR_AIR_TIME_SINCE_JUMP_OFFSET: 3
});

export const GAME_STATE_BUFFER_FLOATS = 448;
export const STATE_BUFFER_FLOATS = GAME_STATE_BUFFER_FLOATS;

export const ARENA_PRESETS = Object.freeze({
  STANDARD_SOCCAR: 0,
  THROWBACK_STADIUM: 1
});

/**
 * Per-car RocketSim physics state offsets within a 40-float block
 * Formula: carOffset = SIM_OFFSETS.CARS + carIndex * CAR_STATE_STRIDE
 */
export const CAR_STATE_OFFSETS = Object.freeze({
  POS: 0,                     // World position [x, y, z] (3 floats)
  FWD: 3,                     // Forward direction unit vector [x, y, z] (3 floats)
  RIGHT: 6,                   // Right direction unit vector [x, y, z] (3 floats)
  UP: 9,                      // Upward direction unit vector [x, y, z] (3 floats)
  VEL: 12,                    // Linear velocity [x, y, z] (3 floats, unreal units / sec)
  ANG_VEL: 15,                // Angular velocity [x, y, z] (3 floats, rad / sec)
  BOOST: 18,                  // Boost reserve (0.0 to 100.0)
  ON_GROUND: 19,              // Contact with ground / surface (1 if >= 3 wheels touching, else 0)
  SUPERSONIC: 20,             // In supersonic state (speed > 2200 uu/s) (1 or 0)
  DEMOED: 21,                 // Demolished state (1 or 0)
  HAS_FLIP_OR_JUMP: 22,       // Has jump or dodge available (1 or 0)
  IS_BOOSTING: 23,            // Currently expending boost (1 or 0)
  IS_FLIPPING: 24,            // Currently executing flip/dodge animation (1 or 0)
  WHEELS: 25,                 // 4 wheels suspension & contact data (12 floats: 4 * [susLength, steerAngle, hasContact])
  GROUND_NORMAL: 37           // Surface contact normal [x, y, z] (3 floats)
});

/**
 * RocketSim ball physics state offsets within an 18-float block
 * Reference: RocketSim PhysState (Vec pos, RotMat rotMat, Vec vel, Vec angVel)
 */
export const BALL_STATE_OFFSETS = Object.freeze({
  POS: 0,                     // World position [x, y, z] (3 floats)
  ROT_MAT: 3,                 // 3x3 Rotation matrix / basis vectors (9 floats: FWD, RIGHT, UP)
  FWD: 3,                     // Forward direction unit vector [x, y, z] (3 floats)
  RIGHT: 6,                   // Right direction unit vector [x, y, z] (3 floats)
  UP: 9,                      // Upward direction unit vector [x, y, z] (3 floats)
  VEL: 12,                    // Linear velocity [x, y, z] (3 floats, uu / sec)
  ANG_VEL: 15                 // Angular velocity [x, y, z] (3 floats, rad / sec)
});

/** Float stride per car in RocketSim state buffer */
export const CAR_STATE_STRIDE = 40;

/** Float stride per ball in RocketSim state buffer */
export const BALL_STATE_STRIDE = 18;

/** Float stride per car in controls view buffer */
export const CONTROLS_STRIDE = 8;

/** Maximum number of cars supported in memory layout */
export const MAX_CARS = 8;

/** Standard 120Hz physics simulation tick rate */
export const PHYSICS_TICK_RATE = 120;

/** Standard fixed physics delta time (1 / 120s = 8.333ms) */
export const FIXED_TIMESTEP = 1 / PHYSICS_TICK_RATE;

/** Maximum physics substeps simulated per frame before dropping (12 ticks = 100ms) */
export const MAX_PHYSICS_SUBSTEPS = 12;

/**
 * Wheel suspension and contact layout
 */
export const WHEEL_COUNT = 4;
export const WHEEL_STATE_STRIDE = 3; // [contact (1/0), susLength, wheelSpeed]
export const WHEEL_OFFSETS = Object.freeze({
  CONTACT: 0,
  SUS_LENGTH: 1,
  WHEEL_SPEED: 2
});

/**
 * RocketSim WebAssembly shared state buffer wheel layout (stride 3)
 * Exact per-wheel memory offsets in RocketSim WASM:
 * [0: susLength, 1: steerAngle, 2: hasContact]
 */
export const WASM_WHEEL_OFFSETS = Object.freeze({
  SUS_LENGTH: 0,
  STEER_ANGLE: 1,
  HAS_CONTACT: 2
});

/**
 * RocketSim arena boost pad state layout
 * Starts immediately after all MAX_CARS state blocks: SIM_OFFSETS.CARS + MAX_CARS * CAR_STATE_STRIDE
 * Formula: padStateOffset = BOOST_PAD_STATES_OFFSET + padIndex * BOOST_PAD_STATE_STRIDE
 */
export const NUM_BOOST_PADS = 34;
export const BOOST_PAD_STATE_STRIDE = 2; // [isActive (1 or 0), cooldownTimer (sec)]
export const BOOST_PAD_STATES_OFFSET = SIM_OFFSETS.CARS + MAX_CARS * CAR_STATE_STRIDE; // 22 + 8 * 40 = 342
export const BOOST_PAD_TIMEOUT_BIG = 10.0;
export const BOOST_PAD_TIMEOUT_SMALL = 4.0;
export const BOOST_PAD_OFFSETS = Object.freeze({
  IS_ACTIVE: 0,
  COOLDOWN: 1
});

/**
 * Per-car input control offsets within an 8-float controls view block
 * Reference: RocketSim CarControls (throttle, steer, pitch, yaw, roll, jump, boost, handbrake)
 */
export const CONTROLS_OFFSETS = Object.freeze({
  THROTTLE: 0,
  STEER: 1,
  PITCH: 2,
  YAW: 3,
  ROLL: 4,
  JUMP: 5,
  BOOST: 6,
  HANDBRAKE: 7
});

/**
 * RocketSim & Rocket League physical environment constants (RLConst.h)
 */
export const GRAVITY_Z = -650;
export const BALL_COLLISION_RADIUS = 91.25;
export const BALL_MAX_SPEED = 4000;
export const CAR_MAX_SPEED = 2300;
export const SUPERSONIC_SPEED_THRESHOLD = 2200;

export const ARENA_EXTENTS = Object.freeze({
  X: 4096,
  Y: 5120,
  Z: 2048,
  WIDTH: 8192,
  LENGTH: 10240,
  HEIGHT: 2048
});

export const GOAL_EXTENTS = Object.freeze({
  WIDTH: 1785.51,
  DEPTH: 880,
  HEIGHT: 642.775
});

export const STANDARD_GOAL_VOLUME_BOX = Object.freeze({
  halfWidthX: 892.755,
  minY: 5120.0,
  maxY: 6000.0,
  minZ: 0.0,
  maxZ: 642.775
});

export const THROWBACK_GOAL_VOLUME_BOX = Object.freeze({
  halfWidthX: 940.0,
  minY: 4922.0,
  maxY: 5460.0,
  minZ: 0.0,
  maxZ: 640.0
});

export const BALL_CONTROL_MODES = Object.freeze([
  'takePossession',
  'startDribble',
  'passBall',
  'launchBall'
]);

export const TEAMS = Object.freeze({
  BLUE: 0,
  ORANGE: 1
});

/**
 * Accurate hitbox dimensions and offsets directly aligned with zealanL/rocketsim (CarConfig.cpp)
 */
export const HITBOX_PRESETS = Object.freeze({
  OCTANE: {
    name: 'Octane',
    size: [120.507, 86.6994, 38.6591],
    offset: [13.8757, 0, 20.755],
    frontWheels: { radius: 12.50, susRest: 38.755, offset: [51.25, 25.90, 20.755] },
    backWheels: { radius: 15.00, susRest: 37.055, offset: [-33.75, 29.50, 20.755] }
  },
  DOMINUS: {
    name: 'Dominus',
    size: [130.427, 85.7799, 33.8],
    offset: [9.0, 0, 15.75],
    frontWheels: { radius: 12.00, susRest: 33.95, offset: [50.30, 31.10, 15.75] },
    backWheels: { radius: 13.50, susRest: 33.85, offset: [-34.75, 33.00, 15.75] }
  },
  PLANK: {
    name: 'Plank',
    size: [131.32, 87.1704, 31.8944],
    offset: [9.00857, 0, 12.0942],
    frontWheels: { radius: 12.50, susRest: 31.9242, offset: [49.97, 27.80, 12.0942] },
    backWheels: { radius: 17.00, susRest: 27.9242, offset: [-35.43, 20.28, 12.0942] }
  },
  BREAKOUT: {
    name: 'Breakout',
    size: [133.992, 83.021, 32.8],
    offset: [12.5, 0, 11.75],
    frontWheels: { radius: 13.50, susRest: 29.7, offset: [51.50, 26.67, 11.75] },
    backWheels: { radius: 15.00, susRest: 29.666, offset: [-35.75, 35.00, 11.75] }
  },
  HYBRID: {
    name: 'Hybrid',
    size: [129.519, 84.6879, 36.6591],
    offset: [13.8757, 0, 20.755],
    frontWheels: { radius: 12.50, susRest: 38.755, offset: [51.25, 25.90, 20.755] },
    backWheels: { radius: 15.00, susRest: 37.055, offset: [-34.00, 29.50, 20.755] }
  },
  MERC: {
    name: 'Merc',
    size: [123.22, 79.2103, 44.1591],
    offset: [11.3757, 0, 21.505],
    frontWheels: { radius: 15.00, susRest: 39.505, offset: [51.25, 25.90, 21.505] },
    backWheels: { radius: 15.00, susRest: 39.105, offset: [-33.75, 29.50, 21.505] }
  },
  PSYCLOPS: {
    name: 'Psyclops (Three-Wheeler)',
    size: [120.641, 86.8334, 38.7931],
    offset: [13.8757, 0, 15.0],
    threeWheels: true,
    frontWheels: { radius: 12.50, susRest: 33.0, offset: [51.25, 5.0, 15.0] },
    backWheels: { radius: 15.00, susRest: 31.3, offset: [-33.75, 29.50, 15.0] }
  }
});

/**
 * Unified 3-Category Hexadecimal Event & Command Space (0x00..0xFF):
 * - Category 1 (0x00..0x3F): Physics Incidents (WASM/Server -> Client, passive physics events)
 * - Category 2 (0x80..0xBF): Server Authoritative Signals (Server -> Client, requires Client ACK, idempotent on Client)
 * - Category 3 (0xC0..0xFF): Client Reliable Commands (Client -> Server, requires Server ACK)
 */
export const INCIDENT_EVENT_TYPES = Object.freeze({
  NONE: 0x00,
  CAR_BALL_HIT: 0x01,
  CAR_CAR_BUMP: 0x02,
  CAR_CAR_COLLISION: 0x02,
  CAR_CAR_DEMO: 0x03,
  BALL_WORLD_HIT: 0x04,
  BALL_GOALPOST_HIT: 0x05,
  CAR_JUMP: 0x06,
  CAR_DOUBLE_JUMP: 0x07,
  CAR_DODGE: 0x08,
  CAR_SUPERSONIC_ENTER: 0x09,
  BOOST_PICKUP: 0x0A,
  BOOST_SPAWN: 0x0B,
  CAR_BOOST_START: 0x0C,
  BOOST_START: 0x0C,
  CAR_BOOST_STOP: 0x0D,
  BOOST_END: 0x0D,
  GOAL_SCORED: 0x0E,
  FLIP_RESET_GAINED: 0x0F,
  BALL_STATE_CHANGE: 0x10,
  POSSESSION_CHANGE: 0x11
});

/**
 * Category 2 (0x80..0xBF): Authoritative Server Signals (Server -> Client, requires Client ACK)
 * Single-shot emission on Server; idempotent execution on Client.
 */
export const SIGNAL_EVENT_TYPES = Object.freeze({
  MATCH_START: 0x80,
  MATCH_STARTED: 0x80,
  KICKOFF_WILL_START: 0x81,
  KICKOFF_PREPARE: 0x81,
  KICKOFF_START: 0x82,
  KICKOFF_GO: 0x82,
  COUNTDOWN_TICK: 0x83,
  MATCH_PAUSED: 0x84,
  MATCH_PAUSE: 0x84,
  MATCH_WILL_RESUME: 0x85,
  MATCH_RESUMED: 0x86,
  MATCH_RESUME: 0x86,
  MATCH_UNPAUSED: 0x86,
  GOAL_REPLAY_WILL_START: 0x87,
  GOAL_REPLAY_START: 0x88,
  GOAL_REPLAY_WILL_END: 0x89,
  GOAL_REPLAY_END: 0x8A,
  OVERTIME_START: 0x8B,
  TIME_ALERT_60S: 0x8C,
  TIME_ALERT_30S: 0x8D,
  PLAYER_JOINED: 0x8E,
  PLAYER_ENTER_ARENA: 0x8E,
  PLAYER_LEFT: 0x8F,
  PLAYER_LEAVE_ARENA: 0x8F,
  FORFEIT_VOTE: 0x90,
  SCORE_UPDATED: 0x91,
  BALL_RESET: 0x92,
  ROUND_STARTED: 0x93,
  MATCH_CREATED: 0x94,
  MATCH_INITIALIZED: 0x95,
  MATCH_PREPARE: 0x96,
  MATCH_ENDED: 0x97,
  MATCH_DESTROYED: 0x98,
  SERVER_DESTROYED: 0x98,
  PODIUM_START: 0x99,
  PLAYER_LOADOUT_UPDATED: 0x9A,
  PLAYER_SLOT_UPDATED: 0x9B,
  DEMOLITION: 0x9C,
  CLOCK_UPDATED_SECONDS: 0x9D,
  COUNTDOWN_10S: 0x9E,
  COMMAND_ACK: 0x9F,
  FLIP_RESET_GAINED: 0x0F
});

export const MATCH_SIGNALS = SIGNAL_EVENT_TYPES;

/**
 * Category 3 (0xC0..0xFF): Client Reliable Commands (Client -> Server, requires Server ACK)
 */
export const CLIENT_COMMAND_TYPES = Object.freeze({
  CMD_READY_ACK: 0xC0,
  READY_TO_START: 0xC0,
  CMD_ARENA_LOADED_ACK: 0xC1,
  ARENA_INITIALIZED: 0xC1,
  CMD_SET_LOADOUT: 0xC2,
  SELECT_LOADOUT: 0xC2,
  CMD_SWITCH_ROLE_TEAM: 0xC3,
  SWITCH_TEAM_ROLE: 0xC3,
  CMD_VOTE_SKIP_REPLAY: 0xC4,
  SKIP_REPLAY_VOTE: 0xC4,
  CMD_VOTE_REMATCH: 0xC5,
  REMATCH_VOTE: 0xC5,
  CMD_REQUEST_PAUSE: 0xC6,
  PAUSE_REQUEST: 0xC6,
  CMD_VOTE_FORFEIT: 0xC7,
  FORFEIT_VOTE: 0xC7,
  CMD_REJOIN_CLAIM: 0xC8,
  RECONNECT_CLAIM: 0xC8
});

export function isIncidentEvent(code) {
  return code >= 0x01 && code <= 0x3F;
}

export function isServerSignal(code) {
  return code === 0x0F || (code >= 0x80 && code <= 0xBF);
}

export function isClientCommand(code) {
  return code >= 0xC0 && code <= 0xFF;
}

export const SURFACE_SUBTYPES = Object.freeze({
  NONE: 0,
  FLOOR: 1,
  CEILING: 2,
  SIDE_WALL: 3,
  BACKBOARD: 4,
  CORNER_45: 5,
  RAMP_GROUND: 6,
  RAMP_CEILING: 7,
  GOALPOST: 8,
  CROSSBAR: 9,
  OTHER_CURVE: 10
});

export const PHYSICS_EVENT_TYPES = Object.freeze({
  ...INCIDENT_EVENT_TYPES,
  ...SIGNAL_EVENT_TYPES,
  CAR_DEMO: 0x03,
  CAR_ACTION: 0x3E
});

export const CAR_ACTION_SUBTYPES = Object.freeze({
  NONE: 0,
  SINGLE_JUMP: 1,
  DOUBLE_JUMP: 2,
  DODGE: 3
});

export const FLIP_RESET_OBJECT_TYPES = Object.freeze({
  NONE: 0,
  BALL: 1,
  CAR: 2,
  WORLD: 3
});

export const FLIP_RESET_SUBTYPES = Object.freeze({
  NONE: 0,
  BALL: 1,
  CAR: 2,
  CEILING: 3,
  BACKBOARD: 4,
  SIDE_WALL: 5,
  CORNER_45: 6,
  RAMP_GROUND: 7,
  RAMP_CEILING: 8,
  GOALPOST: 9,
  CROSSBAR: 10,
  FLOOR: 11,
  DROPSHOT_TILE: 12,
  OTHER_WORLD: 13
});

export const FLIP_RESET_SUBTYPE_LABELS = Object.freeze({
  [FLIP_RESET_SUBTYPES.NONE]: 'none',
  [FLIP_RESET_SUBTYPES.BALL]: 'ball',
  [FLIP_RESET_SUBTYPES.CAR]: 'car',
  [FLIP_RESET_SUBTYPES.CEILING]: 'ceiling',
  [FLIP_RESET_SUBTYPES.BACKBOARD]: 'backboard',
  [FLIP_RESET_SUBTYPES.SIDE_WALL]: 'side_wall',
  [FLIP_RESET_SUBTYPES.CORNER_45]: 'corner_45',
  [FLIP_RESET_SUBTYPES.RAMP_GROUND]: 'ramp_ground',
  [FLIP_RESET_SUBTYPES.RAMP_CEILING]: 'ramp_ceiling',
  [FLIP_RESET_SUBTYPES.GOALPOST]: 'goalpost',
  [FLIP_RESET_SUBTYPES.CROSSBAR]: 'crossbar',
  [FLIP_RESET_SUBTYPES.FLOOR]: 'floor',
  [FLIP_RESET_SUBTYPES.DROPSHOT_TILE]: 'dropshot_tile',
  [FLIP_RESET_SUBTYPES.OTHER_WORLD]: 'other_world'
});

export function getFlipResetObjectCode(subType = 0, flags = 0) {
  const flagObj = (Number(flags) >>> 4) & 0xF;
  if (flagObj === FLIP_RESET_OBJECT_TYPES.BALL || flagObj === FLIP_RESET_OBJECT_TYPES.CAR || flagObj === FLIP_RESET_OBJECT_TYPES.WORLD) {
    return flagObj;
  }
  const st = Number(subType) | 0;
  if (st === FLIP_RESET_SUBTYPES.BALL) return FLIP_RESET_OBJECT_TYPES.BALL;
  if (st === FLIP_RESET_SUBTYPES.CAR) return FLIP_RESET_OBJECT_TYPES.CAR;
  if (st >= FLIP_RESET_SUBTYPES.CEILING && st <= FLIP_RESET_SUBTYPES.OTHER_WORLD) return FLIP_RESET_OBJECT_TYPES.WORLD;
  return FLIP_RESET_OBJECT_TYPES.NONE;
}

export function getFlipResetObjectName(subType = 0, flags = 0) {
  const code = getFlipResetObjectCode(subType, flags);
  if (code === FLIP_RESET_OBJECT_TYPES.BALL) return 'ball';
  if (code === FLIP_RESET_OBJECT_TYPES.CAR) return 'car';
  if (code === FLIP_RESET_OBJECT_TYPES.WORLD) return 'world';
  return 'none';
}

export function isBallFlipResetEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (typeof ev.isBallFlipReset === 'boolean') return ev.isBallFlipReset;
  const subType = Number(ev.resetSubType ?? ev.subType ?? 0);
  if (subType > 0) {
    return subType === FLIP_RESET_SUBTYPES.BALL;
  }
  const objCode = Number(ev.resetObjectCode ?? ((Number(ev.flags ?? 0) >>> 4) & 0xF));
  if (objCode > 0) {
    return objCode === FLIP_RESET_OBJECT_TYPES.BALL;
  }
  if (typeof ev.resetObjectType === 'string') {
    return ev.resetObjectType === 'ball';
  }
  return false;
}

export const PHYSICS_EVENT_FLAGS = Object.freeze({
  INITIAL_TOUCH: 1 << 0,
  SUPERSONIC: 1 << 1,
  FLIP: 1 << 2,
  ON_GROUND: 1 << 3
});

export const EVENT_BUFFER_CAPACITY = 256;
export const EVENT_SIZE_BYTES = 64;
export const EVENT_SIZE_WORDS = 16; // 64 / 4
export const EVENT_HEADER_BYTES = 16;
export const EVENT_HEADER_WORDS = 4; // 16 / 4
export const EVENT_TOTAL_BUFFER_BYTES = EVENT_HEADER_BYTES + EVENT_BUFFER_CAPACITY * EVENT_SIZE_BYTES; // 16400 bytes

export const REPLAY_STORAGE_BYTES = 256 * 1024 * 1024;
export const REPLAY_TIMELINES = Object.freeze({
  STATE: 0,
  INCIDENT: 1,
  SIGNAL: 2,
  USER_INPUT: 3
});

export const BALL_PRED_MAX_SECONDS = 5.0;
export const BALL_PRED_MAX_TICKS = 600;
export const BALL_PRED_STRIDE = 6;

export const DIAGNOSTIC_PROBE_SLOTS = Object.freeze([6, 7]);

export function isDiagnosticProbeSlot(carIndex) {
  return carIndex === 6 || carIndex === 7;
}

export const KICKOFF_SPAWN_PRESETS = Object.freeze([
  { team0: { x: 2048, y: -2560, z: 17, yaw: 2.35619449 }, team1: { x: -2048, y: 2560, z: 17, yaw: -0.78539816 } },
  { team0: { x: -2048, y: -2560, z: 17, yaw: 0.78539816 }, team1: { x: 2048, y: 2560, z: 17, yaw: -2.35619449 } },
  { team0: { x: 256, y: -3840, z: 17, yaw: 1.57079633 }, team1: { x: -256, y: 3840, z: 17, yaw: -1.57079633 } },
  { team0: { x: -256, y: -3840, z: 17, yaw: 1.57079633 }, team1: { x: 256, y: 3840, z: 17, yaw: -1.57079633 } },
  { team0: { x: 0, y: -4608, z: 17, yaw: 1.57079633 }, team1: { x: 0, y: 4608, z: 17, yaw: -1.57079633 } }
]);

/**
 * 4 Primary Demolition Respawn Locations (Ordered strictly Left-to-Right from player perspective: 0..3)
 * and 4 Hidden Fallback Respawn Locations (offset +512 UU forward toward midfield).
 * Note: RocketSim uses a Left-Handed coordinate system where Blue (Y = -4608, facing +Y) has Left = +X
 * and Right = -X, and Orange (Y = +4608, facing -Y) has Left = -X and Right = +X.
 */
export const RESPAWN_SPAWN_PRESETS = Object.freeze([
  { id: 'far-left', slotIndex: 0, name: 'Far Left', label: 'Far Left', team0: { x: 2688, y: -4608, z: 17, yaw: Math.PI / 2 }, team1: { x: -2688, y: 4608, z: 17, yaw: -Math.PI / 2 } },
  { id: 'inner-left', slotIndex: 1, name: 'Inner Left', label: 'Inner Left', team0: { x: 2304, y: -4608, z: 17, yaw: Math.PI / 2 }, team1: { x: -2304, y: 4608, z: 17, yaw: -Math.PI / 2 } },
  { id: 'inner-right', slotIndex: 2, name: 'Inner Right', label: 'Inner Right', team0: { x: -2304, y: -4608, z: 17, yaw: Math.PI / 2 }, team1: { x: 2304, y: 4608, z: 17, yaw: -Math.PI / 2 } },
  { id: 'far-right', slotIndex: 3, name: 'Far Right', label: 'Far Right', team0: { x: -2688, y: -4608, z: 17, yaw: Math.PI / 2 }, team1: { x: 2688, y: 4608, z: 17, yaw: -Math.PI / 2 } }
]);

export const HIDDEN_RESPAWN_SPAWN_PRESETS = Object.freeze([
  { id: 'hidden-far-left', slotIndex: 0, name: 'Hidden Far Left', label: 'Hidden Far Left', team0: { x: 2688, y: -4096, z: 17, yaw: Math.PI / 2 }, team1: { x: -2688, y: 4096, z: 17, yaw: -Math.PI / 2 } },
  { id: 'hidden-inner-left', slotIndex: 1, name: 'Hidden Inner Left', label: 'Hidden Inner Left', team0: { x: 2304, y: -4096, z: 17, yaw: Math.PI / 2 }, team1: { x: -2304, y: 4096, z: 17, yaw: -Math.PI / 2 } },
  { id: 'hidden-inner-right', slotIndex: 2, name: 'Hidden Inner Right', label: 'Hidden Inner Right', team0: { x: -2304, y: -4096, z: 17, yaw: Math.PI / 2 }, team1: { x: 2304, y: 4096, z: 17, yaw: -Math.PI / 2 } },
  { id: 'hidden-far-right', slotIndex: 3, name: 'Hidden Far Right', label: 'Hidden Far Right', team0: { x: -2688, y: -4096, z: 17, yaw: Math.PI / 2 }, team1: { x: 2688, y: 4096, z: 17, yaw: -Math.PI / 2 } }
]);

export function getDesiredRespawnPose(team = 0, slotIndex = 0) {
  const clampedSlot = Math.max(0, Math.min(3, Math.trunc(slotIndex)));
  const entry = RESPAWN_SPAWN_PRESETS[clampedSlot] || RESPAWN_SPAWN_PRESETS[0];
  return Number(team) === 1 ? entry.team1 : entry.team0;
}


