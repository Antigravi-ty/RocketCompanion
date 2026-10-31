import * as THREE from 'three';

/**
 * Standard passthrough copy shader
 */
export const CopyShader = {
  name: "CopyShader",
  uniforms: {
    tDiffuse: { value: null },
    opacity: { value: 1.0 }
  },
  vertexShader: `
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,
  fragmentShader: `
		uniform float opacity;
		uniform sampler2D tDiffuse;
		varying vec2 vUv;
		void main() {
			vec4 texel = texture2D( tDiffuse, vUv );
			gl_FragColor = opacity * texel;
		}`
};

/**
 * Base Pass class adhering to EffectComposer lifecycle
 */
export class Pass {
  constructor() {
    this.isPass = true;
    this.enabled = true;
    this.needsSwap = true;
    this.clear = false;
    this.renderToScreen = false;
  }
  setSize(width, height) {}
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    console.error("THREE.Pass: .render() must be implemented in derived pass.");
  }
  dispose() {}
}

/**
 * Single large triangle covering the entire viewport (-1 to 3 in clip space)
 */
export class FullScreenGeometry extends THREE.BufferGeometry {
  constructor() {
    super();
    const { Float32BufferAttribute } = THREE;
    this.setAttribute("position", new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
    this.setAttribute("uv", new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  }
}

let sharedFullScreenGeometry = null;
let sharedFullScreenCamera = null;

function getSharedFullScreenGeometry() {
  if (!sharedFullScreenGeometry) {
    sharedFullScreenGeometry = new FullScreenGeometry();
  }
  return sharedFullScreenGeometry;
}

function getSharedFullScreenCamera() {
  if (!sharedFullScreenCamera) {
    const { OrthographicCamera } = THREE;
    sharedFullScreenCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  return sharedFullScreenCamera;
}

/**
 * Fullscreen Quad renderer rendering through a fixed OrthographicCamera
 */
export class FullScreenQuad {
  constructor(material) {
    const { Mesh } = THREE;
    this._mesh = new Mesh(getSharedFullScreenGeometry(), material);
  }

  dispose() {
    if (this._mesh && this._mesh.geometry && typeof this._mesh.geometry.dispose === 'function') {
      this._mesh.geometry.dispose();
    }
  }

  render(renderer) {
    if (renderer && typeof renderer.render === 'function') {
      renderer.render(this._mesh, getSharedFullScreenCamera());
    }
  }

  get material() {
    return this._mesh ? this._mesh.material : null;
  }

  set material(value) {
    if (this._mesh) {
      this._mesh.material = value;
    }
  }
}

/**
 * Generic shader pass rendering a full-screen shader material
 */
export class ShaderPass extends Pass {
  constructor(shader, textureID = "tDiffuse") {
    super();
    this.textureID = textureID;
    this.uniforms = null;
    this.material = null;

    const { ShaderMaterial, UniformsUtils } = THREE;

    if (shader && (shader.isShaderMaterial || (typeof ShaderMaterial === 'function' && shader instanceof ShaderMaterial))) {
      this.uniforms = shader.uniforms;
      this.material = shader;
    } else if (shader) {
      this.uniforms = UniformsUtils.clone(shader.uniforms);
      this.material = new ShaderMaterial({
        name: shader.name !== undefined ? shader.name : "unspecified",
        defines: Object.assign({}, shader.defines),
        uniforms: this.uniforms,
        vertexShader: shader.vertexShader,
        fragmentShader: shader.fragmentShader
      });
    }

    this._fsQuad = new FullScreenQuad(this.material);
  }

  render(renderer, writeBuffer, readBuffer) {
    if (this.uniforms && this.uniforms[this.textureID] && readBuffer) {
      this.uniforms[this.textureID].value = readBuffer.texture;
    }
    this._fsQuad.material = this.material;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this._fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) {
        renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
      }
      this._fsQuad.render(renderer);
    }
  }

  dispose() {
    if (this.material && typeof this.material.dispose === 'function') {
      this.material.dispose();
    }
    if (this._fsQuad) {
      this._fsQuad.dispose();
    }
  }
}

/**
 * MaskPass
 * Uses the WebGL stencil buffer to confine subsequent rendering to a masked region
 */
export class MaskPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.clear = true;
    this.needsSwap = false;
    this.inverse = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const gl = renderer.getContext ? renderer.getContext() : null;
    const state = renderer.state;

    if (!gl || !state) return;

    state.buffers.color.setMask(false);
    state.buffers.depth.setMask(false);
    state.buffers.color.setLocked(true);
    state.buffers.depth.setLocked(true);

    const writeValue = this.inverse ? 0 : 1;
    const clearValue = this.inverse ? 1 : 0;

    state.buffers.stencil.setTest(true);
    state.buffers.stencil.setOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
    state.buffers.stencil.setFunc(gl.ALWAYS, writeValue, 0xffffffff);
    state.buffers.stencil.setClear(clearValue);
    state.buffers.stencil.setLocked(true);

    renderer.setRenderTarget(readBuffer);
    if (this.clear) renderer.clear();
    renderer.render(this.scene, this.camera);

    renderer.setRenderTarget(writeBuffer);
    if (this.clear) renderer.clear();
    renderer.render(this.scene, this.camera);

    state.buffers.color.setLocked(false);
    state.buffers.depth.setLocked(false);
    state.buffers.color.setMask(true);
    state.buffers.depth.setMask(true);

    state.buffers.stencil.setLocked(false);
    state.buffers.stencil.setFunc(gl.EQUAL, 1, 0xffffffff);
    state.buffers.stencil.setOp(gl.KEEP, gl.KEEP, gl.KEEP);
    state.buffers.stencil.setLocked(true);
  }
}

/**
 * ClearMaskPass
 * Disables and unlocks stencil testing after masked passes complete
 */
export class ClearMaskPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
  }

  render(renderer) {
    if (renderer && renderer.state && renderer.state.buffers && renderer.state.buffers.stencil) {
      renderer.state.buffers.stencil.setLocked(false);
      renderer.state.buffers.stencil.setTest(false);
    }
  }
}

/**
 * Output color grading and tonemapping shader
 */
export const OutputShader = {
  name: "OutputShader",
  uniforms: {
    tDiffuse: { value: null },
    toneMappingExposure: { value: 1.0 }
  },
  vertexShader: `
		precision highp float;
		uniform mat4 modelViewMatrix;
		uniform mat4 projectionMatrix;
		attribute vec3 position;
		attribute vec2 uv;
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,
  fragmentShader: `
		precision highp float;
		uniform sampler2D tDiffuse;
		#include <tonemapping_pars_fragment>
		#include <colorspace_pars_fragment>
		varying vec2 vUv;
		void main() {
			gl_FragColor = texture2D( tDiffuse, vUv );
			#ifdef LINEAR_TONE_MAPPING
				gl_FragColor.rgb = LinearToneMapping( gl_FragColor.rgb );
			#elif defined( REINHARD_TONE_MAPPING )
				gl_FragColor.rgb = ReinhardToneMapping( gl_FragColor.rgb );
			#elif defined( CINEON_TONE_MAPPING )
				gl_FragColor.rgb = CineonToneMapping( gl_FragColor.rgb );
			#elif defined( ACES_FILMIC_TONE_MAPPING )
				gl_FragColor.rgb = ACESFilmicToneMapping( gl_FragColor.rgb );
			#elif defined( AGX_TONE_MAPPING )
				gl_FragColor.rgb = AgXToneMapping( gl_FragColor.rgb );
			#elif defined( NEUTRAL_TONE_MAPPING )
				gl_FragColor.rgb = NeutralToneMapping( gl_FragColor.rgb );
			#elif defined( CUSTOM_TONE_MAPPING )
				gl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );
			#endif
			#ifdef SRGB_TRANSFER
				gl_FragColor = sRGBTransferOETF( gl_FragColor );
			#endif
		}`
};

