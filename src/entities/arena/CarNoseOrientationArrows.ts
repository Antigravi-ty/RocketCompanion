/**
 * CarNoseOrientationArrows.ts
 * 3D Custom-Training-Pack-style 4-way orientation arrows hard-attached to the
 * center of the front face (nose) of the active vehicle's collision hitbox:
 *   - W: Nose -> Car Bottom (-carUp)
 *   - S: Nose -> Car Top/Roof (+carUp)
 *   - A: Nose -> Car Left (-carRight)
 *   - D: Nose -> Car Right (+carRight)
 * Also computes the exact camera-projected 2D screen angles for the Keyboard Input Overlay's
 * 3D WASD keycap arrows and publishes live keyboard state telemetry.
 */

import * as THREE from 'three';
import { createBallLocatorHaloTexture } from '../BallLocatorArrow.ts';
import {
  getKeyboardInputOverlayConfig,
  resolveNoseArrowHexColors,
} from '../../ui-core/config/keyboardInputOverlayConfig.ts';
import { updateKeyboardInputOverlayTelemetry } from '../../ui-core/config/keyboardInputOverlayTelemetry.ts';
import { HITBOX_PRESETS } from '../../ui-core/config/vehiclePresets.ts';
import { OCTANE_HITBOX_PRESET } from './ArenaConstants.ts';
import {
  createSingleNoseArrowBundle,
  disposeSingleNoseArrowBundle,
  updateSingleNoseArrowBundle,
  type NoseArrowMeshBundle,
} from './CarNoseArrowGeometryBuilder.ts';

export class CarNoseOrientationArrows {
  public readonly scene: THREE.Scene;
  public readonly rootGroup: THREE.Group;

  private _haloTexture: THREE.Texture | null = null;
  private _originHubMesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial> | null =
    null;
  private _arrows: {
    w: NoseArrowMeshBundle;
    s: NoseArrowMeshBundle;
    a: NoseArrowMeshBundle;
    d: NoseArrowMeshBundle;
  } | null = null;

