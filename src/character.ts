// 低多边形人形角色(玩家与 bot 共用) + 背包物品 + 命中体 + 姿态(站/蹲/趴)
import * as THREE from 'three';
import type { AmmoType, ArmorState, GunAttachments, GunState, MeleeState, ThrowableId } from './types';
import type { HealId } from './heals';
import { MELEE } from './weapons';
import { buildHelmetModel, buildVestModel } from './armor';
import { buildPackModel, type PackLevel } from './backpack';
import { buildWeaponModel, attachWeaponMods, type WeaponModel, type WeaponModelId } from './weaponmodels';
import type { World } from './world';
import { WATER_Y } from './world';
import { clamp, lerp } from './utils';

export type Stance = 'stand' | 'crouch' | 'prone';
export type CharacterAction = 'interact' | 'pickup' | 'equip' | 'heal' | 'drink';
const STANCE_TARGET: Record<Stance, number> = { stand: 0, crouch: 1, prone: 2 };
export const SWIM_SPEED = 2.6;
export const SWIM_SPRINT_SPEED = 4.8;
export const SWIM_ENTER_DEPTH = 1.1;
export const SWIM_EXIT_DEPTH = 0.45;

export function advancePoseBlend(current: number, active: boolean, dt: number, enterRate: number, exitRate: number): number {
  return clamp(current + (active ? enterRate : -exitRate) * dt, 0, 1);
}

export function shouldEnterSwimming(depth: number, standH: number, feetY: number): boolean {
  return depth > SWIM_ENTER_DEPTH && feetY < WATER_Y + 0.3 && standH < WATER_Y - 1;
}

export function shouldExitSwimming(depth: number, standH: number): boolean {
  return depth <= SWIM_EXIT_DEPTH || standH >= WATER_Y - SWIM_EXIT_DEPTH;
}

// 玩家和 AI 共用同一套空降垂直物理, 避免机器人因开伞减速参数漂移而提前落地。
export type AirDescentPhase = 'freefall' | 'canopy';
export const CANOPY_DEPLOY_VELOCITY = -9;
const FREEFALL_TERMINAL_VELOCITY = -55;
const CANOPY_TERMINAL_VELOCITY = -10;
const FREEFALL_VELOCITY_RESPONSE = 1.1;
const CANOPY_VELOCITY_RESPONSE = 2.2;

export function stepAirDescentVelocity(vy: number, phase: AirDescentPhase, dt: number): number {
  const terminal = phase === 'freefall' ? FREEFALL_TERMINAL_VELOCITY : CANOPY_TERMINAL_VELOCITY;
  const response = phase === 'freefall' ? FREEFALL_VELOCITY_RESPONSE : CANOPY_VELOCITY_RESPONSE;
  return vy + (terminal - vy) * (1 - Math.exp(-dt * response));
}

// 翻越状态(脚本化运动: 起跳点→顶点上弧→落点)
export interface VaultState {
  t: number;      // 已进行秒数
  dur: number;    // 总时长(~0.7s)
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  topY: number;   // 障碍顶 + 抬腿余量
}

export interface HumanParts {
  inner: THREE.Group;   // 模型根(bob/倒地旋转)
  body: THREE.Group;    // 躯干/头腿及细节件(FPP 统一隐藏，避免遗漏穿模)
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
// 细节件共享几何(面部/领口/护具/鞋底等, 一次创建全局复用)
const GEO_D = {
  neck: new THREE.BoxGeometry(0.14, 0.08, 0.14),
  visor: new THREE.BoxGeometry(0.22, 0.055, 0.02),
  collar: new THREE.BoxGeometry(0.36, 0.06, 0.26),
  shoulder: new THREE.BoxGeometry(0.15, 0.06, 0.17),
  strap: new THREE.BoxGeometry(0.07, 0.5, 0.02),
  belt: new THREE.BoxGeometry(0.42, 0.06, 0.28),
  buckle: new THREE.BoxGeometry(0.08, 0.05, 0.02),
  cuff: new THREE.BoxGeometry(0.125, 0.055, 0.125),
  kneePad: new THREE.BoxGeometry(0.16, 0.11, 0.05),
  sole: new THREE.BoxGeometry(0.17, 0.035, 0.28),
  elbowPad: new THREE.BoxGeometry(0.13, 0.09, 0.045),
  hair: new THREE.BoxGeometry(0.31, 0.07, 0.31),
  ear: new THREE.BoxGeometry(0.045, 0.1, 0.075),
  nose: new THREE.BoxGeometry(0.05, 0.065, 0.045),
  pocket: new THREE.BoxGeometry(0.13, 0.13, 0.025),
  cargo: new THREE.BoxGeometry(0.035, 0.14, 0.11),
};

const MAT = {
  skin: new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.82 }),
  boot: new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 0.9 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.68, metalness: 0.08 }), // 面罩/护具/手套
  strap: new THREE.MeshStandardMaterial({ color: 0x2f2a22, roughness: 0.88 }), // 胸挂/腰带
  glove: new THREE.MeshStandardMaterial({ color: 0x3a342c, roughness: 0.92 }),
  sole: new THREE.MeshStandardMaterial({ color: 0x1b1712, roughness: 0.96 }),
  hair: new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.9 }),
};

