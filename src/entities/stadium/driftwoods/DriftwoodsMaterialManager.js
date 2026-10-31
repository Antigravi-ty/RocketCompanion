import {
  AlwaysStencilFunc,
  Color,
  DoubleSide,
  FrontSide,
  KeepStencilOp,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NearestFilter,
  NearestMipmapLinearFilter,
  MeshLambertMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  ReplaceStencilOp,
  Vector2,
  Vector4
} from 'three';
import {
  DEFAULT_DRIFTWOODS_CONFIG,
  DEFAULT_Q1_LAYER_COLORS,
  cloneDriftwoodsConfig,
  mergeDriftwoodsConfig
} from '../../../ui-core/config/driftwoodsConfig.ts';
import {
  experimentalWallFxRuntimeConfig,
} from '../../../ui-core/config/atmosphereFxConfig.js';
import {
  PULSE_STEADY_MODE_MAP,
  PULSE_DIRECTION_MAP,
  createWallFxUniforms,
  injectWallFxShader,
  createSpherePreviewMeshes
} from './WallFxShaderController.js';
import {
  getOrLoadQ1GroundTexture,
  createBakedGroundDataTexture,
  subscribeQ1MaskReady
} from './DriftwoodsMipmapBuilder.js';
import {
  bakeQ1GroundTexturesIntoManager,
  resolveDriftwoodsTeamColors
} from './DriftwoodsColorMath.js';
import {
  injectSpecularAAShader,
  injectGoalTeamShader,
  injectWallPostTrimOcclusionShader,
  injectGroundDetailShader
} from './DriftwoodsGroundShader.js';

/**
 * Manages Driftwoods stadium mesh materials, hardware-mipmapped RGBA decal ground baking,
 * OKLCH perceptual color synchronization, and high-performance Lambert downgrades in real time.
 */
export class DriftwoodsMaterialManager {
  /**
   * @param {import('three').Group} stadiumScene
   * @param {any} [initialConfig]
   */
  constructor(stadiumScene, initialConfig = DEFAULT_DRIFTWOODS_CONFIG) {
    this.scene = stadiumScene;
    this.config = cloneDriftwoodsConfig(initialConfig);
    this.wallFxConfig = { ...experimentalWallFxRuntimeConfig };

    /** @type {Record<string, import('three').Mesh>} */
    this.meshes = {};

    /** @type {Record<string, import('three').MeshStandardMaterial>} */
    this.standardMaterials = {};

    /** @type {Record<string, import('three').MeshLambertMaterial>} */
    this.lambertMaterials = {};

    /** @type {Record<string, import('three').Mesh>} */
    this.occlusionOverlayMeshes = {};

    /** @type {Record<string, import('three').MeshStandardMaterial>} */
    this.occlusionOverlayStandardMaterials = {};

    /** @type {Record<string, import('three').MeshLambertMaterial>} */
    this.occlusionOverlayLambertMaterials = {};

    /** @type {import('three').MeshStandardMaterial | null} */
    this.sharedUpperOuterStandardMaterial = null;

    /** @type {import('three').MeshLambertMaterial | null} */
    this.sharedUpperOuterLambertMaterial = null;

    const preloadedQ1 = stadiumScene?.userData?.q1GroundTexture || null;
    this.q1GroundTexture = getOrLoadQ1GroundTexture(preloadedQ1);

    this.bakedBlueGroundTexture = createBakedGroundDataTexture();
    this.bakedOrangeGroundTexture = createBakedGroundDataTexture();
    this._lastBakedPaletteSignature = '';

    this._unsubscribeQ1Mask = subscribeQ1MaskReady(() => {
      this._lastBakedPaletteSignature = '';
      this.bakeQ1GroundTextures(this.config.ground);
    });

    const q1Colors = {
      ...DEFAULT_Q1_LAYER_COLORS,
      ...(this.config.ground?.q1Colors || {})
    };

    this.groundUniforms = {
      uGroundMode: { value: this.config.ground?.textureMode === 'original' ? 0.0 : 1.0 },
      uQ1BakedReady: { value: 0.0 },
      uBakedBlueGroundMap: { value: this.bakedBlueGroundTexture },
      uBakedOrangeGroundMap: { value: this.bakedOrangeGroundTexture },
      uQ1GroundMap: { value: this.q1GroundTexture },
      uQ1UvScale: {
        value: new Vector2(
          this.config.ground?.q1ScaleX ?? 1.0,
          this.config.ground?.q1ScaleY ?? 1.0
        )
      },
      uQ1UvOffset: {
        value: new Vector2(
          this.config.ground?.q1OffsetX ?? 0.0,
          this.config.ground?.q1OffsetY ?? 0.0
        )
      },
      uGroundColor: { value: new Color(this.config.ground?.groundColor || '#18441c') },
      uLineColor: { value: new Color(this.config.ground?.lineColor || '#e1e6eb') },
      uLineThreshold: { value: this.config.ground?.lineThreshold ?? 0.35 },
      uLineSmoothness: { value: this.config.ground?.lineSmoothness ?? 0.15 },
      uOrigLineThreshold: { value: this.config.ground?.originalLineThreshold ?? 0.0921 },
      uOrigLineSmoothness: { value: this.config.ground?.originalLineSmoothness ?? 0.0364 },
      uL0Color: { value: new Color(q1Colors.L0) },
      uL1Color: { value: new Color(q1Colors.L1) },
      uL2Color: { value: new Color(q1Colors.L2) },
      uL3Color: { value: new Color(q1Colors.L3) },
      uL4Color: { value: new Color(q1Colors.L4) },
      uL5Color: { value: new Color(q1Colors.L5) },
      uL6Color: { value: new Color(q1Colors.L6) },
      uL4UseTeamColor: { value: this.config.ground?.l4UseTeamColor !== false ? 1.0 : 0.0 },
      uL5UseTeamColor: { value: this.config.ground?.l5UseTeamColor !== false ? 1.0 : 0.0 },
      uL6UseTeamColor: { value: this.config.ground?.l6UseTeamColor !== false ? 1.0 : 0.0 }
    };

    this.wallFxUniforms = createWallFxUniforms(this.wallFxConfig);

    this.specularAAUniforms = {
      uSpecularAAStrength: {
        value:
          this.config.specularAA !== false ? Number(this.config.specularAAStrength ?? 1.0) : 0.0
      }
    };

    this.occlusionUniforms = {
      uOcclusionOpacity: {
        value: Number(this.config.occlusionOpacity ?? 0.4)
      },
      uWallExteriorOcclusionEnabled: {
        value: this.config.wallExteriorOcclusion !== false ? 1.0 : 0.0
      },
      uGoalDepthMaskEnabled: {
        value: this.config.goalDepthMaskEnabled !== false ? 1.0 : 0.0
      },
      uGoalMaskOffsetUu: {
        value: Number(this.config.goalMaskOffsetUu ?? 250)
      },
      uGoalMaskGradientDistanceUu: {
        value: Math.max(1.0, Number(this.config.goalMaskGradientDistanceUu ?? 500))
      },
      uGoalMaskBezier: {
        value: new Vector4(
          Number(this.config.goalMaskBezierP1X ?? 0.27),
          Number(this.config.goalMaskBezierP1Y ?? 0.06),
          Number(this.config.goalMaskBezierP2X ?? 0.26),
          Number(this.config.goalMaskBezierP2Y ?? 0.73)
        )
      }
    };

    this.goalTeamUniforms = {
      uGoalFrameUseTeamColor: {
        value: Boolean(this.config.goalFrame?.useTeamColor) ? 1.0 : 0.0
      },
      uGoalPostsUseTeamColor: {
        value: Boolean(this.config.goalPosts?.useTeamColor) ? 1.0 : 0.0
      },
      uGoalPostsGlowUseTeamColor: {
        value: this.config.goalPostsGlow?.useTeamColor !== false ? 1.0 : 0.0
      },
      uRampsUpperOuterUseTeamColor: {
        value: this.config.rampsUpperOuter?.useTeamColor !== false ? 1.0 : 0.0
      },
      uGoalNetUseTeamColor: { value: 0.0 },
      uGoalBlueColor: { value: new Color('#1982e6') },
      uGoalOrangeColor: { value: new Color('#e05d09') },
      uGoalPostsGlowBlueColor: { value: new Color('#7ec6ff') },
      uGoalPostsGlowOrangeColor: { value: new Color('#ffab6e') },
      uRampsUpperOuterBlueColor: { value: new Color('#1374d1') },
      uRampsUpperOuterOrangeColor: { value: new Color('#c95104') }
    };

    this.spherePreviewGroup = null;
    this.circlePreviewMesh = null;
    this.pulsePreviewMesh = null;

    this.initScene();
    this.setupSpherePreviewMeshes();
    this.applyConfig(this.config);
  }

