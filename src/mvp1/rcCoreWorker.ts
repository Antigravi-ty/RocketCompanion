import { RENDER_FRAME_BYTES } from './renderFrameCodec.ts';

interface RcCoreWasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  rc_alloc(byteLen: number): number;
  rc_free(ptr: number, byteLen: number): void;
  rc_init_arena(meshDataPtr: number, meshSizesPtr: number, chunkCount: number): number;
  rc_set_controls(
    throttle: number,
    steer: number,
    pitch: number,
    yaw: number,
    roll: number,
    jump: number,
    boost: number,
    handbrake: number,
    ballCam: number
  ): void;
  rc_step(ticks: number): void;
  rc_reset_kickoff(seed: number): void;
  rc_get_frame_len(): number;
  rc_copy_frame(outPtr: number): number;
}

type WorkerInboundMessage =
  | { type: 'controls'; data: Float32Array }
  | { type: 'reset'; seed?: number };

const workerSelf = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: (evt: MessageEvent) => void): void;
};

let wasm: RcCoreWasmExports | null = null;
let framePtr = 0;
let frameLen = RENDER_FRAME_BYTES;
const controls = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 1]);
let running = false;

const FIXED_STEP_MS = 1000 / 120;
let lastMs = 0;
let accumulatorMs = 0;

async function initWorker(): Promise<void> {
  const wasmUrl = new URL('./rc_core.wasm', import.meta.url).href;
  const wasmRes = await fetch(wasmUrl);
  if (!wasmRes.ok) {
    throw new Error(`Failed to fetch rc_core.wasm: ${wasmRes.status} ${wasmRes.statusText}`);
  }
  const wasmBytes = await wasmRes.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  wasm = instance.exports as RcCoreWasmExports;

  const manifestRes = await fetch('/arenamesh/manifest.json');
  if (!manifestRes.ok) {
    throw new Error(`Failed to fetch /arenamesh/manifest.json: ${manifestRes.status}`);
  }
  const chunkNames = (await manifestRes.json()) as string[];
  const chunks = await Promise.all(
    chunkNames.map(async (name) => {
      const res = await fetch(`/arenamesh/${name}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch /arenamesh/${name}: ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    })
  );

  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const meshDataPtr = wasm.rc_alloc(totalBytes);
  const meshSizesPtr = wasm.rc_alloc(chunks.length * 4);

  const heapU8 = new Uint8Array(wasm.memory.buffer);
  const heapI32 = new Int32Array(wasm.memory.buffer);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    heapU8.set(chunks[i], meshDataPtr + offset);
    heapI32[(meshSizesPtr >> 2) + i] = chunks[i].byteLength;
    offset += chunks[i].byteLength;
  }

  const ok = wasm.rc_init_arena(meshDataPtr, meshSizesPtr, chunks.length);
  wasm.rc_free(meshDataPtr, totalBytes);
  wasm.rc_free(meshSizesPtr, chunks.length * 4);
  if (ok !== 1) {
    throw new Error('rc_init_arena returned 0');
  }

  frameLen = wasm.rc_get_frame_len();
  framePtr = wasm.rc_alloc(frameLen);

  emitFrame();

  running = true;
  lastMs = performance.now();
  scheduleLoop();
  workerSelf.postMessage({ type: 'ready', frameLen });
}

function emitFrame(): void {
  if (!wasm || !framePtr) return;
  const copied = wasm.rc_copy_frame(framePtr);
  if (copied !== frameLen) {
    throw new Error(`rc_copy_frame returned ${copied}, expected ${frameLen}`);
  }
  const copyBuf = wasm.memory.buffer.slice(framePtr, framePtr + frameLen);
  workerSelf.postMessage({ type: 'frame', buffer: copyBuf }, [copyBuf]);
}

function tickLoop(): void {
  if (!running || !wasm) return;
  const now = performance.now();
  const elapsed = Math.min(now - lastMs, 50);
  lastMs = now;
  accumulatorMs += elapsed;

  let stepped = 0;
  while (accumulatorMs >= FIXED_STEP_MS && stepped < 8) {
    wasm.rc_set_controls(
      controls[0],
      controls[1],
      controls[2],
      controls[3],
      controls[4],
      controls[5],
      controls[6],
      controls[7],
      controls[8]
    );
    wasm.rc_step(1);
    emitFrame();
    accumulatorMs -= FIXED_STEP_MS;
    stepped++;
  }
  scheduleLoop();
}

function scheduleLoop(): void {
  setTimeout(tickLoop, 4);
}

workerSelf.addEventListener('message', (evt: MessageEvent<WorkerInboundMessage>) => {
  const msg = evt.data;
  if (msg.type === 'controls') {
    controls.set(msg.data);
  } else if (msg.type === 'reset' && wasm) {
    wasm.rc_reset_kickoff(msg.seed ?? -1);
    emitFrame();
  }
});

initWorker().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  workerSelf.postMessage({ type: 'error', message });
});
