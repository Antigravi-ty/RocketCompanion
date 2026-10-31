import * as THREE from 'three';
import {
  createRoomEnvironmentMaterial,
  RoomEnvironment
} from './RoomEnvironment.js';
import {
  CopyShader,
  Pass,
  FullScreenGeometry,
  FullScreenQuad,
  ShaderPass,
  MaskPass,
  ClearMaskPass,
  OutputShader,
  OutputPass,
  RenderPass
} from './PostprocessingPasses.js';

export {
  createRoomEnvironmentMaterial,
  RoomEnvironment,
  CopyShader,
  Pass,
  FullScreenGeometry,
  FullScreenQuad,
  ShaderPass,
  MaskPass,
  ClearMaskPass,
  OutputShader,
  OutputPass,
  RenderPass
};

// Tone mapping mode constants
export const LinearToneMapping = 1;
export const ReinhardToneMapping = 2;
export const CineonToneMapping = 3;
export const ACESFilmicToneMapping = 4;
export const CustomToneMapping = 5;
export const AgXToneMapping = 6;
export const NeutralToneMapping = 7;
export const NoBlending = 0;
export const BackSide = 1;
export const HalfFloatType = 1016;
export const SRGBTransfer = 'srgb';

export function resolvePostprocessingContext() {
  return THREE;
}

/**
 * EffectComposer
 * Ping-pong render target coordinator executing the postprocessing pass chain
 */
export class EffectComposer {
  constructor(renderer, renderTarget) {
    this.renderer = renderer;
    this._pixelRatio = (renderer && typeof renderer.getPixelRatio === 'function' ? renderer.getPixelRatio() : 1);

    const {
      Vector2,
      WebGLRenderTarget,
      HalfFloatType: HalfFloatConst,
      NoBlending: NoBlendConst,
      Timer
    } = resolvePostprocessingContext();

    if (renderTarget === undefined) {
      const size = (renderer && typeof renderer.getSize === 'function' ? renderer.getSize(new Vector2()) : new Vector2(800, 600));
      this._width = size.width;
      this._height = size.height;
      renderTarget = new WebGLRenderTarget(
        this._width * this._pixelRatio,
        this._height * this._pixelRatio,
        { type: HalfFloatConst, stencilBuffer: true }
      );
      renderTarget.texture.name = "EffectComposer.rt1";
    } else {
      this._width = renderTarget.width;
      this._height = renderTarget.height;
    }

    this.renderTarget1 = renderTarget;
    this.renderTarget2 = renderTarget.clone();
    if (this.renderTarget2.texture) {
      this.renderTarget2.texture.name = "EffectComposer.rt2";
    }

    this.writeBuffer = this.renderTarget1;
    this.readBuffer = this.renderTarget2;
    this.renderToScreen = true;
    this.passes = [];

    this.copyPass = new ShaderPass(CopyShader);
    if (this.copyPass.material) {
      this.copyPass.material.blending = NoBlendConst;
    }

    this.timer = new Timer();
  }

  swapBuffers() {
    const tmp = this.readBuffer;
    this.readBuffer = this.writeBuffer;
    this.writeBuffer = tmp;
  }

  addPass(pass) {
    this.passes.push(pass);
    if (pass && typeof pass.setSize === 'function') {
      pass.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
    }
  }

  insertPass(pass, index) {
    this.passes.splice(index, 0, pass);
    if (pass && typeof pass.setSize === 'function') {
      pass.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
    }
  }

  removePass(pass) {
    const idx = this.passes.indexOf(pass);
    if (idx !== -1) {
      this.passes.splice(idx, 1);
    }
  }

  isLastEnabledPass(passIndex) {
    for (let i = passIndex + 1; i < this.passes.length; i++) {
      if (this.passes[i].enabled) return false;
    }
    return true;
  }

  render(deltaTime) {
    if (this.timer && typeof this.timer.update === 'function') {
      this.timer.update();
    }
    if (deltaTime === undefined && this.timer && typeof this.timer.getDelta === 'function') {
      deltaTime = this.timer.getDelta();
    }

    const currentRenderTarget = (this.renderer && typeof this.renderer.getRenderTarget === 'function' ? this.renderer.getRenderTarget() : null);
    let maskActive = false;

    for (let i = 0, len = this.passes.length; i < len; i++) {
      const pass = this.passes[i];
      if (pass && pass.enabled !== false) {
        pass.renderToScreen = this.renderToScreen && this.isLastEnabledPass(i);
        pass.render(this.renderer, this.writeBuffer, this.readBuffer, deltaTime, maskActive);

        if (pass.needsSwap) {
          if (maskActive && this.renderer && this.renderer.getContext && this.renderer.state) {
            const gl = this.renderer.getContext();
            const stencil = this.renderer.state.buffers.stencil;
            stencil.setFunc(gl.NOTEQUAL, 1, 0xffffffff);
            this.copyPass.render(this.renderer, this.writeBuffer, this.readBuffer, deltaTime);
            stencil.setFunc(gl.EQUAL, 1, 0xffffffff);
          }
          this.swapBuffers();
        }

        if (pass instanceof MaskPass) {
          maskActive = true;
        } else if (pass instanceof ClearMaskPass) {
          maskActive = false;
        }
      }
    }

    if (this.renderer && typeof this.renderer.setRenderTarget === 'function') {
      this.renderer.setRenderTarget(currentRenderTarget);
    }
  }

  reset(renderTarget) {
    if (renderTarget === undefined) {
      const { Vector2 } = resolvePostprocessingContext();
      const size = (this.renderer && typeof this.renderer.getSize === 'function' ? this.renderer.getSize(new Vector2()) : new Vector2(800, 600));
      this._pixelRatio = (this.renderer && typeof this.renderer.getPixelRatio === 'function' ? this.renderer.getPixelRatio() : 1);
      this._width = size.width;
      this._height = size.height;
      renderTarget = this.renderTarget1.clone();
      renderTarget.setSize(this._width * this._pixelRatio, this._height * this._pixelRatio);
    }

    this.renderTarget1.dispose();
    this.renderTarget2.dispose();
    this.renderTarget1 = renderTarget;
    this.renderTarget2 = renderTarget.clone();
    this.writeBuffer = this.renderTarget1;
    this.readBuffer = this.renderTarget2;
  }

  setSize(width, height) {
    this._width = width;
    this._height = height;
    const w = this._width * this._pixelRatio;
    const h = this._height * this._pixelRatio;
    this.renderTarget1.setSize(w, h);
    this.renderTarget2.setSize(w, h);
    for (let i = 0; i < this.passes.length; i++) {
      if (this.passes[i] && typeof this.passes[i].setSize === 'function') {
        this.passes[i].setSize(w, h);
      }
    }
  }

  setPixelRatio(pixelRatio) {
    this._pixelRatio = pixelRatio;
    this.setSize(this._width, this._height);
  }

  dispose() {
    this.renderTarget1.dispose();
    this.renderTarget2.dispose();
    this.copyPass.dispose();
  }
}

const RawShaderMaterial = THREE.RawShaderMaterial;
export { RawShaderMaterial };
