import type { WorkerInboundMessage, WorkerOutboundMessage } from './protocol.ts';

interface RcCoreExports {
  memory: WebAssembly.Memory;
  rc_alloc: (size: number) => number;
  rc_free: (ptr: number, size: number) => void;
  rc_reset_mesh_staging: () => void;
  rc_push_mesh_chunk: (ptr: number, len: number) => number;
  rc_finalize_arena_meshes: () => number;
  rc_create_sim: () => number;
  rc_set_controls: (
    throttle: number,
    steer: number,
    pitch: number,
    yaw: number,
    roll: number,
    jump: number,
    boost: number,
    handbrake: number,
    ballCam: number
  ) => void;
  rc_set_aspect: (aspect: number) => void;
  rc_reset_kickoff: () => number;
  rc_step_sim: () => number;
  rc_get_render_frame_ptr: () => number;
  rc_get_render_frame_byte_len: () => number;
  rc_prepare_telemetry: () => number;
  rc_get_telemetry_ptr: () => number;
}

const FIXED_TICK_MS = 1000 / 120;
const MAX_TICKS_PER_WAKE = 4;

let wasm: RcCoreExports | null = null;
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let lastStepTimeMs = 0;
let accumulatorMs = 0;

function post(msg: WorkerOutboundMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    self.postMessage(msg, { transfer });
  } else {
    self.postMessage(msg);
  }
}

function transferCurrentFrame(): void {
  if (!wasm) return;
  const ptr = wasm.rc_get_render_frame_ptr();
  const len = wasm.rc_get_render_frame_byte_len();
  // Copy out of WASM linear memory into a fresh ArrayBuffer to prevent detached views on memory.grow.
  const copy = new Uint8Array(wasm.memory.buffer, ptr, len).slice();
  post({ type: 'frame', buffer: copy.buffer, workerTimeMs: performance.now() }, [copy.buffer]);
}

function scheduleLoop(): void {
  if (loopTimer !== null) {
    clearTimeout(loopTimer);
  }
  loopTimer = setTimeout(runStepLoop, 4);
}

function runStepLoop(): void {
  if (!wasm) return;
  const now = performance.now();
  const elapsed = Math.min(50, Math.max(0, now - lastStepTimeMs));
  lastStepTimeMs = now;
  accumulatorMs += elapsed;

  let steps = 0;
  while (accumulatorMs >= FIXED_TICK_MS && steps < MAX_TICKS_PER_WAKE) {
    wasm.rc_step_sim();
    transferCurrentFrame();
    accumulatorMs -= FIXED_TICK_MS;
    steps += 1;
  }

  scheduleLoop();
}

async function initCore(aspect: number): Promise<void> {
  const wasmUrl = new URL('./rc_core.wasm', import.meta.url).href;
  const wasmResp = await fetch(wasmUrl);
  if (!wasmResp.ok) {
    throw new Error(`Failed to fetch rc_core.wasm: HTTP ${wasmResp.status}`);
  }
  const wasmBytes = await wasmResp.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const exports = instance.exports as unknown as RcCoreExports;

  const manifestResp = await fetch('/arenamesh/manifest.json');
  if (!manifestResp.ok) {
    throw new Error(`Failed to fetch arena mesh manifest: HTTP ${manifestResp.status}`);
  }
  const chunkNames = (await manifestResp.json()) as string[];
  const chunkBuffers = await Promise.all(
    chunkNames.map(async (name) => {
      const resp = await fetch(`/arenamesh/${name}`);
      if (!resp.ok) {
        throw new Error(`Failed to fetch arena mesh ${name}: HTTP ${resp.status}`);
      }
      return new Uint8Array(await resp.arrayBuffer());
    })
  );

  exports.rc_reset_mesh_staging();
  for (const chunk of chunkBuffers) {
    const ptr = exports.rc_alloc(chunk.byteLength);
    new Uint8Array(exports.memory.buffer, ptr, chunk.byteLength).set(chunk);
    const pushRes = exports.rc_push_mesh_chunk(ptr, chunk.byteLength);
    exports.rc_free(ptr, chunk.byteLength);
    if (pushRes < 0) {
      throw new Error('rc_push_mesh_chunk failed');
    }
  }

  if (exports.rc_finalize_arena_meshes() !== 0) {
    throw new Error('rc_finalize_arena_meshes failed');
  }
  if (exports.rc_create_sim() !== 0) {
    throw new Error('rc_create_sim failed');
  }
  exports.rc_set_aspect(aspect);

  wasm = exports;
  transferCurrentFrame();
  post({ type: 'ready' });

  lastStepTimeMs = performance.now();
  accumulatorMs = 0;
  scheduleLoop();
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    initCore(msg.aspect).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      post({ type: 'error', message });
    });
    return;
  }

  if (!wasm) return;

  switch (msg.type) {
    case 'controls': {
      const c = msg.input;
      wasm.rc_set_controls(
        c.throttle,
        c.steer,
        c.pitch,
        c.yaw,
        c.roll,
        c.jump ? 1 : 0,
        c.boost ? 1 : 0,
        c.handbrake ? 1 : 0,
        c.ballCam ? 1 : 0
      );
      break;
    }
    case 'resetKickoff': {
      wasm.rc_reset_kickoff();
      transferCurrentFrame();
      break;
    }
    case 'setAspect': {
      wasm.rc_set_aspect(msg.aspect);
      break;
    }
    case 'requestTelemetry': {
      const byteLen = wasm.rc_prepare_telemetry();
      const ptr = wasm.rc_get_telemetry_ptr();
      const copy =
        byteLen > 0 && ptr !== 0
          ? new Uint8Array(wasm.memory.buffer, ptr, byteLen).slice()
          : new Uint8Array(0);
      post({ type: 'telemetry', buffer: copy.buffer }, [copy.buffer]);
      break;
    }
  }
};
