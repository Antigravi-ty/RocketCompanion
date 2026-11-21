export const RENDER_FRAME_MAGIC = 0x52434631;
export const RENDER_FRAME_BYTE_LEN = 140;

export const FRAME_FLAG_BALL_CAM = 1 << 0;
export const FRAME_FLAG_SUPERSONIC = 1 << 1;
export const FRAME_FLAG_BOOSTING = 1 << 2;
export const FRAME_FLAG_GROUNDED = 1 << 3;
export const FRAME_FLAG_HAS_JUMPED = 1 << 4;
export const FRAME_FLAG_HAS_FLIPPED = 1 << 5;

export interface CarControlInput {
  throttle: number;
  steer: number;
  pitch: number;
  yaw: number;
  roll: number;
  jump: boolean;
  boost: boolean;
  handbrake: boolean;
  ballCam: boolean;
}

export interface RenderFrameData {
  tick: number;
  teleportSeq: number;
  flags: number;
  ballPos: [number, number, number];
  ballQuat: [number, number, number, number];
  ballVel: [number, number, number];
  carPos: [number, number, number];
  carQuat: [number, number, number, number];
  carVel: [number, number, number];
  carBoost: number;
  camPos: [number, number, number];
  camQuat: [number, number, number, number];
  camFov: number;
  boostPadsLo: number;
  boostPadsHi: number;
}

export function createEmptyRenderFrame(): RenderFrameData {
  return {
    tick: 0,
    teleportSeq: 0,
    flags: FRAME_FLAG_BALL_CAM,
    ballPos: [0, 93.15, 0],
    ballQuat: [0, 0, 0, 1],
    ballVel: [0, 0, 0],
    carPos: [0, 17, 0],
    carQuat: [0, 0, 0, 1],
    carVel: [0, 0, 0],
    carBoost: 33,
    camPos: [0, 117, -270],
    camQuat: [0, 0, 0, 1],
    camFov: 60,
    boostPadsLo: 0,
    boostPadsHi: 0,
  };
}

export function copyRenderFrame(dst: RenderFrameData, src: RenderFrameData): void {
  dst.tick = src.tick;
  dst.teleportSeq = src.teleportSeq;
  dst.flags = src.flags;
  dst.ballPos[0] = src.ballPos[0];
  dst.ballPos[1] = src.ballPos[1];
  dst.ballPos[2] = src.ballPos[2];
  dst.ballQuat[0] = src.ballQuat[0];
  dst.ballQuat[1] = src.ballQuat[1];
  dst.ballQuat[2] = src.ballQuat[2];
  dst.ballQuat[3] = src.ballQuat[3];
  dst.ballVel[0] = src.ballVel[0];
  dst.ballVel[1] = src.ballVel[1];
  dst.ballVel[2] = src.ballVel[2];
  dst.carPos[0] = src.carPos[0];
  dst.carPos[1] = src.carPos[1];
  dst.carPos[2] = src.carPos[2];
  dst.carQuat[0] = src.carQuat[0];
  dst.carQuat[1] = src.carQuat[1];
  dst.carQuat[2] = src.carQuat[2];
  dst.carQuat[3] = src.carQuat[3];
  dst.carVel[0] = src.carVel[0];
  dst.carVel[1] = src.carVel[1];
  dst.carVel[2] = src.carVel[2];
  dst.carBoost = src.carBoost;
  dst.camPos[0] = src.camPos[0];
  dst.camPos[1] = src.camPos[1];
  dst.camPos[2] = src.camPos[2];
  dst.camQuat[0] = src.camQuat[0];
  dst.camQuat[1] = src.camQuat[1];
  dst.camQuat[2] = src.camQuat[2];
  dst.camQuat[3] = src.camQuat[3];
  dst.camFov = src.camFov;
  dst.boostPadsLo = src.boostPadsLo;
  dst.boostPadsHi = src.boostPadsHi;
}

export function decodeRenderFrame(buffer: ArrayBuffer, out: RenderFrameData): boolean {
  if (buffer.byteLength !== RENDER_FRAME_BYTE_LEN) {
    return false;
  }
  const u32 = new Uint32Array(buffer);
  const f32 = new Float32Array(buffer);
  if (u32[0] !== RENDER_FRAME_MAGIC) {
    return false;
  }

  out.tick = u32[1];
  out.teleportSeq = u32[2];
  out.flags = u32[3];

  out.ballPos[0] = f32[4];
  out.ballPos[1] = f32[5];
  out.ballPos[2] = f32[6];
  out.ballQuat[0] = f32[7];
  out.ballQuat[1] = f32[8];
  out.ballQuat[2] = f32[9];
  out.ballQuat[3] = f32[10];
  out.ballVel[0] = f32[11];
  out.ballVel[1] = f32[12];
  out.ballVel[2] = f32[13];

  out.carPos[0] = f32[14];
  out.carPos[1] = f32[15];
  out.carPos[2] = f32[16];
  out.carQuat[0] = f32[17];
  out.carQuat[1] = f32[18];
  out.carQuat[2] = f32[19];
  out.carQuat[3] = f32[20];
  out.carVel[0] = f32[21];
  out.carVel[1] = f32[22];
  out.carVel[2] = f32[23];
  out.carBoost = f32[24];

  out.camPos[0] = f32[25];
  out.camPos[1] = f32[26];
  out.camPos[2] = f32[27];
  out.camQuat[0] = f32[28];
  out.camQuat[1] = f32[29];
  out.camQuat[2] = f32[30];
  out.camQuat[3] = f32[31];
  out.camFov = f32[32];

  out.boostPadsLo = u32[33];
  out.boostPadsHi = u32[34];
  return true;
}

export interface TelemetrySampleData {
  tick: number;
  teleportSeq: number;
  flags: number;
  carBoost: number;
  carPos: [number, number, number];
  carVel: [number, number, number];
  ballPos: [number, number, number];
  camPos: [number, number, number];
  camFov: number;
}

const TELEMETRY_SAMPLE_FLOATS = 17;
const TELEMETRY_SAMPLE_BYTES = TELEMETRY_SAMPLE_FLOATS * 4;

export function decodeTelemetryBuffer(buffer: ArrayBuffer): TelemetrySampleData[] {
  const count = Math.floor(buffer.byteLength / TELEMETRY_SAMPLE_BYTES);
  const u32 = new Uint32Array(buffer);
  const f32 = new Float32Array(buffer);
  const samples: TelemetrySampleData[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const base = i * TELEMETRY_SAMPLE_FLOATS;
    samples[i] = {
      tick: u32[base + 0],
      teleportSeq: u32[base + 1],
      flags: u32[base + 2],
      carBoost: f32[base + 3],
      carPos: [f32[base + 4], f32[base + 5], f32[base + 6]],
      carVel: [f32[base + 7], f32[base + 8], f32[base + 9]],
      ballPos: [f32[base + 10], f32[base + 11], f32[base + 12]],
      camPos: [f32[base + 13], f32[base + 14], f32[base + 15]],
      camFov: f32[base + 16],
    };
  }
  return samples;
}

export type WorkerInboundMessage =
  | { type: 'init'; aspect: number }
  | { type: 'controls'; input: CarControlInput }
  | { type: 'resetKickoff' }
  | { type: 'setAspect'; aspect: number }
  | { type: 'requestTelemetry' };

export type WorkerOutboundMessage =
  | { type: 'ready' }
  | { type: 'frame'; buffer: ArrayBuffer; workerTimeMs: number }
  | { type: 'telemetry'; buffer: ArrayBuffer }
  | { type: 'error'; message: string };
