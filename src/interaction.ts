import { clamp } from './utils';

export type InteractionKind = 'ally' | 'door' | 'airdrop' | 'deathcrate' | 'vehicle' | 'item';
export type ComparisonTone = 'positive' | 'neutral' | 'warning';

export interface EquipmentComparison {
  text: string;
  tone: ComparisonTone;
}

export function equipmentComparison(
  currentName: string | null,
  currentLevel: number | null,
  nextLevel: number,
): EquipmentComparison {
  if (!currentName || currentLevel === null) return { text: '空栏位 · 直接装备', tone: 'positive' };
  if (nextLevel > currentLevel) return { text: `升级 · 当前 ${currentName}`, tone: 'positive' };
  if (nextLevel < currentLevel) return { text: `降级 · 当前 ${currentName}`, tone: 'warning' };
  return { text: `同等级 · 当前 ${currentName}`, tone: 'neutral' };
}

export interface InteractionCandidate<T = object> {
  kind: InteractionKind;
  target: T;
  distance: number;
  dot: number;
  maxDistance: number;
  minDot: number;
  priority: number;
}

export function interactionScore<T>(candidate: InteractionCandidate<T>, sticky: boolean): number {
  if (candidate.distance > candidate.maxDistance || candidate.dot < candidate.minDot) return -Infinity;
  const proximity = 1 - clamp(candidate.distance / candidate.maxDistance, 0, 1);
  const focus = clamp((candidate.dot - candidate.minDot) / Math.max(0.001, 1 - candidate.minDot), 0, 1);
  return candidate.priority + focus * 0.62 + proximity * 0.38 + (sticky ? 0.13 : 0);
}

// 统一处理门, 物品, 载具和队友。当前目标获得小幅黏滞, 防止相邻目标逐帧抢占提示。
export function chooseInteractionCandidate<T>(
  candidates: readonly InteractionCandidate<T>[],
  currentTarget: T | null,
): InteractionCandidate<T> | null {
  let best: InteractionCandidate<T> | null = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = interactionScore(candidate, candidate.target === currentTarget);
    if (score <= bestScore) continue;
    best = candidate;
    bestScore = score;
  }
  return best;
}
