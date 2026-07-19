// 低多边形人形角色(玩家与 bot 共用) + 背包物品 + 命中体 + 姿态(站/蹲/趴)
import * as THREE from 'three';
import type { AmmoType, ArmorState, GunState, MeleeState, ThrowableId } from './types';
import type { HealId } from './heals';
import { MELEE } from './weapons';
import { buildHelmetModel, buildVestModel } from './armor';
import { buildPackModel, type PackLevel } from './backpack';
import { buildWeaponModel, type WeaponModel, type WeaponModelId } from './weaponmodels';
import type { World } from './world';
import { WATER_Y } from './world';
import { clamp } from './utils';

export type Stance = 'stand' | 'crouch' | 'prone';
const STANCE_TARGET: Record<Stance, number> = { stand: 0, crouch: 1, prone: 2 };

export interface HumanParts {
  inner: THREE.Group;   // 模型根(bob/倒地旋转)
  torso: THREE.Mesh;
  head: THREE.Mesh;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  gun: THREE.Group;      // 手部锚点(当前持械模型挂在这里)
  held: WeaponModel | null; // 当前持械模型(含 muzzle/mag)
  muzzleFallback: THREE.Object3D; // 徒手时的枪口兜底点
}

// 共享几何体(跨对局复用, 重开不泄漏)
const GEO = {
  head: new THREE.BoxGeometry(0.3, 0.32, 0.3),
  torso: new THREE.BoxGeometry(0.46, 0.58, 0.28),   // 收窄肩腰
  waist: new THREE.BoxGeometry(0.4, 0.16, 0.26),
  upperArm: new THREE.BoxGeometry(0.13, 0.3, 0.13),
  forearm: new THREE.BoxGeometry(0.115, 0.3, 0.115),
  hand: new THREE.BoxGeometry(0.1, 0.12, 0.1),
  thigh: new THREE.BoxGeometry(0.16, 0.38, 0.16),
  shin: new THREE.BoxGeometry(0.145, 0.38, 0.145),
  boot: new THREE.BoxGeometry(0.16, 0.12, 0.26),
};

const MAT = {
  skin: new THREE.MeshLambertMaterial({ color: 0xd9a066 }),
  pants: new THREE.MeshLambertMaterial({ color: 0x3d4436 }),
  boot: new THREE.MeshLambertMaterial({ color: 0x2c2620 }),
};

// 裤装配色(bot 按索引错开, 远距可读)
const PANTS_COLORS = [0x3d4436, 0x37404a, 0x4a3f33, 0x2f3a2f, 0x46464e];

const shirtCache = new Map<number, THREE.MeshLambertMaterial>();
function shirtMat(color: number): THREE.MeshLambertMaterial {
  let m = shirtCache.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    shirtCache.set(color, m);
  }
  return m;
}

