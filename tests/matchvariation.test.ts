import { describe, expect, it } from 'vitest';
import { MATCH_VARIATIONS, matchVariationById, selectMatchVariation } from '../src/matchvariation';
import { MAP_CONTENT_SITES, type ResolvedMapContentSite } from '../src/mapcontent';
import { selectRegionEvents } from '../src/regionevents';

const sites: ResolvedMapContentSite[] = MAP_CONTENT_SITES.map((site) => ({
  ...site,
  resolvedX: site.x,
  resolvedZ: site.z,
}));

describe('对局变化规则', () => {
  it('四种规则覆盖资源和节奏差异且参数保持安全边界', () => {
    expect(MATCH_VARIATIONS.map((variant) => variant.id)).toEqual([
      'balanced', 'arsenal', 'lifeline', 'firestorm',
    ]);
    for (const variant of MATCH_VARIATIONS) {
      expect(variant.eventKinds).toHaveLength(3);
      expect(variant.airdropFirstDelay).toBeGreaterThanOrEqual(50);
      expect(variant.airdropInterval[0]).toBeLessThan(variant.airdropInterval[1]);
      expect(variant.bombardmentCooldownScale).toBeGreaterThanOrEqual(0.7);
      expect(variant.bombardmentCooldownScale).toBeLessThanOrEqual(1.25);
    }
  });

  it('随机区间稳定映射到四种规则并钳制异常输入', () => {
    expect(selectMatchVariation(() => 0).id).toBe('balanced');
    expect(selectMatchVariation(() => 0.25).id).toBe('arsenal');
    expect(selectMatchVariation(() => 0.5).id).toBe('lifeline');
    expect(selectMatchVariation(() => 0.999).id).toBe('firestorm');
    expect(selectMatchVariation(() => -2).id).toBe('balanced');
    expect(selectMatchVariation(() => 4).id).toBe('firestorm');
    expect(matchVariationById('lifeline')?.label).toBe('救援前线');
    expect(matchVariationById('unknown')).toBeNull();
  });

  it('规则指定的重复事件类型仍落在三个不同区域', () => {
    const arsenal = MATCH_VARIATIONS.find((variant) => variant.id === 'arsenal');
    expect(arsenal).toBeDefined();
    if (!arsenal) return;
    const events = selectRegionEvents(sites, () => 0.42, arsenal.eventKinds);
    expect(events.map((event) => event.kind)).toEqual(['armory', 'armory', 'workshop']);
    expect(new Set(events.map((event) => event.region)).size).toBe(3);
  });
});