// 裤装配色(bot 按索引错开, 远距可读)
const PANTS_COLORS = [0x3d4436, 0x37404a, 0x4a3f33, 0x2f3a2f, 0x46464e];

const shirtCache = new Map<number, THREE.MeshStandardMaterial>();
function shirtMat(color: number): THREE.MeshStandardMaterial {
  let m = shirtCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
    shirtCache.set(color, m);
  }
  return m;
}

export function buildHumanoid(shirtColor: number, variant = 0): { group: THREE.Group; parts: HumanParts } {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  group.add(inner);
  const body = new THREE.Group();
  inner.add(body);
  const shirt = shirtMat(shirtColor);
  const pants = shirtMat(PANTS_COLORS[variant % PANTS_COLORS.length] as number);

  const torso = new THREE.Mesh(GEO.torso, shirt);
  torso.position.set(0, 1.05, 0);
  torso.castShadow = true;
  body.add(torso);
  for (const side of [-1, 1] as const) {
    const pocket = new THREE.Mesh(GEO_D.pocket, shirt);
    pocket.position.set(0.11 * side, -0.02, 0.15);
    torso.add(pocket);
  }
  // 腰带/裤腰色块
  const waist = new THREE.Mesh(GEO.waist, pants);
  waist.position.set(0, 0.79, 0);
  body.add(waist);
  // ---- 细节: 颈部/领口/肩垫/胸挂带/腰带扣 ----
  const neck = new THREE.Mesh(GEO_D.neck, MAT.skin);
  neck.position.set(0, 1.38, 0);
  body.add(neck);
  const collar = new THREE.Mesh(GEO_D.collar, shirt);
  collar.position.set(0, 1.33, 0);
  body.add(collar);
  for (const side of [-1, 1] as const) {
    const pad = new THREE.Mesh(GEO_D.shoulder, shirt);
    pad.position.set(0.25 * side, 1.365, 0);
    pad.castShadow = true;
    body.add(pad);
  }
  const strap = new THREE.Mesh(GEO_D.strap, MAT.strap);
  strap.position.set(0.09, 1.05, 0.15);
  body.add(strap);
  const belt = new THREE.Mesh(GEO_D.belt, MAT.strap);
  belt.position.set(0, 0.88, 0);
  body.add(belt);
  const buckle = new THREE.Mesh(GEO_D.buckle, MAT.dark);
  buckle.position.set(0, 0.88, 0.15);
  body.add(buckle);

  const head = new THREE.Mesh(GEO.head, MAT.skin);
  head.position.set(0, 1.53, 0);
  head.castShadow = true;
  // 面部面罩条(跟随头部; FPP 隐藏头部时一并隐藏)
  const visor = new THREE.Mesh(GEO_D.visor, MAT.dark);
  visor.position.set(0, 0.03, 0.155);
  head.add(visor);
  const hair = new THREE.Mesh(GEO_D.hair, MAT.hair);
  hair.position.set(0, 0.165, -0.01);
  head.add(hair);
  const nose = new THREE.Mesh(GEO_D.nose, MAT.skin);
  nose.position.set(0, -0.035, 0.17);
  head.add(nose);
  for (const side of [-1, 1] as const) {
    const ear = new THREE.Mesh(GEO_D.ear, MAT.skin);
    ear.position.set(0.17 * side, -0.01, 0);
    head.add(ear);
  }
  body.add(head);

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
    // 袖口(裤色撞色) + 肘垫
    const cuff = new THREE.Mesh(GEO_D.cuff, pants);
    cuff.position.set(0, -0.27, 0);
    elbow.add(cuff);
    const epad = new THREE.Mesh(GEO_D.elbowPad, MAT.dark);
    epad.position.set(0, -0.1, -0.075);
    elbow.add(epad);
    const hand = new THREE.Mesh(GEO.hand, MAT.glove);
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
    const cargo = new THREE.Mesh(GEO_D.cargo, pants);
    cargo.position.set(0.09 * side, -0.02, 0.01);
    thigh.add(cargo);
    const knee = new THREE.Group();
    knee.position.set(0, -0.38, 0);
    const shin = new THREE.Mesh(GEO.shin, pants);
    shin.position.set(0, -0.19, 0);
    shin.castShadow = true;
    knee.add(shin);
    // 护膝
    const kpad = new THREE.Mesh(GEO_D.kneePad, MAT.dark);
    kpad.position.set(0, -0.04, 0.09);
    knee.add(kpad);
    const boot = new THREE.Mesh(GEO.boot, MAT.boot);
    boot.position.set(0, -0.42, 0.03);
    knee.add(boot);
    // 鞋底(深色伪 AO 接地感)
    const sole = new THREE.Mesh(GEO_D.sole, MAT.sole);
    sole.position.set(0, -0.075, 0.01);
    boot.add(sole);
    leg.add(knee);
    return leg;
  };
  const legL = mkLeg(-1);
  body.add(legL);
  const legR = mkLeg(1);
  body.add(legR);

  // 手部锚点(武器模型挂载点, 模型原点=握把, 指向 +Z 前方)
  const gun = new THREE.Group();
  gun.position.set(0.19, 1.26, 0.34);
  const muzzleFallback = new THREE.Object3D();
  muzzleFallback.position.set(0, 0.02, 0.4);
  gun.add(muzzleFallback);
  inner.add(gun);

  return { group, parts: { inner, body, torso, head, armL, armR, legL, legR, gun, held: null, muzzleFallback } };
}

