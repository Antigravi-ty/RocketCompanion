export const RENDER_FRAME_MAGIC = 0x31464352; // "RCF1"
export const RENDER_FRAME_VERSION = 1;
export const RENDER_FRAME_BYTES = 152;

export const CAR_FLAG_IS_BOOSTING = 1 << 0;
export const CAR_FLAG_IS_SUPERSONIC = 1 << 1;
export const CAR_FLAG_ON_GROUND = 1 << 2;
export const CAR_FLAG_HAS_FLIPPED = 1 << 3;

export interface DecodedRenderFrame {
  tick: number;
  teleportSeq: number;
  ballCam: boolean;
  carFlags: number;
  carBoost: number;
  ballPos: [number, number, number];
  ballQuat: [number, number, number, number];
  ballVel: [number, number, number];
  carPos: [number, number, number];
  carQuat: [number, number, number, number];
  carVel: [number, number, number];
  camPos: [number, number, number];
  camDir: [number, number, number];
  camUp: [number, number, number];
  camFov: number;
}

export function decodeRenderFrame(buffer: ArrayBuffer): DecodedRenderFrame {
  if (buffer.byteLength < RENDER_FRAME_BYTES) {
    throw new Error(
      `Invalid RenderFrame byteLength=${buffer.byteLength}, expected >= ${RENDER_FRAME_BYTES}`
    );
  }
  const u32 = new Uint32Array(buffer, 0, 8);
  const f32 = new Float32Array(buffer, 0, RENDER_FRAME_BYTES / 4);

  if (u32[0] !== RENDER_FRAME_MAGIC || u32[1] !== RENDER_FRAME_VERSION) {
    throw new Error(
      `Invalid RenderFrame header magic=0x${u32[0].toString(16)} version=${u32[1]}`
    );
  }

  return {
    tick: u32[2],
    teleportSeq: u32[3],
    ballCam: u32[4] !== 0,
    carFlags: u32[5],
    carBoost: f32[6],
    ballPos: [f32[8], f32[9], f32[10]],
    ballQuat: [f32[11], f32[12], f32[13], f32[14]],
    ballVel: [f32[15], f32[16], f32[17]],
    carPos: [f32[18], f32[19], f32[20]],
    carQuat: [f32[21], f32[22], f32[23], f32[24]],
    carVel: [f32[25], f32[26], f32[27]],
    camPos: [f32[28], f32[29], f32[30]],
    camDir: [f32[31], f32[32], f32[33]],
    camUp: [f32[34], f32[35], f32[36]],
    camFov: f32[37],
  };
}
