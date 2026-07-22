// 渲染管线: 集中维护画质配置, 环境同步和低开销运行指标.
import * as THREE from 'three';
import type { EnvironmentSnapshot } from './environment';
import type { World } from './world';

export const RENDER_QUALITY = Object.freeze({
  antialias: true,
  maxPixelRatio: 1.5,
  shadows: true,
  baseExposure: 1.08,
  saturation: 1.06,
  contrast: 1.035,
});

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
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
  };

  private readonly renderer: THREE.WebGLRenderer;
  private readonly publishTestStats = new URLSearchParams(window.location.search).has('test');
  private sampleTime = 0;
  private sampleFrames = 0;

  constructor(container: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({
      antialias: RENDER_QUALITY.antialias,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER_QUALITY.maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = RENDER_QUALITY.shadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = RENDER_QUALITY.baseExposure;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.filter = `saturate(${RENDER_QUALITY.saturation}) contrast(${RENDER_QUALITY.contrast})`;
    this.renderer = renderer;
    this.domElement = renderer.domElement;
    container.appendChild(renderer.domElement);
  }

  setAnimationLoop(callback: () => void): void {
    this.renderer.setAnimationLoop(callback);
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
    this.renderer.toneMappingExposure = environment.exposure;
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
  }
}