  bakeQ1GroundTextures(g) {
    bakeQ1GroundTexturesIntoManager(this, g);
  }

  getResolvedTeamColors() {
    return resolveDriftwoodsTeamColors(this.config?.ground, this.wallFxConfig);
  }

  ensureSharedUpperOuterMaterials(templateMat) {
    if (this.sharedUpperOuterStandardMaterial && this.sharedUpperOuterLambertMaterial) {
      return {
        standardMat: this.sharedUpperOuterStandardMaterial,
        lambertMat: this.sharedUpperOuterLambertMaterial
      };
    }

    const standardMat = templateMat?.isMeshStandardMaterial
      ? templateMat.clone()
      : new MeshStandardMaterial();
    standardMat.name = 'Woods_Field_Upper_Outer_Standard';
    standardMat.side = FrontSide;
    standardMat.transparent = false;
    standardMat.depthWrite = true;

    const lambertMat = new MeshLambertMaterial({
      name: 'Woods_Field_Upper_Outer_Lambert',
      map: standardMat.map || null,
      transparent: false,
      opacity: 1.0,
      depthWrite: true,
      side: FrontSide,
      wireframe: standardMat.wireframe,
      emissiveIntensity: 0
    });

    this.setupGoalTeamShader(standardMat, 'rampsUpperOuter', true);
    this.setupGoalTeamShader(lambertMat, 'rampsUpperOuter', false);

    this.sharedUpperOuterStandardMaterial = standardMat;
    this.sharedUpperOuterLambertMaterial = lambertMat;

    return { standardMat, lambertMat };
  }

  initScene() {
    /** @type {import('three').Mesh[]} */
    const initialMeshes = [];
    this.scene.traverse((obj) => {
      if (obj.name === 'BoostPads_Combined_Base') {
        obj.visible = false;
        obj.removeFromParent?.();
        return;
      }

      if (obj.isMesh && !obj.userData?.isOcclusionTransparentOverlay) {
        initialMeshes.push(obj);
      }
    });

    for (const obj of initialMeshes) {
      obj.frustumCulled = false;
      this.meshes[obj.name] = obj;
      this.setupMeshMaterials(obj);
    }
  }

