import * as THREE from 'three';
import {
  CAR_FLAG_IS_BOOSTING,
  CAR_FLAG_IS_SUPERSONIC,
  decodeRenderFrame,
  type DecodedRenderFrame,
} from './renderFrameCodec.ts';

interface TimedFrame {
  receivedAtMs: number;
  frame: DecodedRenderFrame;
}

const MAX_TRAIL_POINTS = 90;

export class ArenaRenderer {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;

  private readonly ballMesh: THREE.Mesh;
  private readonly carGroup: THREE.Group;
  private readonly boostFlame: THREE.Mesh;
  private readonly trailGeometry: THREE.BufferGeometry;
  private readonly trailPositions: Float32Array;
  private trailCount = 0;

  private readonly frameQueue: TimedFrame[] = [];
  private readonly interpDelayMs: number;
  private lastTeleportSeq = -1;
  private latestRenderedFrame: DecodedRenderFrame | null = null;
  public renderedCount = 0;
  public receivedCount = 0;

  // Scratch math objects (zero per-frame allocations)
  private readonly vA = new THREE.Vector3();
  private readonly vB = new THREE.Vector3();
  private readonly vC = new THREE.Vector3();
  private readonly qA = new THREE.Quaternion();
  private readonly qB = new THREE.Quaternion();
  private readonly dirVec = new THREE.Vector3();
  private readonly upVec = new THREE.Vector3();
  private readonly lookAtTarget = new THREE.Vector3();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options?: { interpDelayMs?: number }
  ) {
    this.interpDelayMs = options?.interpDelayMs ?? 18;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1220);
    this.scene.fog = new THREE.Fog(0x0b1220, 120, 320);

    this.camera = new THREE.PerspectiveCamera(110, 1, 0.2, 500);

    // Lighting
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.1);
    this.scene.add(hemi);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    dirLight.position.set(30, 80, 40);
    this.scene.add(dirLight);

    // Carball standard field (8192 uu = 163.84m wide X, 10240 uu = 204.8m long Z in Three.js)
    const fieldGeo = new THREE.PlaneGeometry(163.84, 204.8);
    fieldGeo.rotateX(-Math.PI / 2);
    const fieldMat = new THREE.MeshStandardMaterial({
      color: 0x164e36,
      roughness: 0.85,
      metalness: 0.05,
    });
    const field = new THREE.Mesh(fieldGeo, fieldMat);
    this.scene.add(field);

    const grid = new THREE.GridHelper(204.8, 32, 0x34d399, 0x1e3a2f);
    grid.position.y = 0.02;
    this.scene.add(grid);

    // Goal markers (Blue = +Z in Three.js since -Y_rs -> +Z_three; Orange = -Z)
    this.addGoalBox(0, 102.4 + 4.4, 0x2563eb);
    this.addGoalBox(0, -(102.4 + 4.4), 0xea580c);

    // Arena boundary walls wireframe
    const wallGeo = new THREE.BoxGeometry(163.84, 40.88, 204.8);
    const wallEdges = new THREE.EdgesGeometry(wallGeo);
    const wallLines = new THREE.LineSegments(
      wallEdges,
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25 })
    );
    wallLines.position.y = 20.44;
    this.scene.add(wallLines);

    // Ball (radius 92.75 uu = 1.855 m)
    const ballGeo = new THREE.IcosahedronGeometry(1.855, 2);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.35,
      metalness: 0.4,
      wireframe: false,
    });
    this.ballMesh = new THREE.Mesh(ballGeo, ballMat);
    const ballWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(ballGeo),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.65 })
    );
    this.ballMesh.add(ballWire);
    this.scene.add(this.ballMesh);

    // Car (Octane-proportioned box: 2.36m long X, 0.72m tall Y, 1.68m wide Z)
    this.carGroup = new THREE.Group();
    const bodyGeo = new THREE.BoxGeometry(2.36, 0.72, 1.68);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x3b82f6,
      roughness: 0.3,
      metalness: 0.55,
    });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    this.carGroup.add(bodyMesh);

    const cabinGeo = new THREE.BoxGeometry(1.1, 0.45, 1.3);
    const cabinMesh = new THREE.Mesh(
      cabinGeo,
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.2 })
    );
    cabinMesh.position.set(-0.1, 0.45, 0);
    this.carGroup.add(cabinMesh);

    // Boost flame cone at rear (-X)
    const flameGeo = new THREE.ConeGeometry(0.32, 1.4, 8);
    flameGeo.rotateZ(Math.PI / 2);
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
    this.boostFlame = new THREE.Mesh(flameGeo, flameMat);
    this.boostFlame.position.set(-1.8, 0, 0);
    this.boostFlame.visible = false;
    this.carGroup.add(this.boostFlame);
    this.scene.add(this.carGroup);

    // Continuous Trail Ribbon (cuts cleanly on teleportSeq change)
    this.trailPositions = new Float32Array(MAX_TRAIL_POINTS * 3);
    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.trailPositions, 3)
    );
    this.trailGeometry.setDrawRange(0, 0);
    const trailLine = new THREE.Line(
      this.trailGeometry,
      new THREE.LineBasicMaterial({ color: 0xfbbf24 })
    );
    trailLine.frustumCulled = false;
    this.scene.add(trailLine);

    this.resize();
  }

  private addGoalBox(x: number, z: number, color: number): void {
    const geo = new THREE.BoxGeometry(35.72, 12.85, 8.8);
    const edges = new THREE.EdgesGeometry(geo);
    const lines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color }));
    lines.position.set(x, 6.425, z);
    this.scene.add(lines);
  }

  public resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  public pushFrameBuffer(buffer: ArrayBuffer, receivedAtMs = performance.now()): void {
    const frame = decodeRenderFrame(buffer);
    this.receivedCount++;
    this.frameQueue.push({ receivedAtMs, frame });
    // Keep buffer bounded (~1 second max)
    while (this.frameQueue.length > 128) {
      this.frameQueue.shift();
    }
  }

  private resetTrail(): void {
    this.trailCount = 0;
    this.trailGeometry.setDrawRange(0, 0);
  }

  private appendTrailPoint(x: number, y: number, z: number): void {
    if (this.trailCount >= MAX_TRAIL_POINTS) {
      this.trailPositions.copyWithin(0, 3);
      this.trailCount = MAX_TRAIL_POINTS - 1;
    }
    const base = this.trailCount * 3;
    this.trailPositions[base] = x;
    this.trailPositions[base + 1] = y;
    this.trailPositions[base + 2] = z;
    this.trailCount++;
    const attr = this.trailGeometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.trailGeometry.setDrawRange(0, this.trailCount);
  }

  public render(nowMs = performance.now()): void {
    this.resize();
    if (this.frameQueue.length === 0) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const renderTimeMs = nowMs - this.interpDelayMs;

    // Advance queue until frameQueue[1] is after renderTimeMs (or only 1 frame left)
    while (this.frameQueue.length >= 2 && this.frameQueue[1].receivedAtMs <= renderTimeMs) {
      this.frameQueue.shift();
    }

    const slotA = this.frameQueue[0];
    const slotB = this.frameQueue.length >= 2 ? this.frameQueue[1] : slotA;
    const fA = slotA.frame;
    const fB = slotB.frame;

    // Discontinuity guard: if teleportSeq changed, snap to fB and cut trail!
    if (fB.teleportSeq !== this.lastTeleportSeq) {
      this.lastTeleportSeq = fB.teleportSeq;
      this.resetTrail();
      this.applySingleFrame(fB);
      this.latestRenderedFrame = fB;
    } else if (slotA === slotB || slotB.receivedAtMs <= slotA.receivedAtMs) {
      this.applySingleFrame(fA);
      this.latestRenderedFrame = fA;
    } else {
      const span = slotB.receivedAtMs - slotA.receivedAtMs;
      const alpha = Math.max(0, Math.min(1, (renderTimeMs - slotA.receivedAtMs) / span));
      this.applyInterpolatedFrames(fA, fB, alpha);
      this.latestRenderedFrame = fB;
    }

    this.renderedCount++;
    this.renderer.render(this.scene, this.camera);
  }

  private applySingleFrame(f: DecodedRenderFrame): void {
    this.ballMesh.position.set(f.ballPos[0], f.ballPos[1], f.ballPos[2]);
    this.ballMesh.quaternion.set(f.ballQuat[0], f.ballQuat[1], f.ballQuat[2], f.ballQuat[3]);

    this.carGroup.position.set(f.carPos[0], f.carPos[1], f.carPos[2]);
    this.carGroup.quaternion.set(f.carQuat[0], f.carQuat[1], f.carQuat[2], f.carQuat[3]);

    this.applyEffectsAndCamera(
      f.carFlags,
      f.carPos[0],
      f.carPos[1],
      f.carPos[2],
      f.camPos[0],
      f.camPos[1],
      f.camPos[2],
      f.camDir[0],
      f.camDir[1],
      f.camDir[2],
      f.camUp[0],
      f.camUp[1],
      f.camUp[2],
      f.camFov
    );
  }

  private applyInterpolatedFrames(a: DecodedRenderFrame, b: DecodedRenderFrame, t: number): void {
    // Ball
    this.vA.set(a.ballPos[0], a.ballPos[1], a.ballPos[2]);
    this.vB.set(b.ballPos[0], b.ballPos[1], b.ballPos[2]);
    this.ballMesh.position.lerpVectors(this.vA, this.vB, t);

    this.qA.set(a.ballQuat[0], a.ballQuat[1], a.ballQuat[2], a.ballQuat[3]);
    this.qB.set(b.ballQuat[0], b.ballQuat[1], b.ballQuat[2], b.ballQuat[3]);
    this.ballMesh.quaternion.slerpQuaternions(this.qA, this.qB, t);

    // Car
    this.vA.set(a.carPos[0], a.carPos[1], a.carPos[2]);
    this.vB.set(b.carPos[0], b.carPos[1], b.carPos[2]);
    this.carGroup.position.lerpVectors(this.vA, this.vB, t);

    this.qA.set(a.carQuat[0], a.carQuat[1], a.carQuat[2], a.carQuat[3]);
    this.qB.set(b.carQuat[0], b.carQuat[1], b.carQuat[2], b.carQuat[3]);
    this.carGroup.quaternion.slerpQuaternions(this.qA, this.qB, t);

    // Camera
    this.vA.set(a.camPos[0], a.camPos[1], a.camPos[2]);
    this.vB.set(b.camPos[0], b.camPos[1], b.camPos[2]);
    this.vC.lerpVectors(this.vA, this.vB, t);

    this.vA.set(a.camDir[0], a.camDir[1], a.camDir[2]);
    this.vB.set(b.camDir[0], b.camDir[1], b.camDir[2]);
    this.dirVec.lerpVectors(this.vA, this.vB, t).normalize();

    this.vA.set(a.camUp[0], a.camUp[1], a.camUp[2]);
    this.vB.set(b.camUp[0], b.camUp[1], b.camUp[2]);
    this.upVec.lerpVectors(this.vA, this.vB, t).normalize();

    const fov = a.camFov + (b.camFov - a.camFov) * t;
    const flags = t < 0.5 ? a.carFlags : b.carFlags;

    this.applyEffectsAndCamera(
      flags,
      this.carGroup.position.x,
      this.carGroup.position.y,
      this.carGroup.position.z,
      this.vC.x,
      this.vC.y,
      this.vC.z,
      this.dirVec.x,
      this.dirVec.y,
      this.dirVec.z,
      this.upVec.x,
      this.upVec.y,
      this.upVec.z,
      fov
    );
  }

  private applyEffectsAndCamera(
    carFlags: number,
    carX: number,
    carY: number,
    carZ: number,
    camX: number,
    camY: number,
    camZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    upX: number,
    upY: number,
    upZ: number,
    fov: number
  ): void {
    const isBoosting = (carFlags & CAR_FLAG_IS_BOOSTING) !== 0;
    const isSupersonic = (carFlags & CAR_FLAG_IS_SUPERSONIC) !== 0;
    this.boostFlame.visible = isBoosting;

    if (isBoosting || isSupersonic) {
      this.appendTrailPoint(carX, carY + 0.15, carZ);
    }

    this.camera.position.set(camX, camY, camZ);
    this.camera.up.set(upX, upY, upZ);
    this.lookAtTarget.set(camX + dirX * 10, camY + dirY * 10, camZ + dirZ * 10);
    this.camera.lookAt(this.lookAtTarget);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  public getDebugSnapshot() {
    return {
      receivedCount: this.receivedCount,
      renderedCount: this.renderedCount,
      queueLen: this.frameQueue.length,
      lastTeleportSeq: this.lastTeleportSeq,
      trailCount: this.trailCount,
      carPos: this.carGroup.position.toArray(),
      ballPos: this.ballMesh.position.toArray(),
      camPos: this.camera.position.toArray(),
      latestTick: this.latestRenderedFrame?.tick ?? 0,
    };
  }
}
