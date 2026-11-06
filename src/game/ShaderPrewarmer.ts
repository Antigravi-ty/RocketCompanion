import * as THREE from 'three';

export interface ShaderPrewarmPipelineOptions {
  passes?: Array<{ enabled?: boolean; [key: string]: any }>;
  disappearingLightRoots?: Array<THREE.Object3D | null | undefined>;
  composerRenderTarget?: THREE.WebGLRenderTarget | null;
  nonPovHiddenLights?: Array<THREE.Light | null | undefined>;
  renderBloom?: () => Promise<void> | void;
  renderFinal?: () => void;
  onProgress?: (ratio: number) => void;
}

function isLightNode(obj: any): obj is THREE.Light {
  return Boolean(obj && (obj.isLight || (THREE.Light && obj instanceof THREE.Light)));
}

function isRenderableVisualNode(obj: any): boolean {
  return Boolean(
    obj &&
      (obj.isMesh ||
        (THREE.Mesh && obj instanceof THREE.Mesh) ||
        obj.isPoints ||
        (THREE.Points && obj instanceof THREE.Points) ||
        obj.isLine ||
        (THREE.Line && obj instanceof THREE.Line))
  );
}

/**
 * Yields to the browser frame loop when visible, with a bounded timeout fallback so
 * backgrounded, occluded, or headless tabs never stall indefinitely waiting for rAF.
 */
function yieldFrameOrTimeout(maxWaitMs = 32): Promise<void> {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function' &&
    (typeof document === 'undefined' || !document.hidden)
  ) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(finish, maxWaitMs);
      window.requestAnimationFrame(() => {
        clearTimeout(timer);
        finish();
      });
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 4));
}

export function waitForCompiledMaterials(
  renderer: any,
  materials: Set<any> | null | undefined,
  maxWaitMs = 8000
): Promise<void> {
  if (!renderer || !materials || typeof materials.forEach !== 'function' || materials.size === 0) {
    return Promise.resolve();
  }
  if (!renderer.extensions?.get?.('KHR_parallel_shader_compile')) {
    return Promise.resolve();
  }

  try {
    renderer.getContext?.()?.flush?.();
  } catch (_e) {
    // Ignore WebGL flush errors
  }

  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return new Promise((resolve, reject) => {
    function checkMaterialsReady() {
      try {
        const props = renderer.properties;
        if (!props || typeof props.get !== 'function') {
          materials?.clear?.();
          resolve();
          return;
        }

        materials!.forEach((material: any) => {
          if (!material) {
            materials!.delete(material);
            return;
          }
          const materialProperties = props.get(material);
          const program = materialProperties ? materialProperties.currentProgram : null;
          if (!program || typeof program.isReady !== 'function' || program.isReady()) {
            materials!.delete(material);
          }
        });

        if (materials!.size === 0) {
          resolve();
          return;
        }

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - startTime > maxWaitMs) {
          materials?.clear?.();
          resolve();
          return;
        }

        setTimeout(checkMaterialsReady, 8);
      } catch (err) {
        reject(err);
      }
    }

    setTimeout(checkMaterialsReady, 8);
  });
}

export async function compileSceneAsync(
  renderer: any,
  scene: THREE.Scene,
  camera: THREE.Camera,
  targetScene: THREE.Scene | null = null,
  composerRenderTarget: THREE.WebGLRenderTarget | null = null
): Promise<THREE.Scene> {
  if (!renderer || !scene || !camera) return scene;
  if (typeof renderer.compile === 'function') {
    const prevTarget = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
    if (composerRenderTarget && typeof renderer.setRenderTarget === 'function') {
      renderer.setRenderTarget(composerRenderTarget);
    }
    let materials: Set<any> | null | undefined;
    try {
      materials = renderer.compile(scene, camera, targetScene);
    } finally {
      if (composerRenderTarget && typeof renderer.setRenderTarget === 'function') {
        renderer.setRenderTarget(prevTarget);
      }
    }
    await waitForCompiledMaterials(renderer, materials);
  }
  return scene;
}