  /**
   * @param {import('three').Mesh} mesh
   */
  setupMeshMaterials(mesh) {
    const name = mesh.name;
    const origMat = mesh.material;
    const matName = origMat?.name || '';

    const isUpperOrOuter =
      matName === 'Upper' ||
      matName === 'Outer' ||
      name === 'Woods_Field_Ramps_2' ||
      name === 'Woods_Field_Goal_Net_2';

    if (isUpperOrOuter) {
      const { standardMat, lambertMat } = this.ensureSharedUpperOuterMaterials(origMat);
      this.standardMaterials[name] = standardMat;
      this.lambertMaterials[name] = lambertMat;
      mesh.material = this.config.fastDiffuse ? lambertMat : standardMat;
      return;
    }

    const isTransparentEnclosure =
      name === 'Woods_Field_Walls' || name === 'Woods_Field_Walls_Hexes';

    const isGoalPostsMain =
      name === 'Woods_Field_Goal_Posts' ||
      name === 'Woods_Field_Goal_Posts_1' ||
      matName === 'Goal_Posts_Tintable';
    const isGoalPostsGlow =
      name === 'Woods_Field_Goal_Posts_2' || matName === 'Glow';
    const isGoalNetMain =
      name === 'Woods_Field_Goal_Net' ||
      name === 'Woods_Field_Goal_Net_1' ||
      matName === 'Goal_Net_Tintable';
    const isDynamicOcclusionMesh =
      name === 'Woods_Field_Ramps_Trim' ||
      name === 'Woods_Field_Wall_Posts' ||
      name === 'Woods_Field_Goal' ||
      isGoalPostsMain ||
      isGoalPostsGlow ||
      isGoalNetMain;

    const standardMat = origMat.isMeshStandardMaterial
      ? origMat.clone()
      : new MeshStandardMaterial();

    standardMat.name = `${name}_Standard`;
    if (isTransparentEnclosure) {
      standardMat.transparent = true;
      standardMat.depthWrite = false;
      standardMat.side = DoubleSide;
    } else if (isDynamicOcclusionMesh) {
      // Pass 1 (Opaque base pass): renders only non-occluded fragments (alpha >= 0.999)
      // in the opaque queue with depthWrite = true so solid goalposts occlude trajectories normally.
      standardMat.transparent = false;
      standardMat.depthWrite = true;
    }

    const lambertMat = new MeshLambertMaterial({
      name: `${name}_Lambert`,
      map: standardMat.map || null,
      transparent: isTransparentEnclosure ? true : (isDynamicOcclusionMesh ? false : Boolean(standardMat.transparent)),
      opacity: standardMat.opacity,
      depthWrite: isTransparentEnclosure ? false : (isDynamicOcclusionMesh ? true : !standardMat.transparent),
      side: isTransparentEnclosure ? DoubleSide : standardMat.side,
      wireframe: standardMat.wireframe,
      emissiveIntensity: 0
    });

    let overlayOrder = 0;
    if (isGoalPostsGlow) {
      overlayOrder = 0.1;
    } else if (isGoalPostsMain) {
      overlayOrder = 0.2;
    } else if (name === 'Woods_Field_Ramps_Trim') {
      overlayOrder = 0.3;
    } else if (name === 'Woods_Field_Wall_Posts') {
      overlayOrder = 0.4;
    } else if (name === 'Woods_Field_Goal') {
      overlayOrder = 0.5;
    } else if (isGoalNetMain) {
      overlayOrder = 0.6;
    } else if (name === 'Woods_Field_Walls') {
      mesh.renderOrder = 1;
    } else if (name === 'Woods_Field_Walls_Hexes') {
      mesh.renderOrder = 2;
    }

    if (name === 'Woods_Field_Ground') {
      this.setupGroundShader(standardMat);
      this.setupGroundShader(lambertMat);

      for (const mat of [standardMat, lambertMat]) {
        if (mat.map) {
          mat.map.wrapS = RepeatWrapping;
          mat.map.wrapT = RepeatWrapping;
          mat.map.generateMipmaps = true;
          mat.map.minFilter = LinearMipmapLinearFilter;
          mat.map.needsUpdate = true;
        }
      }
    } else if (name === 'Woods_Field_Walls_Hexes' || name === 'Woods_Field_Walls') {
      const isWallsMesh = name === 'Woods_Field_Walls';
      this.setupWallFxShader(standardMat, isWallsMesh);
      this.setupWallFxShader(lambertMat, isWallsMesh);
    } else if (name === 'Woods_Field_Goal') {
      this.setupGoalTeamShader(standardMat, 'goalFrame', true, 'opaque');
      this.setupGoalTeamShader(lambertMat, 'goalFrame', false, 'opaque');
    } else if (isGoalPostsMain) {
      this.setupGoalTeamShader(standardMat, 'goalPosts', true, 'opaque');
      this.setupGoalTeamShader(lambertMat, 'goalPosts', false, 'opaque');
    } else if (isGoalPostsGlow) {
      this.setupGoalTeamShader(standardMat, 'goalPostsGlow', true, 'opaque');
      this.setupGoalTeamShader(lambertMat, 'goalPostsGlow', false, 'opaque');
    } else if (isGoalNetMain) {
      this.setupGoalTeamShader(standardMat, 'goalNet', true, 'opaque');
      this.setupGoalTeamShader(lambertMat, 'goalNet', false, 'opaque');
    } else if (name === 'Woods_Field_Ramps_Trim') {
      this.setupWallOcclusionShader(standardMat, true, true, 'opaque');
      this.setupWallOcclusionShader(lambertMat, true, false, 'opaque');
    } else if (name === 'Woods_Field_Wall_Posts') {
      this.setupWallOcclusionShader(standardMat, false, true, 'opaque');
      this.setupWallOcclusionShader(lambertMat, false, false, 'opaque');
    } else {
      this.setupSpecularAAShader(standardMat);
    }

    this.standardMaterials[name] = standardMat;
    this.lambertMaterials[name] = lambertMat;

    mesh.material = this.config.fastDiffuse ? lambertMat : standardMat;

    // Pass 2 (Transparent occlusion overlay pass): renders only semi-transparent occluded fragments
    // (0.001 < alpha < 0.999) in the transparent queue (renderOrder 0.1..0.6) AFTER
    // BallTrajectoryPredictor.preOcclusionLineMesh (renderOrder 0.05) so the trajectory line is
    // visible through semi-transparent goalposts/recesses while visually layered behind them.
    // Writes stencil bit 0x02 on ZPass so foreground trajectory segments (z_traj <= z_goal) can
    // render cleanly on top at renderOrder 14 without double-blending in the open arena.
    if (isDynamicOcclusionMesh) {
      const overlayStandardMat = origMat.isMeshStandardMaterial
        ? origMat.clone()
        : new MeshStandardMaterial();
      overlayStandardMat.name = `${name}_OcclusionTransparent_Standard`;
      overlayStandardMat.transparent = true;
      overlayStandardMat.depthWrite = true;
      overlayStandardMat.stencilWrite = true;
      overlayStandardMat.stencilFunc = AlwaysStencilFunc;
      overlayStandardMat.stencilRef = 2;
      overlayStandardMat.stencilFuncMask = 0x02;
      overlayStandardMat.stencilWriteMask = 0x02;
      overlayStandardMat.stencilZPass = ReplaceStencilOp;
      overlayStandardMat.stencilFail = KeepStencilOp;
      overlayStandardMat.stencilZFail = KeepStencilOp;

      const overlayLambertMat = new MeshLambertMaterial({
        name: `${name}_OcclusionTransparent_Lambert`,
        map: overlayStandardMat.map || null,
        transparent: true,
        opacity: overlayStandardMat.opacity,
        depthWrite: true,
        side: overlayStandardMat.side,
        wireframe: overlayStandardMat.wireframe,
        emissiveIntensity: 0
      });
      overlayLambertMat.stencilWrite = true;
      overlayLambertMat.stencilFunc = AlwaysStencilFunc;
      overlayLambertMat.stencilRef = 2;
      overlayLambertMat.stencilFuncMask = 0x02;
      overlayLambertMat.stencilWriteMask = 0x02;
      overlayLambertMat.stencilZPass = ReplaceStencilOp;
      overlayLambertMat.stencilFail = KeepStencilOp;
      overlayLambertMat.stencilZFail = KeepStencilOp;

      if (name === 'Woods_Field_Goal') {
        this.setupGoalTeamShader(overlayStandardMat, 'goalFrame', true, 'transparent');
        this.setupGoalTeamShader(overlayLambertMat, 'goalFrame', false, 'transparent');
      } else if (isGoalPostsMain) {
        this.setupGoalTeamShader(overlayStandardMat, 'goalPosts', true, 'transparent');
        this.setupGoalTeamShader(overlayLambertMat, 'goalPosts', false, 'transparent');
      } else if (isGoalPostsGlow) {
        this.setupGoalTeamShader(overlayStandardMat, 'goalPostsGlow', true, 'transparent');
        this.setupGoalTeamShader(overlayLambertMat, 'goalPostsGlow', false, 'transparent');
      } else if (isGoalNetMain) {
        this.setupGoalTeamShader(overlayStandardMat, 'goalNet', true, 'transparent');
        this.setupGoalTeamShader(overlayLambertMat, 'goalNet', false, 'transparent');
      } else if (name === 'Woods_Field_Ramps_Trim') {
        this.setupWallOcclusionShader(overlayStandardMat, true, true, 'transparent');
        this.setupWallOcclusionShader(overlayLambertMat, true, false, 'transparent');
      } else if (name === 'Woods_Field_Wall_Posts') {
        this.setupWallOcclusionShader(overlayStandardMat, false, true, 'transparent');
        this.setupWallOcclusionShader(overlayLambertMat, false, false, 'transparent');
      }

      const overlayMesh = new Mesh(
        mesh.geometry,
        this.config.fastDiffuse ? overlayLambertMat : overlayStandardMat
      );
      overlayMesh.name = `${name}_OcclusionTransparentOverlay`;
      overlayMesh.userData = { isOcclusionTransparentOverlay: true, bloomOccluder: false };
      overlayMesh.frustumCulled = false;
      overlayMesh.position.copy(mesh.position);
      overlayMesh.quaternion.copy(mesh.quaternion);
      overlayMesh.scale.copy(mesh.scale);
      overlayMesh.renderOrder = overlayOrder;
      overlayMesh.visible = mesh.visible;

      if (mesh.parent) {
        mesh.parent.add(overlayMesh);
      }

      this.occlusionOverlayStandardMaterials[name] = overlayStandardMat;
      this.occlusionOverlayLambertMaterials[name] = overlayLambertMat;
      this.occlusionOverlayMeshes[name] = overlayMesh;
    }
  }

