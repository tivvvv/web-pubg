import { describe, expect, it } from 'vitest';
import {
  chooseInteractionCandidate, interactionScore, type InteractionCandidate,
} from '../src/interaction';

function candidate(
  kind: InteractionCandidate['kind'],
  target: object,
  distance: number,
  dot: number,
  priority = 0,
): InteractionCandidate {
  return { kind, target, distance, dot, priority, maxDistance: 2.6, minDot: 0.1 };
}

describe('交互目标选择', () => {
  it('视线外和距离外的目标不会入选', () => {
    expect(interactionScore(candidate('item', {}, 2, 0), false)).toBe(-Infinity);
    expect(interactionScore(candidate('item', {}, 3, 1), false)).toBe(-Infinity);
  });

  it('准星更正的目标优先于仅距离更近的目标', () => {
    const near = candidate('item', {}, 0.8, 0.25);
    const focused = candidate('door', {}, 1.8, 0.95);
    expect(chooseInteractionCandidate([near, focused], null)).toBe(focused);
  });

  it('当前目标获得黏滞避免相邻物品提示抖动', () => {
    const currentTarget = {};
    const current = candidate('item', currentTarget, 1.35, 0.76);
    const challenger = candidate('item', {}, 1.28, 0.8);
    expect(chooseInteractionCandidate([current, challenger], currentTarget)).toBe(current);
  });

  it('直视倒地队友时救援优先于普通拾取', () => {
    const ally = candidate('ally', {}, 1.8, 0.82, 0.24);
    const item = candidate('item', {}, 1.2, 0.84);
    expect(chooseInteractionCandidate([item, ally], null)).toBe(ally);
  });
});
