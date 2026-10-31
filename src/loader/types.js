/**
 * src/loader/types.js
 * Loading Subsystem Types and Lifecycle Stage Definitions.
 */

export const TaskStatus = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped'
});

export const LOADING_STAGES = Object.freeze([
  {
    index: 1,
    id: 'preflight',
    title: 'Security Preflight',
    description: 'Verifying POV camera microkernel SHA-256 and ABI integrity...',
    weight: 0.10
  },
  {
    index: 2,
    id: 'diagnostics',
    title: 'Asset Diagnostics',
    description: 'Auditing static assets and validating binary headers...',
    weight: 0.05
  },
  {
    index: 3,
    id: 'physics',
    title: 'Physics & Arena Mesh',
    description: 'Streaming RocketSim WASM and building 16-chunk collision mesh...',
    weight: 0.35
  },
  {
    index: 4,
    id: 'geometry',
    title: '3D Geometry & Assets',
    description: 'Streaming stadium turf, ball, and player vehicle meshes...',
    weight: 0.30
  },
  {
    index: 5,
    id: 'shaders',
    title: 'Shader Pipeline Prewarming',
    description: 'Pre-compiling GPU shaders and prewarming bloom rendering passes...',
    weight: 0.15
  },
  {
    index: 6,
    id: 'ignition',
    title: 'Engine Ignition',
    description: 'Firing 120Hz deterministic render clock and synchronizing first frame...',
    weight: 0.05
  }
]);

export function getStageMeta(stageIndex) {
  return LOADING_STAGES.find(s => s.index === stageIndex) || {
    index: stageIndex,
    id: `stage_${stageIndex}`,
    title: `Stage ${stageIndex}`,
    description: 'Processing...',
    weight: 0.1
  };
}