  setupSpecularAAShader(material) {
    injectSpecularAAShader(material, this.specularAAUniforms);
  }

  setupGoalTeamShader(
    material,
    targetType = 'goalFrame',
    includeSpecularAA = false,
    occlusionPassMode = 'all'
  ) {
    injectGoalTeamShader(
      material,
      this.goalTeamUniforms,
      this.specularAAUniforms,
      this.occlusionUniforms,
      targetType,
      includeSpecularAA,
      occlusionPassMode
    );
  }

  setupWallOcclusionShader(
    material,
    isRampsTrim = false,
    includeSpecularAA = false,
    occlusionPassMode = 'all'
  ) {
    injectWallPostTrimOcclusionShader(
      material,
      this.occlusionUniforms,
      this.specularAAUniforms,
      isRampsTrim,
      includeSpecularAA,
      occlusionPassMode
    );
  }

  setupGroundShader(material) {
    injectGroundDetailShader(material, this.groundUniforms, this.wallFxUniforms);
  }

  applyConfig(patch) {
    if (!patch) return;

    this.config = mergeDriftwoodsConfig(this.config, patch);
    const c = this.config;

    if (this.specularAAUniforms?.uSpecularAAStrength) {
      this.specularAAUniforms.uSpecularAAStrength.value =
        c.specularAA !== false ? Number(c.specularAAStrength ?? 1.0) : 0.0;
    }

    if (this.occlusionUniforms) {
      this.occlusionUniforms.uOcclusionOpacity.value = Math.max(
        0.0,
        Math.min(1.0, Number(c.occlusionOpacity ?? 0.4))
      );
      this.occlusionUniforms.uWallExteriorOcclusionEnabled.value =
        c.wallExteriorOcclusion !== false ? 1.0 : 0.0;
      this.occlusionUniforms.uGoalDepthMaskEnabled.value =
        c.goalDepthMaskEnabled !== false ? 1.0 : 0.0;
      this.occlusionUniforms.uGoalMaskOffsetUu.value = Number(
        c.goalMaskOffsetUu ?? 250
      );
      this.occlusionUniforms.uGoalMaskGradientDistanceUu.value = Math.max(
        1.0,
        Number(c.goalMaskGradientDistanceUu ?? 500)
      );
      this.occlusionUniforms.uGoalMaskBezier.value.set(
        Number(c.goalMaskBezierP1X ?? 0.27),
        Number(c.goalMaskBezierP1Y ?? 0.06),
        Number(c.goalMaskBezierP2X ?? 0.26),
        Number(c.goalMaskBezierP2Y ?? 0.73)
      );
    }

    const useLambert = Boolean(c.fastDiffuse);
    for (const [name, mesh] of Object.entries(this.meshes)) {
      const targetMat = useLambert ? this.lambertMaterials[name] : this.standardMaterials[name];
      if (mesh.material !== targetMat) {
        mesh.material = targetMat;
      }
      const overlayMesh = this.occlusionOverlayMeshes[name];
      if (overlayMesh) {
        const targetOverlayMat = useLambert
          ? this.occlusionOverlayLambertMaterials[name]
          : this.occlusionOverlayStandardMaterials[name];
        if (targetOverlayMat && overlayMesh.material !== targetOverlayMat) {
          overlayMesh.material = targetOverlayMat;
        }
      }
    }

    const groundMesh = this.meshes['Woods_Field_Ground'];
    if (groundMesh && c.ground) {
      this.groundUniforms.uGroundMode.value = c.ground.textureMode === 'original' ? 0.0 : 1.0;

      this.groundUniforms.uQ1UvScale.value.set(
        c.ground.q1ScaleX ?? 1.0,
        c.ground.q1ScaleY ?? 1.0
      );
      this.groundUniforms.uQ1UvOffset.value.set(
        c.ground.q1OffsetX ?? 0.0,
        c.ground.q1OffsetY ?? 0.0
      );

      if (this.groundUniforms.uL4UseTeamColor) {
        this.groundUniforms.uL4UseTeamColor.value = c.ground.l4UseTeamColor !== false ? 1.0 : 0.0;
      }
      if (this.groundUniforms.uL5UseTeamColor) {
        this.groundUniforms.uL5UseTeamColor.value = c.ground.l5UseTeamColor !== false ? 1.0 : 0.0;
      }
      if (this.groundUniforms.uL6UseTeamColor) {
        this.groundUniforms.uL6UseTeamColor.value = c.ground.l6UseTeamColor !== false ? 1.0 : 0.0;
      }

      if (this.groundUniforms.uLineThreshold && c.ground.lineThreshold !== undefined) {
        this.groundUniforms.uLineThreshold.value = c.ground.lineThreshold;
      }
      if (this.groundUniforms.uLineSmoothness && c.ground.lineSmoothness !== undefined) {
        this.groundUniforms.uLineSmoothness.value = c.ground.lineSmoothness;
      }
      if (this.groundUniforms.uOrigLineThreshold) {
        this.groundUniforms.uOrigLineThreshold.value = c.ground.originalLineThreshold ?? 0.0921;
      }
      if (this.groundUniforms.uOrigLineSmoothness) {
        this.groundUniforms.uOrigLineSmoothness.value = c.ground.originalLineSmoothness ?? 0.0364;
      }

      this.bakeQ1GroundTextures(c.ground);

      this.updateMaterialCommon(this.standardMaterials['Woods_Field_Ground'], c.ground);
      this.updateMaterialCommon(this.lambertMaterials['Woods_Field_Ground'], c.ground);

      const isNearest = c.ground.magFilter === 'nearest';
      const targetMag = isNearest ? NearestFilter : LinearFilter;
      const targetMinMipmap = isNearest ? NearestMipmapLinearFilter : LinearMipmapLinearFilter;
      const targetAnisotropy = Math.max(1, Math.min(16, c.ground.anisotropy ?? 4));

      for (const bakedTex of [this.bakedBlueGroundTexture, this.bakedOrangeGroundTexture]) {
        if (
          bakedTex &&
          (bakedTex.magFilter !== targetMag ||
            bakedTex.minFilter !== targetMinMipmap ||
            bakedTex.anisotropy !== targetAnisotropy)
        ) {
          bakedTex.magFilter = targetMag;
          bakedTex.minFilter = targetMinMipmap;
          bakedTex.anisotropy = targetAnisotropy;
          bakedTex.needsUpdate = true;
        }
      }

      for (const mat of [
        this.standardMaterials['Woods_Field_Ground'],
        this.lambertMaterials['Woods_Field_Ground']
      ]) {
        const tex = mat?.map;
        if (tex) {
          tex.repeat.set(c.ground.scaleX ?? 1.0, c.ground.scaleY ?? 1.0);
          tex.offset.set(c.ground.offsetX ?? 0.0, c.ground.offsetY ?? 0.0);
          if (
            tex.magFilter !== targetMag ||
            tex.minFilter !== targetMinMipmap ||
            tex.anisotropy !== targetAnisotropy
          ) {
            tex.magFilter = targetMag;
            tex.minFilter = targetMinMipmap;
            tex.anisotropy = targetAnisotropy;
            tex.needsUpdate = true;
          }
          tex.updateMatrix();
        }
      }

      groundMesh.visible = c.ground.visible !== false;
    }

    this.applyLayerConfig(['Woods_Field_Ramps', 'Woods_Field_Ramps_1'], c.ramps);
    this.applyLayerConfig(
      ['Woods_Field_Ramps_2', 'Woods_Field_Goal_Net_2'],
      c.rampsUpperOuter
    );
    this.applyLayerConfig('Woods_Field_Ramps_Trim', c.rampsTrim);
    this.applyLayerConfig('Woods_Field_Wall_Posts', c.wallPosts);
    this.applyLayerConfig('Woods_Field_Goal', c.goalFrame);
    this.applyLayerConfig(
      ['Woods_Field_Goal_Posts', 'Woods_Field_Goal_Posts_1'],
      c.goalPosts
    );
    this.applyLayerConfig('Woods_Field_Goal_Posts_2', c.goalPostsGlow);
    this.applyLayerConfig('Woods_Field_Walls', c.walls);
    this.applyLayerConfig(['Woods_Field_Goal_Net', 'Woods_Field_Goal_Net_1'], c.goalNet);
    this.applyLayerConfig('Woods_Field_Walls_Hexes', c.hexes);

    if (this.goalTeamUniforms) {
      this.goalTeamUniforms.uGoalFrameUseTeamColor.value =
        Boolean(c.goalFrame?.useTeamColor) ? 1.0 : 0.0;
      this.goalTeamUniforms.uGoalPostsUseTeamColor.value =
        Boolean(c.goalPosts?.useTeamColor) ? 1.0 : 0.0;
      this.goalTeamUniforms.uGoalPostsGlowUseTeamColor.value =
        c.goalPostsGlow?.useTeamColor !== false ? 1.0 : 0.0;
      this.goalTeamUniforms.uRampsUpperOuterUseTeamColor.value =
        c.rampsUpperOuter?.useTeamColor !== false ? 1.0 : 0.0;
    }

    const hexVisible = c.hexes?.visible !== false;
    const wallsVisible = c.walls?.visible !== false;
    const u = this.wallFxUniforms;
    if (u) {
      if (u.uWallBaseVisible) u.uWallBaseVisible.value = wallsVisible ? 1.0 : 0.0;
      if (u.uHexEmissiveColor && (c.hexes?.emissive || c.hexes?.color)) {
        u.uHexEmissiveColor.value.set(c.hexes.emissive || c.hexes.color);
      }
      if (u.uHexEmissiveIntensity) {
        u.uHexEmissiveIntensity.value = Number(c.hexes?.emissiveIntensity ?? 0.0);
      }
    }

    const wallsMesh = this.meshes['Woods_Field_Walls'];
    const hexMesh = this.meshes['Woods_Field_Walls_Hexes'];
    if (hexMesh) hexMesh.visible = hexVisible;
    if (wallsMesh) wallsMesh.visible = wallsVisible;
  }

