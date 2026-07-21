import type { RegionId } from './regions';

export type MapContentKind = 'market' | 'freight' | 'grain' | 'lumber' | 'relay' | 'fishmarket';

export interface MapContentSiteDef {
  id: string;
  region: RegionId;
  name: string;
  feature: string;
  kind: MapContentKind;
  x: number;
  z: number;
  radius: number;
  premiumSpots: 0 | 1 | 2;
}

export interface ResolvedMapContentSite extends MapContentSiteDef {
  resolvedX: number;
  resolvedZ: number;
}

// 六个主地标负责区域识别, 战术节奏和稳定的室外补给锚点.
// 世界构建时会在设计点附近寻找安全落位, 避免和随机建筑或植被重叠.
export const MAP_CONTENT_SITES: readonly MapContentSiteDef[] = [
  {
    id: 'stonegate-market', region: 'stonegate', name: '旧城集市', feature: '棚摊交错的近距争夺点',
    kind: 'market', x: -60, z: -20, radius: 24, premiumSpots: 2,
  },
  {
    id: 'ironring-freight', region: 'ironring', name: '冠军货场', feature: '集装箱夹道和双侧突破口',
    kind: 'freight', x: 214, z: -40, radius: 25, premiumSpots: 2,
  },
  {
    id: 'sunfield-granary', region: 'sunfield', name: '丰收粮站', feature: '高粮仓和开阔农田观察位',
    kind: 'grain', x: -96, z: 214, radius: 26, premiumSpots: 1,
  },
  {
    id: 'mistwood-lumberyard', region: 'mistwood', name: '北境木场', feature: '木料堆和林下短视线交火',
    kind: 'lumber', x: -10, z: -208, radius: 26, premiumSpots: 0,
  },
  {
    id: 'eagleridge-relay', region: 'eagleridge', name: '鹰眼电台', feature: '高地通信塔和环形防守位',
    kind: 'relay', x: -220, z: 20, radius: 24, premiumSpots: 2,
  },
  {
    id: 'tideharbor-fishmarket', region: 'tideharbor', name: '海风鱼市', feature: '雨棚货台和临水转移线',
    kind: 'fishmarket', x: 204, z: -220, radius: 24, premiumSpots: 1,
  },
];

export function mapContentSiteAt(
  sites: readonly ResolvedMapContentSite[],
  x: number,
  z: number,
): ResolvedMapContentSite | null {
  let nearest: ResolvedMapContentSite | null = null;
  let nearestDistance = Infinity;
  for (const site of sites) {
    const distance = Math.hypot(x - site.resolvedX, z - site.resolvedZ);
    if (distance > site.radius || distance >= nearestDistance) continue;
    nearest = site;
    nearestDistance = distance;
  }
  return nearest;
}
