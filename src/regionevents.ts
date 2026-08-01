import type { LootKind } from './types';
import type { ResolvedMapContentSite } from './mapcontent';
import type { RegionId } from './regions';

export type RegionEventKind = 'armory' | 'medical' | 'workshop';

export interface RegionEvent {
  kind: RegionEventKind;
  region: RegionId;
  siteId: string;
  x: number;
  z: number;
  label: string;
  feature: string;
  color: string;
}

const EVENT_META: Readonly<Record<RegionEventKind, Pick<RegionEvent, 'label' | 'feature' | 'color'>>> = {
  armory: { label: '军械缓存', feature: '枪械和高级护具集中刷新', color: '#ff795c' },
  medical: { label: '医疗补给', feature: '恢复品和防护装备集中刷新', color: '#65db91' },
  workshop: { label: '配件工坊', feature: '瞄具和枪械配件集中刷新', color: '#71bfff' },
};

export const REGION_EVENT_LOOT: Readonly<Record<RegionEventKind, readonly LootKind[]>> = {
  armory: ['lmg', 'ammoRifle', 'vest2', 'helmet2', 'frag', 'attScope2'],
  medical: ['medkit', 'bandage', 'drink', 'vest2', 'pack2', 'smoke'],
  workshop: ['attScope2', 'attScope4', 'attExtmag', 'attComp', 'attSuppressor', 'flash'],
};

export function selectRegionEvents(
  sites: readonly ResolvedMapContentSite[],
  rng: () => number,
  kinds: readonly RegionEventKind[] = ['armory', 'medical', 'workshop'],
): RegionEvent[] {
  if (sites.length === 0) return [];
  const candidates = [...sites];
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [candidates[i], candidates[j]] = [candidates[j] as ResolvedMapContentSite, candidates[i] as ResolvedMapContentSite];
  }
  return candidates.slice(0, Math.min(kinds.length, candidates.length)).map((site, index) => {
    const kind = kinds[index] as RegionEventKind;
    const meta = EVENT_META[kind];
    return {
      kind,
      region: site.region,
      siteId: site.id,
      x: site.resolvedX,
      z: site.resolvedZ,
      ...meta,
    };
  });
}

export function regionEventAt(
  events: readonly RegionEvent[],
  x: number,
  z: number,
  radius = 28,
): RegionEvent | null {
  let nearest: RegionEvent | null = null;
  let best = radius;
  for (const event of events) {
    const distance = Math.hypot(x - event.x, z - event.z);
    if (distance >= best) continue;
    nearest = event;
    best = distance;
  }
  return nearest;
}