  applyLayerConfig(meshNames, layerConfig) {
    if (!layerConfig) return;
    const names = Array.isArray(meshNames) ? meshNames : [meshNames];

    for (const meshName of names) {
      const mesh = this.meshes[meshName];
      if (!mesh) continue;

      mesh.visible = layerConfig.visible !== false;

      const overlayMesh = this.occlusionOverlayMeshes[meshName];
      if (overlayMesh) {
        overlayMesh.visible = mesh.visible;
      }

      const std = this.standardMaterials[meshName];
      const lam = this.lambertMaterials[meshName];
      const overlayStd = this.occlusionOverlayStandardMaterials[meshName];
      const overlayLam = this.occlusionOverlayLambertMaterials[meshName];

      const keepTransparent =
        meshName === 'Woods_Field_Walls' || meshName === 'Woods_Field_Walls_Hexes';
      const isDynamicOcclusionMesh =
        meshName === 'Woods_Field_Ramps_Trim' ||
        meshName === 'Woods_Field_Wall_Posts' ||
        meshName === 'Woods_Field_Goal' ||
        meshName === 'Woods_Field_Goal_Posts' ||
        meshName === 'Woods_Field_Goal_Posts_1' ||
        meshName === 'Woods_Field_Goal_Posts_2' ||
        meshName === 'Woods_Field_Goal_Net' ||
        meshName === 'Woods_Field_Goal_Net_1';
      const isEmissiveMesh =
        meshName === 'Woods_Field_Walls_Hexes' || meshName === 'Woods_Field_Goal_Posts_2';
      const isUpperOuterMesh =
        meshName === 'Woods_Field_Ramps_2' || meshName === 'Woods_Field_Goal_Net_2';

      for (const mat of [std, lam, overlayStd, overlayLam]) {
        if (!mat) continue;
        const isOverlayMat = mat === overlayStd || mat === overlayLam;
        if (layerConfig.color) mat.color.set(layerConfig.color);
        if (mat.isMeshStandardMaterial) {
          if (layerConfig.roughness !== undefined) mat.roughness = layerConfig.roughness;
          if (layerConfig.metalness !== undefined) mat.metalness = layerConfig.metalness;
        }
        if (isUpperOuterMesh) {
          const targetSide =
            layerConfig.oneWaySeeThrough !== false ? FrontSide : DoubleSide;
          if (mat.side !== targetSide) {
            mat.side = targetSide;
            mat.needsUpdate = true;
          }
        }
        if (isDynamicOcclusionMesh) {
          if (layerConfig.opacity !== undefined) {
            mat.opacity = layerConfig.opacity;
          }
          // Base pass stays in the opaque queue (renders alpha >= 0.999);
          // Overlay pass stays in the transparent queue after preOcclusionLineMesh (renders alpha < 0.999).
          mat.transparent = isOverlayMat;
          mat.depthWrite = true;
          if (isOverlayMat) {
            mat.stencilWrite = true;
            mat.stencilFunc = AlwaysStencilFunc;
            mat.stencilRef = 2;
            mat.stencilFuncMask = 0x02;
            mat.stencilWriteMask = 0x02;
            mat.stencilZPass = ReplaceStencilOp;
            mat.stencilFail = KeepStencilOp;
            mat.stencilZFail = KeepStencilOp;
          }
        } else if (layerConfig.opacity !== undefined) {
          mat.opacity = layerConfig.opacity;
          mat.transparent = keepTransparent || layerConfig.opacity < 0.999;
          mat.depthWrite = !mat.transparent;
        } else if (keepTransparent) {
          mat.transparent = true;
          mat.depthWrite = false;
        }
        if (isEmissiveMesh) {
          if (layerConfig.emissive || layerConfig.color) {
            mat.emissive.set(layerConfig.emissive || layerConfig.color);
          }
          mat.emissiveIntensity = Number(layerConfig.emissiveIntensity ?? 0);
        } else {
          mat.emissive.set('#000000');
          mat.emissiveIntensity = 0;
        }
        if (layerConfig.wireframe !== undefined) {
          mat.wireframe = layerConfig.wireframe;
        }
      }
    }
  }

