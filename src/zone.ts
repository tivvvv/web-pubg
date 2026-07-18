// 毒圈: 等待→缩圈相位机 + 蓝色能量墙 + 圈外伤害
import * as THREE from 'three';
import { lerp, rand } from './utils';

interface Phase {
  wait: number;   // 等待秒数
  shrink: number; // 缩圈秒数
  radius: number; // 缩到的半径
}

const PHASES: Phase[] = [
  { wait: 22, shrink: 26, radius: 195 },
  { wait: 20, shrink: 24, radius: 120 },
  { wait: 18, shrink: 22, radius: 72 },
  { wait: 16, shrink: 20, radius: 40 },
  { wait: 14, shrink: 16, radius: 20 },
  { wait: 12, shrink: 14, radius: 9 },
];
const DPS = [1, 2, 4, 7, 10, 14];
const WALL_H = 90;

export type ZoneState = 'wait' | 'shrink' | 'done';

export class Zone {
  readonly center = new THREE.Vector2();
  radius = 310;
  readonly nextCenter = new THREE.Vector2();
  nextRadius = 310;
  phase = 0;              // 已完成缩圈次数
  state: ZoneState = 'wait';
  timer = PHASES[0]?.wait ?? 22;
  justBeganShrink = false;

  private startCenter = new THREE.Vector2();
  private startRadius = 310;
  private mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private timeU = { value: 0 };

  constructor(scene: THREE.Scene) {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true);
    // 顶部渐隐 alphaMap: 墙顶硬边会在天上画出一个灰色圆罩(叠加混合+双面两层)
    const cv = document.createElement('canvas');
    cv.width = 1;
    cv.height = 64;
    const cx = cv.getContext('2d');
    if (cx) {
      const gr = cx.createLinearGradient(0, 0, 0, 64);
      gr.addColorStop(0, '#000000'); // canvas 顶 = 圆柱顶(v=1): 全透明
      gr.addColorStop(0.25, '#000000');
      gr.addColorStop(0.5, '#ffffff');
      gr.addColorStop(1, '#ffffff');
      cx.fillStyle = gr;
      cx.fillRect(0, 0, 1, 64);
    }
    const fadeTex = new THREE.CanvasTexture(cv);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x3f9fff, transparent: true, opacity: 0.16,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, alphaMap: fadeTex,
    });
    // 扫描线微光(time uniform; alphaMap 顶部渐隐保持生效)
    const timeU = this.timeU;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vWy;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWy = (modelMatrix * vec4(transformed, 1.0)).y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vWy;')
        .replace(
          '#include <alphamap_fragment>',
          `#include <alphamap_fragment>
  diffuseColor.a *= 0.78 + 0.22 * sin(vWy * 4.5 - uTime * 2.4);`,
        );
    };
    mat.customProgramCacheKey = () => 'zone-wall-shimmer';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.reset();
  }

  reset(): void {
    // 初始圈: 半径~310, 圆心随机偏移地图中心
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * 55;
    this.center.set(Math.cos(a) * d, Math.sin(a) * d);
    this.radius = 310;
    this.phase = 0;
    this.state = 'wait';
    this.timer = (PHASES[0] as Phase).wait;
    this.pickNext();
    this.syncMesh();
  }

  private pickNext(): void {
    const p = PHASES[this.phase] as Phase | undefined;
    if (!p) {
      this.nextCenter.copy(this.center);
      this.nextRadius = this.radius;
      return;
    }
    // 新圆心保证整个小圈在当前圈内
    const maxOff = Math.max(0, (this.radius - p.radius) * 0.75);
    const a = Math.random() * Math.PI * 2;
    const d = Math.random() * maxOff;
    this.nextCenter.set(this.center.x + Math.cos(a) * d, this.center.y + Math.sin(a) * d);
    this.nextRadius = p.radius;
  }

  get dps(): number {
    return DPS[Math.min(this.phase, DPS.length - 1)] as number;
  }

  isOutside(x: number, z: number): boolean {
    const dx = x - this.center.x;
    const dz = z - this.center.y;
    return dx * dx + dz * dz > this.radius * this.radius;
  }

  distOutside(x: number, z: number): number {
    const dx = x - this.center.x;
    const dz = z - this.center.y;
    return Math.sqrt(dx * dx + dz * dz) - this.radius;
  }

  update(dt: number): void {
    this.justBeganShrink = false;
    this.timeU.value += dt;
    if (this.state === 'done') return;
    this.timer -= dt;
    const p = PHASES[this.phase] as Phase | undefined;
    if (!p) {
      this.state = 'done';
      return;
    }
    if (this.state === 'wait') {
      if (this.timer <= 0) {
        this.state = 'shrink';
        this.timer = p.shrink;
        this.startCenter.copy(this.center);
        this.startRadius = this.radius;
        this.justBeganShrink = true;
      }
    } else {
      const t = 1 - Math.max(0, this.timer / p.shrink);
      this.center.set(
        lerp(this.startCenter.x, this.nextCenter.x, t),
        lerp(this.startCenter.y, this.nextCenter.y, t),
      );
      this.radius = lerp(this.startRadius, this.nextRadius, t);
      if (this.timer <= 0) {
        this.center.copy(this.nextCenter);
        this.radius = this.nextRadius;
        this.phase++;
        const np = PHASES[this.phase] as Phase | undefined;
        if (np) {
          this.state = 'wait';
          this.timer = np.wait;
          this.pickNext();
        } else {
          this.state = 'done';
        }
      }
    }
    this.syncMesh();
  }

  private syncMesh(): void {
    this.mesh.position.set(this.center.x, WALL_H / 2 - 2, this.center.y);
    this.mesh.scale.set(this.radius, WALL_H, this.radius);
  }

  // HUD 状态文案
  statusText(): string {
    if (this.state === 'wait') return `距离缩圈还有 ${Math.ceil(this.timer)}s`;
    if (this.state === 'shrink') return '正在缩圈！';
    return '最终圈';
  }

  // 随机圈内点(bots 用)
  randomPointInside(out: THREE.Vector2, scale = 0.6): THREE.Vector2 {
    const a = rand(0, Math.PI * 2);
    const d = Math.sqrt(Math.random()) * this.radius * scale;
    out.set(this.center.x + Math.cos(a) * d, this.center.y + Math.sin(a) * d);
    return out;
  }
}
