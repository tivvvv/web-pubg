// 低多边形人形角色(玩家与 bot 共用) + 背包物品 + 命中体 + 姿态(站/蹲/趴)
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applySurfaceAsset } from './assets';
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
export const GROUND_SNAP_DISTANCE = 0.22;

export function shouldSnapToGround(wasGrounded: boolean, verticalVelocity: number, gap: number): boolean {
  return wasGrounded && verticalVelocity <= 0 && gap >= 0 && gap <= GROUND_SNAP_DISTANCE;
}

export function advancePoseBlend(current: number, active: boolean, dt: number, enterRate: number, exitRate: number): number {
  return clamp(current + (active ? enterRate : -exitRate) * dt, 0, 1);
}

export interface LocomotionPose {
  legL: number;
  legR: number;
  kneeL: number;
  kneeR: number;
  armSwing: number;
  bob: number;
  hipYaw: number;
  shoulderRoll: number;
  lateral: number;
}

// 相位驱动的步态采样让脚步落点, 膝盖弯曲, 手臂反摆和重心起伏保持同一节奏。
export function locomotionPose(phase: number, speed: number, stanceF: number, blend = 1): LocomotionPose {
  const motion = clamp(speed / 6.9, 0, 1) * clamp(blend, 0, 1);
  const crouch = Math.min(stanceF, 1);
  const prone = Math.max(0, stanceF - 1);
  const strideScale = clamp(blend, 0, 1) * (1 - crouch * 0.5 - prone * 0.72);
  const stride = Math.sin(phase);
  const harmonic = Math.sin(phase * 2) * motion * 0.08;
  // Bend the knee that is travelling forward. Deriving the lift from the
  // stride itself keeps the knee and thigh in phase at every frame rate.
  const leftLift = Math.max(0, -stride + harmonic);
  const rightLift = Math.max(0, stride + harmonic);
  const amplitude = (0.3 + motion * 0.56) * strideScale;
  return {
    legL: (stride + harmonic) * amplitude,
    legR: (-stride + harmonic) * amplitude,
    kneeL: leftLift * (0.12 + motion * 0.5) * strideScale,
    kneeR: rightLift * (0.12 + motion * 0.5) * strideScale,
    armSwing: -(stride + harmonic * 0.45) * (0.2 + motion * 0.46) * strideScale,
    bob: (0.5 - Math.cos(phase * 2) * 0.5) * (0.014 + motion * 0.045) * (1 - crouch * 0.72),
    hipYaw: -stride * motion * 0.105 * (1 - prone),
    shoulderRoll: (-stride * 0.026 + Math.sin(phase * 2) * 0.012) * motion * (1 - prone),
    lateral: Math.cos(phase) * motion * 0.018 * strideScale,
  };
}

export interface MeleeMotionPose {
  windup: number;
  extension: number;
  recovery: number;
}

function smoothRange(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(0.001, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// 预备、爆发、回收分成三段，避免旧动画只在前半程抽动一次后僵直等待冷却。
export function meleeMotionPose(progress: number): MeleeMotionPose {
  const p = clamp(progress, 0, 1);
  const strike = smoothRange(0.16, 0.4, p);
  const recover = smoothRange(0.52, 0.98, p);
  return {
    windup: smoothRange(0, 0.2, p) * (1 - strike),
    extension: strike * (1 - recover),
    recovery: recover,
  };
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

interface SharedCanopyAssets {
  lightPanels: THREE.BufferGeometry;
  darkPanels: THREE.BufferGeometry;
  lines: THREE.BufferGeometry;
  trailing: THREE.BufferGeometry;
  lineMaterial: THREE.LineBasicMaterial;
  trailingMaterial: THREE.MeshBasicMaterial;
}

let sharedCanopyAssets: SharedCanopyAssets | null = null;
const canopyMaterialCache = new Map<number, readonly [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial]>();

function canopyAssets(): SharedCanopyAssets {
  if (sharedCanopyAssets) return sharedCanopyAssets;
  const light: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const panelCount = 9;
  for (let i = 0; i < panelCount; i++) {
    const geometry = new THREE.SphereGeometry(
      1, 4, 3, (i / panelCount) * Math.PI * 2, Math.PI * 2 / panelCount, 0, Math.PI / 2,
    );
    geometry.scale(2.65, 0.74, 1.58);
    geometry.translate(0, 0.22, 0);
    (i % 2 === 0 ? light : dark).push(geometry);
  }
  const lightPanels = mergeGeometries(light, false);
  const darkPanels = mergeGeometries(dark, false);
  for (const geometry of [...light, ...dark]) geometry.dispose();
  if (!lightPanels || !darkPanels) throw new Error('降落伞面板合批失败');

  const linePos: number[] = [];
  for (const [lx, lz] of [[-2.15, -0.82], [-2.15, 0.82], [-0.8, -1.28], [-0.8, 1.28], [0.8, -1.28], [0.8, 1.28], [2.15, -0.82], [2.15, 0.82]] as const) {
    const harnessX = Math.sign(lx) * 0.3;
    const harnessZ = Math.sign(lz) * 0.18;
    linePos.push(lx, 0.2, lz, harnessX, -2.48, harnessZ);
  }
  const lines = new THREE.BufferGeometry();
  lines.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
  const trailing = new THREE.TorusGeometry(1, 0.025, 4, 24, Math.PI);
  trailing.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0.22, 0),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)),
    new THREE.Vector3(2.62, 1.55, 1),
  ));
  sharedCanopyAssets = {
    lightPanels,
    darkPanels,
    lines,
    trailing,
    lineMaterial: new THREE.LineBasicMaterial({ color: 0xe3ddd0, transparent: true, opacity: 0.92 }),
    trailingMaterial: new THREE.MeshBasicMaterial({ color: 0x2d332c }),
  };
  return sharedCanopyAssets;
}

