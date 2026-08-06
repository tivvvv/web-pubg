import type { SurfaceAssetId } from './assets';
import type { RegionId } from './regions';

export type BuildingArchetypeId =
  | 'cottage1'
  | 'cottage2'
  | 'terrace'
  | 'apartment'
  | 'barn'
  | 'shop'
  | 'gym';

export type AssetCategory =
  | 'building-archetype'
  | 'building-module'
  | 'building-region-kit'
  | 'map-infrastructure'
  | 'map-nature'
  | 'map-tactical'
  | 'map-landmark';

export interface AssetDefinition {
  readonly category: AssetCategory;
  readonly surface: SurfaceAssetId;
  readonly detailTier: 1 | 2 | 3;
  readonly collision: 'none' | 'solid' | 'platform';
  readonly description: string;
}

export interface SurfaceMaterialPreset {
  readonly scale: number;
  readonly strength: number;
  readonly roughness: number;
  readonly metalness: number;
}

export const ASSET_CATALOG_VERSION = 'map-building-v1';

// 地图与建筑共用一份材质规格。生成器只选择资产语义，不再各自维护魔法参数。
export const SURFACE_MATERIAL_PRESETS: Readonly<Record<SurfaceAssetId, SurfaceMaterialPreset>> = Object.freeze({
  plaster: { scale: 2.5, strength: 0.82, roughness: 0.9, metalness: 0 },
  terrain: { scale: 0.08, strength: 0.7, roughness: 0.96, metalness: 0 },
  wood: { scale: 2.9, strength: 0.82, roughness: 0.88, metalness: 0 },
  metal: { scale: 3.4, strength: 0.62, roughness: 0.6, metalness: 0.24 },
  fabric: { scale: 3.2, strength: 0.68, roughness: 0.96, metalness: 0 },
  stone: { scale: 2.3, strength: 0.8, roughness: 0.94, metalness: 0 },
  concrete: { scale: 3.1, strength: 0.72, roughness: 0.94, metalness: 0 },
  roof: { scale: 2.15, strength: 0.88, roughness: 0.84, metalness: 0 },
  foliage: { scale: 2.5, strength: 0.6, roughness: 0.95, metalness: 0 },
  paintedMetal: { scale: 2.7, strength: 0.64, roughness: 0.72, metalness: 0.08 },
  stonegateBrick: { scale: 0.82, strength: 0.92, roughness: 0.93, metalness: 0 },
});

export const ASSET_CATALOG = {
  'building.archetype.cottage1': { category: 'building-archetype', surface: 'plaster', detailTier: 1, collision: 'solid', description: '单层民居原型' },
  'building.archetype.cottage2': { category: 'building-archetype', surface: 'plaster', detailTier: 1, collision: 'solid', description: '双层民居原型' },
  'building.archetype.terrace': { category: 'building-archetype', surface: 'plaster', detailTier: 1, collision: 'solid', description: '露台住宅原型' },
  'building.archetype.apartment': { category: 'building-archetype', surface: 'concrete', detailTier: 1, collision: 'solid', description: '多层楼房原型' },
  'building.archetype.barn': { category: 'building-archetype', surface: 'wood', detailTier: 1, collision: 'solid', description: '农场谷仓原型' },
  'building.archetype.shop': { category: 'building-archetype', surface: 'paintedMetal', detailTier: 1, collision: 'solid', description: '街边商店原型' },
  'building.archetype.gym': { category: 'building-archetype', surface: 'concrete', detailTier: 1, collision: 'solid', description: '竞技馆原型' },
  'building.module.wall': { category: 'building-module', surface: 'plaster', detailTier: 1, collision: 'solid', description: '承重墙与隔墙模块' },
  'building.module.floor': { category: 'building-module', surface: 'concrete', detailTier: 1, collision: 'platform', description: '地板和楼板模块' },
  'building.module.roof': { category: 'building-module', surface: 'roof', detailTier: 1, collision: 'solid', description: '平顶与坡顶模块' },
  'building.module.opening': { category: 'building-module', surface: 'wood', detailTier: 2, collision: 'solid', description: '门窗和装饰框模块' },
  'building.module.stairs': { category: 'building-module', surface: 'wood', detailTier: 1, collision: 'platform', description: '楼梯和扶手模块' },
  'building.module.interior': { category: 'building-module', surface: 'wood', detailTier: 2, collision: 'solid', description: '室内家具与战术陈设模块' },
  'building.module.exterior': { category: 'building-module', surface: 'metal', detailTier: 3, collision: 'none', description: '排水管空调和立面五金模块' },
  'building.region.stonegate': { category: 'building-region-kit', surface: 'stonegateBrick', detailTier: 2, collision: 'none', description: '磐石城旧城砖石立面套件' },
  'building.region.ironring': { category: 'building-region-kit', surface: 'paintedMetal', detailTier: 2, collision: 'none', description: '铁环竞技场工业立面套件' },
  'building.region.sunfield': { category: 'building-region-kit', surface: 'wood', detailTier: 2, collision: 'none', description: '丰禾农场木作立面套件' },
  'building.region.mistwood': { category: 'building-region-kit', surface: 'wood', detailTier: 2, collision: 'none', description: '雾松林场林区立面套件' },
  'building.region.eagleridge': { category: 'building-region-kit', surface: 'stone', detailTier: 2, collision: 'none', description: '鹰脊哨站山地立面套件' },
  'building.region.tideharbor': { category: 'building-region-kit', surface: 'paintedMetal', detailTier: 2, collision: 'none', description: '潮汐渔港海港立面套件' },
  'map.infrastructure.road': { category: 'map-infrastructure', surface: 'terrain', detailTier: 1, collision: 'platform', description: '道路网络模块' },
  'map.infrastructure.bridge': { category: 'map-infrastructure', surface: 'wood', detailTier: 1, collision: 'platform', description: '模块化桥梁套件' },
  'map.infrastructure.utility': { category: 'map-infrastructure', surface: 'wood', detailTier: 2, collision: 'solid', description: '电杆路牌和围栏套件' },
  'map.nature.tree.pine': { category: 'map-nature', surface: 'foliage', detailTier: 1, collision: 'solid', description: '多层松树资产' },
  'map.nature.tree.broadleaf': { category: 'map-nature', surface: 'foliage', detailTier: 1, collision: 'solid', description: '阔叶树资产' },
  'map.nature.rock': { category: 'map-nature', surface: 'stone', detailTier: 1, collision: 'solid', description: '岩石与碎石簇资产' },
  'map.nature.bush': { category: 'map-nature', surface: 'foliage', detailTier: 2, collision: 'none', description: '灌木簇资产' },
  'map.nature.grass': { category: 'map-nature', surface: 'foliage', detailTier: 3, collision: 'none', description: '草丛和林下植被资产' },
  'map.nature.crop': { category: 'map-nature', surface: 'foliage', detailTier: 3, collision: 'none', description: '农田作物行资产' },
  'map.nature.shore': { category: 'map-nature', surface: 'foliage', detailTier: 3, collision: 'none', description: '岸线芦苇和湿地细节资产' },
  'map.tactical.cover': { category: 'map-tactical', surface: 'paintedMetal', detailTier: 1, collision: 'solid', description: '箱体路障和掩体模块' },
  'map.tactical.farm': { category: 'map-tactical', surface: 'fabric', detailTier: 1, collision: 'solid', description: '干草捆和农场掩体套件' },
  'map.tactical.harbor': { category: 'map-tactical', surface: 'wood', detailTier: 1, collision: 'solid', description: '渔船码头和箱堆套件' },
  'map.landmark.lookout': { category: 'map-landmark', surface: 'wood', detailTier: 1, collision: 'solid', description: '林区观景台地标' },
  'map.landmark.windmill': { category: 'map-landmark', surface: 'paintedMetal', detailTier: 1, collision: 'solid', description: '农场风车地标' },
  'map.landmark.ruins': { category: 'map-landmark', surface: 'stone', detailTier: 1, collision: 'solid', description: '山地遗迹地标' },
  'map.landmark.dock': { category: 'map-landmark', surface: 'wood', detailTier: 1, collision: 'solid', description: '渔港码头地标' },
  'map.landmark.region-site': { category: 'map-landmark', surface: 'paintedMetal', detailTier: 2, collision: 'solid', description: '区域玩法内容套件' },
} as const satisfies Record<string, AssetDefinition>;

