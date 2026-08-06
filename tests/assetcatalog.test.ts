import { describe, expect, it } from 'vitest';
import {
  ASSET_CATALOG,
  ASSET_CATALOG_VERSION,
  AssetUsageRegistry,
  buildingAssetPack,
  SURFACE_MATERIAL_PRESETS,
  validateAssetCatalog,
  type BuildingArchetypeId,
} from '../src/assetcatalog';
import { REGIONS } from '../src/regions';
import { SURFACE_ASSET_URLS } from '../src/assets';

describe('地图与建筑资产目录', () => {
  it('目录版本和全部资产定义通过完整性校验', () => {
    expect(ASSET_CATALOG_VERSION).toBe('map-building-v1');
    expect(Object.keys(ASSET_CATALOG).length).toBeGreaterThanOrEqual(35);
    expect(validateAssetCatalog()).toEqual([]);
  });

  it('统一材质预设覆盖全部表面纹理且参数有效', () => {
    expect(Object.keys(SURFACE_MATERIAL_PRESETS).sort()).toEqual(Object.keys(SURFACE_ASSET_URLS).sort());
    for (const preset of Object.values(SURFACE_MATERIAL_PRESETS)) {
      expect(preset.scale).toBeGreaterThan(0);
      expect(preset.strength).toBeGreaterThan(0);
      expect(preset.strength).toBeLessThanOrEqual(1);
      expect(preset.roughness).toBeGreaterThanOrEqual(0);
      expect(preset.roughness).toBeLessThanOrEqual(1);
      expect(preset.metalness).toBeGreaterThanOrEqual(0);
      expect(preset.metalness).toBeLessThanOrEqual(1);
    }
  });

  it('七种建筑原型拥有结构模块且多层建筑包含楼梯', () => {
    const archetypes: BuildingArchetypeId[] = [
      'cottage1', 'cottage2', 'terrace', 'apartment', 'barn', 'shop', 'gym',
    ];
    for (const archetype of archetypes) {
      const pack = buildingAssetPack(archetype, null);
      expect(pack).toContain(`building.archetype.${archetype}`);
      expect(pack).toContain('building.module.wall');
      expect(pack).toContain('building.module.floor');
      expect(pack).toContain('building.module.roof');
      expect(pack).toContain('building.module.opening');
      expect(pack.includes('building.module.stairs')).toBe(
        archetype === 'cottage2' || archetype === 'terrace' || archetype === 'apartment',
      );
    }
  });

  it('六个正式区域各自接入独立建筑资产套件', () => {
    for (const region of REGIONS) {
      expect(buildingAssetPack('cottage1', region.id)).toContain(`building.region.${region.id}`);
    }
  });

  it('运行时用量注册可累计复用实例并忽略无效数量', () => {
    const usage = new AssetUsageRegistry();
    usage.add('map.nature.tree.pine', 12);
    usage.add('map.nature.tree.pine', 3);
    usage.add('map.infrastructure.bridge', 2);
    usage.add('map.infrastructure.bridge', -1);
    expect(usage.uniqueCount).toBe(2);
    expect(usage.totalInstances).toBe(17);
    expect(usage.count('map.nature.tree.pine')).toBe(15);
    expect(usage.snapshot()).toEqual({
      'map.infrastructure.bridge': 2,
      'map.nature.tree.pine': 15,
    });
    usage.clear();
    expect(usage.totalInstances).toBe(0);
  });
});