function canopyMaterials(color: number): readonly [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] {
  const key = color >>> 0;
  const cached = canopyMaterialCache.get(key);
  if (cached) return cached;
  const base = new THREE.Color(key);
  const materials = [
    new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(1.08), roughness: 0.86, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: base.clone().multiplyScalar(0.82), roughness: 0.86, side: THREE.DoubleSide }),
  ] as const;
  canopyMaterialCache.set(key, materials);
  return materials;
}

export function stepAirDescentVelocity(vy: number, phase: AirDescentPhase, dt: number): number {
  const terminal = phase === 'freefall' ? FREEFALL_TERMINAL_VELOCITY : CANOPY_TERMINAL_VELOCITY;
  const response = phase === 'freefall' ? FREEFALL_VELOCITY_RESPONSE : CANOPY_VELOCITY_RESPONSE;
  return vy + (terminal - vy) * (1 - Math.exp(-dt * response));
}

// 空降水平位移按角色半径细分并逐段解算。直接一次移动到终点会在卡顿帧跨过
// 薄外墙，而且旧空降逻辑完全未调用静态碰撞，最终会把人送进建筑内部。
export function moveAirDescentHorizontal(
  position: THREE.Vector3,
  deltaX: number,
  deltaZ: number,
  radius: number,
  world: Pick<World, 'resolveCollision'>,
): boolean {
  if (![position.x, position.y, position.z, deltaX, deltaZ, radius].every(Number.isFinite) || radius <= 0) return false;
  const distance = Math.hypot(deltaX, deltaZ);
  if (distance <= 1e-7) return false;
  const steps = Math.min(64, Math.max(1, Math.ceil(distance / Math.max(0.08, radius * 0.36))));
  const stepX = deltaX / steps;
  const stepZ = deltaZ / steps;
  let collided = false;
  for (let step = 0; step < steps; step++) {
    const targetX = position.x + stepX;
    const targetZ = position.z + stepZ;
    position.x = targetX;
    position.z = targetZ;
    world.resolveCollision(position, radius);
    if (Math.abs(position.x - targetX) > 1e-5 || Math.abs(position.z - targetZ) > 1e-5) collided = true;
  }
  return collided;
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
  elbowL: THREE.Group;
  elbowR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  gun: THREE.Group;      // 手部锚点(当前持械模型挂在这里)
  held: WeaponModel | null; // 当前持械模型(含 muzzle/mag)
  muzzleFallback: THREE.Object3D; // 徒手时的枪口兜底点
}

// 共享几何体(跨对局复用, 重开不泄漏)
const GEO = {
  head: new THREE.BoxGeometry(0.36, 0.36, 0.34),
  torso: new THREE.BoxGeometry(0.44, 0.54, 0.24),
  waist: new THREE.BoxGeometry(0.34, 0.15, 0.22),
  upperArm: new THREE.BoxGeometry(0.13, 0.29, 0.13),
  forearm: new THREE.BoxGeometry(0.125, 0.29, 0.125),
  hand: new THREE.BoxGeometry(0.13, 0.13, 0.13),
  thigh: new THREE.BoxGeometry(0.16, 0.31, 0.17),
  shin: new THREE.BoxGeometry(0.15, 0.31, 0.16),
  boot: new THREE.BoxGeometry(0.16, 0.13, 0.24),
};
// 细节件共享几何(面部/领口/护具/鞋底等, 一次创建全局复用)
const GEO_D = {
  neck: new THREE.BoxGeometry(0.12, 0.09, 0.12),
  eye: new THREE.BoxGeometry(0.055, 0.04, 0.012),
  brow: new THREE.BoxGeometry(0.06, 0.012, 0.012),
  mouth: new THREE.BoxGeometry(0.065, 0.01, 0.01),
  collar: new THREE.BoxGeometry(0.13, 0.055, 0.03),
  chestPanel: new THREE.BoxGeometry(0.32, 0.18, 0.018),
  chestSeam: new THREE.BoxGeometry(0.27, 0.018, 0.014),
  belt: new THREE.BoxGeometry(0.36, 0.05, 0.24),
  buckle: new THREE.BoxGeometry(0.065, 0.04, 0.018),
  cuff: new THREE.BoxGeometry(0.135, 0.05, 0.135),
  kneePad: new THREE.BoxGeometry(0.13, 0.09, 0.035),
  sole: new THREE.BoxGeometry(0.15, 0.028, 0.245),
  elbowPad: new THREE.BoxGeometry(0.105, 0.075, 0.035),
  hair: new THREE.BoxGeometry(0.37, 0.1, 0.35),
  hairBack: new THREE.BoxGeometry(0.37, 0.23, 0.055),
  cargo: new THREE.BoxGeometry(0.028, 0.12, 0.09),
  backYoke: new THREE.BoxGeometry(0.31, 0.075, 0.016),
  bootToe: new THREE.BoxGeometry(0.15, 0.06, 0.1),
};

const MAT = {
  boot: new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 0.9 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.68, metalness: 0.08 }), // 面罩/护具/手套
  strap: new THREE.MeshStandardMaterial({ color: 0x2f2a22, roughness: 0.88 }), // 胸挂/腰带
  glove: new THREE.MeshStandardMaterial({ color: 0x3a342c, roughness: 0.92 }),
  sole: new THREE.MeshStandardMaterial({ color: 0x1b1712, roughness: 0.96 }),
  hair: new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.9 }),
  face: new THREE.MeshStandardMaterial({ color: 0x292522, roughness: 0.88 }),
  lip: new THREE.MeshStandardMaterial({ color: 0x8a5142, roughness: 0.9 }),
};
applySurfaceAsset(MAT.boot, 'fabric', 3.6, 0.48);
applySurfaceAsset(MAT.dark, 'fabric', 3.8, 0.42);
applySurfaceAsset(MAT.strap, 'fabric', 4.5, 0.58);
applySurfaceAsset(MAT.glove, 'fabric', 4.2, 0.58);
applySurfaceAsset(MAT.sole, 'fabric', 4.8, 0.36);

