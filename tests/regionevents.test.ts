import { describe, expect, it } from 'vitest';
import { MAP_CONTENT_SITES, type ResolvedMapContentSite } from '../src/mapcontent';
import { REGION_EVENT_LOOT, regionEventAt, selectRegionEvents } from '../src/regionevents';

const sites: ResolvedMapContentSite[] = MAP_CONTENT_SITES.map((site) => ({
  ...site,
  resolvedX: site.x,
  resolvedZ: site.z,
}));

function sequence(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

describe('动态区域事件', () => {
  it('每局选择三个不同区域并完整覆盖事件类型', () => {
    const events = selectRegionEvents(sites, sequence([0.82, 0.14, 0.63, 0.31, 0.55]));
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.region)).size).toBe(3);
    expect(events.map((event) => event.kind)).toEqual(['armory', 'medical', 'workshop']);
    for (const event of events) {
      expect(event.label.length).toBeGreaterThan(3);
      expect(event.feature.length).toBeGreaterThan(8);
      expect(event.siteId.length).toBeGreaterThan(3);
    }
  });

  it('同一随机序列得到完全相同的事件布局', () => {
    const values = [0.11, 0.92, 0.42, 0.74, 0.33];
    expect(selectRegionEvents(sites, sequence(values))).toEqual(selectRegionEvents(sites, sequence(values)));
  });

  it('事件掉落表各有六件且事件范围只命中最近目标', () => {
    for (const loot of Object.values(REGION_EVENT_LOOT)) expect(loot).toHaveLength(6);
    const events = selectRegionEvents(sites, () => 0.5);
    const first = events[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(regionEventAt(events, first.x + 4, first.z)?.kind).toBe(first.kind);
    expect(regionEventAt(events, first.x + 40, first.z, 20)).toBeNull();
  });
});