export interface HitTestResult {
  t: number;
  head: boolean;
}

export interface OwnModelVisibility {
  head: boolean;
  body: boolean;
  hands: boolean;
}

// 第一人称不渲染自身躯干和腿，避免低机位穿模；趴姿时连同手臂和武器一起收起。
export function ownModelVisibility(firstPerson: boolean, stanceF: number): OwnModelVisibility {
  if (!firstPerson) return { head: true, body: true, hands: true };
  return { head: false, body: false, hands: stanceF <= 1.05 };
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
  stepAcc = 0;

  // ---- 背包 ----
  guns: (GunState | null)[] = [null, null, null]; // 0/1 主武器, 2 手枪
  melee: MeleeState = { def: MELEE.fists };        // 近战(默认拳头)
  ammo: Record<AmmoType, number> = { pistol: 0, rifle: 0, smg: 0, sniper: 0, shotgun: 0 };
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
  airSteerRight = 0;   // 自由落体左右修正 -1..1
  airSteerForward = 0; // 自由落体前后修正 -1..1
  swimming = false;      // 深水游泳中(由 Game.updateSwim 维护)
  swimT = 0;             // 游泳累计时间(浮沉/划臂相位)
  swimDip = 0;           // 高处落水下潜剩余秒(0.4s 俯冲后浮起)
  swimAcc = 0;           // 划水距离累计(划水声/小水花节流)
  vault: VaultState | null = null; // 翻越中(脚本位移, 输入锁定)
  vaultCd = 0;           // 翻越/跳跃冷却(落地 0.4s)
  // ---- 击倒/救援(DBNO, 仅小队) ----
  knocked = false;       // 击倒状态(流血倒计时, 可被扶起)
  knockHp = 0;           // 击倒血(上限 30)
  knockCount = 0;        // 本局被击倒次数(流血加速: 60/40/25s)
  bleedTime = 60;        // 本次击倒流血总时长
  reviveT = 0;           // 我正在执行的救援读条(秒, 8s 完成)
  reviveTarget: Character | null = null;
  rescuerId = 0;         // 正在救我的人的角色 id(0=无人)
  lastHitX = 0;          // 最近伤害来源位置(倒地爬离用)
  lastHitZ = 0;
  private swimF = 0;     // 游泳姿态混合 0..1(平滑进出)
  private knockF = 0;    // 击倒/起身姿态混合 0..1
  private airPoseF = 0;   // 空降/乘车姿态混合 0..1
  private visualAirPose: 'fall' | 'canopy' | 'sit' | null = null;
  private deathPoseCaptured = false;
  private deathStartRotX = 0;
  private deathStartY = 0;
  canopyGroup: THREE.Group | null = null;   // 降落伞模型(开伞挂载, 落地卸载)
  private lastLegSwing = 0; // 上帧腿摆角(疾跑摆臂用)
  lastAttackerId = 0;
  lastShotT = -100;    // 最近一次开枪时间(小地图红点)
  lastLoudShotT = -100; // 最近一次未消音开枪时间(敌人小地图暴露)
  kills = 0;
  reload01 = 0;        // 换弹进度 0..1(0=未换弹), 玩家控制器每帧写入
  aimPitch = 0;        // ADS 时枪械俯仰(玩家控制器写入), bot 恒 0
  gunKick = 0;         // 开枪瞬间的枪身后坐位移
  moveLean = 0;        // 左右移动时的身体侧倾 -1..1
  actionPose: CharacterAction | null = null; // 短交互动作, 由拾取/开门/切枪/恢复触发
  actionT = 0;

  private heldKey = '';               // 已同步的持械外观(模型 id + 配件)
  private armorKey = 0;              // 已同步的护具外观(helmetLvl*100+vestLvl*10+packLvl)
  private firstPerson = false;
  private helmetMesh: THREE.Group | null = null;
  private vestMesh: THREE.Group | null = null;
  private packMesh: THREE.Group | null = null;
  private actionF = 0;
  private visualAction: CharacterAction | 'revive' | null = null;

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

  beginAction(pose: CharacterAction, duration: number): void {
    const continuing = this.actionPose === pose;
    this.actionPose = pose;
    this.actionT = continuing ? Math.max(this.actionT, duration) : duration;
  }

  cancelAction(pose?: CharacterAction): void {
    if (pose && this.actionPose !== pose) return;
    this.actionPose = null;
    this.actionT = 0;
  }

  // 挂载降落伞(开伞): 弧形伞盖 + 吊绳, 跟随角色
  attachCanopy(color: number): void {
    this.removeCanopy();
    const g = new THREE.Group();
    const base = new THREE.Color(color);
    const panelCount = 9;
    for (let i = 0; i < panelCount; i++) {
      const tint = base.clone().multiplyScalar(i % 2 === 0 ? 1.08 : 0.82);
      const panel = new THREE.Mesh(
        new THREE.SphereGeometry(1, 4, 3, (i / panelCount) * Math.PI * 2, Math.PI * 2 / panelCount, 0, Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: tint, roughness: 0.86, side: THREE.DoubleSide }),
      );
      panel.scale.set(2.65, 0.74, 1.58);
      panel.position.y = 0.22;
      panel.castShadow = true;
      g.add(panel);
    }
    const linePos: number[] = [];
    for (const [lx, lz] of [[-2.15, -0.82], [-2.15, 0.82], [-0.8, -1.28], [-0.8, 1.28], [0.8, -1.28], [0.8, 1.28], [2.15, -0.82], [2.15, 0.82]] as const) {
      const harnessX = Math.sign(lx) * 0.3;
      const harnessZ = Math.sign(lz) * 0.18;
      linePos.push(lx, 0.2, lz, harnessX, -2.48, harnessZ);
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
    g.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xe3ddd0, transparent: true, opacity: 0.92 })));
    // 伞盖后缘黑色导流带, 远距离也能读出伞面轮廓。
    const trailing = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.025, 4, 24, Math.PI),
      new THREE.MeshBasicMaterial({ color: 0x2d332c }),
    );
    trailing.scale.set(2.62, 1.55, 1);
    trailing.rotation.x = Math.PI / 2;
    trailing.position.set(0, 0.22, 0);
    g.add(trailing);
    g.position.set(0, 2.72, 0);
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

  // 第一人称切换: 仅保留不会穿入相机的手臂和武器，趴姿低机位完全隐藏自身模型。
  setFirstPerson(fpp: boolean): void {
    this.firstPerson = fpp;
    this.syncOwnModelVisibility();
    this.parts.gun.position.set(fpp ? 0.14 : 0.19, fpp ? 1.38 : 1.26, 0.34);
  }

  private syncOwnModelVisibility(): void {
    const visible = ownModelVisibility(this.firstPerson, this.stanceF);
    const p = this.parts;
    p.body.visible = visible.body;
    p.head.visible = visible.head;
    p.torso.visible = visible.body;
    p.legL.visible = visible.body;
    p.legR.visible = visible.body;
    p.armL.visible = visible.hands;
    p.armR.visible = visible.hands;
    p.gun.visible = visible.hands;
    if (this.helmetMesh) this.helmetMesh.visible = visible.head;
    if (this.vestMesh) this.vestMesh.visible = visible.body;
    if (this.packMesh) this.packMesh.visible = visible.body;
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

  // 切换手持模型(栏位/武器/配件变化时调用; 克隆原型, 零逐帧分配)
  private swapHeld(id: WeaponModelId | null, att: GunAttachments | null): void {
    const key = id ? `${id}:${att?.sight ?? ''}${att?.mag ?? ''}${att?.muzzle ?? ''}` : '';
    if (key === this.heldKey) return;
    this.heldKey = key;
    const p = this.parts;
    if (p.held) {
      p.gun.remove(p.held.group);
      p.held = null;
    }
    if (id) {
      p.held = buildWeaponModel(id);
      if (att) attachWeaponMods(p.held.group, att);
      p.gun.add(p.held.group);
    }
  }

  // 游泳位移: 水平限速由调用方保证; Y 锁定水面浮沉, 岸边保留少量推进避免突然刹停
  applySwim(vx: number, vz: number, dt: number, world: World): void {
    const oldX = this.pos.x;
    const oldZ = this.pos.z;
    const startDepth = WATER_Y - world.getHeight(this.pos.x, this.pos.z);
    const startStandH = world.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.3);
    if (startDepth <= SWIM_EXIT_DEPTH || startStandH >= WATER_Y - SWIM_EXIT_DEPTH) {
      vx *= 0.35;
      vz *= 0.35;
    }
    this.pos.x += vx * dt;
    this.pos.z += vz * dt;
    world.resolveCollision(this.pos, this.radius);
    const speed = Math.hypot(this.pos.x - oldX, this.pos.z - oldZ) / Math.max(dt, 1e-4);
    const speedF = clamp(speed / SWIM_SPEED, 0, 1);
    const sprintF = clamp((speed - SWIM_SPEED) / (SWIM_SPRINT_SPEED - SWIM_SPEED), 0, 1);
    this.swimT += dt * (0.45 + speedF * 0.65 + sprintF * 0.55);
    const bob = Math.sin(this.swimT * 2.5) * (0.025 + speedF * 0.018 + sprintF * 0.012);
    const groundY = world.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.3);
    const depth = WATER_Y - groundY;
    const shoreF = clamp((0.8 - depth) / (0.8 - SWIM_EXIT_DEPTH), 0, 1);
    const waterY = WATER_Y - 0.78 + bob;
    let targetY = waterY + (groundY - waterY) * shoreF;
    if (this.swimDip > 0) {
      this.swimDip = Math.max(0, this.swimDip - dt);
      const p = 1 - this.swimDip / 0.4; // 0→1
      targetY -= Math.sin(p * Math.PI) * 0.55; // 下潜再弹回
    }
    const buoyancy = shoreF > 0 ? 9 : 6;
    this.pos.y += (targetY - this.pos.y) * (1 - Math.exp(-dt * buoyancy));
    this.vy = 0;
    this.grounded = false;
    this.groundH = WATER_Y - 0.03 + (groundY - (WATER_Y - 0.03)) * shoreF;
    this.speed2d = speed;
  }

  // 通用位移: 水平速度 + 重力 + 地面/碰撞
  applyMove(vx: number, vz: number, dt: number, world: World): void {
    const oldX = this.pos.x;
    const oldZ = this.pos.z;
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
    this.speed2d = Math.hypot(this.pos.x - oldX, this.pos.z - oldZ) / Math.max(dt, 1e-4);
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
    this.knockF = advancePoseBlend(this.knockF, this.knocked, dt, 5.2, 3.4);
    if (this.airPose) this.visualAirPose = this.airPose;
    this.airPoseF = advancePoseBlend(this.airPoseF, this.airPose !== null, dt, 6.5, 4.5);
    if (!this.airPose && this.airPoseF <= 0) this.visualAirPose = null;
    this.actionT = Math.max(0, this.actionT - dt);
    if (this.actionT <= 0) this.actionPose = null;
    const requestedAction: CharacterAction | 'revive' | null = this.reviveTarget
      ? 'revive'
      : this.actionPose;
    if (requestedAction) this.visualAction = requestedAction;
    this.actionF = advancePoseBlend(this.actionF, requestedAction !== null, dt, 7.5, 6);
    if (!requestedAction && this.actionF <= 0) this.visualAction = null;
    this.gunKick *= Math.exp(-dt * 15);
    // 持械模型切换(仅在栏位/武器变化时克隆)
    const gun = this.curSlot < 3 ? this.guns[this.curSlot] : null;
    const stowForAction = this.actionF > 0.02 &&
      (this.visualAction === 'revive' || this.visualAction === 'pickup' ||
        this.visualAction === 'heal' || this.visualAction === 'drink');
    const wantId: WeaponModelId | null = this.airPose || this.airPoseF > 0.02 || this.swimming || this.knocked ||
      this.knockF > 0.02 || this.vault || stowForAction
      ? null // 空降/游泳/击倒/翻越/救援收枪
      : gun
        ? gun.def.id
        : this.curSlot === 3 && this.melee.def.id !== 'fists' ? this.melee.def.id
          : this.curSlot === 4 ? this.throwKind
            : null;
    this.swapHeld(wantId, gun ? gun.att : null);
    // 护具外观(装备/等级变化时重建)
    const aKey = (this.helmet?.level ?? 0) * 100 + (this.vest?.level ?? 0) * 10 + (this.pack?.level ?? 0);
    if (aKey !== this.armorKey) {
      this.armorKey = aKey;
      this.swapArmor();
    }
    // 姿态插值和装备重建都可能改变可见性，每帧统一收敛，避免趴下过渡或换装时短暂穿模。
    this.syncOwnModelVisibility();
    // 枪姿态: ADS 俯仰 + 换弹下压; 弹匣中段脱落/回装
    const reloadDip = this.reload01 > 0 ? Math.sin(Math.min(1, this.reload01) * Math.PI) * 0.55 : 0;
    p.gun.position.set(
      this.firstPerson ? 0.14 : 0.19,
      (this.firstPerson ? 1.38 : 1.26) - this.gunKick * 0.12,
      0.34 - this.gunKick,
    );
    p.gun.rotation.set(-this.aimPitch + reloadDip - this.gunKick * 0.55, 0, 0);
    if (p.held?.mag) {
      p.held.mag.visible = this.reload01 < 0.4 || this.reload01 > 0.68;
    }
    // 左臂大致迎向护木(长枪更前伸), 持刀/徒手放松
    if (wantId === 'rifle' || wantId === 'akm' || wantId === 'dmr' || wantId === 'sniper' || wantId === 'shotgun') {
      p.armL.rotation.set(-1.5, 0, 0.5);
    } else if (wantId === 'smg' || wantId === 'pistol') {
      p.armL.rotation.set(-1.28, 0, 0.38);
    } else {
      p.armL.rotation.set(-1.15, 0, 0.25);
    }
    if (!this.alive) {
      if (this.dieT >= 0 && this.dieT < 1) {
        if (!this.deathPoseCaptured) {
          this.deathPoseCaptured = true;
          this.deathStartRotX = p.inner.rotation.x;
          this.deathStartY = p.inner.position.y;
        }
        this.dieT = Math.min(1, this.dieT + dt * 2.4);
        const e = 1 - (1 - this.dieT) * (1 - this.dieT);
        const targetRot = this.deathStartRotX > 0.6 ? Math.PI / 2 - 0.08 : -Math.PI / 2;
        p.inner.rotation.x = lerp(this.deathStartRotX, targetRot, e);
        p.inner.position.y = lerp(this.deathStartY, 0.15, e);
      }
      return;
    }
    // 空降姿势覆盖: 自由落体(展开俯冲) / 开伞(悬挂) / 驾驶(坐姿)
    if (this.visualAirPose && this.airPoseF > 0.001) {
      const f = this.airPoseF * this.airPoseF * (3 - 2 * this.airPoseF);
      const k = 1 - Math.exp(-dt * 13);
      if (this.visualAirPose === 'fall') {
        p.inner.rotation.x = lerp(p.inner.rotation.x, (Math.PI / 2 * 0.92 + this.airSteerForward * 0.14) * f, k);
        p.inner.rotation.z = lerp(p.inner.rotation.z, -this.airSteerRight * 0.32 * f, k);
        p.inner.position.y = lerp(p.inner.position.y, 0.3 * f, k);
        p.armL.rotation.x = lerp(p.armL.rotation.x, lerp(-1.15, -0.3, f), k);
        p.armL.rotation.z = lerp(p.armL.rotation.z, lerp(0.25, 1.15, f), k);
        p.armR.rotation.x = lerp(p.armR.rotation.x, lerp(-1.3, -0.3, f), k);
        p.armR.rotation.z = lerp(p.armR.rotation.z, lerp(-0.1, -1.15, f), k);
        p.legL.rotation.x = lerp(p.legL.rotation.x, 0.28 * f, k);
        p.legL.rotation.z = lerp(p.legL.rotation.z, 0.25 * f, k);
        p.legR.rotation.x = lerp(p.legR.rotation.x, -0.18 * f, k);
        p.legR.rotation.z = lerp(p.legR.rotation.z, -0.25 * f, k);
      } else if (this.visualAirPose === 'canopy') {
        p.inner.rotation.x = lerp(p.inner.rotation.x, 0.12 * f, k);
        p.inner.rotation.z = lerp(p.inner.rotation.z, 0, k);
        p.inner.position.y = lerp(p.inner.position.y, 0, k);
        p.armL.rotation.x = lerp(p.armL.rotation.x, lerp(-1.15, -2.7, f), k);
        p.armL.rotation.z = lerp(p.armL.rotation.z, lerp(0.25, 0.5, f), k);
        p.armR.rotation.x = lerp(p.armR.rotation.x, lerp(-1.3, -2.7, f), k);
        p.armR.rotation.z = lerp(p.armR.rotation.z, lerp(-0.1, -0.5, f), k);
        p.legL.rotation.x = lerp(p.legL.rotation.x, 0.32 * f, k);
        p.legL.rotation.y = lerp(p.legL.rotation.y, 0, k);
        p.legL.rotation.z = lerp(p.legL.rotation.z, 0, k);
        p.legR.rotation.x = lerp(p.legR.rotation.x, 0.18 * f, k);
        p.legR.rotation.y = lerp(p.legR.rotation.y, 0, k);
        p.legR.rotation.z = lerp(p.legR.rotation.z, 0, k);
      } else {
        // 驾驶/乘客坐姿平滑进入和离开, 避免上下车瞬间折叠.
        p.inner.rotation.x = lerp(p.inner.rotation.x, 0.05 * f, k);
        p.inner.rotation.z = lerp(p.inner.rotation.z, 0, k);
        p.inner.position.y = lerp(p.inner.position.y, 0, k);
        p.armL.rotation.x = lerp(p.armL.rotation.x, lerp(-1.15, -1.15, f), k);
        p.armL.rotation.z = lerp(p.armL.rotation.z, lerp(0.25, 0.35, f), k);
        p.armR.rotation.x = lerp(p.armR.rotation.x, lerp(-1.3, -1.15, f), k);
        p.armR.rotation.z = lerp(p.armR.rotation.z, lerp(-0.1, -0.35, f), k);
        p.legL.rotation.x = lerp(p.legL.rotation.x, -1.35 * f, k);
        p.legL.rotation.z = lerp(p.legL.rotation.z, 0.08 * f, k);
        p.legR.rotation.x = lerp(p.legR.rotation.x, -1.3 * f, k);
        p.legR.rotation.z = lerp(p.legR.rotation.z, -0.08 * f, k);
      }
      return;
    }
    p.inner.rotation.z = 0;
    // 翻越姿势: 收腿前倾 + 单手撑沿
    if (this.vault) {
      const k = Math.min(1, this.vault.t / this.vault.dur);
      const tuck = Math.sin(Math.min(1, k) * Math.PI); // 中段收腿最大
      p.inner.rotation.x = 0.45 * tuck;
      p.inner.rotation.y = 0;
      p.inner.position.y = 0;
      p.inner.position.z = 0;
      p.legL.rotation.x = -1.45 * tuck;
      p.legR.rotation.x = -1.25 * tuck;
      p.armL.rotation.set(-1.15 + 0.5 * tuck, 0, 0.3);
      p.armR.rotation.set(-0.5 - 0.4 * tuck, 0, -0.25); // 右臂下压撑沿
      p.armL.position.z = 0;
      p.armR.position.z = 0;
      return;
    }
    // 击倒姿态强制卧倒, 不受站/蹲/趴输入覆盖
    if (this.knockF > 0.001) {
      this.swimF = 0;
      const f = this.knockF * this.knockF * (3 - 2 * this.knockF);
      p.inner.rotation.set((Math.PI / 2 - 0.12) * f, 0, 0);
      p.inner.position.set(0, 0.3 * f, 0);
      p.armL.rotation.set(lerp(-1.15, -1.55, f), 0, lerp(0.25, 0.38, f));
      p.armR.rotation.set(lerp(-1.3, -1.35, f), 0, lerp(-0.1, -0.22, f));
      p.armL.position.z = 0;
      p.armR.position.z = 0;
      p.legL.rotation.set(0.18 * f, 0, 0.08 * f);
      p.legR.rotation.set(-0.12 * f, 0, -0.08 * f);
      return;
    }
    // 游泳姿势: 水平俯身贴水面 + 交替划臂打水(swimF 平滑进出)
    this.swimF = clamp(this.swimF + (this.swimming ? 4.2 : -7.5) * dt, 0, 1);
    if (this.swimF > 0.001) {
      const f = this.swimF;
      const ph = this.swimT * 3.6;
      const sL = Math.sin(ph);
      const sR = Math.sin(ph + Math.PI);
      const motionF = clamp(this.speed2d / SWIM_SPEED, 0, 1);
      const sprintF = this.swimming
        ? clamp((this.speed2d - SWIM_SPEED) / (SWIM_SPRINT_SPEED - SWIM_SPEED), 0, 1)
        : 0;
      const armStroke = 0.14 + motionF * 0.38 + sprintF * 0.38;
      const legKick = 0.04 + motionF * 0.08 + sprintF * 0.12;
      p.inner.rotation.x = f * (Math.PI / 2 - 0.22 + sprintF * 0.08); // 加速时更水平
      p.inner.rotation.z = Math.sin(ph * 0.5) * (0.012 + motionF * 0.02 + sprintF * 0.065) * f;
      p.inner.rotation.y = 0;
      p.inner.position.y = f * (0.6 + sprintF * 0.04);
      p.inner.position.z = 0;
      p.armL.rotation.set(
        -1.15 + f * (-0.3 + sL * armStroke),
        sL * sprintF * 0.18,
        0.25 + f * 0.1,
      );
      p.armR.rotation.set(
        -1.3 + f * (-0.15 + sR * armStroke),
        sR * sprintF * 0.18,
        -0.1 - f * 0.1,
      );
      p.armL.position.z = 0;
      p.armR.position.z = 0;
      p.legL.rotation.x = f * (0.08 + sR * legKick);
      p.legR.rotation.x = f * (0.08 + sL * legKick);
      return;
    }
    // 交互动作: 开门/拾取/切枪为短动作, 恢复和救援维持到读条结束。
    if (this.visualAction && this.visualAction !== 'interact' && this.visualAction !== 'equip' && this.actionF > 0.001) {
      const f = this.actionF * this.actionF * (3 - 2 * this.actionF);
      p.inner.rotation.y = 0;
      p.inner.rotation.z = 0;
      p.inner.position.z = 0;
      p.armL.position.z = 0;
      p.armR.position.z = 0;
      if (this.visualAction === 'revive') {
        p.inner.rotation.x = 0.34 * f;
        p.inner.position.y = -0.42 * f;
        p.legL.rotation.set(-0.95 * f, 0, 0.08 * f);
        p.legR.rotation.set(-1.28 * f, 0, -0.08 * f);
        p.armL.rotation.set(lerp(-1.15, -2.05, f), 0, lerp(0.25, 0.42, f));
        p.armR.rotation.set(lerp(-1.3, -1.9, f), 0, lerp(-0.1, -0.32, f));
      } else if (this.visualAction === 'pickup') {
        p.inner.rotation.x = 0.52 * f;
        p.inner.position.y = -0.26 * f;
        p.legL.rotation.set(-0.55 * f, 0, 0);
        p.legR.rotation.set(-0.72 * f, 0, 0);
        p.armL.rotation.set(lerp(-1.15, -1.7, f), 0, lerp(0.25, 0.36, f));
        p.armR.rotation.set(lerp(-1.3, -2.2, f), 0, lerp(-0.1, -0.24, f));
        p.armR.position.z = 0.22 * f;
      } else if (this.visualAction === 'heal' || this.visualAction === 'drink') {
        const drink = this.visualAction === 'drink';
        p.inner.rotation.x = 0.12 * f;
        p.inner.position.y = -0.1 * f;
        p.legL.rotation.set(-0.22 * f, 0, 0);
        p.legR.rotation.set(-0.22 * f, 0, 0);
        p.armL.rotation.set(lerp(-1.15, -1.75, f), 0, lerp(0.25, 0.34, f));
        p.armR.rotation.set(lerp(-1.3, drink ? -2.65 : -1.82, f), 0, lerp(-0.1, -0.3, f));
        p.armR.position.z = (drink ? 0.1 : 0.22) * f;
      } else {
        p.inner.rotation.x = 0.08 * f;
        p.inner.position.y = 0;
        p.legL.rotation.set(0, 0, 0);
        p.legR.rotation.set(0, 0, 0);
        p.armL.rotation.set(-1.15, 0, 0.25);
        p.armR.rotation.set(lerp(-1.3, -2.25, f), 0, lerp(-0.1, -0.2, f));
        p.armR.position.z = 0.28 * f;
      }
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
      if (this.melee.def.id !== 'fists') {
        // 近战装备: 大幅度横斩或挥击(手臂横扫过身)
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
    // 使用完整欧拉角复位，避免自由落体的侧向展开角残留到落地、站立和跑步姿态。
    p.legL.rotation.set(legSwing + legBend, 0, 0);
    p.legR.rotation.set(-legSwing + legBend, 0, 0);
    // 身体下沉(蹲 -0.53 / 趴 +0.30 由旋转完成趴倒)与旋转(趴 = 面朝下平躺, 部分随瞄准俯仰)
    p.inner.position.y = bob - 0.53 * fC + 0.83 * fP;
    // 移动前倾(速度越大越前倾, 趴下不再加)
    const lean = Math.min(1, this.speed2d / 6.6) * 0.18 * (1 - fP);
    p.inner.rotation.x = 0.2 * fC + lean + fP * (Math.PI / 2 - 0.2 - clamp(this.aimPitch, -0.5, 0.5) * 0.6);
    p.inner.rotation.z = this.moveLean * 0.075 * (1 - fP);
    if (this.reload01 > 0) {
      const phase = Math.sin(clamp(this.reload01, 0, 1) * Math.PI);
      p.inner.rotation.y = -0.08 * phase;
      p.armL.rotation.set(
        lerp(p.armL.rotation.x, -2.2, phase),
        0,
        lerp(p.armL.rotation.z, 0.34, phase),
      );
      p.armR.rotation.set(
        lerp(p.armR.rotation.x, -1.82, phase),
        0,
        lerp(p.armR.rotation.z, -0.22, phase),
      );
      p.armL.position.z = 0.16 * phase;
    }
    if ((this.visualAction === 'interact' || this.visualAction === 'equip') && this.actionF > 0.001) {
      const f = this.actionF * this.actionF * (3 - 2 * this.actionF);
      if (this.visualAction === 'equip') {
        p.armL.rotation.x = lerp(p.armL.rotation.x, -1.65, f);
        p.armL.rotation.z = lerp(p.armL.rotation.z, 0.46, f);
        p.armR.rotation.x = lerp(p.armR.rotation.x, -1.7, f);
        p.armR.rotation.z = lerp(p.armR.rotation.z, -0.24, f);
      } else {
        p.inner.rotation.y = -0.08 * f;
        p.armR.rotation.x = lerp(p.armR.rotation.x, -2.25, f);
        p.armR.rotation.z = lerp(p.armR.rotation.z, -0.2, f);
        p.armR.position.z = 0.28 * f;
      }
    }
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

// 共享位移入口: 游泳走水面浮动, 否则常规重力位移
export function moveChar(
  c: Character,
  vx: number,
  vz: number,
  dt: number,
  world: World,
  swimMaxSpeed = SWIM_SPEED,
): void {
  if (c.swimming) {
    const l = Math.hypot(vx, vz);
    if (l > swimMaxSpeed) {
      const s = swimMaxSpeed / l;
      vx *= s;
      vz *= s;
    }
    c.applySwim(vx, vz, dt, world);
  } else {
    c.applyMove(vx, vz, dt, world);
  }
}
