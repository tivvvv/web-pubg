// ─────────────────────────────────────────────────────────────────────────────
// attachments.ts - 武器配件: 定义/兼容规则/弹容计算/loot 映射
// 每枪 3 槽: 瞄具(sight) / 弹匣(mag) / 枪口(muzzle); S686 全禁, AWM 内置镜不可装瞄具
// ─────────────────────────────────────────────────────────────────────────────
import type { AttachmentId, AttSlot, GunAttachments, GunState, LootKind, WeaponId } from './types';

export interface AttachmentDef {
  id: AttachmentId;
  name: string;
  short: string; // HUD 小标
  slot: AttSlot;
}

export const ATTACHMENTS: Record<AttachmentId, AttachmentDef> = {
  reddot: { id: 'reddot', name: '红点瞄准镜', short: '红', slot: 'sight' },
  scope2: { id: 'scope2', name: '2倍镜', short: '2×', slot: 'sight' },
  scope4: { id: 'scope4', name: '4倍镜', short: '4×', slot: 'sight' },
  extmag: { id: 'extmag', name: '扩容弹匣', short: '扩', slot: 'mag' },
  comp: { id: 'comp', name: '枪口补偿器', short: '补', slot: 'muzzle' },
  suppressor: { id: 'suppressor', name: '消音器', short: '消', slot: 'muzzle' },
};

export function emptyAttachments(): GunAttachments {
  return { sight: null, mag: null, muzzle: null };
}

export function attachmentSummary(att: GunAttachments): string {
  const labels: string[] = [];
  if (att.sight) labels.push(ATTACHMENTS[att.sight].short);
  if (att.mag) labels.push(ATTACHMENTS[att.mag].short);
  if (att.muzzle) labels.push(ATTACHMENTS[att.muzzle].short);
  return labels.join(' ');
}

export const ATT_LOOT_KIND: Record<AttachmentId, LootKind> = {
  reddot: 'attReddot', scope2: 'attScope2', scope4: 'attScope4',
  extmag: 'attExtmag', comp: 'attComp', suppressor: 'attSuppressor',
};

const LOOT_TO_ATT: Partial<Record<LootKind, AttachmentId>> = {
  attReddot: 'reddot', attScope2: 'scope2', attScope4: 'scope4',
  attExtmag: 'extmag', attComp: 'comp', attSuppressor: 'suppressor',
};

export function isAttachKind(kind: LootKind): boolean {
  return kind in LOOT_TO_ATT;
}

export function attachFromLoot(kind: LootKind): AttachmentId | null {
  return LOOT_TO_ATT[kind] ?? null;
}

// 兼容规则
export function canAttach(weaponId: WeaponId, attId: AttachmentId): boolean {
  if (weaponId === 'shotgun') return false; // S686 无配件
  const slot = ATTACHMENTS[attId].slot;
  if (slot === 'sight') {
    if (weaponId === 'sniper') return false; // AWM 内置 4 倍
    if (weaponId === 'pistol') return attId === 'reddot'; // 手枪仅红点
    return true;
  }
  return true; // 弹匣/枪口: 其余四枪通用
}

// 扩容弹匣增量(各枪)
const EXTMAG_BONUS: Partial<Record<WeaponId, number>> = {
  rifle: 10, akm: 10, smg: 10, dmr: 10, sniper: 2, pistol: 5,
};

// 有效弹匣容量
export function magSizeOf(gun: GunState): number {
  return gun.def.magSize + (gun.att.mag === 'extmag' ? EXTMAG_BONUS[gun.def.id] ?? 0 : 0);
}

// 瞄具给的 ADS 倍率(无瞄具用枪自身 zoom)
export function sightZoomOf(gun: GunState): number {
  switch (gun.att.sight) {
    case 'reddot': return 1.3;
    case 'scope2': return 2;
    case 'scope4': return 4;
    default: return gun.def.zoom;
  }
}

// 补偿器系数
export function recoilFactorOf(gun: GunState): number {
  return gun.att.muzzle === 'comp' ? 0.7 : 1;
}

export function spreadFactorOf(gun: GunState): number {
  return gun.att.muzzle === 'comp' ? 0.85 : 1;
}

export function isSuppressed(gun: GunState): boolean {
  return gun.att.muzzle === 'suppressor';
}
