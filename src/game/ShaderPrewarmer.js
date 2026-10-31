import * as THREE from 'three';

function isLightNode(obj) {
  return Boolean(obj && (obj.isLight || (THREE.Light && obj instanceof THREE.Light)));
}

function isRenderableVisualNode(obj) {
  return Boolean(
    obj && (
      obj.isMesh || (THREE.Mesh && obj instanceof THREE.Mesh) ||
      obj.isPoints || (THREE.Points && obj instanceof THREE.Points) ||
      obj.isLine || (THREE.Line && obj instanceof THREE.Line)
    )
  );
}

function yieldAnimationFrame() {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
  return Promise.resolve();
}

export function waitForCompiledMaterials(renderer, materials, maxWaitMs = 15000) {
  if (!renderer || !materials || typeof materials.forEach !== 'function' || materials.size === 0) {
    return Promise.resolve();
  }
  if (!renderer.extensions?.get?.('KHR_parallel_shader_compile')) {
    return Promise.resolve();
  }

  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

  return new Promise((resolve, reject) => {
    function checkMaterialsReady() {
      try {
        const props = renderer.properties;
        if (!props || typeof props.get !== 'function') {
          materials.clear?.();
          resolve();
          return;
        }

        materials.forEach((material) => {
          if (!material) {
            materials.delete(material);
            return;
          }
          const materialProperties = props.get(material);
          const program = materialProperties ? materialProperties.currentProgram : null;
          if (!program || typeof program.isReady !== 'function' || program.isReady()) {
            materials.delete(material);
          }
        });

        if (materials.size === 0) {
          resolve();
          return;
        }

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - startTime > maxWaitMs) {
          materials.clear?.();
          resolve();
          return;
        }

        setTimeout(checkMaterialsReady, 10);
      } catch (err) {
        reject(err);
      }
    }

    setTimeout(checkMaterialsReady, 10);
  });
}

export async function compileSceneAsync(renderer, scene, camera, targetScene = null) {
  if (!renderer || !scene || !camera) return scene;
  if (typeof renderer.compile === 'function') {
    const materials = renderer.compile(scene, camera, targetScene);
    await waitForCompiledMaterials(renderer, materials);
  }
  return scene;
}

export async function prewarmSceneShaders(renderer, scene, camera, pipeline = {}) {
  if (!renderer || !scene || !camera) return;

  const initiallyVisibleLights = new Set();
  scene.traverseVisible?.((node) => {
    if (isLightNode(node)) initiallyVisibleLights.add(node);
  });

  const savedStates = [];
  const savedDrawRanges = new Map();
  const passes = (pipeline.passes ?? []).map((p) => ({ pass: p, enabled: p.enabled }));
  const disappearingLightRoots = (pipeline.disappearingLightRoots ?? [])
    .map((root) => {
      const lights = [];
      root?.traverse?.((u) => {
        if (isLightNode(u)) lights.push(u);
      });
      return lights;
    })
    .filter((group) => group.length > 0);

  const prevRenderTarget = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
  const prevShadowMapNeedsUpdate = renderer.shadowMap ? renderer.shadowMap.needsUpdate : false;

  scene.traverse?.((node) => {
    savedStates.push({
      object: node,
      visible: node.visible,
      frustumCulled: node.frustumCulled
    });
    node.visible = true;
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
    const compiledPermutationKeys = new Set();

    for (const forceLightVisible of [false, true]) {
      const numPermutations = 2 ** disappearingLightRoots.length;
      for (let u = 0; u < numPermutations; u++) {
        for (const { object: lightObj } of savedStates) {
          if (isLightNode(lightObj)) {
            lightObj.visible = forceLightVisible || initiallyVisibleLights.has(lightObj);
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
          .map(({ object: node }) => node.id)
          .join(',');

        if (!compiledPermutationKeys.has(visibleLightKey)) {
          compiledPermutationKeys.add(visibleLightKey);
          await compileSceneAsync(renderer, scene, camera);

          if (typeof pipeline.renderBloom === 'function') {
            await pipeline.renderBloom();
          }

          if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true;

          if (typeof pipeline.renderFinal === 'function') {
            pipeline.renderFinal();
          }

          await yieldAnimationFrame();
        }
      }
    }
  } finally {
    for (const { object: node, visible, frustumCulled } of savedStates) {
      node.visible = visible;
      node.frustumCulled = frustumCulled;
    }
    for (const [geo, range] of savedDrawRanges) {
      geo.setDrawRange?.(range.start, range.count);
    }
    for (const { pass, enabled } of passes) {
      if (pass) pass.enabled = enabled;
    }
    if (renderer.shadowMap) renderer.shadowMap.needsUpdate = prevShadowMapNeedsUpdate;
    if (renderer.setRenderTarget) renderer.setRenderTarget(prevRenderTarget);
  }
}
