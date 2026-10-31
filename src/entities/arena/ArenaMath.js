/**
 * ArenaMath.js
 * Coordinate space transforms, basis orientation unpackers,
 * and visual hitbox wireframe generation for ArenaWorld entities.
 */

import * as THREE from 'three';
import { OCTANE_HITBOX_PRESET } from './ArenaConstants.js';

export function unrealToThreeCoords(target, x = 0, y = 0, z = 0) {
  return target.set(x || 0, z || 0, y || 0);
}

let basisFwd = null;
let basisRight = null;
let basisUp = null;
let basisMatrix = null;

function ensureBasisHelpers() {
  if (!basisFwd) basisFwd = new THREE.Vector3();
  if (!basisRight) basisRight = new THREE.Vector3();
  if (!basisUp) basisUp = new THREE.Vector3();
  if (!basisMatrix) basisMatrix = new THREE.Matrix4();
}

/**
 * Converts 3-axis basis vectors from state view to Three.js Quaternion.
 */
export function viewBasisToQuaternion(targetQuat, view) {
  ensureBasisHelpers();

  unrealToThreeCoords(basisFwd, view.fwdX, view.fwdY, view.fwdZ);
  unrealToThreeCoords(basisRight, view.rightX, view.rightY, view.rightZ);
  unrealToThreeCoords(basisUp, view.upX, view.upY, view.upZ);

  if (basisFwd.lengthSq() < 1e-6 || basisUp.lengthSq() < 1e-6 || basisRight.lengthSq() < 1e-6) {
    targetQuat.set(0, 0, 0, 1);
    return targetQuat;
  }

  basisMatrix.makeBasis(basisFwd, basisUp, basisRight);
  targetQuat.setFromRotationMatrix(basisMatrix);
  return targetQuat;
}

export function bufferBasisToQuaternion(targetQuat, buffer, offset) {
  ensureBasisHelpers();

  unrealToThreeCoords(basisFwd, buffer[offset], buffer[offset + 1], buffer[offset + 2]);
  unrealToThreeCoords(basisRight, buffer[offset + 3], buffer[offset + 4], buffer[offset + 5]);
  unrealToThreeCoords(basisUp, buffer[offset + 6], buffer[offset + 7], buffer[offset + 8]);

  if (basisFwd.lengthSq() < 1e-6 || basisUp.lengthSq() < 1e-6 || basisRight.lengthSq() < 1e-6) {
    targetQuat.set(0, 0, 0, 1);
    return targetQuat;
  }

  basisMatrix.makeBasis(basisFwd, basisUp, basisRight);
  targetQuat.setFromRotationMatrix(basisMatrix);
  return targetQuat;
}

/**
 * Backward compatibility quaternion unpacker: supports either 9-float basis vector extraction
 * or fallback 4-float quaternion unpacking.
 */
export function unpackBufferQuaternion(targetQuat, buffer, offset) {
  if (!buffer || buffer.length < offset + 9) {
    if (buffer && buffer.length >= offset + 4 && (buffer[offset] || buffer[offset + 1] || buffer[offset + 2] || buffer[offset + 3])) {
      targetQuat.set(buffer[offset], buffer[offset + 2], buffer[offset + 1], buffer[offset + 3]);
      return targetQuat;
    }
    targetQuat.set(0, 0, 0, 1);
    return targetQuat;
  }
  return bufferBasisToQuaternion(targetQuat, buffer, offset);
}

/**
 * Generates procedural wireframe box for visual hitbox debugging.
 */
export function createCarHitboxWireframe(preset = OCTANE_HITBOX_PRESET) {
  const boxGeom = new THREE.BoxGeometry(preset.length, preset.height, preset.width);
  const edgesGeom = new THREE.EdgesGeometry(boxGeom);
  const lineMat = new THREE.LineBasicMaterial({
    color: 16777215,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
    depthWrite: false
  });
  const hitboxMesh = new THREE.LineSegments(edgesGeom, lineMat);
  hitboxMesh.name = "car-hitbox";
  hitboxMesh.position.set(preset.forward, preset.up, 0);
  hitboxMesh.renderOrder = 100;
  hitboxMesh.visible = false;
  return hitboxMesh;
}

/**
 * Interpolates physics transform (position and orientation) between previous and current state.
 */
export function interpolatePhysicsTransform(targetMesh, prevViewOrState, currViewOrState, offsetOrAlpha, alphaParam, pA, pB, qA, qB) {
  if (typeof offsetOrAlpha === "number" && typeof alphaParam === "number") {
    const prevState = prevViewOrState;
    const currState = currViewOrState;
    const offset = offsetOrAlpha;
    const alpha = alphaParam;
    unrealToThreeCoords(pA, prevState[offset], prevState[offset + 1], prevState[offset + 2]);
    unrealToThreeCoords(pB, currState[offset], currState[offset + 1], currState[offset + 2]);
    targetMesh.position.lerpVectors(pA, pB, alpha);

    unpackBufferQuaternion(qA, prevState, offset + 3);
    unpackBufferQuaternion(qB, currState, offset + 3);
    targetMesh.quaternion.slerpQuaternions(qA, qB, alpha);
    return;
  }

  const prevView = prevViewOrState;
  const currView = currViewOrState;
  const alpha = offsetOrAlpha;
  unrealToThreeCoords(pA, prevView.posX, prevView.posY, prevView.posZ);
  unrealToThreeCoords(pB, currView.posX, currView.posY, currView.posZ);
  targetMesh.position.lerpVectors(pA, pB, alpha);

  viewBasisToQuaternion(qA, prevView);
  viewBasisToQuaternion(qB, currView);
  targetMesh.quaternion.slerpQuaternions(qA, qB, alpha);
}
