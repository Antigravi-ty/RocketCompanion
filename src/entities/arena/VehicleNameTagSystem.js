/**
 * VehicleNameTagSystem.js
 * Renders camera-distance-scaled horizontal pill name tags above vehicles in
 * Multiplayer Mode, Multi-Car Bots Mode, and the 6-Car Kickoff Name Tag Active Tuner.
 */

import * as THREE from 'three';
import {
  getNameTagConfig,
  getNameTagRuntimeState,
} from '../../config/nameTagConfig.ts';

const CANVAS_W = 512;
const CANVAS_H = 160;

function hexToRgba(hex, alpha = 1.0) {
  const clean = String(hex || '#000000').replace('#', '');
  const num = parseInt(
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean,
    16
  );
  if (!Number.isFinite(num)) return `rgba(12, 45, 72, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

function truncateUsername(name, maxChars) {
  const str = String(name || 'Player').trim();
  const limit = Math.max(4, Math.min(32, Math.round(maxChars || 16)));
  if (str.length <= limit) return str;
  return `${str.slice(0, Math.max(1, limit - 1))}…`;
}

function createNameTagSprite() {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (canvas) {
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
  }
  const texture = canvas ? new THREE.CanvasTexture(canvas) : null;
  if (texture) {
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if (THREE.SRGBColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace;
    }
  }
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0.94,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 950;
  sprite.frustumCulled = false;
  sprite.visible = false;
  sprite.userData = {
    canvas,
    texture,
    material,
    cacheKey: '',
  };
  return sprite;
}

function renderPillCardToSprite(sprite, displayText, team, cfg) {
  if (!sprite?.userData?.canvas) return;
  const isOrange = team === 1;
  const bgColor = isOrange ? cfg.orangeBgColor : cfg.blueBgColor;
  const borderColor = isOrange ? cfg.orangeBorderColor : cfg.blueBorderColor;
  const textColor = isOrange ? cfg.orangeTextColor : cfg.blueTextColor;

  const key = [
    displayText,
    team,
    cfg.pillWidth,
    cfg.pillHeight,
    cfg.borderWidth,
    cfg.fontSize,
    cfg.bgOpacity,
    bgColor,
    borderColor,
    textColor,
  ].join('|');

  if (sprite.userData.cacheKey === key) return;
  sprite.userData.cacheKey = key;

  const canvas = sprite.userData.canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  const w = Math.max(100, Math.min(CANVAS_W - 24, Number(cfg.pillWidth) || 240));
  const h = Math.max(28, Math.min(CANVAS_H - 24, Number(cfg.pillHeight) || 54));
  const x = (CANVAS_W - w) * 0.5;
  const y = (CANVAS_H - h) * 0.5;
  const radius = h * 0.5;

  // Horizontal pill background
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = hexToRgba(bgColor, cfg.bgOpacity);
  ctx.fill();

  const bw = Math.max(0, Math.min(12, Number(cfg.borderWidth) ?? 3.5));
  if (bw > 0) {
    ctx.lineWidth = bw;
    ctx.strokeStyle = borderColor;
    ctx.stroke();
  }

  // Clip inside pill so text never bleeds outside border
  ctx.clip();

  const fontSize = Math.max(12, Math.min(48, Number(cfg.fontSize) || 25));
  ctx.font = `700 ${fontSize}px "JetBrains Mono", "SF Mono", "Inter", system-ui, sans-serif`;
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayText, CANVAS_W * 0.5, CANVAS_H * 0.5 + 1);
  ctx.restore();

  if (sprite.userData.texture) {
    sprite.userData.texture.needsUpdate = true;
  }
}

export class VehicleNameTagSystem {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'vehicle-name-tags';
    this.sprites = [];

    for (let i = 0; i < 8; i++) {
      const sprite = createNameTagSprite();
      this.sprites.push(sprite);
      this.root.add(sprite);
    }

    if (this.scene) {
      this.scene.add(this.root);
    }
  }

  update(arena, numCars = 0, camera = null) {
    if (!arena || !this.root) return;
    const cfg = getNameTagConfig();
    const rt = getNameTagRuntimeState();

    const shouldShowSystem =
      Boolean(cfg.enabled) &&
      (Boolean(rt.isTunerArenaActive) ||
        Boolean(rt.isMultiplayerOrMultiCarMode) ||
        Boolean(arena.isLobbyMode) ||
        numCars > 1);

    if (!shouldShowSystem) {
      this.root.visible = false;
      return;
    }

    this.root.visible = true;
    const activeCam = camera || arena.camera;
    const maxSlots = Math.min(this.sprites.length, Math.max(arena.cars?.length || 0, numCars));

    for (let carIndex = 0; carIndex < this.sprites.length; carIndex++) {
      const sprite = this.sprites[carIndex];
      if (!sprite) continue;

      const carMesh = arena.cars?.[carIndex];
      if (carIndex >= maxSlots || !carMesh || !carMesh.visible) {
        sprite.visible = false;
        continue;
      }

      const isLocalCar = carIndex === (arena.playerCarIndex ?? 0);
      if (isLocalCar && !cfg.showOnLocalCar && !rt.isTunerArenaActive && !arena.isFreeCam) {
        sprite.visible = false;
        continue;
      }

      const entry = Array.isArray(rt.carEntries)
        ? rt.carEntries.find((e) => e.carIndex === carIndex)
        : null;

      const rawName =
        entry?.name ||
        cfg.previewNames?.[carIndex % 6] ||
        `Player ${carIndex + 1}`;
      const team =
        typeof entry?.team === 'number'
          ? entry.team
          : typeof arena.carTeams?.[carIndex] === 'number'
          ? arena.carTeams[carIndex]
          : carIndex < 3
          ? 0
          : 1;

      const displayText = truncateUsername(rawName, cfg.maxChars);
      renderPillCardToSprite(sprite, displayText, team, cfg);

      sprite.material.opacity = Math.max(0.1, Math.min(1.0, Number(cfg.opacity) || 0.94));
      sprite.position.set(
        carMesh.position.x,
        carMesh.position.y + (Number(cfg.verticalOffsetUu) || 88),
        carMesh.position.z
      );

      // Keep constant size relative to camera distance
      let dist = 1200;
      if (activeCam?.position) {
        dist = Math.max(180, activeCam.position.distanceTo(sprite.position));
      }
      const scaleFactor = Math.max(0.04, Math.min(0.3, Number(cfg.cameraScaleFactor) || 0.11));
      const baseHeightWorld = dist * scaleFactor;
      const baseWidthWorld = baseHeightWorld * (CANVAS_W / CANVAS_H);
      sprite.scale.set(baseWidthWorld, baseHeightWorld, 1);
      sprite.visible = true;
    }
  }

  dispose() {
    for (const s of this.sprites) {
      s?.userData?.texture?.dispose?.();
      s?.userData?.material?.dispose?.();
    }
    if (this.root && this.scene) {
      this.scene.remove(this.root);
    }
  }
}
