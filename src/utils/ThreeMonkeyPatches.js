/**
 * src/utils/ThreeMonkeyPatches.js
 * Defensive monkey-patching and compatibility layer for Three.js.
 *
 * Safely wraps and augments Three.js classes and prototype methods so that
 * standard upstream Three.js (r128 - r185+) can seamlessly operate with
 * game assets, interleaved stadium meshes, procedural shaders, and web environments:
 *
 * 1. InterleavedBufferAttribute:
 *    - Augments missing .applyMatrix4(m), .applyNormalMatrix(m), and .transformDirection(m).
 *    - Guards vertex coordinate reads against out-of-bounds NaNs.
 * 2. Box3 & BufferGeometry Bounding Logic:
 *    - Box3.prototype.setFromBufferAttribute: Defensively filters NaN components.
 * 3. LoadingManager:
 *    - Defensively ensures .resolveURL exists.
 * 4. ShaderChunk ANGLE Metal (Apple Silicon) Compatibility:
 *    - Replaces 'out IncidentLight light' with 'inout IncidentLight light' in
 *      ShaderChunk.lights_pars_begin to satisfy Metal Shading Language (MSL) rules.
 * 5. FileLoader Asset Diagnostics & SPA 404 Fallback Guard:
 *    - Intercepts FileLoader fetch responses with validateAssetResponse to fail fast
 *      with clear diagnostics if a static server returns an HTML SPA 404 fallback
 *      instead of a binary .glb/.obj asset.
 */

import { validateAssetResponse } from './AssetResponseValidator.js';

const appliedThreeInstances = new WeakSet();
let patchesApplied = false;

/**
 * Applies defensive monkey patches to a target Three.js instance.
 * @param {object} THREE Three.js namespace or context
 * @returns {object} The patched Three.js context
 */
