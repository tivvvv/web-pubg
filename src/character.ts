// 低多边形人形角色(玩家与 bot 共用) + 背包物品 + 命中体
import * as THREE from 'three';
import type { AmmoType, GunState, MeleeState } from './types';
import { MELEE } from './weapons';
import type { World } from './world';

export interface HumanParts {
  inner: THREE.Group;   // 模型根(bob/倒地旋转)
  torso: THREE.Mesh;
  head: THREE.Mesh;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  gun: THREE.Group;      // 枪械锚点
  gunBody: THREE.Mesh;
  gunMag: THREE.Mesh;
  knife: THREE.Group;    // 砍刀(挂在手部锚点)
  muzzle: THREE.Object3D;
}

// 共享几何体(跨对局复用, 重开不泄漏)
const GEO = {
  head: new THREE.BoxGeometry(0.3, 0.32, 0.3),
  helmet: new THREE.BoxGeometry(0.34, 0.14, 0.34),
  torso: new THREE.BoxGeometry(0.52, 0.62, 0.3),
  arm: new THREE.BoxGeometry(0.14, 0.56, 0.14),
  leg: new THREE.BoxGeometry(0.17, 0.74, 0.17),
  gunBody: new THREE.BoxGeometry(0.07, 0.15, 0.64),
  gunMag: new THREE.BoxGeometry(0.05, 0.16, 0.09),
  blade: new THREE.BoxGeometry(0.035, 0.02, 0.48),
  knifeGuard: new THREE.BoxGeometry(0.09, 0.03, 0.04),
  knifeHandle: new THREE.BoxGeometry(0.045, 0.045, 0.14),
};

const MAT = {
  skin: new THREE.MeshLambertMaterial({ color: 0xd9a066 }),
  pants: new THREE.MeshLambertMaterial({ color: 0x3d4436 }),
  helmet: new THREE.MeshLambertMaterial({ color: 0x4a5240 }),
  gun: new THREE.MeshLambertMaterial({ color: 0x22231f }),
  blade: new THREE.MeshLambertMaterial({ color: 0xc8ccd4 }),
  knifeHandle: new THREE.MeshLambertMaterial({ color: 0x5a3a22 }),
};

const shirtCache = new Map<number, THREE.MeshLambertMaterial>();
function shirtMat(color: number): THREE.MeshLambertMaterial {
  let m = shirtCache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    shirtCache.set(color, m);
  }
  return m;
}

export function buildHumanoid(shirtColor: number): { group: THREE.Group; parts: HumanParts } {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  group.add(inner);
  const shirt = shirtMat(shirtColor);

  const torso = new THREE.Mesh(GEO.torso, shirt);
  torso.position.set(0, 1.05, 0);
  torso.castShadow = true;
  inner.add(torso);

  const head = new THREE.Mesh(GEO.head, MAT.skin);
  head.position.set(0, 1.53, 0);
  head.castShadow = true;
  inner.add(head);
  const helmet = new THREE.Mesh(GEO.helmet, MAT.helmet);
  helmet.position.set(0, 1.72, 0);
  inner.add(helmet);

  // 手臂: 肩部枢轴, 前平举持械
  const armL = new THREE.Group();
  armL.position.set(-0.33, 1.32, 0);
  const armLMesh = new THREE.Mesh(GEO.arm, shirt);
  armLMesh.position.set(0, -0.26, 0);
  armLMesh.castShadow = true;
  armL.add(armLMesh);
  armL.rotation.x = -1.15;
  armL.rotation.z = 0.25;
  inner.add(armL);

  const armR = new THREE.Group();
  armR.position.set(0.33, 1.32, 0);
  const armRMesh = new THREE.Mesh(GEO.arm, shirt);
  armRMesh.position.set(0, -0.26, 0);
  armRMesh.castShadow = true;
  armR.add(armRMesh);
  armR.rotation.x = -1.3;
  armR.rotation.z = -0.1;
  inner.add(armR);

  // 腿: 髋部枢轴
  const legL = new THREE.Group();
  legL.position.set(-0.13, 0.74, 0);
  const legLMesh = new THREE.Mesh(GEO.leg, MAT.pants);
  legLMesh.position.set(0, -0.37, 0);
  legLMesh.castShadow = true;
  legL.add(legLMesh);
  inner.add(legL);

  const legR = new THREE.Group();
  legR.position.set(0.13, 0.74, 0);
  const legRMesh = new THREE.Mesh(GEO.leg, MAT.pants);
  legRMesh.position.set(0, -0.37, 0);
  legRMesh.castShadow = true;
  legR.add(legRMesh);
  inner.add(legR);

  // 手部锚点(枪械/砍刀挂载, 指向 +Z 前方)
  const gun = new THREE.Group();
  gun.position.set(0.19, 1.26, 0.34);
  const gunBody = new THREE.Mesh(GEO.gunBody, MAT.gun);
  gunBody.castShadow = true;
  gun.add(gunBody);
  const gunMag = new THREE.Mesh(GEO.gunMag, MAT.gun);
  gunMag.position.set(0, -0.12, 0.05);
  gun.add(gunMag);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, 0.38);
  gun.add(muzzle);
  // 砍刀
  const knife = new THREE.Group();
  const blade = new THREE.Mesh(GEO.blade, MAT.blade);
  blade.position.set(0, 0.02, 0.3);
  blade.castShadow = true;
  knife.add(blade);
  const guard = new THREE.Mesh(GEO.knifeGuard, MAT.gun);
  guard.position.set(0, 0.02, 0.06);
  knife.add(guard);
  const handle = new THREE.Mesh(GEO.knifeHandle, MAT.knifeHandle);
  handle.position.set(0, 0.02, -0.04);
  knife.add(handle);
  knife.visible = false;
  gun.add(knife);
  inner.add(gun);

  return { group, parts: { inner, torso, head, armL, armR, legL, legR, gun, gunBody, gunMag, knife, muzzle } };
}

