// 特效: 曳光弹 / 枪口火光 / 命中粒子(全部对象池, 零逐帧分配)
import * as THREE from 'three';

const TRACER_CAP = 48;
const FLASH_CAP = 8;
const PARTICLE_CAP = 768;

function makeFlashTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,230,1)');
  grad.addColorStop(0.35, 'rgba(255,200,90,0.9)');
  grad.addColorStop(1, 'rgba(255,140,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

interface Tracer {
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

interface Flash {
  sprite: THREE.Sprite;
  life: number;
}

export class Effects {
  private tracers: Tracer[] = [];
  private tracerIdx = 0;
  private flashes: Flash[] = [];
  private flashIdx = 0;
  private light: THREE.PointLight;
  private points: THREE.Points;
  private pPos: Float32Array;
  private pCol: Float32Array;
  private pVel: Float32Array;
  private pLife: Float32Array;
  private pMaxLife: Float32Array;
  private pBaseCol: Float32Array;
  private pIdx = 0;
  private geoPos: THREE.BufferAttribute;
  private geoCol: THREE.BufferAttribute;

  constructor(scene: THREE.Scene) {
    // 曳光弹池
    const tGeo = new THREE.BoxGeometry(0.035, 0.035, 1);
    for (let i = 0; i < TRACER_CAP; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd27a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(tGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    // 枪口火光精灵池 + 共享点光源
    const tex = makeFlashTexture();
    for (let i = 0; i < FLASH_CAP; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.scale.setScalar(0.55);
      scene.add(sprite);
      this.flashes.push({ sprite, life: 0 });
    }
    this.light = new THREE.PointLight(0xffc873, 0, 14, 2);
    scene.add(this.light);

    // 粒子池(单个 Points)
    this.pPos = new Float32Array(PARTICLE_CAP * 3);
    this.pCol = new Float32Array(PARTICLE_CAP * 3);
    this.pVel = new Float32Array(PARTICLE_CAP * 3);
    this.pLife = new Float32Array(PARTICLE_CAP);
    this.pMaxLife = new Float32Array(PARTICLE_CAP);
    this.pBaseCol = new Float32Array(PARTICLE_CAP * 3);
    for (let i = 0; i < PARTICLE_CAP; i++) this.pPos[i * 3 + 1] = -999;
    const geo = new THREE.BufferGeometry();
    this.geoPos = new THREE.BufferAttribute(this.pPos, 3);
    this.geoCol = new THREE.BufferAttribute(this.pCol, 3);
    geo.setAttribute('position', this.geoPos);
    geo.setAttribute('color', this.geoCol);
    const mat = new THREE.PointsMaterial({
      size: 0.1, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    const t = this.tracers[this.tracerIdx] as Tracer;
    this.tracerIdx = (this.tracerIdx + 1) % TRACER_CAP;
    const m = t.mesh;
    m.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
    m.lookAt(to);
    const len = from.distanceTo(to);
    m.scale.set(1, 1, Math.max(len, 0.1));
    m.material.color.setHex(color);
    m.material.opacity = 0.9;
    m.visible = true;
    t.life = 0.07;
  }

  muzzleFlash(pos: THREE.Vector3): void {
    const f = this.flashes[this.flashIdx] as Flash;
    this.flashIdx = (this.flashIdx + 1) % FLASH_CAP;
    f.sprite.position.copy(pos);
    f.sprite.scale.setScalar(0.45 + Math.random() * 0.3);
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.sprite.material.opacity = 1;
    f.sprite.visible = true;
    f.life = 0.05;
    this.light.position.copy(pos);
    this.light.intensity = 30;
  }

  burst(point: THREE.Vector3, n: number, r: number, g: number, b: number, speed: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.pIdx;
      this.pIdx = (this.pIdx + 1) % PARTICLE_CAP;
      this.pPos[i * 3] = point.x;
      this.pPos[i * 3 + 1] = point.y;
      this.pPos[i * 3 + 2] = point.z;
      // 半球随机速度
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.9 + 0.15;
      const sp = speed * (0.4 + Math.random() * 0.8);
      const hr = Math.sqrt(Math.max(0, 1 - up * up));
      this.pVel[i * 3] = Math.cos(a) * hr * sp;
      this.pVel[i * 3 + 1] = up * sp;
      this.pVel[i * 3 + 2] = Math.sin(a) * hr * sp;
      const life = 0.3 + Math.random() * 0.35;
      this.pLife[i] = life;
      this.pMaxLife[i] = life;
      this.pBaseCol[i * 3] = r * (0.7 + Math.random() * 0.5);
      this.pBaseCol[i * 3 + 1] = g * (0.7 + Math.random() * 0.5);
      this.pBaseCol[i * 3 + 2] = b * (0.7 + Math.random() * 0.5);
    }
  }

  impactDust(p: THREE.Vector3): void { this.burst(p, 9, 0.62, 0.55, 0.42, 2.4); }
  impactSpark(p: THREE.Vector3): void { this.burst(p, 7, 1.0, 0.8, 0.35, 4.2); }
  impactBlood(p: THREE.Vector3): void { this.burst(p, 10, 0.75, 0.08, 0.06, 2.6); }
  // 木门窗: 子弹命中木屑
  impactWood(p: THREE.Vector3): void { this.burst(p, 8, 0.55, 0.4, 0.22, 2.8); }
  // 玻璃: 子弹命中碎屑
  impactGlass(p: THREE.Vector3): void { this.burst(p, 8, 0.75, 0.9, 0.95, 3.2); }
  // 门板/玻璃彻底破碎: 大量碎块
  debrisWood(p: THREE.Vector3): void { this.burst(p, 22, 0.5, 0.36, 0.2, 4.5); }
  debrisGlass(p: THREE.Vector3): void { this.burst(p, 22, 0.8, 0.92, 0.98, 4.5); }

  update(dt: number): void {
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        t.mesh.material.opacity = Math.max(0, t.life / 0.07) * 0.9;
        if (t.life <= 0) t.mesh.visible = false;
      }
    }
    for (const f of this.flashes) {
      if (f.life > 0) {
        f.life -= dt;
        f.sprite.material.opacity = Math.max(0, f.life / 0.05);
        if (f.life <= 0) f.sprite.visible = false;
      }
    }
    if (this.light.intensity > 0) {
      this.light.intensity = Math.max(0, this.light.intensity - dt * 380);
    }
    // 粒子
    let any = false;
    for (let i = 0; i < PARTICLE_CAP; i++) {
      if (this.pLife[i] <= 0) continue;
      any = true;
      this.pLife[i] = (this.pLife[i] as number) - dt;
      if (this.pLife[i] <= 0) {
        this.pPos[i * 3 + 1] = -999;
        this.pCol[i * 3] = 0;
        this.pCol[i * 3 + 1] = 0;
        this.pCol[i * 3 + 2] = 0;
        continue;
      }
      this.pVel[i * 3 + 1] = (this.pVel[i * 3 + 1] as number) - 7.5 * dt;
      this.pPos[i * 3] = (this.pPos[i * 3] as number) + (this.pVel[i * 3] as number) * dt;
      this.pPos[i * 3 + 1] = (this.pPos[i * 3 + 1] as number) + (this.pVel[i * 3 + 1] as number) * dt;
      this.pPos[i * 3 + 2] = (this.pPos[i * 3 + 2] as number) + (this.pVel[i * 3 + 2] as number) * dt;
      const f = (this.pLife[i] as number) / (this.pMaxLife[i] as number);
      this.pCol[i * 3] = (this.pBaseCol[i * 3] as number) * f;
      this.pCol[i * 3 + 1] = (this.pBaseCol[i * 3 + 1] as number) * f;
      this.pCol[i * 3 + 2] = (this.pBaseCol[i * 3 + 2] as number) * f;
    }
    if (any) {
      this.geoPos.needsUpdate = true;
      this.geoCol.needsUpdate = true;
    }
  }

  reset(): void {
    for (const t of this.tracers) {
      t.life = 0;
      t.mesh.visible = false;
    }
    for (const f of this.flashes) {
      f.life = 0;
      f.sprite.visible = false;
    }
    this.light.intensity = 0;
    for (let i = 0; i < PARTICLE_CAP; i++) {
      this.pLife[i] = 0;
      this.pPos[i * 3 + 1] = -999;
      this.pCol[i * 3] = 0;
      this.pCol[i * 3 + 1] = 0;
      this.pCol[i * 3 + 2] = 0;
    }
    this.geoPos.needsUpdate = true;
    this.geoCol.needsUpdate = true;
  }
}