  private readonly _localNosePos = new THREE.Vector3();
  private readonly _worldNosePos = new THREE.Vector3();
  private readonly _dirW = new THREE.Vector3();
  private readonly _dirS = new THREE.Vector3();
  private readonly _dirA = new THREE.Vector3();
  private readonly _dirD = new THREE.Vector3();
  private readonly _originView = new THREE.Vector3();
  private readonly _tipView = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'car-nose-orientation-arrows-root';
    this.rootGroup.visible = false;
    this.scene.add(this.rootGroup);
  }

  private _ensureBuilt(): void {
    if (this._arrows) return;
    this._haloTexture = createBallLocatorHaloTexture();

    const hubMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      emissive: 0x64748b,
      emissiveIntensity: 0.45,
      metalness: 0.2,
      roughness: 0.35,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
    });
    this._originHubMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), hubMat);
    this._originHubMesh.renderOrder = 15;
    this.rootGroup.add(this._originHubMesh);

    this._arrows = {
      w: createSingleNoseArrowBundle(
        this.rootGroup,
        this._haloTexture,
        '#10b981',
        'nose-arrow-w-bottom'
      ),
      s: createSingleNoseArrowBundle(
        this.rootGroup,
        this._haloTexture,
        '#f43f5e',
        'nose-arrow-s-top'
      ),
      a: createSingleNoseArrowBundle(
        this.rootGroup,
        this._haloTexture,
        '#f59e0b',
        'nose-arrow-a-left'
      ),
      d: createSingleNoseArrowBundle(
        this.rootGroup,
        this._haloTexture,
        '#0ea5e9',
        'nose-arrow-d-right'
      ),
    };
  }

  private _projectDirectionAngleDeg(
    originWorld: THREE.Vector3,
    dirWorld: THREE.Vector3,
    lengthUu: number,
    camera: THREE.Camera
  ): number {
    this._originView.copy(originWorld).applyMatrix4(camera.matrixWorldInverse);
    this._tipView
      .copy(originWorld)
      .addScaledVector(dirWorld, Math.max(25, lengthUu))
      .applyMatrix4(camera.matrixWorldInverse);

    let dx = 0;
    let dy = 0;
    if (this._originView.z < -1 && this._tipView.z < -1) {
      const ox = this._originView.x / -this._originView.z;
      const oy = this._originView.y / -this._originView.z;
      const tx = this._tipView.x / -this._tipView.z;
      const ty = this._tipView.y / -this._tipView.z;
      dx = tx - ox;
      dy = ty - oy;
    }
    if (dx * dx + dy * dy < 1e-7) {
      dx = this._tipView.x - this._originView.x;
      dy = this._tipView.y - this._originView.y;
    }
    if (dx * dx + dy * dy < 1e-9) {
      return 0;
    }
    return Math.atan2(dx, dy) * (180 / Math.PI);
  }

  public update(
    targetCar:
      | { position: THREE.Vector3; quaternion: THREE.Quaternion; visible?: boolean }
      | null
      | undefined,
    carPresetKey: string | null | undefined,
    camera: THREE.Camera | null | undefined,
    keyboard?: { held?(action: string): boolean } | null
  ): void {
    const cfg = getKeyboardInputOverlayConfig();

    const qPressed = Boolean(keyboard?.held?.('airRollLeft'));
    const wPressed = Boolean(keyboard?.held?.('throttleForward'));
    const ePressed = Boolean(keyboard?.held?.('airRollRight'));
    const aPressed = Boolean(keyboard?.held?.('steerLeft'));
    const sPressed = Boolean(keyboard?.held?.('throttleReverse'));
    const dPressed = Boolean(keyboard?.held?.('steerRight'));
    const slidePressed = Boolean(keyboard?.held?.('powerslide'));
    const boostPressed = Boolean(keyboard?.held?.('boost'));
    const jumpPressed = Boolean(keyboard?.held?.('jump'));

    if (!targetCar || targetCar.visible === false) {
      this.rootGroup.visible = false;
      updateKeyboardInputOverlayTelemetry({
        qPressed,
        wPressed,
        ePressed,
        aPressed,
        sPressed,
        dPressed,
        slidePressed,
        boostPressed,
        jumpPressed,
      });
      return;
    }

    const preset =
      (carPresetKey && HITBOX_PRESETS[carPresetKey as keyof typeof HITBOX_PRESETS]) ||
      OCTANE_HITBOX_PRESET;

    // Front face (nose) center of the 6-face collision hitbox in local Three.js car coords (+X = fwd, +Y = up, +Z = right)
    const noseLocalX = preset.forward + preset.length * 0.5 + cfg.noseForwardOffsetUu;
    const noseLocalY = preset.up;
    this._localNosePos.set(noseLocalX, noseLocalY, 0);
    this._worldNosePos
      .copy(this._localNosePos)
      .applyQuaternion(targetCar.quaternion)
      .add(targetCar.position);

    // 4 orthogonal directions from the car nose:
    // W = toward car bottom (-carUp = (0, -1, 0))
    // S = toward car top/roof (+carUp = (0, +1, 0))
    // A = toward car left (-carRight = (0, 0, -1))
    // D = toward car right (+carRight = (0, 0, +1))
    this._dirW.set(0, -1, 0).applyQuaternion(targetCar.quaternion).normalize();
    this._dirS.set(0, 1, 0).applyQuaternion(targetCar.quaternion).normalize();
    this._dirA.set(0, 0, -1).applyQuaternion(targetCar.quaternion).normalize();
    this._dirD.set(0, 0, 1).applyQuaternion(targetCar.quaternion).normalize();

    if (camera) {
      camera.updateMatrixWorld();
      const projLen = cfg.noseArrowTotalLengthUu || 85;
      const wAngleDeg = this._projectDirectionAngleDeg(
        this._worldNosePos,
        this._dirW,
        projLen,
        camera
      );
      const sAngleDeg = this._projectDirectionAngleDeg(
        this._worldNosePos,
        this._dirS,
        projLen,
        camera
      );
      const aAngleDeg = this._projectDirectionAngleDeg(
        this._worldNosePos,
        this._dirA,
        projLen,
        camera
      );
      const dAngleDeg = this._projectDirectionAngleDeg(
        this._worldNosePos,
        this._dirD,
        projLen,
        camera
      );

      updateKeyboardInputOverlayTelemetry({
        wAngleDeg,
        sAngleDeg,
        aAngleDeg,
        dAngleDeg,
        qPressed,
        wPressed,
        ePressed,
        aPressed,
        sPressed,
        dPressed,
        slidePressed,
        boostPressed,
        jumpPressed,
      });
    } else {
      updateKeyboardInputOverlayTelemetry({
        qPressed,
        wPressed,
        ePressed,
        aPressed,
        sPressed,
        dPressed,
        slidePressed,
        boostPressed,
        jumpPressed,
      });
    }

    if (!cfg.enableNoseArrowRendering) {
      this.rootGroup.visible = false;
      return;
    }

    this._ensureBuilt();
    this.rootGroup.visible = true;

    if (this._originHubMesh) {
      this._originHubMesh.position.copy(this._worldNosePos);
      this._originHubMesh.scale.setScalar(Math.max(1.8, cfg.noseShaftRadiusUu * 1.45));
      this._originHubMesh.material.opacity = cfg.noseArrowOpacity;
    }

    const colors = resolveNoseArrowHexColors(cfg);
    if (this._arrows) {
      updateSingleNoseArrowBundle(
        this._arrows.w,
        this._worldNosePos,
        this._dirW,
        colors.wHex,
        cfg,
        wPressed
      );
      updateSingleNoseArrowBundle(
        this._arrows.s,
        this._worldNosePos,
        this._dirS,
        colors.sHex,
        cfg,
        sPressed
      );
      updateSingleNoseArrowBundle(
        this._arrows.a,
        this._worldNosePos,
        this._dirA,
        colors.aHex,
        cfg,
        aPressed
      );
      updateSingleNoseArrowBundle(
        this._arrows.d,
        this._worldNosePos,
        this._dirD,
        colors.dHex,
        cfg,
        dPressed
      );
    }
  }

  public dispose(): void {
    this.rootGroup.visible = false;
    if (this._arrows) {
      for (const b of Object.values(this._arrows)) {
        disposeSingleNoseArrowBundle(b);
      }
      this._arrows = null;
    }
    if (this._originHubMesh) {
      this._originHubMesh.geometry.dispose();
      this._originHubMesh.material.dispose();
      this._originHubMesh = null;
    }
    if (this._haloTexture) {
      this._haloTexture.dispose();
      this._haloTexture = null;
    }
    this.scene.remove(this.rootGroup);
  }
}