export function applyThreeMonkeyPatches(THREE) {
  if (!THREE || typeof THREE !== 'object') return THREE;
  if (appliedThreeInstances.has(THREE)) return THREE;
  appliedThreeInstances.add(THREE);

  // 1. InterleavedBufferAttribute math helpers
  if (THREE.InterleavedBufferAttribute) {
    const proto = THREE.InterleavedBufferAttribute.prototype;

    if (!proto.applyMatrix4) {
      proto.applyMatrix4 = function (m) {
        if (!THREE.Vector3) return this;
        const v = new THREE.Vector3();
        const count = this.data ? this.data.count : this.count;
        for (let i = 0; i < count; i++) {
          v.fromBufferAttribute(this, i);
          v.applyMatrix4(m);
          this.setXYZ(i, v.x, v.y, v.z);
        }
        return this;
      };
    }

    if (!proto.applyNormalMatrix) {
      proto.applyNormalMatrix = function (m) {
        if (!THREE.Vector3) return this;
        const v = new THREE.Vector3();
        const count = this.data ? this.data.count : this.count;
        for (let i = 0; i < count; i++) {
          v.fromBufferAttribute(this, i);
          v.applyNormalMatrix(m);
          this.setXYZ(i, v.x, v.y, v.z);
        }
        return this;
      };
    }

    if (!proto.transformDirection) {
      proto.transformDirection = function (m) {
        if (!THREE.Vector3) return this;
        const v = new THREE.Vector3();
        const count = this.data ? this.data.count : this.count;
        for (let i = 0; i < count; i++) {
          v.fromBufferAttribute(this, i);
          v.transformDirection(m);
          this.setXYZ(i, v.x, v.y, v.z);
        }
        return this;
      };
    }
  }

  // 2. Box3 setFromBufferAttribute NaN bounds guarding
  if (THREE.Box3 && THREE.Vector3) {
    THREE.Box3.prototype.setFromBufferAttribute = function (attribute) {
      if (!attribute) return this.makeEmpty();
      this.makeEmpty();
      const v = new THREE.Vector3();
      const count = attribute.count || 0;
      for (let i = 0; i < count; i++) {
        v.fromBufferAttribute(attribute, i);
        if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) {
          this.expandByPoint(v);
        }
      }
      return this;
    };
  }

  // 3. LoadingManager resolveURL defensive fallback
  if (THREE.LoadingManager && !THREE.LoadingManager.prototype.resolveURL) {
    THREE.LoadingManager.prototype.resolveURL = function (url) {
      return typeof this.urlModifier === 'function' ? this.urlModifier(url) : url;
    };
  }

  // 4. ShaderChunk ANGLE Metal MSL light parameter patch
  if (THREE.ShaderChunk && THREE.ShaderChunk.lights_pars_begin) {
    THREE.ShaderChunk.lights_pars_begin = THREE.ShaderChunk.lights_pars_begin
      .replaceAll(/\bout IncidentLight light\b/g, 'inout IncidentLight light');
  }

  // 5. FileLoader asset diagnostics and SPA 404 HTML fallback guard
  if (THREE.FileLoader && !THREE.FileLoader.prototype._hasAssetDiagnosticsPatch) {
    const originalLoad = THREE.FileLoader.prototype.load;
    THREE.FileLoader.prototype.load = function (url, onLoad, onProgress, onError) {
      const origFetch = globalThis.fetch;
      if (typeof origFetch === 'function') {
        const responseType = this.responseType;
        globalThis.fetch = function (input, init) {
          // Restore immediately after invocation to avoid side effects on other fetches
          globalThis.fetch = origFetch;
          return origFetch.call(this, input, init).then((res) => {
            if (typeof validateAssetResponse === 'function') {
              const reqUrl = typeof input === 'string' ? input : (input && input.url ? input.url : url);
              const check = validateAssetResponse(res, reqUrl, responseType);
              if (!check.ok && responseType !== 'document' && !String(reqUrl).endsWith('.html')) {
                throw check.error;
              }
            }
            return res;
          });
        };
        try {
          return originalLoad.call(this, url, onLoad, onProgress, onError);
        } finally {
          globalThis.fetch = origFetch;
        }
      } else {
        return originalLoad.call(this, url, onLoad, onProgress, onError);
      }
    };
    THREE.FileLoader.prototype._hasAssetDiagnosticsPatch = true;
  }

  // 6. WebGLRenderer.compileAsync defensive guard against disposed materials and unrejected setTimeout errors
  if (THREE.WebGLRenderer && THREE.WebGLRenderer.prototype && !THREE.WebGLRenderer.prototype._hasSafeCompileAsyncPatch) {
    Object.defineProperty(THREE.WebGLRenderer.prototype, 'compileAsync', {
      configurable: true,
      enumerable: true,
      get() {
        return this._safeCompileAsync || this._origCompileAsync;
      },
      set(origCompileAsync) {
        this._origCompileAsync = origCompileAsync;
        this._safeCompileAsync = function (scene, camera, targetScene = null) {
          const renderer = this;
          return new Promise((resolve, reject) => {
            let materials;
            try {
              if (typeof renderer.compile === 'function') {
                materials = renderer.compile(scene, camera, targetScene);
              }
            } catch (err) {
              reject(err);
              return;
            }

            if (!materials || typeof materials.forEach !== 'function' || materials.size === 0) {
              resolve(scene);
              return;
            }
            if (!renderer.extensions?.get?.('KHR_parallel_shader_compile')) {
              resolve(scene);
              return;
            }

            const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const maxWaitMs = 15000;

            function checkMaterialsReady() {
              try {
                const props = renderer.properties;
                if (!props || typeof props.get !== 'function') {
                  materials.clear?.();
                  resolve(scene);
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
                  resolve(scene);
                  return;
                }

                const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                if (now - startTime > maxWaitMs) {
                  materials.clear?.();
                  resolve(scene);
                  return;
                }

                setTimeout(checkMaterialsReady, 10);
              } catch (err) {
                reject(err);
              }
            }

            setTimeout(checkMaterialsReady, 10);
          });
        };
      }
    });
    THREE.WebGLRenderer.prototype._hasSafeCompileAsyncPatch = true;
  }

  patchesApplied = true;
  return THREE;
}

export function areThreeMonkeyPatchesApplied() {
  return patchesApplied;
}
