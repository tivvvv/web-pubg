// 武器/近战定义 + 手工 hitscan(角色命中体/静态碰撞体/地形, 取最近命中)
import * as THREE from 'three';
import type { Character, HitTestResult } from './character';
import type {
  AmmoType, GunState, MeleeDef, MeleeId, SurfaceKind, ThrowableId, WeaponDef, WeaponId,
} from './types';
import type { World, StaticHit } from './world';

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: {
    id: 'pistol', name: 'P92 手枪', damage: 16, headMult: 2, fireInterval: 0.24,
    auto: false, magSize: 12, reloadTime: 1.3, spreadHip: 0.016, spreadAim: 0.007,
    recoil: 0.012, zoom: 1.25, tier: 1, ammo: 'pistol',
  },
  rifle: {
    id: 'rifle', name: 'M416 步枪', damage: 22, headMult: 2, fireInterval: 0.125,
    auto: true, magSize: 30, reloadTime: 2.0, spreadHip: 0.02, spreadAim: 0.0075,
    recoil: 0.0135, zoom: 1.35, tier: 3, ammo: 'rifle',
  },
  smg: {
    id: 'smg', name: 'UMP 冲锋枪', damage: 13, headMult: 2, fireInterval: 0.077,
    auto: true, magSize: 32, reloadTime: 1.7, spreadHip: 0.028, spreadAim: 0.013,
    recoil: 0.0085, zoom: 1.3, tier: 2, ammo: 'smg',
  },
  sniper: {
    id: 'sniper', name: 'AWM 狙击枪', damage: 85, headMult: 2, fireInterval: 1.5,
    auto: false, magSize: 5, reloadTime: 2.8, spreadHip: 0.035, spreadAim: 0.0012,
    recoil: 0.05, zoom: 4, tier: 4, ammo: 'sniper',
  },
};

export const MELEE: Record<MeleeId, MeleeDef> = {
  fists: { id: 'fists', name: '拳头', damage: 15, range: 2.2, cooldown: 0.45 },
  knife: { id: 'knife', name: '砍刀', damage: 40, range: 2.4, cooldown: 0.6 },
};

// 投掷物定义(手雷伤害逻辑在 throwables.ts)
export const THROWABLES: Record<ThrowableId, { id: ThrowableId; name: string; max: number }> = {
  frag: { id: 'frag', name: '手雷', max: 5 },
  smoke: { id: 'smoke', name: '烟雾弹', max: 5 },
};

// 弹药箱补给量(每种类型)
export const AMMO_PACK: Record<AmmoType, number> = { pistol: 16, rifle: 30, smg: 40, sniper: 8 };

export const AMMO_NAME: Record<AmmoType, string> = {
  pistol: '手枪弹', rifle: '步枪弹', smg: '冲锋枪弹', sniper: '狙击弹',
};

export function makeWeapon(id: WeaponId, mag?: number): GunState {
  const def = WEAPONS[id];
  return { def, mag: mag ?? def.magSize };
}

export interface ShotResult {
  hit: boolean;
  t: number;
  point: THREE.Vector3;
  char: Character | null;
  head: boolean;
  surface: SurfaceKind | null;
}

const charHit: HitTestResult = { t: 0, head: false };

// 手工 hitscan: 方向 d 必须为单位向量; exclude 通常为射手本人
export function hitscan(
  world: World,
  chars: readonly Character[],
  exclude: Character | null,
  o: THREE.Vector3,
  d: THREE.Vector3,
  maxDist: number,
  staticHit: StaticHit,
  res: ShotResult,
): ShotResult {
  let best = maxDist;
  let char: Character | null = null;
  let head = false;
  let surface: SurfaceKind | null = null;

  const tTerr = world.raycastTerrain(o, d, best);
  if (tTerr < best) {
    best = tTerr;
    surface = 'terrain';
  }
  if (world.raycastStatics(o, d, best, staticHit)) {
    best = staticHit.t;
    surface = staticHit.kind;
    char = null;
  }
  for (const c of chars) {
    if (!c.alive || c === exclude) continue;
    if (c.hitTest(o.x, o.y, o.z, d.x, d.y, d.z, best, charHit)) {
      best = charHit.t;
      char = c;
      head = charHit.head;
      surface = 'char';
    }
  }
  res.hit = surface !== null;
  res.t = best;
  res.char = char;
  res.head = head;
  res.surface = surface;
  res.point.set(o.x + d.x * best, o.y + d.y * best, o.z + d.z * best);
  return res;
}

export function makeShotResult(): ShotResult {
  return { hit: false, t: 0, point: new THREE.Vector3(), char: null, head: false, surface: null };
}

// 单位向量上加随机锥形散布(弧度)
export function applySpread(d: THREE.Vector3, spread: number, tmp: THREE.Vector3): THREE.Vector3 {
  if (spread <= 0) return d;
  // 构造正交基
  tmp.set(1, 0, 0);
  if (Math.abs(d.x) > 0.9) tmp.set(0, 1, 0);
  const ux = d.y * tmp.z - d.z * tmp.y;
  const uy = d.z * tmp.x - d.x * tmp.z;
  const uz = d.x * tmp.y - d.y * tmp.x;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  const uxx = ux / ul;
  const uyy = uy / ul;
  const uzz = uz / ul;
  const vxx = d.y * uzz - d.z * uyy;
  const vyy = d.z * uxx - d.x * uzz;
  const vzz = d.x * uyy - d.y * uxx;
  // 高斯-ish 散布
  const ang = Math.random() * Math.PI * 2;
  const r = (Math.random() + Math.random()) * 0.5 * spread;
  const ca = Math.cos(ang) * r;
  const sa = Math.sin(ang) * r;
  d.x += uxx * ca + vxx * sa;
  d.y += uyy * ca + vyy * sa;
  d.z += uzz * ca + vzz * sa;
  return d.normalize();
}
