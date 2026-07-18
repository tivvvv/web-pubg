// ─────────────────────────────────────────────────────────────────────────────
// throwables.ts — 投掷物: 手雷/烟雾弹的弹道模拟(对象池)、轨迹预览、烟雾云与 LOS 遮挡
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import type { Character } from './character';
import type { ThrowableId } from './types';
import type { World } from './world';
import type { Game } from './game';
import { buildWeaponModel } from './weaponmodels';

const MAX_GRENADES = 12;      // 活动投掷物上限
const MAX_CLOUDS = 4;         // 同时烟幕上限
const SPRITES_PER_CLOUD = 16;
const GRAV = 22;              // 与角色重力一致
const RESTITUTION = 0.45;     // 法向弹性
const PREVIEW_DOTS = 20;
const SMOKE_TIME = 25;        // 烟幕总时长(含 3s 消散)
const SMOKE_R = 7;

// 单步推进(重力 + 地形/AABB/圆柱反弹), 真实模拟与轨迹预览共用同一物理
export function stepProjectile(w: World, pos: THREE.Vector3, vel: THREE.Vector3, dt: number): boolean {
  vel.y -= GRAV * dt;
  pos.addScaledVector(vel, dt);
  let bounced = false;

  // 地形(梯度法线反弹)
  const g = w.getHeight(pos.x, pos.z);
  if (pos.y < g + 0.04) {
    pos.y = g + 0.04;
    const hx = w.getHeight(pos.x + 0.4, pos.z) - w.getHeight(pos.x - 0.4, pos.z);
    const hz = w.getHeight(pos.x, pos.z + 0.4) - w.getHeight(pos.x, pos.z - 0.4);
    let nx = -hx / 0.8;
    let nz = -hz / 0.8;
    const nl = Math.hypot(nx, 1, nz);
    nx /= nl;
    const ny = 1 / nl;
    nz /= nl;
    const vn = vel.x * nx + vel.y * ny + vel.z * nz;
    if (vn < 0) {
      vel.x -= (1 + RESTITUTION) * vn * nx;
      vel.y -= (1 + RESTITUTION) * vn * ny;
      vel.z -= (1 + RESTITUTION) * vn * nz;
      vel.x *= 0.72; // 切向阻尼
      vel.z *= 0.72;
      bounced = true;
    }
  }

  // AABB(墙/地板/屋顶/门窗): 点扩 0.04, 最小穿透轴反弹
  for (const b of w.aabbs) {
    if (b.off) continue;
    if (pos.x < b.minX - 0.04 || pos.x > b.maxX + 0.04) continue;
    if (pos.y < b.minY - 0.04 || pos.y > b.maxY + 0.04) continue;
    if (pos.z < b.minZ - 0.04 || pos.z > b.maxZ + 0.04) continue;
    const px1 = pos.x - (b.minX - 0.04), px2 = (b.maxX + 0.04) - pos.x;
    const py1 = pos.y - (b.minY - 0.04), py2 = (b.maxY + 0.04) - pos.y;
    const pz1 = pos.z - (b.minZ - 0.04), pz2 = (b.maxZ + 0.04) - pos.z;
    const mx = Math.min(px1, px2), my = Math.min(py1, py2), mz = Math.min(pz1, pz2);
    if (mx < my && mx < mz) {
      pos.x = px1 < px2 ? b.minX - 0.04 : b.maxX + 0.04;
      vel.x = -vel.x * RESTITUTION;
      vel.y *= 0.8;
      vel.z *= 0.8;
    } else if (my < mz) {
      pos.y = py1 < py2 ? b.minY - 0.04 : b.maxY + 0.04;
      vel.y = -vel.y * RESTITUTION;
      vel.x *= 0.8;
      vel.z *= 0.8;
    } else {
      pos.z = pz1 < pz2 ? b.minZ - 0.04 : b.maxZ + 0.04;
      vel.z = -vel.z * RESTITUTION;
      vel.x *= 0.8;
      vel.y *= 0.8;
    }
    bounced = true;
  }

  // 树/石圆柱: 水平推开 + 反射
  for (const c of w.cyls) {
    if (pos.y < c.y0 || pos.y > c.y1) continue;
    const dx = pos.x - c.x;
    const dz = pos.z - c.z;
    const rr = c.r + 0.04;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr || d2 < 1e-8) continue;
    const d = Math.sqrt(d2);
    const nx = dx / d;
    const nz = dz / d;
    pos.x = c.x + nx * rr;
    pos.z = c.z + nz * rr;
    const vn = vel.x * nx + vel.z * nz;
    if (vn < 0) {
      vel.x -= (1 + RESTITUTION) * vn * nx;
      vel.z -= (1 + RESTITUTION) * vn * nz;
    }
    bounced = true;
  }
  return bounced;
}

