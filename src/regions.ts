// 地图区域定义: 地名、资源等级、特色、落点承载和掉落倾向共用同一份数据。
import type { WeaponId } from './types';

export type RegionId = 'stonegate' | 'ironring' | 'sunfield' | 'mistwood' | 'eagleridge' | 'tideharbor';
export type LootTier = 'low' | 'medium' | 'high';
export type LootProfile = 'urban' | 'arena' | 'farm' | 'forest' | 'ridge' | 'harbor';

export interface RegionDef {
  id: RegionId | 'wilderness';
  name: string;
  x: number;
  z: number;
  radius: number;
  tier: LootTier;
  profile: LootProfile;
  signatureWeapon: WeaponId;
  landmarkLootSpots: number;
  lootBudget: number;
  dropWeight: number;
  dropCapacity: number;
  emptyChance: number;
  feature: string;
  color: number;
}

export const REGIONS: readonly RegionDef[] = [
  {
    id: 'stonegate', name: '磐石城', x: -60, z: -20, radius: 94, tier: 'high', profile: 'urban',
    signatureWeapon: 'rifle', landmarkLootSpots: 8, lootBudget: 48,
    dropWeight: 1.35, dropCapacity: 5, emptyChance: 0.04,
    feature: '密集楼群和屋顶交火', color: 0xc7a56a,
  },
  {
    id: 'ironring', name: '铁环竞技场', x: 180, z: -40, radius: 68, tier: 'high', profile: 'arena',
    signatureWeapon: 'akm', landmarkLootSpots: 7, lootBudget: 32,
    dropWeight: 1.2, dropCapacity: 4, emptyChance: 0.04,
    feature: '开阔场馆和硬质掩体', color: 0xc97862,
  },
  {
    id: 'sunfield', name: '丰禾农场', x: -40, z: 200, radius: 92, tier: 'medium', profile: 'farm',
    signatureWeapon: 'shotgun', landmarkLootSpots: 7, lootBudget: 32,
    dropWeight: 1.05, dropCapacity: 4, emptyChance: 0.1,
    feature: '谷仓围栏和中近距战斗', color: 0xd4bd67,
  },
  {
    id: 'mistwood', name: '雾松林场', x: 0, z: -200, radius: 105, tier: 'low', profile: 'forest',
    signatureWeapon: 'smg', landmarkLootSpots: 7, lootBudget: 27,
    dropWeight: 0.82, dropCapacity: 3, emptyChance: 0.15,
    feature: '林木隐蔽和分散补给', color: 0x6e9a6c,
  },
  {
    id: 'eagleridge', name: '鹰脊哨站', x: -220, z: 20, radius: 78, tier: 'high', profile: 'ridge',
    signatureWeapon: 'dmr', landmarkLootSpots: 7, lootBudget: 26,
    dropWeight: 0.95, dropCapacity: 3, emptyChance: 0.04,
    feature: '制高点和远距离视野', color: 0x9b9b91,
  },
  {
    id: 'tideharbor', name: '潮汐渔港', x: 200, z: -220, radius: 74, tier: 'medium', profile: 'harbor',
    signatureWeapon: 'shotgun', landmarkLootSpots: 7, lootBudget: 30,
    dropWeight: 1.05, dropCapacity: 4, emptyChance: 0.09,
    feature: '码头箱堆和临水巷战', color: 0x5f9eaa,
  },
];

export const WILDERNESS_REGION: Readonly<RegionDef> = {
  id: 'wilderness', name: '荒野', x: 0, z: 0, radius: 0, tier: 'low', profile: 'forest',
  signatureWeapon: 'pistol', landmarkLootSpots: 0, lootBudget: 18,
  dropWeight: 0, dropCapacity: 0, emptyChance: 0.22,
  feature: '补给稀疏', color: 0x769161,
};

export function regionById(id: RegionId): RegionDef {
  const region = REGIONS.find((candidate) => candidate.id === id);
  if (!region) throw new Error(`未知地图区域: ${id}`);
  return region;
}

export function regionAt(x: number, z: number): RegionDef | null {
  let best: RegionDef | null = null;
  let bestScore = Infinity;
  for (const region of REGIONS) {
    const d = Math.hypot(x - region.x, z - region.z);
    if (d > region.radius) continue;
    const score = d / region.radius;
    if (score < bestScore) {
      best = region;
      bestScore = score;
    }
  }
  return best;
}

export function regionOrWilderness(x: number, z: number): RegionDef {
  return regionAt(x, z) ?? WILDERNESS_REGION;
}
