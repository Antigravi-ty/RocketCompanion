import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SpeedTrail } from '../entities/SpeedTrail.ts';
import { createGeodesicBallGeometry } from '../entities/BallVisual.ts';
import { FRAME_FLAG_BOOSTING, FRAME_FLAG_SUPERSONIC, type RenderFrameData } from './protocol.ts';

const ARENA_HALF_X = 4096;
const ARENA_HALF_Z = 5120;
const ARENA_HEIGHT = 2044;
const GOAL_HALF_WIDTH = 893;
const GOAL_HEIGHT = 642.775;
const GOAL_DEPTH = 880;
const BALL_RADIUS = 91.25;

export class ArenaRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;

  private readonly ballMesh: THREE.Mesh;
  private readonly carGroup = new THREE.Group();
  private readonly fallbackCarMesh: THREE.Mesh;
  private readonly boostFlames: THREE.Mesh[] = [];
  private readonly ballTrail = new SpeedTrail();
  private readonly carTrail = new SpeedTrail();

  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpVel = new THREE.Vector3();
  private readonly tmpCarFwd = new THREE.Vector3();
  private readonly tmpTrailOrigin = new THREE.Vector3();
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b101b);
    this.scene.fog = new THREE.Fog(0x0b101b, 4500, 14000);

    const aspect =
      canvas.clientWidth > 0 && canvas.clientHeight > 0
        ? canvas.clientWidth / canvas.clientHeight
        : 16 / 9;
    this.camera = new THREE.PerspectiveCamera(60, aspect, 10, 25000);

    this.setupLighting();
    this.buildArenaEnvironment();

    const ballGeo = createGeodesicBallGeometry(0x1f2937);
    const ballMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.35,
      metalness: 0.25,
    });
    this.ballMesh = new THREE.Mesh(ballGeo, ballMat);
    this.ballMesh.scale.setScalar(BALL_RADIUS);
    this.scene.add(this.ballMesh);

    const fallbackGeo = new THREE.BoxGeometry(118, 36, 84);
    const fallbackMat = new THREE.MeshStandardMaterial({
      color: 0x3b82f6,
      roughness: 0.4,
      metalness: 0.3,
    });
    this.fallbackCarMesh = new THREE.Mesh(fallbackGeo, fallbackMat);
    this.fallbackCarMesh.position.y = 18;
    this.carGroup.add(this.fallbackCarMesh);

    const flameGeo = new THREE.ConeGeometry(8, 36, 12);
    flameGeo.rotateZ(-Math.PI / 2);
    const flameMat = new THREE.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flameLeft = new THREE.Mesh(flameGeo, flameMat);
    flameLeft.position.set(-68, 14.5, -10);
    flameLeft.visible = false;
    const flameRight = new THREE.Mesh(flameGeo, flameMat);
    flameRight.position.set(-68, 14.5, 10);
    flameRight.visible = false;
    this.carGroup.add(flameLeft, flameRight);
    this.boostFlames.push(flameLeft, flameRight);

    this.scene.add(this.carGroup);
    this.scene.add(this.ballTrail.object);
    this.scene.add(this.carTrail.object);

    this.loadOctaneModel();
    this.resize();
  }

  private setupLighting(): void {
    const hemi = new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.35);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(1600, 3200, 1200);
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x93c5fd, 0.7);
    fill.position.set(-1800, 1500, -1400);
    this.scene.add(fill);
  }

  private buildArenaEnvironment(): void {
    const floorGeo = new THREE.PlaneGeometry(ARENA_HALF_X * 2, ARENA_HALF_Z * 2);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x132030,
      roughness: 0.85,
      metalness: 0.1,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = 0;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(ARENA_HALF_Z * 2, 32, 0x334155, 0x1e293b);
    grid.position.y = 0.5;
    grid.scale.x = ARENA_HALF_X / ARENA_HALF_Z;
    this.scene.add(grid);

    const lineMat = new THREE.LineBasicMaterial({ color: 0x64748b });
    const midfieldPts = [
      new THREE.Vector3(-ARENA_HALF_X, 1.5, 0),
      new THREE.Vector3(ARENA_HALF_X, 1.5, 0),
    ];
    this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(midfieldPts), lineMat));

    const circlePts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      circlePts.push(new THREE.Vector3(Math.cos(a) * 900, 1.5, Math.sin(a) * 900));
    }
    this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePts), lineMat));

    const wallMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.12,
    });
    const wallBox = new THREE.BoxGeometry(
      ARENA_HALF_X * 2,
      ARENA_HEIGHT,
      ARENA_HALF_Z * 2,
      8,
      4,
      10
    );
    const walls = new THREE.Mesh(wallBox, wallMat);
    walls.position.y = ARENA_HEIGHT * 0.5;
    this.scene.add(walls);

    const addGoalFrame = (zSign: number, color: number) => {
      const goalMat = new THREE.MeshBasicMaterial({
        color,
        wireframe: true,
        transparent: true,
        opacity: 0.45,
      });
      const goalGeo = new THREE.BoxGeometry(GOAL_HALF_WIDTH * 2, GOAL_HEIGHT, GOAL_DEPTH, 4, 2, 2);
      const goal = new THREE.Mesh(goalGeo, goalMat);
      goal.position.set(0, GOAL_HEIGHT * 0.5, zSign * (ARENA_HALF_Z + GOAL_DEPTH * 0.5));
      this.scene.add(goal);
    };
    addGoalFrame(-1, 0x3b82f6);
    addGoalFrame(1, 0xf97316);
  }

  private loadOctaneModel(): void {
    const loader = new GLTFLoader();
    loader.load(
      '/assets/vehicles/Octane.glb',
      (gltf) => {
        if (this.disposed) return;
        const model = gltf.scene;
        model.scale.setScalar(100);
        model.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = false;
            obj.receiveShadow = false;
          }
        });
        this.carGroup.remove(this.fallbackCarMesh);
        this.fallbackCarMesh.geometry.dispose();
        (this.fallbackCarMesh.material as THREE.Material).dispose();
        this.carGroup.add(model);
      },
      undefined,
      (err) => {
        console.error('[ArenaRenderer] Failed to load Octane.glb:', err);
      }
    );
  }

  resize(): number {
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    return aspect;
  }

  render(frame: RenderFrameData, dtSec: number, teleported: boolean): void {
    if (this.disposed) return;

    this.ballMesh.position.set(frame.ballPos[0], frame.ballPos[1], frame.ballPos[2]);
    this.ballMesh.quaternion.set(
      frame.ballQuat[0],
      frame.ballQuat[1],
      frame.ballQuat[2],
      frame.ballQuat[3]
    );

    this.carGroup.position.set(frame.carPos[0], frame.carPos[1], frame.carPos[2]);
    this.carGroup.quaternion.set(
      frame.carQuat[0],
      frame.carQuat[1],
      frame.carQuat[2],
      frame.carQuat[3]
    );

    const isBoosting = (frame.flags & FRAME_FLAG_BOOSTING) !== 0;
    const isSupersonic = (frame.flags & FRAME_FLAG_SUPERSONIC) !== 0;
    const flameScale = isBoosting ? 1.0 + Math.sin(frame.tick * 0.6) * 0.2 : 0;
    for (const flame of this.boostFlames) {
      flame.visible = isBoosting;
      if (isBoosting) {
        flame.scale.set(flameScale, 1, 1);
      }
    }

    this.camera.position.set(frame.camPos[0], frame.camPos[1], frame.camPos[2]);
    this.camera.quaternion.set(
      frame.camQuat[0],
      frame.camQuat[1],
      frame.camQuat[2],
      frame.camQuat[3]
    );
    if (Math.abs(this.camera.fov - frame.camFov) > 1e-3) {
      this.camera.fov = frame.camFov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();

    if (teleported) {
      this.ballTrail.reset();
      this.carTrail.reset();
    } else {
      const safeDt = Math.min(0.05, Math.max(0.0001, dtSec));
      this.tmpPos.set(frame.ballPos[0], frame.ballPos[1], frame.ballPos[2]);
      this.tmpVel.set(frame.ballVel[0], frame.ballVel[1], frame.ballVel[2]);
      this.ballTrail.update(this.tmpPos, this.tmpVel, safeDt);

      this.tmpCarFwd.set(1, 0, 0).applyQuaternion(this.carGroup.quaternion);
      this.tmpTrailOrigin
        .set(frame.carPos[0], frame.carPos[1], frame.carPos[2])
        .addScaledVector(this.tmpCarFwd, -52);
      this.tmpVel.set(frame.carVel[0], frame.carVel[1], frame.carVel[2]);
      if (isSupersonic || isBoosting) {
        this.carTrail.update(this.tmpTrailOrigin, this.tmpVel, safeDt);
      } else {
        this.carTrail.update(this.tmpTrailOrigin, this.tmpVel.setScalar(0), safeDt);
      }
    }

    this.ballTrail.prepare(this.camera);
    this.carTrail.prepare(this.camera);

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    this.ballTrail.dispose();
    this.carTrail.dispose();
    this.renderer.dispose();
  }
}
