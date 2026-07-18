// 共享类型定义
export type WeaponId = 'pistol' | 'rifle' | 'smg' | 'sniper';
export type MeleeId = 'fists' | 'knife';
export type AmmoType = 'pistol' | 'rifle' | 'smg' | 'sniper';
export type LootKind = WeaponId | 'knife' | 'ammo' | 'medkit';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  damage: number;
  headMult: number;      // 爆头倍率
  fireInterval: number;  // 两次射击间隔(秒)
  auto: boolean;         // 是否全自动
  magSize: number;
  reloadTime: number;    // 秒
  spreadHip: number;     // 腰射散布(弧度)
  spreadAim: number;     // 机瞄散布(弧度)
  recoil: number;        // 每发后坐力(弧度, 作用于俯仰)
  zoom: number;          // 瞄准时 FOV 缩放倍率
  tier: number;          // 武器品级(bot 选枪用)
  ammo: AmmoType;        // 弹药类型
}

export interface GunState {
  def: WeaponDef;
  mag: number;
}

export interface MeleeDef {
  id: MeleeId;
  name: string;
  damage: number;
  range: number;    // 米
  cooldown: number; // 秒
}

export interface MeleeState {
  def: MeleeDef;
}

// 静态碰撞体: 圆柱(树/石头) 或 AABB(墙体)
export type Collider =
  | { kind: 'cyl'; x: number; z: number; r: number; y0: number; y1: number; tag: 'tree' | 'rock' }
  | { kind: 'aabb'; minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number; tag: 'wall' };

export type SurfaceKind = 'char' | 'terrain' | 'wall' | 'tree' | 'rock';

export interface GameStats {
  kills: number;
  damage: number;
  timeSec: number;
  placement: number;
}