export type AssetId = keyof typeof ASSET_CATALOG;

const ARCHETYPE_ASSETS: Readonly<Record<BuildingArchetypeId, AssetId>> = {
  cottage1: 'building.archetype.cottage1',
  cottage2: 'building.archetype.cottage2',
  terrace: 'building.archetype.terrace',
  apartment: 'building.archetype.apartment',
  barn: 'building.archetype.barn',
  shop: 'building.archetype.shop',
  gym: 'building.archetype.gym',
};

const REGION_ASSETS: Readonly<Record<RegionId, AssetId>> = {
  stonegate: 'building.region.stonegate',
  ironring: 'building.region.ironring',
  sunfield: 'building.region.sunfield',
  mistwood: 'building.region.mistwood',
  eagleridge: 'building.region.eagleridge',
  tideharbor: 'building.region.tideharbor',
};

export function buildingAssetPack(
  archetype: BuildingArchetypeId,
  region: RegionId | null,
): readonly AssetId[] {
  const pack: AssetId[] = [
    ARCHETYPE_ASSETS[archetype],
    'building.module.wall',
    'building.module.floor',
    'building.module.roof',
    'building.module.opening',
    'building.module.interior',
    'building.module.exterior',
  ];
  if (archetype === 'cottage2' || archetype === 'terrace' || archetype === 'apartment') {
    pack.push('building.module.stairs');
  }
  if (region) pack.push(REGION_ASSETS[region]);
  return pack;
}

export class AssetUsageRegistry {
  private readonly counts = new Map<AssetId, number>();

  clear(): void {
    this.counts.clear();
  }

  add(id: AssetId, count = 1): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.counts.set(id, (this.counts.get(id) ?? 0) + Math.floor(count));
  }

  get uniqueCount(): number {
    return this.counts.size;
  }

  get totalInstances(): number {
    let total = 0;
    for (const count of this.counts.values()) total += count;
    return total;
  }

  count(id: AssetId): number {
    return this.counts.get(id) ?? 0;
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b))));
  }
}

export function validateAssetCatalog(): readonly string[] {
  const issues: string[] = [];
  for (const [id, definition] of Object.entries(ASSET_CATALOG)) {
    if (!id.includes('.')) issues.push(`${id}: 资产标识缺少命名空间`);
    if (!SURFACE_MATERIAL_PRESETS[definition.surface]) issues.push(`${id}: 表面资产不存在`);
    if (!definition.description.trim()) issues.push(`${id}: 缺少说明`);
  }
  return issues;
}
