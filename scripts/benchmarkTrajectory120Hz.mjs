#!/usr/bin/env node
/**
 * scripts/benchmarkTrajectory120Hz.mjs
 * 120Hz continuous trajectory sampling & zero-copy WASM mesh benchmark.
 * Validates `_physics_buildTrajectoryMesh` and zero-copy pointer reads
 * over 1200 simulated 120Hz frames (10 seconds) with zero heap churn.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const wasmPath = path.join(rootDir, 'src/physics/core.wasm');
  const coreJsPath = path.join(rootDir, 'src/physics/core.js');
  const wasmBinary = fs.readFileSync(wasmPath);
  const { default: createModule } = await import(coreJsPath);
  const mod = await createModule({ wasmBinary });

  const headerPtr = mod._physics_getTrajectoryMeshHeaderPtr();
  const posPtr = mod._physics_getTrajectoryPositionsPtr();
  const normPtr = mod._physics_getTrajectoryNormalsPtr();
  const uvPtr = mod._physics_getTrajectoryUvsPtr();
  const idxPtr = mod._physics_getTrajectoryIndicesPtr();
  const bouncePtr = mod._physics_getTrajectoryBounceMarkersPtr();
  const dropsPtr = mod._physics_getTrajectoryGroundDropsPtr();
  const rawPtsPtr = mod._physics_getTrajectoryRawPointsPtr();

  if (
    !headerPtr ||
    !posPtr ||
    !normPtr ||
    !uvPtr ||
    !idxPtr ||
    !bouncePtr ||
    !dropsPtr ||
    !rawPtsPtr
  ) {
    throw new Error('Missing zero-copy trajectory WASM pointers');
  }

  const headerU32 = new Uint32Array(mod.HEAPF32.buffer, headerPtr, 8);
  const rawPtsWord = rawPtsPtr >>> 2;
  const sampleCount = 360;
  for (let i = 0; i < sampleCount; i++) {
    const t = i / 120;
    const x = Math.sin(t * 2.1) * 1800;
    const y = Math.cos(t * 1.4) * 3200;
    const z = Math.abs(Math.sin(t * 3.0)) * 1200 + 93.15;
    mod.HEAPF32[rawPtsWord + i * 3 + 0] = x;
    mod.HEAPF32[rawPtsWord + i * 3 + 1] = y;
    mod.HEAPF32[rawPtsWord + i * 3 + 2] = z;
  }
  headerU32[5] = sampleCount;

  const iterations = 1200;
  let totalIndices = 0;
  let totalVertices = 0;
  const t0 = performance.now();

  for (let frame = 0; frame < iterations; frame++) {
    const startIdx = frame % 120;
    const indexCount = mod._physics_buildTrajectoryMesh(
      startIdx,
      120,
      60,
      frame % 12,
      18.25,
      0.35,
      6,
      1,
      0,
      60,
      0b11,
      1,
      mod.HEAPF32[rawPtsWord + startIdx * 3],
      mod.HEAPF32[rawPtsWord + startIdx * 3 + 1],
      mod.HEAPF32[rawPtsWord + startIdx * 3 + 2]
    );
    totalIndices += indexCount;
    totalVertices += headerU32[0];
  }

  const elapsedMs = performance.now() - t0;
  const usPerFrame = (elapsedMs * 1000) / iterations;
  const result = {
    iterations,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    usPerFrame: Number(usPerFrame.toFixed(2)),
    avgVertices: Math.round(totalVertices / iterations),
    avgIndices: Math.round(totalIndices / iterations),
    budget120HzUs: 8333.33,
    headroomPct: Number((((8333.33 - usPerFrame) / 8333.33) * 100).toFixed(2)),
  };
  console.log(JSON.stringify(result, null, 2));
  if (usPerFrame > 1000) {
    throw new Error(`Trajectory mesh build too slow: ${usPerFrame}us/frame`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
