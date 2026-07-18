// 特效: 曳光弹 / 枪口火光 / 命中粒子(全部对象池, 零逐帧分配)
import * as THREE from 'three';

const TRACER_CAP = 48;
const FLASH_CAP = 8;
const PARTICLE_CAP = 768;

// 枪口火光: 四角星形(十字+斜芒)
function makeFlashTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.translate(32, 32);
  const spike = (rot: number, len: number, wid: number, alpha: number) => {
    g.rotate(rot);
    const grad = g.createLinearGradient(0, -wid, 0, wid);
    grad.addColorStop(0, 'rgba(255,240,200,0)');
    grad.addColorStop(0.5, `rgba(255,225,150,${alpha})`);
    grad.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = grad;
    g.fillRect(0, -wid, len, wid * 2);
    g.rotate(-rot);
  };
  for (let i = 0; i < 4; i++) spike((Math.PI / 2) * i, 30, 3.2, 1);
  for (let i = 0; i < 4; i++) spike((Math.PI / 2) * i + Math.PI / 4, 18, 2.0, 0.75);
  const core = g.createRadialGradient(0, 0, 0, 0, 0, 9);
  core.addColorStop(0, 'rgba(255,255,235,1)');
  core.addColorStop(1, 'rgba(255,180,80,0)');
  g.fillStyle = core;
  g.fillRect(-9, -9, 18, 18);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

// 烟雾纹理(灰白蓬松)
function makePuffTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(215,215,210,0.85)');
  grad.addColorStop(0.6, 'rgba(190,190,185,0.4)');
  grad.addColorStop(1, 'rgba(180,180,175,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// 渐变曳光几何体: 头亮尾暗(顶点色沿 z 衰减)
function makeTracerGeo(): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(0.03, 0.03, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const headC = new THREE.Color(1.0, 0.95, 0.75);
  const tailC = new THREE.Color(1.0, 0.55, 0.15);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getZ(i) + 0.5; // 头(z+0.5)→尾(z-0.5)
    tmp.copy(tailC).lerp(headC, t);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

interface Tracer {
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

interface Flash {
  sprite: THREE.Sprite;
  life: number;
}

interface ShockRing {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

interface SmokeCol {
  sprites: THREE.Sprite[];
  life: number;
  vy: number[];
}

export class Effects {
  private tracers: Tracer[] = [];
  private tracerIdx = 0;
  private flashes: Flash[] = [];
  private flashIdx = 0;
  private light: THREE.PointLight;
  private rings: ShockRing[] = [];
  private ringIdx = 0;
  private smokeCols: SmokeCol[] = [];
  private colIdx = 0;
  private puffTex: THREE.Texture;
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
    // 曳光弹池(渐变几何体: 头亮尾暗)
    const tGeo = makeTracerGeo();
    for (let i = 0; i < TRACER_CAP; i++) {
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0,
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

    // 冲击波环池(爆炸)
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffcf90, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.58, 32), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.rings.push({ mesh, life: 0 });
    }

    // 烟柱池(每柱 3 层 sprite, ~3s 上升)
    this.puffTex = makePuffTexture();
    for (let i = 0; i < 4; i++) {
      const sprites: THREE.Sprite[] = [];
      const vy: number[] = [];
      for (let k = 0; k < 3; k++) {
        const mat = new THREE.SpriteMaterial({
          map: this.puffTex, color: 0x8f8f8c, transparent: true, opacity: 0, depthWrite: false,
        });
        const sp = new THREE.Sprite(mat);
        sp.visible = false;
        scene.add(sp);
        sprites.push(sp);
        vy.push(1.2 + k * 0.5);
      }
      this.smokeCols.push({ sprites, life: 0, vy });
    }

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

  muzzleFlash(pos: THREE.Vector3, scale = 1): void {
    const f = this.flashes[this.flashIdx] as Flash;
    this.flashIdx = (this.flashIdx + 1) % FLASH_CAP;
    f.sprite.position.copy(pos);
    f.sprite.scale.setScalar((0.45 + Math.random() * 0.3) * scale);
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.sprite.material.opacity = 1;
    f.sprite.visible = true;
    f.life = 0.05;
    this.light.position.copy(pos);
    this.light.intensity = 30 * scale;
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

  /** 手雷爆炸: 闪光 + 冲击波环 + 泥土碎石 + 浓烟 + 火星 + 3s 烟柱 */
  explosion(p: THREE.Vector3): void {
    this.muzzleFlash(p, 5);
    // 冲击波环
    const ring = this.rings[this.ringIdx] as ShockRing;
    this.ringIdx = (this.ringIdx + 1) % this.rings.length;
    ring.mesh.position.copy(p);
    ring.mesh.position.y = Math.max(p.y + 0.15, 0.2);
    ring.mesh.scale.setScalar(1);
    ring.mesh.material.opacity = 0.85;
    ring.mesh.visible = true;
    ring.life = 0.45;
    // 烟柱(3 层, 3s)
    const col = this.smokeCols[this.colIdx] as SmokeCol;
    this.colIdx = (this.colIdx + 1) % this.smokeCols.length;
    col.life = 3;
    col.sprites.forEach((sp, k) => {
      sp.position.set(p.x + (Math.random() - 0.5) * 0.6, p.y + 0.6 + k * 0.9, p.z + (Math.random() - 0.5) * 0.6);
      sp.scale.setScalar(1.2 + k * 0.5);
      sp.material.opacity = 0.55;
      sp.material.rotation = Math.random() * Math.PI * 2;
      sp.visible = true;
    });
    this.burst(p, 26, 0.5, 0.38, 0.2, 7);      // 泥土碎块
    this.burst(p, 16, 0.35, 0.35, 0.38, 3.2);   // 浓烟
    this.burst(p, 10, 1.0, 0.75, 0.3, 9);       // 火星
  }

  // 水面溅射(白色喷沫)
  splash(p: THREE.Vector3): void {
    this.burst(p, 14, 0.85, 0.93, 1.0, 3.6);
  }

  // 岩石命中: 灰白碎屑 + 火星
  impactRock(p: THREE.Vector3): void {
    this.burst(p, 6, 0.72, 0.72, 0.7, 3.2);
    this.burst(p, 3, 1.0, 0.85, 0.45, 4.0);
  }

  update(dt: number): void {
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        t.mesh.material.opacity = Math.max(0, t.life / 0.07) * 0.95;
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
    // 冲击波环: 扩张 + 淡出
    for (const r of this.rings) {
      if (r.life > 0) {
        r.life -= dt;
        const t = 1 - Math.max(0, r.life) / 0.45;
        r.mesh.scale.setScalar(1 + t * 14);
        r.mesh.material.opacity = 0.85 * (1 - t);
        if (r.life <= 0) r.mesh.visible = false;
      }
    }
    // 烟柱: 上升 + 膨化 + 淡出
    for (const col of this.smokeCols) {
      if (col.life > 0) {
        col.life -= dt;
        const fade = Math.min(1, col.life / 1.2);
        col.sprites.forEach((sp, k) => {
          sp.position.y += (col.vy[k] as number) * dt * 0.55;
          sp.scale.addScalar(dt * 0.9);
          sp.material.opacity = 0.55 * fade;
          if (col.life <= 0) sp.visible = false;
        });
      }
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
    for (const r of this.rings) {
      r.life = 0;
      r.mesh.visible = false;
    }
    for (const col of this.smokeCols) {
      col.life = 0;
      for (const sp of col.sprites) sp.visible = false;
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