export interface HitTestResult {
  t: number;
  head: boolean;
}

export class Character {
  static nextId = 1;
  readonly id: number;
  readonly name: string;
  readonly isPlayer: boolean;
  readonly radius = 0.42;
  readonly pos = new THREE.Vector3();
  yaw = 0;
  vy = 0;
  grounded = true;
  hp = 100;
  alive = true;
  speed2d = 0;
  walkPhase = 0;

  // ---- 背包 ----
  guns: (GunState | null)[] = [null, null, null]; // 0/1 主武器, 2 手枪
  melee: MeleeState = { def: MELEE.fists };        // 近战(默认拳头)
  ammo: Record<AmmoType, number> = { pistol: 0, rifle: 0, smg: 0, sniper: 0 };
  medkits = 0;
  curSlot = 3; // 0/1 主武器, 2 手枪, 3 近战

  swingT = 0;          // 挥击动画进度(1→0)
  lastMeleeT = -100;   // 上次挥击时间
  dieT = -1;           // >=0 表示死亡动画进度
  lastAttackerId = 0;
  lastShotT = -100;    // 最近一次开枪时间(小地图红点)
  kills = 0;

  readonly group: THREE.Group;
  readonly parts: HumanParts;

  constructor(name: string, isPlayer: boolean, shirtColor: number) {
    this.id = Character.nextId++;
    this.name = name;
    this.isPlayer = isPlayer;
    const { group, parts } = buildHumanoid(shirtColor);
    this.group = group;
    this.parts = parts;
  }

  heldGun(): GunState | null {
    return this.curSlot < 3 ? this.guns[this.curSlot] : null;
  }

  hasGun(): boolean {
    return this.guns[0] !== null || this.guns[1] !== null || this.guns[2] !== null;
  }

  // 品级最高的枪所在栏位(bot 用), 无枪返回 -1
  bestGunSlot(): number {
    let best = -1;
    let tier = 0;
    for (let i = 0; i < 3; i++) {
      const g = this.guns[i];
      if (g && g.def.tier > tier) {
        tier = g.def.tier;
        best = i;
      }
    }
    return best;
  }

