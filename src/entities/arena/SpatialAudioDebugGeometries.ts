/**
 * SpatialAudioDebugGeometries.ts
 * Pure Three.js wireframe geometry builders and 2D Canvas billboard renderer
 * for SpatialAudioDebugVisualizer.
 */

import * as THREE from 'three';
import type { SpatialAttenuationProfile } from '../../ui-core/config/spatialAttenuationProfiles';
import type { SpatialAudioVisualizerConfig } from '../../ui-core/config/spatialAudioVisualizerConfig';

export const INNER_COLOR_HEX = 0x10b981; // Emerald 500 (100% Core)
export const ISO75_COLOR_HEX = 0x34d399; // Emerald 400 (75% Contour)
export const ISO50_COLOR_HEX = 0x38bdf8; // Sky 400 (50% / -6dB Iso-Ring)
export const ISO25_COLOR_HEX = 0xfbbf24; // Amber 400 (25% Contour)
export const OUTER_FLOOR_HEX = 0xf59e0b; // Amber 500 (Soft Floor > 0)
export const OUTER_CULL_HEX = 0xf43f5e;  // Rose 500 (Hard Cull = 0)

export interface SpatialAudioBillboardResources {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  texture: THREE.CanvasTexture;
  lastSignature: string;
}

export function createUnitSphereWireframeGeometry(segments = 64): THREE.BufferGeometry {
  const positions: number[] = [];
  const addRing = (axis: 'xy' | 'xz' | 'yz', radius = 1.0, yOffset = 0.0) => {
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const c0 = Math.cos(a0) * radius;
      const s0 = Math.sin(a0) * radius;
      const c1 = Math.cos(a1) * radius;
      const s1 = Math.sin(a1) * radius;
      if (axis === 'xz') {
        positions.push(c0, yOffset, s0, c1, yOffset, s1);
      } else if (axis === 'xy') {
        positions.push(c0, s0, 0, c1, s1, 0);
      } else {
        positions.push(0, s0, c0, 0, s1, c1);
      }
    }
  };

  addRing('xz', 1.0, 0.0);
  addRing('xz', Math.cos(Math.PI / 6), Math.sin(Math.PI / 6));
  addRing('xz', Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6));
  addRing('xy', 1.0, 0.0);
  addRing('yz', 1.0, 0.0);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geom;
}

export function createUnitCircleLineGeometry(segments = 96, dashed = false): THREE.BufferGeometry {
  const positions: number[] = [];
  const step = dashed ? 2 : 1;
  for (let i = 0; i < segments; i += step) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    positions.push(Math.cos(a0), 0, Math.sin(a0), Math.cos(a1), 0, Math.sin(a1));
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geom;
}

export function createSpatialAudioBillboard(): SpatialAudioBillboardResources | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 144;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  const spriteMat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.renderOrder = 1002;
  return {
    sprite,
    canvas,
    ctx,
    texture,
    lastSignature: '',
  };
}

export function renderSpatialAudioBillboardLabel(
  billboard: SpatialAudioBillboardResources,
  profile: SpatialAttenuationProfile,
  cfg: SpatialAudioVisualizerConfig,
  distUU: number,
  gain: number,
  isCulled: boolean,
  r50: number,
  rMin: number = profile.minDistanceUU,
  rMax: number = profile.maxDistanceUU
): void {
  const { ctx, canvas, texture } = billboard;
  if (!ctx) return;
  const distRound = Math.round(distUU);
  const gainPct = (gain * 100).toFixed(1);
  const rMinRound = Math.round(rMin);
  const r50Round = Math.round(r50);
  const rMaxRound = Math.round(rMax);
  const sig = `${profile.id}|${cfg.anchorMode}|${distRound}|${gainPct}|${isCulled}|${rMinRound}|${r50Round}|${rMaxRound}`;
  if (sig === billboard.lastSignature) return;
  billboard.lastSignature = sig;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = 'rgba(10, 14, 23, 0.88)';
  ctx.strokeStyle = isCulled
    ? 'rgba(244, 63, 94, 0.85)'
    : gain >= 0.999
      ? 'rgba(16, 185, 129, 0.9)'
      : 'rgba(56, 189, 248, 0.85)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(6, 6, w - 12, h - 12, 18);
  ctx.fill();
  ctx.stroke();

  ctx.font = 'bold 20px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#f8fafc';
  const modeTag = cfg.anchorMode === 'listener' ? 'LISTENER RADAR' : 'EMITTER SPHERE';
  ctx.fillText(`${profile.label} [${modeTag}]`, 22, 38);

  const dbStr = gain <= 1e-4 ? '-∞ dB' : `${(20 * Math.log10(gain)).toFixed(1)} dB`;
  const statusText = isCulled
    ? 'CULLED (0%)'
    : gain >= 0.999
      ? 'CORE (100%)'
      : distUU >= rMax
        ? 'FLOOR'
        : 'ROLLOFF';
  ctx.font = 'bold 24px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = isCulled ? '#fb7185' : gain >= 0.999 ? '#34d399' : '#38bdf8';
  ctx.fillText(`Dist: ${distRound} UU  ·  Gain: ${gainPct}% (${dbStr})`, 22, 78);

  ctx.font = '18px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(
    `R_min: ${rMinRound} · R_50%: ${r50Round} · R_max: ${rMaxRound} UU [${statusText}]`,
    22,
    114
  );

  texture.needsUpdate = true;
}