  setupSpherePreviewMeshes() {
    if (!this.scene || this.spherePreviewGroup) return;
    const preview = createSpherePreviewMeshes(this.scene, this.wallFxConfig);
    if (preview) {
      this.spherePreviewGroup = preview.group;
      this.circlePreviewMesh = preview.circlePreviewMesh;
      this.pulsePreviewMesh = preview.pulsePreviewMesh;
      this.syncSpherePreviewMeshes();
    }
  }

  syncSpherePreviewMeshes() {
    const c = this.wallFxConfig;
    const u = this.wallFxUniforms;
    if (this.circlePreviewMesh) {
      const rX = Math.max(10, Number(c.circleRadius) || 500);
      const rY = Math.max(10, rX + (Number(c.circleVerticalExtendUu) || 0));
      this.circlePreviewMesh.visible = Boolean(c.circleShowSpherePreview && c.circleEnabled);
      this.circlePreviewMesh.scale.set(rX, rY, rX);
      this.circlePreviewMesh.position.copy(u.uCircleBallPos.value);
    }
    if (this.pulsePreviewMesh) {
      const rX = Math.max(10, Number(c.pulseSphereRadius) || 4000);
      const rY = Math.max(10, rX + (Number(c.pulseVerticalExtendUu) || 0));
      this.pulsePreviewMesh.visible = Boolean(c.pulseShowSpherePreview && c.pulseEnabled);
      this.pulsePreviewMesh.scale.set(rX, rY, rX);
      this.pulsePreviewMesh.position.copy(u.uPulseBallPos.value);
    }
  }