/**
 * OutputPass
 * Dynamically maps output color space and tone mapping algorithm onto the OutputShader defines
 */
export class OutputPass extends Pass {
  constructor() {
    super();
    this.isOutputPass = true;

    const { RawShaderMaterial, ShaderMaterial, UniformsUtils } = THREE;
    const MaterialClass = RawShaderMaterial || ShaderMaterial;

    this.uniforms = UniformsUtils.clone(OutputShader.uniforms);
    this.material = new MaterialClass({
      name: OutputShader.name,
      uniforms: this.uniforms,
      vertexShader: OutputShader.vertexShader,
      fragmentShader: OutputShader.fragmentShader
    });
    this._fsQuad = new FullScreenQuad(this.material);
    this._outputColorSpace = null;
    this._toneMapping = null;
  }

  render(renderer, writeBuffer, readBuffer) {
    const {
      ColorManagement,
      SRGBTransfer: SRGBTransferConst,
      LinearToneMapping: LinearConst,
      ReinhardToneMapping: ReinhardConst,
      CineonToneMapping: CineonConst,
      ACESFilmicToneMapping: ACESConst,
      AgXToneMapping: AgXConst,
      NeutralToneMapping: NeutralConst,
      CustomToneMapping: CustomConst
    } = THREE;

    if (this.uniforms && this.uniforms.tDiffuse && readBuffer) {
      this.uniforms.tDiffuse.value = readBuffer.texture;
    }
    if (this.uniforms && this.uniforms.toneMappingExposure) {
      this.uniforms.toneMappingExposure.value = renderer ? renderer.toneMappingExposure : 1.0;
    }

    if (renderer && (this._outputColorSpace !== renderer.outputColorSpace || this._toneMapping !== renderer.toneMapping)) {
      this._outputColorSpace = renderer.outputColorSpace;
      this._toneMapping = renderer.toneMapping;

      this.material.defines = {};

      if (ColorManagement && ColorManagement.getTransfer && ColorManagement.getTransfer(this._outputColorSpace) === SRGBTransferConst) {
        this.material.defines.SRGB_TRANSFER = "";
      }

      if (this._toneMapping === LinearConst) {
        this.material.defines.LINEAR_TONE_MAPPING = "";
      } else if (this._toneMapping === ReinhardConst) {
        this.material.defines.REINHARD_TONE_MAPPING = "";
      } else if (this._toneMapping === CineonConst) {
        this.material.defines.CINEON_TONE_MAPPING = "";
      } else if (this._toneMapping === ACESConst) {
        this.material.defines.ACES_FILMIC_TONE_MAPPING = "";
      } else if (this._toneMapping === AgXConst) {
        this.material.defines.AGX_TONE_MAPPING = "";
      } else if (this._toneMapping === NeutralConst) {
        this.material.defines.NEUTRAL_TONE_MAPPING = "";
      } else if (this._toneMapping === CustomConst) {
        this.material.defines.CUSTOM_TONE_MAPPING = "";
      }

      this.material.needsUpdate = true;
    }

    if (this.renderToScreen === true) {
      if (renderer) renderer.setRenderTarget(null);
      this._fsQuad.render(renderer);
    } else {
      if (renderer) {
        renderer.setRenderTarget(writeBuffer);
        if (this.clear) {
          renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
        }
      }
      this._fsQuad.render(renderer);
    }
  }