// 裤装配色(bot 按索引错开, 远距可读)
const PANTS_COLORS = [0x3d4436, 0x37404a, 0x4a3f33, 0x2f3a2f, 0x46464e];
const SKIN_COLORS = [0xd7a06a, 0xb9794f, 0xe0b07a, 0x9b6547, 0xc98d61];
const HAIR_COLORS = [0x35251d, 0x241e1b, 0x4a3224, 0x1f2022];
const skinCache = new Map<number, THREE.MeshStandardMaterial>();
const hairCache = new Map<number, THREE.MeshStandardMaterial>();

function cachedCharacterMaterial(
  cache: Map<number, THREE.MeshStandardMaterial>, color: number, roughness: number,
): THREE.MeshStandardMaterial {
  let material = cache.get(color);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, roughness });
    cache.set(color, material);
  }
  return material;
}

const shirtCache = new Map<number, THREE.MeshStandardMaterial>();
const shirtDetailCache = new Map<number, THREE.MeshStandardMaterial>();
function shirtMat(color: number): THREE.MeshStandardMaterial {
  let m = shirtCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
    applySurfaceAsset(m, 'fabric', 3.2, 0.68);
    shirtCache.set(color, m);
  }
  return m;
}

function shirtDetailMat(color: number): THREE.MeshStandardMaterial {
  let material = shirtDetailCache.get(color);
  if (!material) {
    const detailColor = new THREE.Color(color).multiplyScalar(0.82);
    material = new THREE.MeshStandardMaterial({ color: detailColor, roughness: 0.92, metalness: 0 });
    applySurfaceAsset(material, 'fabric', 4.2, 0.6);
    shirtDetailCache.set(color, material);
  }
  return material;
}

const GHILLIE_MATERIALS = [0x4d6938, 0x617b42, 0x354f31, 0x7b7745].map((color) => {
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.98, side: THREE.DoubleSide });
  applySurfaceAsset(material, 'foliage', 4.8, 0.62);
  return material;
});
const GHILLIE_CORD = new THREE.MeshStandardMaterial({ color: 0x766f48, roughness: 1 });
applySurfaceAsset(GHILLIE_CORD, 'fabric', 7.5, 0.48);

export function buildGhillieSuitModel(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ghillie-suit';

  // 七边形斗篷代替单块背板, 轮廓从肩部收紧并向下自然散开。
  const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.39, 0.78, 7, 3, true), GHILLIE_MATERIALS[2]);
  cloak.name = 'ghillie-cloak';
  cloak.position.set(0, 1.03, -0.015);
  cloak.scale.z = 0.76;
  cloak.castShadow = true;
  group.add(cloak);

  const mantle = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.31, 0.22, 10, 2), GHILLIE_MATERIALS[1]);
  mantle.name = 'ghillie-mantle';
  mantle.position.set(0, 1.31, -0.015);
  mantle.scale.z = 0.78;
  mantle.castShadow = true;
  group.add(mantle);

  const backclothGeometry = new THREE.BufferGeometry();
  backclothGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.28, 1.35, -0.292,
    0.28, 1.35, -0.292,
    0.36, 0.69, -0.292,
    -0.36, 0.69, -0.292,
  ], 3));
  backclothGeometry.setIndex([0, 2, 1, 0, 3, 2]);
  backclothGeometry.computeVertexNormals();
  const backcloth = new THREE.Mesh(backclothGeometry, GHILLIE_MATERIALS[2]);
  backcloth.name = 'ghillie-backcloth';
  backcloth.castShadow = true;
  group.add(backcloth);

  const hood = new THREE.Mesh(
    new THREE.SphereGeometry(0.285, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.72),
    GHILLIE_MATERIALS[0],
  );
  hood.name = 'ghillie-hood';
  hood.position.set(0, 1.57, -0.035);
  hood.scale.set(1.08, 1.02, 1.14);
  hood.castShadow = true;
  group.add(hood);

  // 不等长的后摆和侧摆打破整齐底边, 避免像一块绿色纸板。
  const ragGeometry = new THREE.BoxGeometry(0.105, 0.46, 0.035, 1, 3, 1);
  for (let index = 0; index < 7; index++) {
    const rag = new THREE.Mesh(ragGeometry, GHILLIE_MATERIALS[(index + 1) % GHILLIE_MATERIALS.length]);
    rag.name = 'ghillie-rag';
    rag.position.set((index - 3) * 0.085, 0.78 - (index % 3) * 0.025, -0.285 + Math.abs(index - 3) * 0.008);
    rag.rotation.z = (index - 3) * 0.045;
    rag.scale.y = 0.76 + (index % 4) * 0.09;
    rag.castShadow = true;
    group.add(rag);
  }

  const leafGeometry = new THREE.BufferGeometry();
  leafGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.17, 0,
    -0.075, 0, 0,
    0, -0.17, 0,
    0.075, 0, 0,
    0, 0, 0.035,
  ], 3));
  leafGeometry.setIndex([
    0, 1, 4,
    1, 2, 4,
    2, 3, 4,
    3, 0, 4,
  ]);
  leafGeometry.computeVertexNormals();
  const clusters = [
    [-0.29, 1.38, -0.17, -0.42], [-0.14, 1.4, -0.25, 0.18], [0.03, 1.39, -0.28, -0.12],
    [0.18, 1.38, -0.24, 0.32], [0.3, 1.36, -0.16, 0.46],
    [-0.27, 1.2, -0.27, -0.52], [-0.08, 1.22, -0.32, 0.28], [0.12, 1.19, -0.33, -0.25],
    [0.28, 1.17, -0.25, 0.52], [-0.3, 0.98, -0.25, -0.44], [-0.13, 1.0, -0.34, 0.17],
    [0.05, 0.96, -0.35, -0.2], [0.24, 0.95, -0.29, 0.46], [-0.27, 0.76, -0.23, -0.35],
    [-0.08, 0.78, -0.34, 0.24], [0.13, 0.74, -0.32, -0.26], [0.29, 0.75, -0.22, 0.38],
    [-0.19, 1.69, -0.08, -0.28], [0.0, 1.72, -0.17, 0.08], [0.19, 1.68, -0.08, 0.3],
    [-0.29, 1.1, 0.11, -0.62], [0.29, 1.08, 0.1, 0.62],
  ] as const;
  for (let index = 0; index < clusters.length; index++) {
    const [x, y, z, rotation] = clusters[index] as typeof clusters[number];
    const leaf = new THREE.Mesh(leafGeometry, GHILLIE_MATERIALS[index % GHILLIE_MATERIALS.length]);
    leaf.name = 'ghillie-foliage';
    leaf.position.set(x, y, z);
    leaf.rotation.set(0.12 + (index % 4) * 0.18, rotation + (index % 3 - 1) * 0.24, rotation * 0.72);
    leaf.scale.set(0.82 + (index % 3) * 0.12, 0.82 + (index % 4) * 0.1, 1);
    leaf.castShadow = true;
    group.add(leaf);
  }

  // 麻绳丝条提供细节尺度, 近景时不再只有块面叶片。
  const strandGeometry = new THREE.CylinderGeometry(0.008, 0.012, 0.38, 5);
  for (let index = 0; index < 10; index++) {
    const strand = new THREE.Mesh(strandGeometry, GHILLIE_CORD);
    strand.name = 'ghillie-strand';
    strand.position.set(-0.27 + (index % 6) * 0.108, 0.93 + Math.floor(index / 6) * 0.27, -0.325);
    strand.rotation.z = ((index % 5) - 2) * 0.07;
    strand.castShadow = true;
    group.add(strand);
  }
  return group;
}