interface GrenadeSlot {
  active: boolean;
  kind: ThrowableId;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  thrower: Character | null;
  fuse: number;      // 手雷引信(出手起算)
  age: number;       // 出手至今
  bounceAge: number; // 首次反弹时的 age
  bounced: boolean;
  rest: boolean;
  restT: number;
  popped: boolean;   // 烟雾弹已起烟
  group: THREE.Group;
  fragMesh: THREE.Group;
  smokeMesh: THREE.Group;
}

interface Cloud {
  active: boolean;
  pos: THREE.Vector3;
  t: number;         // 剩余时间
  r: number;
  drift: THREE.Vector3;
  seed: Float32Array; // 每 sprite 4 个随机数
}

function makeSmokeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.75)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class GrenadeManager {
  private slots: GrenadeSlot[] = [];
  private nextIdx = 0;
  private clouds: Cloud[] = [];
  private nextCloud = 0;
  private sprites: THREE.Sprite[] = [];
  // 轨迹预览
  private dots: THREE.Points;
  private dotPos: Float32Array;
  private dotAttr: THREE.BufferAttribute;
  private ring: THREE.Mesh;
  private tmpO = new THREE.Vector3();
  private tmpP = new THREE.Vector3();
  private tmpV = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const fragProto = buildWeaponModel('frag');
    const smokeProto = buildWeaponModel('smoke');
    for (let i = 0; i < MAX_GRENADES; i++) {
      const group = new THREE.Group();
      const fragMesh = fragProto.group.clone(true);
      const smokeMesh = smokeProto.group.clone(true);
      group.add(fragMesh);
      group.add(smokeMesh);
      group.visible = false;
      scene.add(group);
      this.slots.push({
        active: false, kind: 'frag', pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        thrower: null, fuse: 0, age: 0, bounceAge: 0, bounced: false, rest: false, restT: 0,
        popped: false, group, fragMesh, smokeMesh,
      });
    }
    // 烟幕 sprite 池
    const tex = makeSmokeTexture();
    for (let c = 0; c < MAX_CLOUDS; c++) {
      this.clouds.push({
        active: false, pos: new THREE.Vector3(), t: 0, r: 0,
        drift: new THREE.Vector3(), seed: new Float32Array(SPRITES_PER_CLOUD * 4),
      });
      for (let s = 0; s < SPRITES_PER_CLOUD; s++) {
        const mat = new THREE.SpriteMaterial({
          map: tex, color: 0x9aa2a8, transparent: true, opacity: 0, depthWrite: false,
        });
        const sp = new THREE.Sprite(mat);
        sp.visible = false;
        scene.add(sp);
        this.sprites.push(sp);
      }
    }
    // 预览: 20 个虚线点 + 落点环
    this.dotPos = new Float32Array(PREVIEW_DOTS * 3);
    const geo = new THREE.BufferGeometry();
    this.dotAttr = new THREE.BufferAttribute(this.dotPos, 3);
    geo.setAttribute('position', this.dotAttr);
    this.dots = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.13, transparent: true, opacity: 0.9, depthWrite: false, sizeAttenuation: true,
    }));
    this.dots.frustumCulled = false;
    this.dots.visible = false;
    scene.add(this.dots);
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.45, 0.035, 8, 32),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    scene.add(this.ring);
  }

  reset(): void {
    for (const s of this.slots) {
      s.active = false;
      s.group.visible = false;
    }
    for (const c of this.clouds) c.active = false;
    for (const sp of this.sprites) sp.visible = false;
    this.hidePreview();
  }

  // 出手一颗投掷物(dir 需为单位向量)
  spawn(thrower: Character, kind: ThrowableId, origin: THREE.Vector3, dir: THREE.Vector3, speed: number): void {
    const s = this.slots[this.nextIdx] as GrenadeSlot;
    this.nextIdx = (this.nextIdx + 1) % MAX_GRENADES;
    s.active = true;
    s.kind = kind;
    s.pos.copy(origin);
    s.vel.copy(dir).multiplyScalar(speed);
    s.thrower = thrower;
    s.fuse = 3.5;
    s.age = 0;
    s.bounceAge = 0;
    s.bounced = false;
    s.rest = false;
    s.restT = 0;
    s.popped = false;
    s.fragMesh.visible = kind === 'frag';
    s.smokeMesh.visible = kind === 'smoke';
    s.group.visible = true;
    s.group.position.copy(origin);
  }

  // 最近的未爆手雷(bot 自保逃跑用)
  nearestLiveFrag(x: number, y: number, z: number, maxDist: number, out: { x: number; z: number }): boolean {
    let best = maxDist * maxDist;
    let found = false;
    for (const s of this.slots) {
      if (!s.active || s.kind !== 'frag') continue;
      const dx = s.pos.x - x;
      const dy = s.pos.y - y;
      const dz = s.pos.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) {
        best = d2;
        out.x = s.pos.x;
        out.z = s.pos.z;
        found = true;
      }
    }
    return found;
  }

  // 烟幕球遮挡视线(线段-球求交)
  blocksLOS(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const len2 = abx * abx + aby * aby + abz * abz;
    for (const c of this.clouds) {
      if (!c.active || c.t < 3) continue; // 消散期不再遮挡
      const r = c.r * 0.92;
      if (r < 1.5) continue;
      let t = 0;
      if (len2 > 1e-8) {
        t = ((c.pos.x - a.x) * abx + (c.pos.y - a.y) * aby + (c.pos.z - a.z) * abz) / len2;
        t = Math.max(0, Math.min(1, t));
      }
      const px = a.x + abx * t - c.pos.x;
      const py = a.y + aby * t - (c.pos.y + c.r * 0.4); // 云心略偏上
      const pz = a.z + abz * t - c.pos.z;
      if (px * px + py * py + pz * pz < r * r) return true;
    }
    return false;
  }

  // 玩家按住左键: 以相同物理预演 ~1.2s, 20 点虚线 + 落点环
  showPreview(world: World, origin: THREE.Vector3, dir: THREE.Vector3, speed: number): void {
    this.tmpP.copy(origin);
    this.tmpV.copy(dir).multiplyScalar(speed);
    let n = 0;
    for (let step = 0; step < 72 && n < PREVIEW_DOTS; step++) {
      stepProjectile(world, this.tmpP, this.tmpV, 1 / 60);
      if (step % 3 === 2) {
        this.dotPos[n * 3] = this.tmpP.x;
        this.dotPos[n * 3 + 1] = this.tmpP.y;
        this.dotPos[n * 3 + 2] = this.tmpP.z;
        n++;
      }
      if (this.tmpV.lengthSq() < 0.2) break;
    }
    if (n === 0) {
      this.dotPos[0] = this.tmpP.x;
      this.dotPos[1] = this.tmpP.y;
      this.dotPos[2] = this.tmpP.z;
      n = 1;
    }
    this.dotAttr.needsUpdate = true;
    this.dots.geometry.setDrawRange(0, n);
    this.dots.visible = true;
    this.ring.position.set(this.tmpP.x, this.tmpP.y + 0.06, this.tmpP.z);
    this.ring.visible = true;
  }

  hidePreview(): void {
    this.dots.visible = false;
    this.ring.visible = false;
  }

  update(dt: number, game: Game): void {
    const steps = Math.max(1, Math.min(6, Math.ceil(dt / (1 / 120))));
    const sdt = dt / steps;
    for (const s of this.slots) {
      if (!s.active) continue;
      s.age += dt;
      // 手雷引信
      if (s.kind === 'frag') {
        s.fuse -= dt;
        if (s.fuse <= 0) {
          this.explode(s, game);
          s.active = false;
          s.group.visible = false;
          continue;
        }
      }
      // 运动
      if (!s.rest) {
        let bounced = false;
        for (let k = 0; k < steps; k++) {
          if (stepProjectile(game.world, s.pos, s.vel, sdt)) bounced = true;
        }
        if (bounced && !s.bounced) {
          s.bounced = true;
          s.bounceAge = s.age;
        }
        // 静止检测
        if (s.vel.lengthSq() < 0.14) {
          s.restT += dt;
          s.vel.multiplyScalar(Math.max(0, 1 - 8 * dt));
          if (s.restT > 0.3) {
            s.rest = true;
            s.vel.set(0, 0, 0);
          }
        } else {
          s.restT = 0;
        }
        // 飞行/滚动自旋
        s.group.rotation.x += dt * 5;
        s.group.rotation.z += dt * 3;
      }
      s.group.position.copy(s.pos);
      // 烟雾弹起烟: 静止或首次反弹 1.5s 后
      if (s.kind === 'smoke' && !s.popped) {
        if (s.rest || (s.bounced && s.age - s.bounceAge > 1.5)) {
          s.popped = true;
          this.popSmoke(s, game);
        }
      }
    }
    // 烟幕生长/漂移/消散
    for (const c of this.clouds) {
      if (!c.active) continue;
      c.t -= dt;
      if (c.t <= 0) {
        c.active = false;
      }
      const lifeT = SMOKE_TIME - c.t;
      const grow = Math.min(1, lifeT / 2.5);
      c.r = SMOKE_R * grow;
      c.pos.addScaledVector(c.drift, dt);
      const idx = this.clouds.indexOf(c);
      const alpha = 0.36 * Math.min(1, lifeT / 1.2) * Math.max(0, Math.min(1, c.t / 3));
      for (let i = 0; i < SPRITES_PER_CLOUD; i++) {
        const sp = this.sprites[idx * SPRITES_PER_CLOUD + i] as THREE.Sprite;
        if (!c.active) {
          sp.visible = false;
          continue;
        }
        const jx = c.seed[i * 4] as number;
        const jy = c.seed[i * 4 + 1] as number;
        const jz = c.seed[i * 4 + 2] as number;
        const js = c.seed[i * 4 + 3] as number;
        const rr = c.r * 0.75;
        sp.position.set(
          c.pos.x + jx * rr + Math.sin(lifeT * 0.5 + i) * 0.3,
          c.pos.y + 0.3 + (jy + 0.5) * c.r * 0.35,
          c.pos.z + jz * rr + Math.cos(lifeT * 0.4 + i * 1.7) * 0.3,
        );
        sp.scale.setScalar(c.r * (0.72 + js * 0.4));
        sp.material.opacity = alpha * (0.75 + js * 0.25);
        sp.visible = true;
      }
    }
  }

  private popSmoke(s: GrenadeSlot, game: Game): void {
    const c = this.clouds[this.nextCloud] as Cloud;
    this.nextCloud = (this.nextCloud + 1) % MAX_CLOUDS;
    c.active = true;
    c.pos.copy(s.pos);
    c.t = SMOKE_TIME;
    c.r = 0.5;
    c.drift.set((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5);
    for (let i = 0; i < c.seed.length; i++) c.seed[i] = Math.random() * 2 - 1;
    game.soundAt(s.pos, (d, p) => game.audio.hiss(d, p));
  }

  private explode(s: GrenadeSlot, game: Game): void {
    game.effects.explosion(s.pos);
    game.soundAt(s.pos, (d, p) => game.audio.explosion(d, p));
    game.addShakeFrom(s.pos);
    // 伤害: 中心 110 → 9m 处 15, 不分敌我(含投掷者); 小队爆炸免伤
    for (const c of game.chars) {
      if (!c.alive) continue;
      if (s.thrower && s.thrower.team === 'squad' && c.team === 'squad') continue;
      const dx = c.pos.x - s.pos.x;
      const dy = c.pos.y + 0.9 - s.pos.y;
      const dz = c.pos.z - s.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 9) continue;
      const dmg = 110 - 95 * (d / 9);
      game.damageChar(c, dmg, false, s.thrower, '手雷', true); // 爆炸无视护甲
    }
    // 载具: 重伤害(近点 320 → 远点 40)
    for (const v of game.vehicles.list) {
      const d = Math.hypot(v.pos.x - s.pos.x, v.pos.y + 0.6 - s.pos.y, v.pos.z - s.pos.z);
      if (d > 9) continue;
      game.vehicles.damage(v, 320 - 280 * (d / 9));
    }
    // 5m 内门窗全部摧毁
    for (const dst of game.world.buildings.destructibles) {
      if (!dst.alive) continue;
      const d = Math.hypot(dst.cx - s.pos.x, dst.cy - s.pos.y, dst.cz - s.pos.z);
      if (d < 5) {
        this.tmpO.set(dst.cx, dst.cy, dst.cz);
        game.hitDestructible(dst, 999, this.tmpO);
      }
    }
  }
}