  dispose() {
    if (this.material && typeof this.material.dispose === 'function') {
      this.material.dispose();
    }
    if (this._fsQuad) {
      this._fsQuad.dispose();
    }
  }
}

/**
 * RenderPass
 * Evaluates the 3D scene & camera into an offscreen render target
 */
export class RenderPass extends Pass {
  constructor(scene, camera, overrideMaterial = null, clearColor = null, clearAlpha = null) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.overrideMaterial = overrideMaterial;
    this.clearColor = clearColor;
    this.clearAlpha = clearAlpha;
    this.clear = true;
    this.clearDepth = false;
    this.needsSwap = false;
    this.isRenderPass = true;

    const { Color } = THREE;
    this._oldClearColor = new Color();
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!renderer) return;

    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    let oldClearAlpha, oldOverrideMaterial;

    if (this.overrideMaterial !== null && this.scene) {
      oldOverrideMaterial = this.scene.overrideMaterial;
      this.scene.overrideMaterial = this.overrideMaterial;
    }

    if (this.clearColor !== null) {
      renderer.getClearColor(this._oldClearColor);
      renderer.setClearColor(this.clearColor, renderer.getClearAlpha());
    }

    if (this.clearAlpha !== null) {
      oldClearAlpha = renderer.getClearAlpha();
      renderer.setClearAlpha(this.clearAlpha);
    }

    if (this.clearDepth === true && renderer.clearDepth) {
      renderer.clearDepth();
    }

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);

    if (this.clear === true) {
      renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);
    }

    renderer.render(this.scene, this.camera);

    if (this.clearColor !== null) {
      renderer.setClearColor(this._oldClearColor);
    }

    if (this.clearAlpha !== null) {
      renderer.setClearAlpha(oldClearAlpha);
    }

    if (this.overrideMaterial !== null && this.scene) {
      this.scene.overrideMaterial = oldOverrideMaterial;
    }

    renderer.autoClear = oldAutoClear;
  }
}
