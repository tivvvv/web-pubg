// 渲染管线: 集中维护画质配置, 环境同步和低开销运行指标.
import * as THREE from 'three';
import type { EnvironmentSnapshot } from './environment';
import type { World } from './world';

export const RENDER_QUALITY = Object.freeze({
  antialias: true,
  maxPixelRatio: 1.5,
  shadows: true,
  shadowRefreshHz: 20,
  baseExposure: 1.1,
  saturation: 1.08,
  contrast: 1.02,
});

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
    // three.js 新版的 PCF 已内置可调半径软化，避免使用已废弃的 PCFSoftShadowMap。
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
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