  eyePos(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + 1.58, this.pos.z);
  }

  chestPos(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + 1.15, this.pos.z);
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.parts.muzzle.getWorldPosition(out);
  }

  // 通用位移: 水平速度 + 重力 + 地面/碰撞
  applyMove(vx: number, vz: number, dt: number, world: World): void {
    this.pos.x += vx * dt;
    this.pos.z += vz * dt;
    this.vy -= 22 * dt;
    this.pos.y += this.vy * dt;
    world.resolveCollision(this.pos, this.radius);
    const ground = world.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.1);
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.vy = 0;
      this.grounded = true;
    } else {
      this.grounded = this.pos.y - ground < 0.05;
    }
    this.speed2d = Math.sqrt(vx * vx + vz * vz);
  }

  // 模型同步: 位置/朝向/持械可见性/挥击/走路摆动/倒地
  syncModel(dt: number, moving: boolean): void {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    const p = this.parts;
    // 持械可见性
    const gunVisible = this.curSlot < 3 && this.guns[this.curSlot] !== null;
    p.gunBody.visible = gunVisible;
    p.gunMag.visible = gunVisible;
    p.knife.visible = this.curSlot === 3 && this.melee.def.id === 'knife';
    if (!this.alive) {
      if (this.dieT >= 0 && this.dieT < 1) {
        this.dieT = Math.min(1, this.dieT + dt * 2.4);
        const e = 1 - (1 - this.dieT) * (1 - this.dieT);
        p.inner.rotation.x = -Math.PI / 2 * e;
        p.inner.position.y = 0.15 * e;
      }
      return;
    }
    // 挥击动画(覆盖右臂姿态)
    if (this.swingT > 0) {
      this.swingT = Math.max(0, this.swingT - dt * 3.4);
      p.armR.rotation.x = -1.3 - Math.sin(this.swingT * Math.PI) * 1.15;
    } else {
      p.armR.rotation.x = -1.3;
    }
    if (moving && this.speed2d > 0.3) {
      this.walkPhase += dt * (2.0 + this.speed2d * 1.6);
      const s = Math.sin(this.walkPhase);
      p.legL.rotation.x = s * 0.72;
      p.legR.rotation.x = -s * 0.72;
      p.inner.position.y = Math.abs(Math.cos(this.walkPhase)) * 0.055;
    } else {
      p.legL.rotation.x *= 1 - Math.min(1, dt * 10);
      p.legR.rotation.x *= 1 - Math.min(1, dt * 10);
      p.inner.position.y *= 1 - Math.min(1, dt * 10);
    }
  }

  // 解析命中: 头部球体 + 身体有向盒(随 yaw 旋转), 命中填充 res 并返回 true
  hitTest(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxT: number, res: HitTestResult,
  ): boolean {
    let bestT = maxT;
    let head = false;
    // 头部球体: 中心 pos+(0,1.55,0), r=0.26
    const hx = this.pos.x - ox;
    const hy = this.pos.y + 1.55 - oy;
    const hz = this.pos.z - oz;
    const bHalf = hx * dx + hy * dy + hz * dz; // |d|=1
    const cSq = hx * hx + hy * hy + hz * hz - 0.26 * 0.26;
    if (cSq > 0 && bHalf > 0) {
      const disc = bHalf * bHalf - cSq;
      if (disc >= 0) {
        const t = bHalf - Math.sqrt(disc);
        if (t > 0 && t < bestT) {
          bestT = t;
          head = true;
        }
      }
    }
    // 身体 OBB: 中心 pos+(0,0.78,0), 半尺寸 (0.3, 0.78, 0.22), 绕 Y 旋转 yaw
    // 局部系 = R_y(-yaw) * (p - c): x'=x·cosY - z·sinY, z'=x·sinY + z·cosY
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    const lox0 = ox - this.pos.x;
    const loz0 = oz - this.pos.z;
    const lox = lox0 * cosY - loz0 * sinY;
    const loz = lox0 * sinY + loz0 * cosY;
    const ldx = dx * cosY - dz * sinY;
    const ldz = dx * sinY + dz * cosY;
    const loy = oy - (this.pos.y + 0.78);
    // slab
    let tmin = 0;
    let tmax = bestT;
    let ok = true;
    // x
    if (Math.abs(ldx) < 1e-9) {
      if (lox < -0.3 || lox > 0.3) ok = false;
    } else {
      let t1 = (-0.3 - lox) / ldx;
      let t2 = (0.3 - lox) / ldx;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) ok = false;
    }
    // y
    if (ok) {
      if (Math.abs(dy) < 1e-9) {
        if (loy < -0.78 || loy > 0.78) ok = false;
      } else {
        let t1 = (-0.78 - loy) / dy;
        let t2 = (0.78 - loy) / dy;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) ok = false;
      }
    }
    // z
    if (ok) {
      if (Math.abs(ldz) < 1e-9) {
        if (loz < -0.22 || loz > 0.22) ok = false;
      } else {
        let t1 = (-0.22 - loz) / ldz;
        let t2 = (0.22 - loz) / ldz;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) ok = false;
      }
    }
    if (ok && tmin > 0 && tmin < bestT) {
      bestT = tmin;
      head = false;
    }
    if (bestT >= maxT) return false;
    res.t = bestT;
    res.head = head;
    return true;
  }
}

export const BOT_SHIRTS = [
  0xb3413c, 0x3c6db3, 0x3cb36a, 0xb39a3c, 0x8a3cb3,
  0x3cb3a5, 0xb3623c, 0x6db33c, 0x3c4fb3, 0xb33c8f,
  0x7a7a7a, 0x2e6e5e, 0xa34d6d, 0x5d8aa8, 0x8f9779,
  0xc25e4e, 0x4e7dc2, 0x4ec27d, 0xc2a54e, 0x9a4ec2,
  0x4ec2b2, 0xc27d4e, 0x7dc24e,
];