export function buildHumanoid(shirtColor: number, variant = 0): { group: THREE.Group; parts: HumanParts } {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  group.add(inner);
  const shirt = shirtMat(shirtColor);
  const pants = shirtMat(PANTS_COLORS[variant % PANTS_COLORS.length] as number);

  const torso = new THREE.Mesh(GEO.torso, shirt);
  torso.position.set(0, 1.05, 0);
  torso.castShadow = true;
  inner.add(torso);
  // 腰带/裤腰色块
  const waist = new THREE.Mesh(GEO.waist, pants);
  waist.position.set(0, 0.79, 0);
  inner.add(waist);

  const head = new THREE.Mesh(GEO.head, MAT.skin);
  head.position.set(0, 1.53, 0);
  head.castShadow = true;
  inner.add(head);

  // 手臂: 肩部枢轴 → 上臂 → 肘部枢轴 → 前臂 + 手(肘/手暗示)
  const mkArm = (side: 1 | -1): THREE.Group => {
    const arm = new THREE.Group();
    arm.position.set(0.31 * side, 1.32, 0);
    const upper = new THREE.Mesh(GEO.upperArm, shirt);
    upper.position.set(0, -0.14, 0);
    upper.castShadow = true;
    arm.add(upper);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.3, 0);
    elbow.rotation.x = -0.35; // 肘部微屈
    const fore = new THREE.Mesh(GEO.forearm, shirt);
    fore.position.set(0, -0.14, 0);
    fore.castShadow = true;
    elbow.add(fore);
    const hand = new THREE.Mesh(GEO.hand, MAT.skin);
    hand.position.set(0, -0.32, 0);
    elbow.add(hand);
    arm.add(elbow);
    arm.rotation.x = -1.15;
    arm.rotation.z = 0.25 * side * -1;
    return arm;
  };
  const armL = mkArm(-1);
  armL.rotation.z = 0.25;
  inner.add(armL);
  const armR = mkArm(1);
  armR.rotation.x = -1.3;
  armR.rotation.z = -0.1;
  inner.add(armR);

  // 腿: 髋部枢轴 → 大腿 → 膝部枢轴 → 小腿 + 靴(膝/靴暗示)
  const mkLeg = (side: 1 | -1): THREE.Group => {
    const leg = new THREE.Group();
    leg.position.set(0.13 * side, 0.74, 0);
    const thigh = new THREE.Mesh(GEO.thigh, pants);
    thigh.position.set(0, -0.19, 0);
    thigh.castShadow = true;
    leg.add(thigh);
    const knee = new THREE.Group();
    knee.position.set(0, -0.38, 0);
    const shin = new THREE.Mesh(GEO.shin, pants);
    shin.position.set(0, -0.19, 0);
    shin.castShadow = true;
    knee.add(shin);
    const boot = new THREE.Mesh(GEO.boot, MAT.boot);
    boot.position.set(0, -0.42, 0.03);
    knee.add(boot);
    leg.add(knee);
    return leg;
  };
  const legL = mkLeg(-1);
  inner.add(legL);
  const legR = mkLeg(1);
  inner.add(legR);

  // 手部锚点(武器模型挂载点, 模型原点=握把, 指向 +Z 前方)
  const gun = new THREE.Group();
  gun.position.set(0.19, 1.26, 0.34);
  const muzzleFallback = new THREE.Object3D();
  muzzleFallback.position.set(0, 0.02, 0.4);
  gun.add(muzzleFallback);
  inner.add(gun);

  return { group, parts: { inner, torso, head, armL, armR, legL, legR, gun, held: null, muzzleFallback } };
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
  team: 'squad' | 'enemy' = 'enemy'; // 队伍(玩家+3队友=squad)
  speed2d = 0;
  walkPhase = 0;

  // ---- 背包 ----
  guns: (GunState | null)[] = [null, null, null]; // 0/1 主武器, 2 手枪
  melee: MeleeState = { def: MELEE.fists };        // 近战(默认拳头)
  ammo: Record<AmmoType, number> = { pistol: 0, rifle: 0, smg: 0, sniper: 0 };
  heals: Record<HealId, number> = { bandage: 0, medkit: 0, drink: 0 }; // 恢复品存量
  throwables: Record<ThrowableId, number> = { frag: 0, smoke: 0 };
  throwKind: ThrowableId = 'frag'; // 当前选中的投掷物类型
  curSlot = 3; // 0/1 主武器, 2 手枪, 3 近战, 4 投掷物
  helmet: ArmorState | null = null;  // 已装备头盔(减头部伤害)
  vest: ArmorState | null = null;    // 已装备防弹衣(减身体伤害)
  pack: { level: PackLevel } | null = null; // 已装备背包(加负重)

  swingT = 0;          // 挥击动画进度(1→0)
  swingSide = 1;       // 出拳侧(1 右 / -1 左, 每次挥击交替)
  lastMeleeT = -100;   // 上次挥击时间
  dieT = -1;           // >=0 表示死亡动画进度
  stance: Stance = 'stand'; // 姿态: 站/蹲/趴
  stanceF = 0;         // 姿态插值 0站→1蹲→2趴(平滑过渡)
  groundH = 0;         // 脚下地面高(供贴地阴影)
  airPose: 'fall' | 'canopy' | 'sit' | null = null; // 空降姿势/驾驶坐姿(驾驶时收枪)
  swimming = false;      // 深水游泳中(由 Game.updateSwim 维护)
  swimT = 0;             // 游泳累计时间(浮沉/划臂相位)
  swimDip = 0;           // 高处落水下潜剩余秒(0.4s 俯冲后浮起)
  swimAcc = 0;           // 划水距离累计(划水声/小水花节流)
  private swimF = 0;     // 游泳姿态混合 0..1(平滑进出)
  canopyGroup: THREE.Group | null = null;   // 降落伞模型(开伞挂载, 落地卸载)
  private lastLegSwing = 0; // 上帧腿摆角(疾跑摆臂用)
  lastAttackerId = 0;
  lastShotT = -100;    // 最近一次开枪时间(小地图红点)
  kills = 0;
  reload01 = 0;        // 换弹进度 0..1(0=未换弹), 玩家控制器每帧写入
  aimPitch = 0;        // ADS 时枪械俯仰(玩家控制器写入), bot 恒 0

  private heldId: WeaponModelId | null = null;
  private armorKey = 0;              // 已同步的护具外观(helmetLvl*100+vestLvl*10+packLvl)
  private helmetMesh: THREE.Group | null = null;
  private vestMesh: THREE.Group | null = null;
  private packMesh: THREE.Group | null = null;

  readonly group: THREE.Group;
  readonly parts: HumanParts;

  constructor(name: string, isPlayer: boolean, shirtColor: number) {
    this.id = Character.nextId++;
    this.name = name;
    this.isPlayer = isPlayer;
    const { group, parts } = buildHumanoid(shirtColor, this.id);
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
    return out.set(this.pos.x, this.pos.y + this.eyeHeight(), this.pos.z);
  }

  chestPos(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + this.chestHeight(), this.pos.z);
  }

  // 姿态切换(任务4的灌木隐蔽也读这个状态)
  setStance(s: Stance): void {
    this.stance = s;
  }

  // 挂载降落伞(开伞): 弧形伞盖 + 吊绳, 跟随角色
  attachCanopy(color: number): void {
    this.removeCanopy();
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color });
    const mkPanel = (x: number, rz: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.14, 1.5), mat);
      m.position.set(x, 0, 0);
      m.rotation.z = rz;
      return m;
    };
    g.add(mkPanel(-1.1, 0.32), mkPanel(0, 0), mkPanel(1.1, -0.32));
    const lineMat = new THREE.MeshLambertMaterial({ color: 0xcccccc });
    for (const [lx, lz] of [[-1.5, -0.55], [-1.5, 0.55], [1.5, -0.55], [1.5, 0.55]] as const) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.02, 2.0, 0.02), lineMat);
      line.position.set(lx * 0.62, -1.0, lz * 0.62);
      line.rotation.z = lx > 0 ? 0.28 : -0.28;
      line.rotation.x = lz > 0 ? 0.18 : -0.18;
      g.add(line);
    }
    g.position.set(0, 2.6, 0);
    this.parts.inner.add(g);
    this.canopyGroup = g;
  }

  // 卸载降落伞(落地/重开)
  removeCanopy(): void {
    if (this.canopyGroup) {
      this.parts.inner.remove(this.canopyGroup);
      this.canopyGroup = null;
    }
  }

  // 当前眼高(站1.62/蹲1.1/趴0.35, 随 stanceF 平滑; 游泳时贴水面)
  eyeHeight(): number {
    if (this.swimming) return 0.95; // pos.y ≈ 水面-0.78 → 眼位露出水面 ~0.17
    const f = this.stanceF;
    return f <= 1 ? 1.62 - 0.52 * f : 1.1 - 0.75 * (f - 1);
  }

  // 胸部命中/瞄准参考高(站1.15/蹲0.72/趴0.3; 游泳时在水面)
  chestHeight(): number {
    if (this.swimming) return 0.6;
    const f = this.stanceF;
    return f <= 1 ? 1.15 - 0.43 * f : 0.72 - 0.42 * (f - 1);
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    const held = this.parts.held;
    const m = held ? held.muzzle : this.parts.muzzleFallback;
    return m.getWorldPosition(out);
  }

  // 第一人称切换: 隐藏头部+头盔防穿模, 武器锚点上抬靠向视线中心(每帧幂等调用, 零分配)
  setFirstPerson(fpp: boolean): void {
    this.parts.head.visible = !fpp;
    if (this.helmetMesh) this.helmetMesh.visible = !fpp;
    this.parts.gun.position.set(fpp ? 0.14 : 0.19, fpp ? 1.38 : 1.26, 0.34);
  }

  // 护具外观同步(装备变化时重建挂载, 平时零分配)
  private swapArmor(): void {
    const p = this.parts;
    if (this.helmetMesh) {
      p.inner.remove(this.helmetMesh);
      this.helmetMesh = null;
    }
    if (this.vestMesh) {
      p.inner.remove(this.vestMesh);
      this.vestMesh = null;
    }
    if (this.packMesh) {
      p.inner.remove(this.packMesh);
      this.packMesh = null;
    }
    if (this.helmet) {
      this.helmetMesh = buildHelmetModel(this.helmet.level);
      this.helmetMesh.position.set(0, 1.63, 0);
      p.inner.add(this.helmetMesh);
    }
    if (this.vest) {
      this.vestMesh = buildVestModel(this.vest.level);
      this.vestMesh.position.set(0, 1.1, 0);
      p.inner.add(this.vestMesh);
    }
    if (this.pack) {
      this.packMesh = buildPackModel(this.pack.level);
      this.packMesh.position.set(0, 1.12, -0.31); // 背部(模型正面朝 +z)
      p.inner.add(this.packMesh);
    }
  }

  // 切换手持模型(栏位/武器变化时调用; 克隆原型, 零逐帧分配)
  private swapHeld(id: WeaponModelId | null): void {
    if (id === this.heldId) return;
    const p = this.parts;
    if (p.held) {
      p.gun.remove(p.held.group);
      p.held = null;
    }
    this.heldId = id;
    if (id) {
      p.held = buildWeaponModel(id);
      p.gun.add(p.held.group);
    }
  }

  // 游泳位移: 水平限速由调用方保证; Y 锁定水面浮沉, 高处落水先下潜再浮起
  applySwim(vx: number, vz: number, dt: number, world: World): void {
    this.pos.x += vx * dt;
    this.pos.z += vz * dt;
    world.resolveCollision(this.pos, this.radius);
    this.swimT += dt;
    const bob = Math.sin(this.swimT * 2.3) * 0.045;
    let targetY = WATER_Y - 0.78 + bob;
    if (this.swimDip > 0) {
      this.swimDip = Math.max(0, this.swimDip - dt);
      const p = 1 - this.swimDip / 0.4; // 0→1
      targetY -= Math.sin(p * Math.PI) * 0.55; // 下潜再弹回
    }
    this.pos.y += (targetY - this.pos.y) * Math.min(1, dt * 5);
    this.vy = 0;
    this.grounded = false;
    this.groundH = WATER_Y - 0.03; // 贴水面的阴影
    this.speed2d = Math.sqrt(vx * vx + vz * vz);
  }

  // 通用位移: 水平速度 + 重力 + 地面/碰撞
  applyMove(vx: number, vz: number, dt: number, world: World): void {
    this.pos.x += vx * dt;
    this.pos.z += vz * dt;
    this.vy -= 22 * dt;
    this.pos.y += this.vy * dt;
    world.resolveCollision(this.pos, this.radius);
    const ground = world.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.1);
    this.groundH = ground;
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.vy = 0;
      this.grounded = true;
    } else {
      this.grounded = this.pos.y - ground < 0.05;
    }
    this.speed2d = Math.sqrt(vx * vx + vz * vz);
  }

  // 模型同步: 位置/朝向/持械模型/挥击/走路摆动/倒地/姿态
  syncModel(dt: number, moving: boolean): void {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    // 姿态插值: 蹲 ~0.25s, 趴 ~0.4s
    const stTarget = STANCE_TARGET[this.stance];
    if (this.stanceF !== stTarget) {
      const rate = stTarget > 1 || this.stanceF > 1 ? 2.5 : 4;
      this.stanceF = clamp(this.stanceF + Math.sign(stTarget - this.stanceF) * rate * dt, 0, 2);
      if (Math.abs(this.stanceF - stTarget) < 0.03) this.stanceF = stTarget;
    }
    const p = this.parts;
    // 持械模型切换(仅在栏位/武器变化时克隆)
    const gun = this.curSlot < 3 ? this.guns[this.curSlot] : null;
    const wantId: WeaponModelId | null = this.airPose || this.swimming
      ? null // 空降/游泳收枪
      : gun
        ? gun.def.id
        : this.curSlot === 3 && this.melee.def.id === 'knife' ? 'knife'
          : this.curSlot === 4 ? this.throwKind
            : null;
    this.swapHeld(wantId);
    // 护具外观(装备/等级变化时重建)
    const aKey = (this.helmet?.level ?? 0) * 100 + (this.vest?.level ?? 0) * 10 + (this.pack?.level ?? 0);
    if (aKey !== this.armorKey) {
      this.armorKey = aKey;
      this.swapArmor();
    }
    // 枪姿态: ADS 俯仰 + 换弹下压; 弹匣中段脱落/回装
    const reloadDip = this.reload01 > 0 ? Math.sin(Math.min(1, this.reload01) * Math.PI) * 0.55 : 0;
    p.gun.rotation.x = -this.aimPitch + reloadDip;
    if (p.held?.mag) {
      p.held.mag.visible = this.reload01 < 0.4 || this.reload01 > 0.68;
    }
    // 左臂大致迎向护木(长枪更前伸), 持刀/徒手放松
    if (wantId === 'rifle' || wantId === 'sniper') {
      p.armL.rotation.x = -1.5;
      p.armL.rotation.z = 0.5;
    } else if (wantId === 'smg' || wantId === 'pistol') {
      p.armL.rotation.x = -1.28;
      p.armL.rotation.z = 0.38;
    } else {
      p.armL.rotation.x = -1.15;
      p.armL.rotation.z = 0.25;
    }
    if (!this.alive) {
      if (this.dieT >= 0 && this.dieT < 1) {
        this.dieT = Math.min(1, this.dieT + dt * 2.4);
        const e = 1 - (1 - this.dieT) * (1 - this.dieT);
        p.inner.rotation.x = -Math.PI / 2 * e;
        p.inner.position.y = 0.15 * e;
      }
      return;
    }
    // 空降姿势覆盖: 自由落体(展开俯冲) / 开伞(悬挂) / 驾驶(坐姿)
    if (this.airPose) {
      if (this.airPose === 'fall') {
        p.inner.rotation.x = Math.PI / 2 * 0.92; // 面朝下俯冲
        p.inner.position.y = 0.3;
        p.armL.rotation.set(-0.3, 0, 1.15);
        p.armR.rotation.set(-0.3, 0, -1.15);
        p.legL.rotation.set(0.28, 0, 0.25);
        p.legR.rotation.set(-0.18, 0, -0.25);
      } else if (this.airPose === 'canopy') {
        p.inner.rotation.x = 0.12; // 悬挂微后仰
        p.inner.position.y = 0;
        p.armL.rotation.set(-2.7, 0, 0.5);
        p.armR.rotation.set(-2.7, 0, -0.5);
        p.legL.rotation.set(0.32, 0, 0.06);
        p.legR.rotation.set(0.18, 0, -0.06);
      } else {
        // 驾驶坐姿: 腿前伸, 手扶方向盘
        p.inner.rotation.x = 0.05;
        p.inner.position.y = -0.35;
        p.armL.rotation.set(-1.15, 0, 0.35);
        p.armR.rotation.set(-1.15, 0, -0.35);
        p.legL.rotation.set(-1.35, 0, 0.08);
        p.legR.rotation.set(-1.3, 0, -0.08);
      }
      return;
    }
    // 游泳姿势: 水平俯身贴水面 + 交替划臂打水(swimF 平滑进出)
    this.swimF = clamp(this.swimF + (this.swimming ? 1 : -1) * dt * 3.2, 0, 1);
    if (this.swimF > 0.001) {
      const f = this.swimF;
      const ph = this.swimT * 3.4;
      const sL = Math.sin(ph);
      const sR = Math.sin(ph + Math.PI);
      p.inner.rotation.x = f * (Math.PI / 2 - 0.22); // 接近水平, 头抬出水面
      p.inner.rotation.y = 0;
      p.inner.position.y = f * 0.6;
      p.inner.position.z = 0;
      p.armL.rotation.set(-1.15 + f * (-0.3 + sL * 0.5), 0, 0.25 + f * 0.1);
      p.armR.rotation.set(-1.3 + f * (-0.15 + sR * 0.5), 0, -0.1 - f * 0.1);
      p.armL.position.z = 0;
      p.armR.position.z = 0;
      p.legL.rotation.x = f * (0.3 + sR * 0.18);
      p.legR.rotation.x = f * (0.3 + sL * 0.18);
      return;
    }
    // 姿态混合: fC 蹲权重(0..1), fP 趴权重(0..1)
    const fC = Math.min(this.stanceF, 1);
    const fP = Math.max(0, this.stanceF - 1);
    // 疾跑摆臂(不瞄准时, 与腿反相)
    const sprintF = this.speed2d > 5 && this.aimPitch < 0.01 ? Math.min(1, (this.speed2d - 5) / 1.6) : 0;
    // 挥击动画(快进慢回: 交替直拳 / 砍刀横斩; 命中时机不变)
    if (this.swingT > 0) {
      this.swingT = Math.max(0, this.swingT - dt * 3.4);
      const prog = 1 - this.swingT; // 0→1
      const ext = Math.sin(Math.min(1, prog * 1.9) * Math.PI); // 峰值偏前的出收曲线
      const side = this.swingSide;
      const arm = side > 0 ? p.armR : p.armL;
      if (this.melee.def.id === 'knife') {
        // 砍刀: 大幅度横斩(手臂横扫过身)
        arm.rotation.x = -1.5;
        arm.rotation.z = side * (0.95 - prog * 1.9);
        arm.position.z = 0.1 + ext * 0.28;
      } else {
        // 交替直拳: 拳峰前送 + 躯干微转 + 小前冲
        arm.rotation.x = -1.3 - ext * 0.55;
        arm.rotation.z = (side > 0 ? -0.1 : 0.25) + side * -ext * 0.12;
        arm.position.z = ext * 0.4;
      }
      p.inner.rotation.y = -side * ext * 0.3;
      p.inner.position.z = ext * 0.07;
    } else {
      // 复位(挥臂基线; armL 的 z 由持枪姿态段每帧重写)
      p.armR.rotation.x = -1.3 + this.lastLegSwing * sprintF;
      p.armR.rotation.z = -0.1;
      p.armR.position.z = 0;
      p.armL.position.z = 0;
      p.inner.rotation.y = 0;
      p.inner.position.z = 0;
    }
    if (sprintF > 0) {
      p.armL.rotation.x = -1.5 - this.lastLegSwing * sprintF;
    }
    // 走路摆动(蹲/趴时幅度衰减)
    let legSwing = 0;
    let bob = 0;
    if (moving && this.speed2d > 0.3) {
      this.walkPhase += dt * (2.0 + this.speed2d * 1.6);
      legSwing = Math.sin(this.walkPhase) * 0.72 * (1 - 0.6 * fC - 0.4 * fP);
      bob = Math.abs(Math.cos(this.walkPhase)) * 0.055 * (1 - 0.8 * fC);
      this.lastLegSwing = legSwing;
    } else {
      this.lastLegSwing *= 1 - Math.min(1, dt * 8);
    }
    // 蹲: 腿前弯; 趴: 腿顺直
    const legBend = -1.05 * fC * (1 - fP);
    p.legL.rotation.x = legSwing + legBend;
    p.legR.rotation.x = -legSwing + legBend;
    // 身体下沉(蹲 -0.53 / 趴 +0.30 由旋转完成趴倒)与旋转(趴 = 面朝下平躺, 部分随瞄准俯仰)
    p.inner.position.y = bob - 0.53 * fC + 0.83 * fP;
    // 移动前倾(速度越大越前倾, 趴下不再加)
    const lean = Math.min(1, this.speed2d / 6.6) * 0.18 * (1 - fP);
    p.inner.rotation.x = 0.2 * fC + lean + fP * (Math.PI / 2 - 0.2 - clamp(this.aimPitch, -0.5, 0.5) * 0.6);
  }

  // 解析命中: 头部球体 + 身体有向盒(随 yaw 旋转), 命中填充 res 并返回 true
  // 姿态感知: 蹲头降至 1.02, 趴头 0.35 前移 1.1, 身体盒变低变长
  hitTest(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxT: number, res: HitTestResult,
  ): boolean {
    let bestT = maxT;
    let head = false;
    const f = this.stanceF;
    const fC = Math.min(f, 1);
    const fP = Math.max(0, f - 1);
    const swim = this.swimming;
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    // 头部球体: 中心 pos + 高 headY (+ 趴时前移 headFwd), r=0.26; 游泳时头在水面上
    const headY = swim ? 1.12 : 1.55 - 0.53 * fC - 0.67 * fP;
    const headFwd = swim ? 0.5 : 1.1 * fP;
    const hx = this.pos.x + sinY * headFwd - ox;
    const hy = this.pos.y + headY - oy;
    const hz = this.pos.z + cosY * headFwd - oz;
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
    // 身体 OBB: 半尺寸随姿态(高 halfY, 长 halfZ), 趴时前移 bodyFwd; 游泳时低平贴水面
    const bodyY = swim ? 0.72 : 0.78 - 0.26 * fC - 0.22 * fP;
    const bodyHalfY = swim ? 0.36 : bodyY;
    const bodyFwd = swim ? 0.3 : 0.85 * fP;
    const bodyHalfZ = swim ? 0.8 : 0.22 + 0.63 * fP;
    const bcx = this.pos.x + sinY * bodyFwd;
    const bcz = this.pos.z + cosY * bodyFwd;
    const lox0 = ox - bcx;
    const loz0 = oz - bcz;
    const lox = lox0 * cosY - loz0 * sinY;
    const loz = lox0 * sinY + loz0 * cosY;
    const ldx = dx * cosY - dz * sinY;
    const ldz = dx * sinY + dz * cosY;
    const loy = oy - (this.pos.y + bodyY);
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
        if (loy < -bodyHalfY || loy > bodyHalfY) ok = false;
      } else {
        let t1 = (-bodyHalfY - loy) / dy;
        let t2 = (bodyHalfY - loy) / dy;
        if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) ok = false;
      }
    }
    // z
    if (ok) {
      if (Math.abs(ldz) < 1e-9) {
        if (loz < -bodyHalfZ || loz > bodyHalfZ) ok = false;
      } else {
        let t1 = (-bodyHalfZ - loz) / ldz;
        let t2 = (bodyHalfZ - loz) / ldz;
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

// 共享位移入口: 游泳时限速 2.2m/s 并走水面浮动, 否则常规重力位移
export function moveChar(c: Character, vx: number, vz: number, dt: number, world: World): void {
  if (c.swimming) {
    const l = Math.hypot(vx, vz);
    if (l > 2.2) {
      const s = 2.2 / l;
      vx *= s;
      vz *= s;
    }
    c.applySwim(vx, vz, dt, world);
  } else {
    c.applyMove(vx, vz, dt, world);
  }
}