  setupWallFxShader(material, isWallsMesh = false) {
    injectWallFxShader(material, this.wallFxUniforms, isWallsMesh);
  }

  updateBallProximity(ballPos, ballVel, dt = 0.016) {
    this.wallFxUniforms.uTime.value += Math.max(0, Math.min(0.1, dt || 0.016));
    const t = this.wallFxUniforms.uTime.value;
    const c = this.wallFxConfig;

    if (c.circlePreviewOrbit || c.previewBallNearWall) {
      this.wallFxUniforms.uCircleBallPos.value.set(
        3820,
        420 + Math.sin(t * 1.4) * 220,
        Math.cos(t * 0.8) * 900
      );
    } else if (ballPos) {
      this.wallFxUniforms.uCircleBallPos.value.copy(ballPos);
    }

    if (c.pulsePreviewOrbit || c.previewBallNearWall) {
      this.wallFxUniforms.uPulseBallPos.value.set(
        3820,
        420 + Math.sin(t * 1.4) * 220,
        Math.cos(t * 0.8) * 900
      );
    } else if (ballPos) {
      this.wallFxUniforms.uPulseBallPos.value.copy(ballPos);
    }

    if (c.circleShowSpherePreview || c.pulseShowSpherePreview) {
      this.syncSpherePreviewMeshes();
    }
  }

