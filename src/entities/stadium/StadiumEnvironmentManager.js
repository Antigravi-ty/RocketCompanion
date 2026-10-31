/**
 * StadiumEnvironmentManager.js
 * Manages Driftwoods stadium scene graph attachment and exterior visibility.
 */

import * as THREE from 'three';

export class StadiumEnvironmentManager {
  constructor(scene, onRenderTreeChanged) {
    this.scene = scene;
    this.onRenderTreeChanged = onRenderTreeChanged;
    this.stadiumVisible = true;
    this.driftwoodsStadiumVisible = true;
    this.sky = null;
    this.driftwoodsStadium = null;
  }

  attachDriftwoodsStadium(driftwoodsStadium) {
    if (driftwoodsStadium !== undefined) {
      this.driftwoodsStadium = driftwoodsStadium;
    }
    this.driftwoodsStadiumVisible = true;
    if (this.driftwoodsStadium) {
      if (!this.driftwoodsStadium.parent) {
        this.scene.add(this.driftwoodsStadium);
      }
      this.driftwoodsStadium.visible = true;
    }
    this.onRenderTreeChanged?.();
  }

  setStadiumVisible(visible, sky, driftwoodsStadium) {
    if (this.stadiumVisible !== visible) {
      this.stadiumVisible = visible;
      const effectiveSky = sky || this.sky;
      if (effectiveSky) {
        visible ? this.scene.add(effectiveSky) : effectiveSky.removeFromParent?.();
      }
      const effectiveStadium = driftwoodsStadium || this.driftwoodsStadium;
      if (effectiveStadium) {
        effectiveStadium.visible = Boolean(visible);
      }
      this.scene.background = new THREE.Color(visible ? 4679561 : 0);
      this.onRenderTreeChanged?.();
    }
  }
}