function buildGhillieLimbWrap(kind: 'arm' | 'leg', variant: number): THREE.Group {
  const group = new THREE.Group();
  group.name = kind === 'arm' ? 'ghillie-arm-wrap' : 'ghillie-leg-wrap';
  const height = kind === 'arm' ? 0.31 : 0.43;
  const radius = kind === 'arm' ? 0.105 : 0.13;
  const sleeve = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 1.12, height, 7, 2, true),
    GHILLIE_MATERIALS[(variant + 1) % GHILLIE_MATERIALS.length],
  );
  sleeve.position.y = kind === 'arm' ? -0.14 : -0.2;
  sleeve.scale.z = 0.8;
  sleeve.castShadow = true;
  group.add(sleeve);
  for (let index = 0; index < 3; index++) {
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(0.032, height * (0.54 + index * 0.08), 0.024),
      GHILLIE_MATERIALS[(variant + index + 2) % GHILLIE_MATERIALS.length],
    );
    strip.name = 'ghillie-limb-strip';
    strip.position.set((index - 1) * radius * 0.68, sleeve.position.y - height * 0.22, -radius * 0.78);
    strip.rotation.z = (index - 1) * 0.12;
    strip.castShadow = true;
    group.add(strip);
  }
  return group;
}

export function buildHumanoid(shirtColor: number, variant = 0): { group: THREE.Group; parts: HumanParts } {
  const group = new THREE.Group();
  const inner = new THREE.Group();
  group.add(inner);
  const body = new THREE.Group();
  inner.add(body);
  const shirt = shirtMat(shirtColor);
  const shirtDetail = shirtDetailMat(shirtColor);
  const pants = shirtMat(PANTS_COLORS[variant % PANTS_COLORS.length] as number);
  const skinColor = SKIN_COLORS[variant % SKIN_COLORS.length] as number;
  const hairColor = HAIR_COLORS[variant % HAIR_COLORS.length] as number;
  const skin = cachedCharacterMaterial(skinCache, skinColor, 0.84);
  const hairMaterial = cachedCharacterMaterial(hairCache, hairColor, 0.92);

  // 方块人使用单纯清晰的长方体轮廓。动画骨架仍保留，但关节不再额外挂球或护垫。
  const torso = new THREE.Mesh(GEO.torso, shirt);
  torso.name = 'torso';
  torso.position.set(0, 1.07, 0);
  torso.castShadow = true;
  body.add(torso);
  const chestPanel = new THREE.Mesh(GEO_D.chestPanel, shirtDetail);
  chestPanel.name = 'jacket-chest-panel';
  chestPanel.position.set(0, 0.075, 0.127);
  chestPanel.scale.set(1, 1, 0.8);
  torso.add(chestPanel);
  const chestSeam = new THREE.Mesh(GEO_D.chestSeam, shirtDetail);
  chestSeam.name = 'jacket-chest-seam';
  chestSeam.position.set(0, -0.105, 0.127);
  torso.add(chestSeam);

  const waist = new THREE.Mesh(GEO.waist, pants);
  waist.name = 'character-waist';
  waist.position.set(0, 0.77, 0);
  body.add(waist);
  const neck = new THREE.Mesh(GEO_D.neck, skin);
  neck.position.set(0, 1.38, 0);
  body.add(neck);
  for (const side of [-1, 1] as const) {
    const collar = new THREE.Mesh(GEO_D.collar, shirtDetail);
    collar.name = side < 0 ? 'collar-left' : 'collar-right';
    collar.position.set(0.07 * side, 1.34, 0.13);
    collar.rotation.set(-0.34, side * 0.12, side * 0.35);
    body.add(collar);
  }
  const belt = new THREE.Mesh(GEO_D.belt, MAT.strap);
  belt.name = 'character-belt';
  belt.position.set(0, 0.82, 0);
  body.add(belt);
  const buckle = new THREE.Mesh(GEO_D.buckle, MAT.dark);
  buckle.position.set(0, 0.82, 0.132);
  body.add(buckle);
  const backYoke = new THREE.Mesh(GEO_D.backYoke, shirt);
  backYoke.name = 'jacket-back-yoke';
  backYoke.position.set(0, 1.24, -0.129);
  body.add(backYoke);

  // 单块立方头配像素化五官和方形发片，接近经典方块人但保留本项目配色。
  const head = new THREE.Mesh(GEO.head, skin);
  head.name = 'head';
  head.position.set(0, 1.54, 0);
  head.castShadow = true;
  for (const side of [-1, 1] as const) {
    const eye = new THREE.Mesh(GEO_D.eye, MAT.face);
    eye.name = side < 0 ? 'eye-left' : 'eye-right';
    eye.position.set(side * 0.072, 0.025, 0.176);
    head.add(eye);
    const brow = new THREE.Mesh(GEO_D.brow, hairMaterial);
    brow.name = side < 0 ? 'brow-left' : 'brow-right';
    brow.position.set(side * 0.072, 0.072, 0.177);
    head.add(brow);
  }
  const mouth = new THREE.Mesh(GEO_D.mouth, MAT.lip);
  mouth.name = 'mouth';
  mouth.position.set(0, -0.085, 0.177);
  head.add(mouth);
  const hair = new THREE.Mesh(GEO_D.hair, hairMaterial);
  hair.name = 'hair-cap';
  hair.position.set(0, 0.155, 0);
  head.add(hair);
  const hairBack = new THREE.Mesh(GEO_D.hairBack, hairMaterial);
  hairBack.name = 'hair-back';
  hairBack.position.set(0, 0.045, -0.17);
  head.add(hairBack);
  body.add(head);

  // 手臂由两段方块组成，枢轴只负责动画且完全不可见。
  const mkArm = (side: 1 | -1): { root: THREE.Group; elbow: THREE.Group } => {
    const arm = new THREE.Group();
    arm.position.set(0.285 * side, 1.3, 0);
    const upper = new THREE.Mesh(GEO.upperArm, shirt);
    upper.name = side < 0 ? 'upper-arm-left' : 'upper-arm-right';
    upper.position.set(0, -0.145, 0);
    upper.castShadow = true;
    arm.add(upper);
    const sleeveBand = new THREE.Mesh(GEO_D.cuff, shirtDetail);
    sleeveBand.position.set(0, -0.285, 0);
    arm.add(sleeveBand);
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.29, 0);
    elbow.rotation.x = -0.35; // 肘部微屈
    const fore = new THREE.Mesh(GEO.forearm, shirt);
    fore.position.set(0, -0.14, 0);
    fore.castShadow = true;
    elbow.add(fore);
    // 方形袖口和手掌遮住段间缝隙，不显示圆形肘关节。
    const cuff = new THREE.Mesh(GEO_D.cuff, MAT.glove);
    cuff.position.set(0, -0.265, 0);
    elbow.add(cuff);
    const hand = new THREE.Mesh(GEO.hand, MAT.glove);
    hand.name = side < 0 ? 'hand-left' : 'hand-right';
    hand.position.set(0, -0.32, 0);
    elbow.add(hand);
    arm.add(elbow);
    arm.rotation.x = -1.15;
    arm.rotation.z = 0.25 * side * -1;
    return { root: arm, elbow };
  };
  const leftArm = mkArm(-1);
  const armL = leftArm.root;
  armL.rotation.z = 0.25;
  inner.add(armL);
  const rightArm = mkArm(1);
  const armR = rightArm.root;
  armR.rotation.x = -1.3;
  armR.rotation.z = -0.1;
  inner.add(armR);

  // 双腿同样采用无可见关节的方块段，保留膝枢轴以兼容跑步、游泳和倒地动作。
  const mkLeg = (side: 1 | -1): { root: THREE.Group; knee: THREE.Group } => {
    const leg = new THREE.Group();
    leg.position.set(0.095 * side, 0.75, 0);
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
    boot.name = side < 0 ? 'boot-left' : 'boot-right';
    boot.position.set(0, -0.405, 0.035);
    knee.add(boot);
    // 鞋底(深色伪 AO 接地感)
    const sole = new THREE.Mesh(GEO_D.sole, MAT.sole);
    sole.position.set(0, -0.064, 0.008);
    boot.add(sole);
    leg.add(knee);
    return { root: leg, knee };
  };
  const leftLeg = mkLeg(-1);
  const legL = leftLeg.root;
  body.add(legL);
  const rightLeg = mkLeg(1);
  const legR = rightLeg.root;
  body.add(legR);

  // 手部锚点(武器模型挂载点, 模型原点=握把, 指向 +Z 前方)
  const gun = new THREE.Group();
  gun.position.set(0.19, 1.26, 0.34);
  const muzzleFallback = new THREE.Object3D();
  muzzleFallback.position.set(0, 0.02, 0.4);
  gun.add(muzzleFallback);
  inner.add(gun);

  return {
    group,
    parts: {
      inner, body, torso, head,
      armL, armR, elbowL: leftArm.elbow, elbowR: rightArm.elbow,
      legL, legR, kneeL: leftLeg.knee, kneeR: rightLeg.knee,
      gun, held: null, muzzleFallback,
    },
  };
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
  throwables: Record<ThrowableId, number> = { frag: 0, smoke: 0, flash: 0 };
  throwKind: ThrowableId = 'frag'; // 当前选中的投掷物类型
  flashT = 0; // 闪光弹致盲/失能剩余时间
  curSlot = 3; // 0/1 主武器, 2 手枪, 3 近战, 4 投掷物
  helmet: ArmorState | null = null;  // 已装备头盔(减头部伤害)
  vest: ArmorState | null = null;    // 已装备防弹衣(减身体伤害)
  pack: { level: PackLevel } | null = null; // 已装备背包(加负重)
  ghillie = false; // 林中宝箱的唯一吉利服, 提供外观和侦察距离减益

  swingT = 0;          // 挥击动画进度(1→0)
  swingSide = 1;       // 出拳侧(1 右 / -1 左, 每次挥击交替)
  lastMeleeT = -100;   // 上次挥击时间
  dieT = -1;           // >=0 表示死亡动画进度
  stance: Stance = 'stand'; // 姿态: 站/蹲/趴
  stanceF = 0;         // 姿态插值 0站→1蹲→2趴(平滑过渡)
  groundH = 0;         // 脚下地面高(供贴地阴影)
  airPose: 'fall' | 'canopy' | 'sit' | 'moto' | null = null; // 空降姿势/乘车坐姿(驾驶时收枪)
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
  private visualAirPose: 'fall' | 'canopy' | 'sit' | 'moto' | null = null;
  private deathPoseCaptured = false;
  private deathStartRotX = 0;
  private deathStartY = 0;
  canopyGroup: THREE.Group | null = null;   // 降落伞模型(开伞挂载, 落地卸载)
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
  private ghillieMesh: THREE.Group | null = null;
  private actionF = 0;
  private actionDuration = 0;
  private visualAction: CharacterAction | 'revive' | null = null;
  private locomotionF = 0;
  private idleT = 0;

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

  equipGhillie(): boolean {
    if (this.ghillie) return false;
    this.ghillie = true;
    this.ghillieMesh = buildGhillieSuitModel();
    this.parts.body.add(this.ghillieMesh);
    this.parts.armL.add(buildGhillieLimbWrap('arm', 0));
    this.parts.armR.add(buildGhillieLimbWrap('arm', 1));
    this.parts.legL.add(buildGhillieLimbWrap('leg', 2));
    this.parts.legR.add(buildGhillieLimbWrap('leg', 3));
    return true;
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
    if (continuing) {
      this.actionT = Math.max(this.actionT, duration);
      this.actionDuration = Math.max(this.actionDuration, this.actionT);
    } else {
      this.actionT = duration;
      this.actionDuration = duration;
    }
  }

  cancelAction(pose?: CharacterAction): void {
    if (pose && this.actionPose !== pose) return;
    this.actionPose = null;
    this.actionT = 0;
    this.actionDuration = 0;
  }

  // 挂载降落伞(开伞): 弧形伞盖 + 吊绳, 跟随角色
  attachCanopy(color: number): void {
    this.removeCanopy();
    const g = new THREE.Group();
    const assets = canopyAssets();
    const materials = canopyMaterials(color);
    const lightPanels = new THREE.Mesh(assets.lightPanels, materials[0]);
    const darkPanels = new THREE.Mesh(assets.darkPanels, materials[1]);
    lightPanels.castShadow = true;
    darkPanels.castShadow = true;
    g.add(lightPanels, darkPanels);
    g.add(new THREE.LineSegments(assets.lines, assets.lineMaterial));
    // 伞盖后缘黑色导流带, 远距离也能读出伞面轮廓。
    g.add(new THREE.Mesh(assets.trailing, assets.trailingMaterial));
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
    this.parts.gun.position.set(fpp ? 0.16 : 0.19, fpp ? 1.28 : 1.26, fpp ? 0.54 : 0.34);
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
    const wasGrounded = this.grounded;
    this.pos.x += vx * dt;
    this.pos.z += vz * dt;
    this.vy -= 22 * dt;
    this.pos.y += this.vy * dt;
    world.resolveCollision(this.pos, this.radius);
    const ground = world.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.1);
    this.groundH = ground;
    if (this.pos.y <= ground || shouldSnapToGround(wasGrounded, this.vy, this.pos.y - ground)) {
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
    p.inner.position.x = 0;
    this.idleT += dt;
    this.locomotionF = advancePoseBlend(
      this.locomotionF,
      moving && this.speed2d > 0.18 && this.grounded && !this.swimming,
      dt,
      5.8,
      7.5,
    );
    const breathe = Math.sin(this.idleT * 1.75) * (1 - this.locomotionF) * 0.012;
    p.torso.scale.set(1 + breathe * 0.3, 1 + breathe, 0.72 + breathe * 0.16);
    p.head.position.y = 1.54 + breathe * 0.55;
    p.head.rotation.set(-this.aimPitch * 0.16, 0, 0);
    p.elbowL.rotation.set(-0.35, 0, 0);
    p.elbowR.rotation.set(-0.35, 0, 0);
    p.kneeL.rotation.set(0, 0, 0);
    p.kneeR.rotation.set(0, 0, 0);
    this.knockF = advancePoseBlend(this.knockF, this.knocked, dt, 5.2, 3.4);
    if (this.airPose) this.visualAirPose = this.airPose;
    this.airPoseF = advancePoseBlend(this.airPoseF, this.airPose !== null, dt, 6.5, 4.5);
    if (!this.airPose && this.airPoseF <= 0) this.visualAirPose = null;
    this.actionT = Math.max(0, this.actionT - dt);
    if (this.actionT <= 0) this.actionPose = null;
    const actionProgress = this.actionDuration > 0
      ? clamp(1 - this.actionT / this.actionDuration, 0, 1)
      : 1;
    const actionMotion = this.actionPose ? Math.sin(actionProgress * Math.PI) : 0;
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
      this.firstPerson ? 0.16 : 0.19,
      (this.firstPerson ? 1.28 : 1.26) - this.gunKick * 0.12,
      (this.firstPerson ? 0.54 : 0.34) - this.gunKick,
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
        p.kneeL.rotation.x = 0.18 * f;
        p.kneeR.rotation.x = 0.28 * f;
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
        p.elbowL.rotation.x = lerp(-0.35, -0.72, f);
        p.elbowR.rotation.x = lerp(-0.35, -0.72, f);
        p.kneeL.rotation.x = 0.38 * f;
        p.kneeR.rotation.x = 0.5 * f;
      } else if (this.visualAirPose === 'moto') {
        // 摩托驾驶员前倾贴近车把，双手与握把同宽且肘部只保留自然微屈。
        p.inner.rotation.x = lerp(p.inner.rotation.x, 0.2 * f, k);
        p.inner.rotation.y = lerp(p.inner.rotation.y, 0, k);
        p.inner.rotation.z = lerp(p.inner.rotation.z, 0, k);
        p.inner.position.y = lerp(p.inner.position.y, 0, k);
        p.inner.position.z = lerp(p.inner.position.z, 0, k);
        p.armL.rotation.x = lerp(p.armL.rotation.x, -1 * f, k);
        p.armL.rotation.z = lerp(p.armL.rotation.z, 0, k);
        p.armR.rotation.x = lerp(p.armR.rotation.x, -1 * f, k);
        p.armR.rotation.z = lerp(p.armR.rotation.z, 0, k);
        p.armL.position.z = lerp(p.armL.position.z, 0, k);
        p.armR.position.z = lerp(p.armR.position.z, 0, k);
        p.elbowL.rotation.x = lerp(p.elbowL.rotation.x, -0.15 * f, k);
        p.elbowR.rotation.x = lerp(p.elbowR.rotation.x, -0.15 * f, k);
        p.legL.rotation.x = lerp(p.legL.rotation.x, -1.38 * f, k);
        p.legL.rotation.z = lerp(p.legL.rotation.z, 0.12 * f, k);
        p.legR.rotation.x = lerp(p.legR.rotation.x, -1.38 * f, k);
        p.legR.rotation.z = lerp(p.legR.rotation.z, -0.12 * f, k);
        p.kneeL.rotation.x = 1.28 * f;
        p.kneeR.rotation.x = 1.28 * f;
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
        p.elbowL.rotation.x = lerp(-0.35, -0.62, f);
        p.elbowR.rotation.x = lerp(-0.35, -0.62, f);
        p.kneeL.rotation.x = 1.22 * f;
        p.kneeR.rotation.x = 1.18 * f;
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
      p.kneeL.rotation.x = 1.05 * tuck;
      p.kneeR.rotation.x = 0.9 * tuck;
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
      p.kneeL.rotation.x = 0.22 * f;
      p.kneeR.rotation.x = 0.32 * f;
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
      p.elbowL.rotation.x = -0.35 + Math.max(0, sL) * (0.48 + sprintF * 0.28) * f;
      p.elbowR.rotation.x = -0.35 + Math.max(0, sR) * (0.48 + sprintF * 0.28) * f;
      p.kneeL.rotation.x = Math.max(0, sR) * (0.22 + sprintF * 0.18) * f;
      p.kneeR.rotation.x = Math.max(0, sL) * (0.22 + sprintF * 0.18) * f;
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
        const reach = f * (0.48 + actionMotion * 0.52);
        p.inner.rotation.x = 0.52 * reach;
        p.inner.position.y = -0.26 * reach;
        p.legL.rotation.set(-0.55 * reach, 0, 0);
        p.legR.rotation.set(-0.72 * reach, 0, 0);
        p.armL.rotation.set(lerp(-1.15, -1.7, reach), 0, lerp(0.25, 0.36, reach));
        p.armR.rotation.set(lerp(-1.3, -2.2, reach), 0, lerp(-0.1, -0.24, reach));
        p.armR.position.z = 0.22 * reach;
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
    let meleeBodyLean = 0;
    let meleeBodyDip = 0;
    // 挥击动画(预备→爆发→回收: 交替直拳 / 砍刀横斩; 命中时机不变)
    if (this.swingT > 0) {
      this.swingT = Math.max(0, this.swingT - dt * 2.9);
      const prog = 1 - this.swingT; // 0→1
      const motion = meleeMotionPose(prog);
      const ext = motion.extension;
      const side = this.swingSide;
      const arm = side > 0 ? p.armR : p.armL;
      const offArm = side > 0 ? p.armL : p.armR;
      const elbow = side > 0 ? p.elbowR : p.elbowL;
      const offElbow = side > 0 ? p.elbowL : p.elbowR;
      if (this.melee.def.id !== 'fists') {
        // 近战装备: 先向持械侧蓄力，再横扫过身体并自然回收。
        arm.rotation.x = -1.18 - ext * 0.42 - motion.windup * 0.18;
        arm.rotation.z = side * (0.82 + motion.windup * 0.42 - ext * 1.65);
        arm.position.z = 0.06 + ext * 0.3 - motion.windup * 0.05;
        elbow.rotation.x = -0.38 + ext * 0.22;
        offArm.rotation.x = -0.52 - ext * 0.28;
        offArm.rotation.z = -side * 0.24;
        offElbow.rotation.x = -0.62;
      } else {
        // 交替直拳: 后撤蓄力、肩部送拳、肘部伸直，另一只手保持护脸。
        arm.rotation.x = -0.42 - motion.windup * 0.34 - ext * 1.48;
        arm.rotation.y = side * (motion.windup * 0.12 - ext * 0.09);
        arm.rotation.z = -side * (0.11 + ext * 0.13);
        arm.position.z = ext * 0.42 - motion.windup * 0.07;
        elbow.rotation.x = -0.5 + ext * 0.43;
        offArm.rotation.x = -0.62 - ext * 0.3;
        offArm.rotation.y = -side * 0.08;
        offArm.rotation.z = side * 0.22;
        offArm.position.z = 0.08 + ext * 0.05;
        offElbow.rotation.x = -0.72;
      }
      p.inner.rotation.y = side * (motion.windup * 0.16 - ext * 0.36);
      p.inner.position.z = ext * 0.1 - motion.windup * 0.025;
      meleeBodyLean = ext * 0.11;
      meleeBodyDip = ext * 0.045;
    } else {
      // 复位。徒手步态会在下方把双臂放回身体两侧，持械姿态仍由武器段覆盖。
      p.armR.rotation.x = -1.3;
      p.armR.rotation.z = -0.1;
      p.armR.position.z = 0;
      p.armL.position.z = 0;
      p.armR.rotation.y = 0;
      p.armL.rotation.y = 0;
      p.inner.rotation.y = 0;
      p.inner.position.z = 0;
    }
    // 走路摆动(蹲/趴时幅度衰减)
    let legSwing = 0;
    let bob = 0;
    let gait = locomotionPose(this.walkPhase, this.speed2d, this.stanceF, this.locomotionF);
    if (moving && this.speed2d > 0.3) {
      this.walkPhase += dt * (5.1 + this.speed2d * 1.05);
      gait = locomotionPose(this.walkPhase, this.speed2d, this.stanceF, this.locomotionF);
      legSwing = gait.legL;
      bob = gait.bob;
    }
    // 蹲: 腿前弯; 趴: 腿顺直
    // 蹲姿使用“髋向前, 膝向后”的折叠链保持鞋底落在身体正下方。
    // 旧姿态只有髋部前弯、膝盖补偿不足，双脚会伸进前方的楼梯立板，
    // 同时模型根下沉过多，导致腿和腰一起埋进踏步。
    const legBend = -1.0 * fC * (1 - fP);
    // 使用完整欧拉角复位，避免自由落体的侧向展开角残留到落地、站立和跑步姿态。
    p.legL.rotation.set(legSwing + legBend, 0, 0);
    p.legR.rotation.set(gait.legR + legBend, 0, 0);
    p.kneeL.rotation.x = gait.kneeL + fC * 2.2 * (1 - fP);
    p.kneeR.rotation.x = gait.kneeR + fC * 2.2 * (1 - fP);
    // 身体下沉(蹲 -0.53 / 趴 +0.30 由旋转完成趴倒)与旋转(趴 = 面朝下平躺, 部分随瞄准俯仰)
    p.inner.position.x = gait.lateral * (1 - fP);
    p.inner.position.y = bob - meleeBodyDip - 0.36 * fC + 0.66 * fP;
    // 移动前倾(速度越大越前倾, 趴下不再加)
    const lean = Math.min(1, this.speed2d / 6.6) * 0.18 * (1 - fP);
    p.inner.rotation.x = 0.2 * fC + lean + meleeBodyLean + fP * (Math.PI / 2 - 0.2 - clamp(this.aimPitch, -0.5, 0.5) * 0.6);
    p.inner.rotation.y += gait.hipYaw * (wantId ? 0.45 : 1);
    p.inner.rotation.z = (this.moveLean * 0.075 + gait.shoulderRoll * (wantId ? 0.35 : 1)) * (1 - fP);
    if (!wantId && this.swingT <= 0 && this.actionF <= 0.001) {
      // 徒手跑步从身体两侧自然前后反摆，不再沿用持枪时的前伸基线。
      p.armL.rotation.x = -0.08 + gait.armSwing;
      p.armL.rotation.y = -gait.hipYaw * 0.45;
      p.armL.rotation.z = 0.12;
      p.armR.rotation.x = -0.08 - gait.armSwing;
      p.armR.rotation.y = gait.hipYaw * 0.45;
      p.armR.rotation.z = -0.12;
      const runBend = clamp(this.speed2d / 6.9, 0, 1);
      p.elbowL.rotation.x = -0.18 - Math.max(0, gait.armSwing) * 0.58 - runBend * 0.08;
      p.elbowR.rotation.x = -0.18 - Math.max(0, -gait.armSwing) * 0.58 - runBend * 0.08;
      p.head.rotation.y = -gait.hipYaw * 0.38;
      p.head.rotation.z = -gait.shoulderRoll * 0.32;
    } else if (wantId) {
      p.elbowL.rotation.x = -0.58;
      p.elbowR.rotation.x = -0.46;
    }
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
      const blend = this.actionF * this.actionF * (3 - 2 * this.actionF);
      const f = blend * (0.5 + actionMotion * 0.5);
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

function hasPhysicalBody(c: Character): boolean {
  return c.alive && c.group.visible && c.airPose === null;
}

// 角色间只在同一高度层做软分离。每轮分离后重新约束到静态碰撞体外，
// 避免门口聚集时把角色推入墙内、下一帧又被墙推出而形成穿模和抽搐。
export function separateCharacterBodies(
  characters: readonly Character[],
  resolveStatic: (character: Character) => void,
  passes = 2,
): number {
  const moved = new Set<Character>();
  let movedCount = 0;
  for (let pass = 0; pass < passes; pass++) {
    moved.clear();
    for (let i = 0; i < characters.length; i++) {
      const a = characters[i] as Character;
      if (!hasPhysicalBody(a)) continue;
      for (let j = i + 1; j < characters.length; j++) {
        const b = characters[j] as Character;
        if (!hasPhysicalBody(b) || Math.abs(a.pos.y - b.pos.y) > 1.35) continue;
        let dx = b.pos.x - a.pos.x;
        let dz = b.pos.z - a.pos.z;
        const rr = a.radius + b.radius;
        let d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        if (d2 < 1e-8) {
          // 完全重叠时使用角色 id 生成稳定方向，不能直接跳过并永久叠在一起。
          const angle = ((a.id * 73856093 + b.id * 19349663) >>> 0) / 0xffffffff * Math.PI * 2;
          dx = Math.cos(angle) * 0.001;
          dz = Math.sin(angle) * 0.001;
          d2 = dx * dx + dz * dz;
        }
        const d = Math.sqrt(d2);
        const push = (rr - d) * 0.5 / d;
        a.pos.x -= dx * push;
        a.pos.z -= dz * push;
        b.pos.x += dx * push;
        b.pos.z += dz * push;
        moved.add(a);
        moved.add(b);
      }
    }
    if (moved.size === 0) break;
    movedCount += moved.size;
    for (const c of moved) resolveStatic(c);
  }
  return movedCount;
}

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
