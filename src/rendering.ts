// 渲染管线: 集中维护画质配置, 环境同步和低开销运行指标.
import * as THREE from 'three';
import type { EnvironmentSnapshot } from './environment';
import type { World } from './world';

export const RENDER_QUALITY = Object.freeze({
  antialias: true,
  maxPixelRatio: 1.75,
  shadows: true,
  shadowRefreshHz: 24,
  baseExposure: 1.12,
  saturation: 1.045,
  contrast: 1.035,
  environmentIntensity: 0.82,
});

function createOutdoorEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const width = 512;
  const height = 256;
  const pixels = new Uint8Array(width * height * 4);
  const zenith = new THREE.Color(0x72a9d6);
  const horizon = new THREE.Color(0xdde7df);
  const ground = new THREE.Color(0x526143);
  const sunColor = new THREE.Color(0xfff4d1);
  const sun = new THREE.Vector3(0.72, 0.54, 0.3).normalize();
  const direction = new THREE.Vector3();
  const color = new THREE.Color();
  for (let y = 0; y < height; y++) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    const cosLatitude = Math.cos(latitude);
    for (let x = 0; x < width; x++) {
      const longitude = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      direction.set(
        Math.sin(longitude) * cosLatitude,
        Math.sin(latitude),
        -Math.cos(longitude) * cosLatitude,
      );
      if (direction.y >= 0) {
        const skyBlend = Math.pow(direction.y, 0.42);
        color.copy(horizon).lerp(zenith, skyBlend);
        const sunAmount = Math.pow(Math.max(0, direction.dot(sun)), 420);
        color.lerp(sunColor, sunAmount * 0.92);
      } else {
        color.copy(horizon).lerp(ground, Math.min(1, -direction.y * 2.2));
      }
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round(THREE.MathUtils.clamp(color.r, 0, 1) * 255);
      pixels[offset + 1] = Math.round(THREE.MathUtils.clamp(color.g, 0, 1) * 255);
      pixels[offset + 2] = Math.round(THREE.MathUtils.clamp(color.b, 0, 1) * 255);
      pixels[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  const generator = new THREE.PMREMGenerator(renderer);
  generator.compileEquirectangularShader();
  const target = generator.fromEquirectangular(texture);
  generator.dispose();
  texture.dispose();
  return target;
}

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  contextLosses: number;
}

export class GameRenderer {
  readonly domElement: HTMLCanvasElement;
  readonly stats: RenderStats = {
    fps: 0,
    frameMs: 0,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    contextLosses: 0,
  };

  private readonly renderer: THREE.WebGLRenderer;
  private readonly publishTestStats = new URLSearchParams(window.location.search).has('test');
  private sampleTime = 0;
  private sampleFrames = 0;
  private lastVisualFilter = '';
  private contextLost = false;
  private shadowRefreshElapsed = 0;
  private readonly lastShadowCameraPosition = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private environmentScene: THREE.Scene | null = null;

  constructor(container: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({
      antialias: RENDER_QUALITY.antialias,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER_QUALITY.maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = RENDER_QUALITY.shadows;
    // 阴影保持 2048 分辨率, 但不再在 60-120Hz 下重复绘制完全相同的静态世界。
    // 20Hz 更新对缓慢太阳移动和角色阴影足够平滑, 贴地阴影仍然逐帧跟随。
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    // three.js 新版 PCF 结合灯光 shadow.radius 完成柔化，避免使用已废弃的 PCFSoftShadowMap。
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = RENDER_QUALITY.baseExposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.filter = `saturate(${RENDER_QUALITY.saturation}) contrast(${RENDER_QUALITY.contrast})`;
    this.renderer = renderer;
    this.domElement = renderer.domElement;
    renderer.domElement.addEventListener('webglcontextlost', (event) => {
      // 阻止浏览器永久销毁上下文, Three.js 可在资源恢复后继续使用现有场景。
      event.preventDefault();
      this.contextLost = true;
      this.stats.contextLosses++;
      document.body.dataset.webglContext = 'lost';
      document.body.dataset.webglContextLosses = String(this.stats.contextLosses);
    });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      document.body.dataset.webglContext = 'restored';
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER_QUALITY.maxPixelRatio));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.shadowMap.needsUpdate = true;
    });
    container.appendChild(renderer.domElement);
  }

  setAnimationLoop(callback: (() => void) | null): void {
    this.renderer.setAnimationLoop(callback);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    const environmentScene = this.environmentScene;
    if (environmentScene && environmentScene.environment === this.environmentTarget?.texture) {
      environmentScene.environment = null;
    }
    this.environmentTarget?.dispose();
    this.environmentTarget = null;
    this.environmentScene = null;
    this.renderer.dispose();
    this.domElement.remove();
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }

  cssHeight(): number {
    return this.domElement.height / this.renderer.getPixelRatio();
  }

  renderFrame(
    dt: number,
    scene: THREE.Scene,
    camera: THREE.Camera,
    world: World,
    advanceEnvironment: boolean,
  ): EnvironmentSnapshot {
    world.updateVisuals(dt, camera.position, advanceEnvironment);
    const environment = world.environmentState;
    if (this.contextLost) return environment;
    if (this.environmentScene !== scene || !this.environmentTarget) {
      this.environmentTarget?.dispose();
      this.environmentTarget = createOutdoorEnvironment(this.renderer);
      this.environmentScene = scene;
      scene.environment = this.environmentTarget.texture;
    }
    scene.environmentIntensity = RENDER_QUALITY.environmentIntensity * (
      0.72 + environment.daylight * 0.28 + environment.cloudiness * 0.08
    );
    this.renderer.toneMappingExposure = environment.exposure;
    const visualFilter = `saturate(${environment.saturation.toFixed(3)}) contrast(${environment.contrast.toFixed(3)})`;
    if (visualFilter !== this.lastVisualFilter) {
      this.domElement.style.filter = visualFilter;
      this.lastVisualFilter = visualFilter;
    }
    this.shadowRefreshElapsed += dt;
    const cameraMoved = camera.position.distanceToSquared(this.lastShadowCameraPosition) > 36;
    if (cameraMoved || this.shadowRefreshElapsed >= 1 / RENDER_QUALITY.shadowRefreshHz) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowRefreshElapsed = 0;
      this.lastShadowCameraPosition.copy(camera.position);
    }
    this.renderer.render(scene, camera);
    this.updateStats(dt);
    return environment;
  }

  private updateStats(dt: number): void {
    this.sampleTime += dt;
    this.sampleFrames++;
    if (this.sampleTime < 0.5) return;
    const info = this.renderer.info;
    this.stats.fps = this.sampleFrames / this.sampleTime;
    this.stats.frameMs = (this.sampleTime / this.sampleFrames) * 1000;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.geometries = info.memory.geometries;
    this.stats.textures = info.memory.textures;
    this.sampleTime = 0;
    this.sampleFrames = 0;
    if (!this.publishTestStats) return;
    document.body.dataset.fps = this.stats.fps.toFixed(1);
    document.body.dataset.frameMs = this.stats.frameMs.toFixed(2);
    document.body.dataset.drawCalls = String(this.stats.drawCalls);
    document.body.dataset.triangles = String(this.stats.triangles);
    document.body.dataset.geometries = String(this.stats.geometries);
    document.body.dataset.textures = String(this.stats.textures);
    document.body.dataset.webglContextLosses = String(this.stats.contextLosses);
  }
}
