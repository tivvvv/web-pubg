import type { RegionEventKind } from './regionevents';

export type MatchVariationId = 'balanced' | 'arsenal' | 'lifeline' | 'firestorm';

export interface MatchVariation {
  id: MatchVariationId;
  label: string;
  detail: string;
  eventKinds: readonly RegionEventKind[];
  airdropFirstDelay: number;
  airdropInterval: readonly [number, number];
  bombardmentCooldownScale: number;
}

export const MATCH_VARIATIONS: readonly MatchVariation[] = [
  {
    id: 'balanced',
    label: '均衡战局',
    detail: '资源类型均衡, 标准空投与轰炸节奏',
    eventKinds: ['armory', 'medical', 'workshop'],
    airdropFirstDelay: 70,
    airdropInterval: [75, 90],
    bombardmentCooldownScale: 1,
  },
  {
    id: 'arsenal',
    label: '军械争夺',
    detail: '双军械热点, 空投更早抵达',
    eventKinds: ['armory', 'armory', 'workshop'],
    airdropFirstDelay: 56,
    airdropInterval: [70, 82],
    bombardmentCooldownScale: 1.08,
  },
  {
    id: 'lifeline',
    label: '救援前线',
    detail: '双医疗热点, 轰炸间隔更长',
    eventKinds: ['medical', 'medical', 'workshop'],
    airdropFirstDelay: 76,
    airdropInterval: [80, 94],
    bombardmentCooldownScale: 1.2,
  },
  {
    id: 'firestorm',
    label: '火线转移',
    detail: '轰炸区更频繁, 中期空投节奏加快',
    eventKinds: ['armory', 'medical', 'workshop'],
    airdropFirstDelay: 64,
    airdropInterval: [68, 80],
    bombardmentCooldownScale: 0.72,
  },
] as const;

export const DEFAULT_MATCH_VARIATION = MATCH_VARIATIONS[0] as MatchVariation;

export function matchVariationById(value: string | null): MatchVariation | null {
  return MATCH_VARIATIONS.find((variant) => variant.id === value) ?? null;
}

export function selectMatchVariation(rng: () => number): MatchVariation {
  const value = Math.max(0, Math.min(0.999999, rng()));
  return MATCH_VARIATIONS[Math.floor(value * MATCH_VARIATIONS.length)] ?? DEFAULT_MATCH_VARIATION;
}