export async function prewarmSceneShaders(
  renderer: any,
  scene: THREE.Scene,
  camera: THREE.Camera,
  pipeline: ShaderPrewarmPipelineOptions = {}
): Promise<void> {
  if (!renderer || !scene || !camera) return;

  const initiallyVisibleLights = new Set<THREE.Object3D>();
  scene.traverseVisible?.((node: THREE.Object3D) => {
    if (isLightNode(node)) initiallyVisibleLights.add(node);
  });

  const savedStates: Array<{
    object: THREE.Object3D;
    visible: boolean;
    frustumCulled: boolean;
    castShadow: boolean;
  }> = [];
  const savedDrawRanges = new Map<any, { start: number; count: number }>();
  const passes = (pipeline.passes ?? []).map((p) => ({ pass: p, enabled: p.enabled }));
  const disappearingLightRoots = (pipeline.disappearingLightRoots ?? [])
    .map((root) => {
      const lights: THREE.Light[] = [];
      root?.traverse?.((u: THREE.Object3D) => {
        if (isLightNode(u)) lights.push(u);
      });
      return lights;
    })
    .filter((group) => group.length > 0);
  const nonPovHiddenLights = new Set(
    (pipeline.nonPovHiddenLights ?? []).filter((l): l is THREE.Light => isLightNode(l))
  );

  const prevRenderTarget = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
  const prevShadowMapNeedsUpdate = renderer.shadowMap ? renderer.shadowMap.needsUpdate : false;

  scene.traverse?.((node: any) => {
    savedStates.push({
      object: node,
      visible: node.visible,
      frustumCulled: node.frustumCulled,
      castShadow: Boolean(node.castShadow),
    });
    if (isLightNode(node)) {
      node.visible = initiallyVisibleLights.has(node);
    } else {
      node.visible = true;
    }
    node.frustumCulled = false;

    if (isRenderableVisualNode(node)) {
      const geo = node.geometry;
      if (geo && geo.drawRange && geo.drawRange.count === 0 && !savedDrawRanges.has(geo)) {
        savedDrawRanges.set(geo, { ...geo.drawRange });
        const vertexCount = geo.index?.count ?? geo.attributes?.position?.count ?? 0;
        geo.setDrawRange?.(0, vertexCount);
      }
    }
  });

  for (const { pass } of passes) {
    if (pass) pass.enabled = true;
  }

  try {
    const compiledPermutationKeys = new Set<string>();

    // Prewarm both POV shadow-casting state (allowShadows=true) and Director/FreeCam shadow-off
    // state (allowShadows=false) so transitioning to Goal Replay Director Camera never stalls on
    // synchronous WebGL shader recompilation when carSun.castShadow flips from true to false
    // and ballSun/opponentSun are hidden in 'off' light rig mode.
    const shadowModes = [true, false];
    const numPermutations = 2 ** disappearingLightRoots.length;
    const totalSteps = shadowModes.length * numPermutations;
    let completedSteps = 0;

    for (const allowShadows of shadowModes) {
      for (let u = 0; u < numPermutations; u++) {
        for (const { object: lightObj, castShadow } of savedStates) {
          if (isLightNode(lightObj)) {
            lightObj.visible = initiallyVisibleLights.has(lightObj);
            lightObj.castShadow = allowShadows ? castShadow : false;
          }
        }
        if (!allowShadows && nonPovHiddenLights.size > 0) {
          for (const light of nonPovHiddenLights) {
            light.visible = false;
          }
        }
        for (let v = 0; v < disappearingLightRoots.length; v++) {
          if (u & (1 << v)) {
            for (const light of disappearingLightRoots[v]) {
              light.visible = false;
            }
          }
        }

        const visibleLightKey = savedStates
          .filter(({ object: node }) => isLightNode(node) && node.visible)
          .map(({ object: node }) => `${node.id}:${node.castShadow ? 1 : 0}`)
          .join(',');

        if (!compiledPermutationKeys.has(visibleLightKey)) {
          compiledPermutationKeys.add(visibleLightKey);
          await compileSceneAsync(
            renderer,
            scene,
            camera,
            null,
            pipeline.composerRenderTarget ?? null
          );

          if (typeof pipeline.renderBloom === 'function') {
            await pipeline.renderBloom();
          }

          if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
          if (typeof pipeline.renderFinal === 'function') {
            pipeline.renderFinal();
          }

          await yieldFrameOrTimeout();
        }

        completedSteps++;
        pipeline.onProgress?.(completedSteps / totalSteps);
      }
    }
  } finally {
    for (const { object: node, visible, frustumCulled, castShadow } of savedStates) {
      node.visible = visible;
      node.frustumCulled = frustumCulled;
      if (isLightNode(node)) {
        node.castShadow = castShadow;
      }
    }
    for (const [geo, range] of savedDrawRanges) {
      geo.setDrawRange?.(range.start, range.count);
    }
    for (const { pass, enabled } of passes) {
      if (pass) pass.enabled = enabled;
    }
    if (renderer.shadowMap) renderer.shadowMap.needsUpdate = prevShadowMapNeedsUpdate;
    if (renderer.setRenderTarget) renderer.setRenderTarget(prevRenderTarget);

    if (typeof pipeline.renderBloom === 'function') {
      await pipeline.renderBloom();
    }
    if (typeof pipeline.renderFinal === 'function') {
      pipeline.renderFinal();
    }
    try {
      const gl = renderer.getContext?.();
      if (gl && typeof gl.getError === 'function') {
        gl.getError();
      }
    } catch (_e) {
      // Ignore WebGL flush errors
    }
  }
}