  updateExperimentalWallConfig(patch) {
    if (!patch) return;
    Object.assign(this.wallFxConfig, patch);
    Object.assign(experimentalWallFxRuntimeConfig, this.wallFxConfig);
    const c = this.wallFxConfig;
    const u = this.wallFxUniforms;

    u.uCircleEnabled.value = c.circleEnabled ? 1.0 : 0.0;
    u.uCircleRadius.value = Number(c.circleRadius) || 500;
    u.uCircleVerticalExtendUu.value = Number(c.circleVerticalExtendUu) || 0;
    u.uCircleThickness.value = Number(c.circleThickness) || 5;
    if (c.circleColor) u.uCircleColor.value.set(c.circleColor);
    u.uCircleUseTeamColor.value = c.circleUseTeamColor ? 1.0 : 0.0;
    u.uCircleOpacity.value = Number(c.circleOpacity) ?? 0.75;

    u.uPulseEnabled.value = c.pulseEnabled ? 1.0 : 0.0;
    if (u.uPulseApplyToHexes) u.uPulseApplyToHexes.value = c.pulseApplyToHexes !== false ? 1.0 : 0.0;
    if (u.uPulseApplyToWalls) u.uPulseApplyToWalls.value = c.pulseApplyToWalls ? 1.0 : 0.0;
    u.uPulseSphereRadius.value = Number(c.pulseSphereRadius) || 4000;
    u.uPulseVerticalExtendUu.value = Number(c.pulseVerticalExtendUu) || 0;
    if (u.uPulseDirection) u.uPulseDirection.value = PULSE_DIRECTION_MAP[c.pulseDirection] ?? 1;
    if (u.uPulseFadeShrinkPct) u.uPulseFadeShrinkPct.value = Number(c.pulseFadeShrinkPct ?? 50);
    if (u.uPulseFadeBezier) {
      u.uPulseFadeBezier.value.set(
        Number(c.pulseFadeBezierP1X ?? 0.5),
        Number(c.pulseFadeBezierP1Y ?? 0.0),
        Number(c.pulseFadeBezierP2X ?? 1.0),
        Number(c.pulseFadeBezierP2Y ?? 0.0)
      );
    }
    if (u.uPulseSteadyMode) u.uPulseSteadyMode.value = PULSE_STEADY_MODE_MAP[c.pulseSteadyMode] ?? 0;
    if (u.uPulseStaticPositionPct) u.uPulseStaticPositionPct.value = Number(c.pulseStaticPositionPct ?? 47);
    if (u.uPulseStaticBandWidthPct) u.uPulseStaticBandWidthPct.value = Number(c.pulseStaticBandWidthPct ?? 5);
    u.uPulseIntervalSec.value = Number(c.pulseIntervalSec) || 1.0;
    if (u.uPulseRiseDurationSec) u.uPulseRiseDurationSec.value = Number(c.pulseRiseDurationSec ?? 0.01);
    if (u.uPulseFallDurationSec) u.uPulseFallDurationSec.value = Number(c.pulseFallDurationSec ?? 0.2);
    u.uPulseSpeedRadiusPct.value = Number(c.pulseSpeedRadiusPct) || 50;
    if (u.uPulseRiseBezier) {
      u.uPulseRiseBezier.value.set(
        Number(c.pulseRiseBezierP1X ?? 0.33),
        Number(c.pulseRiseBezierP1Y ?? 0.33),
        Number(c.pulseRiseBezierP2X ?? 0.67),
        Number(c.pulseRiseBezierP2Y ?? 0.67)
      );
    }
    if (u.uPulseFallBezier) {
      u.uPulseFallBezier.value.set(
        Number(c.pulseFallBezierP1X ?? 0.0),
        Number(c.pulseFallBezierP1Y ?? 0.5),
        Number(c.pulseFallBezierP2X ?? 0.0),
        Number(c.pulseFallBezierP2Y ?? 1.01)
      );
    }
    u.uPulseIntensity.value = Number(c.pulseIntensity) ?? 1.0;
    if (c.pulseColor) u.uPulseColor.value.set(c.pulseColor);
    u.uPulseMultiplyTeamColor.value = c.pulseMultiplyTeamColor ? 1.0 : 0.0;
    u.uPulseOpacity.value = Number(c.pulseOpacity) ?? 0.92;

    u.uTeamGradientEnabled.value = c.teamGradientEnabled ? 1.0 : 0.0;
    u.uCenterLineWidth.value = Number(c.centerLineWidth) ?? 5;
    u.uTeamTransitionWidth.value = Number(c.teamTransitionWidth) ?? 1000;
    u.uTeamColorStrength.value = Number(c.teamColorStrength) ?? 0.8;
    if (c.blueTeamColor) u.uBlueTeamColor.value.set(c.blueTeamColor);
    u.uBlueTeamAlpha.value = Number(c.blueTeamAlpha) ?? 0.85;
    if (c.orangeTeamColor) u.uOrangeTeamColor.value.set(c.orangeTeamColor);
    u.uOrangeTeamAlpha.value = Number(c.orangeTeamAlpha) ?? 0.85;
    if (c.centerLineColor) u.uCenterLineColor.value.set(c.centerLineColor);
    u.uCenterLineAlpha.value = Number(c.centerLineAlpha) ?? 0.0;

    if ((patch.blueTeamColor || patch.orangeTeamColor) && this.config?.ground) {
      this.bakeQ1GroundTextures(this.config.ground);
    }

    this.syncSpherePreviewMeshes();
  }

  updateMaterialCommon(mat, config) {
    if (!mat) return;
    if (config.roughness !== undefined && 'roughness' in mat) mat.roughness = config.roughness;
    if (config.metalness !== undefined && 'metalness' in mat) mat.metalness = config.metalness;
    if (config.wireframe !== undefined) mat.wireframe = config.wireframe;
  }
}

export function createDriftwoodsManager(stadiumScene, config) {
  return new DriftwoodsMaterialManager(stadiumScene, config);
}
