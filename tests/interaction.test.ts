import { describe, expect, it } from 'vitest';
import {
  chooseInteractionCandidate, doorwayOccupied, equipmentComparison, interactionDistanceText,
  interactionScore, isAutomaticPickupKind, reviveCancellationReason, type InteractionCandidate,
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

  it('当前目标在阈值边缘获得容差但不会无限扩大交互范围', () => {
    const target = {};
    const edgeDistance = candidate('door', target, 2.72, 0.06);
    const edgeAim = candidate('item', target, 2.2, 0.04);
    const tooFar = candidate('door', target, 2.81, 0.9);
    const tooFarOffAim = candidate('item', target, 1.2, 0.01);

    expect(interactionScore(edgeDistance, false)).toBe(-Infinity);
    expect(interactionScore(edgeDistance, true)).toBeGreaterThan(-Infinity);
    expect(interactionScore(edgeAim, false)).toBe(-Infinity);
    expect(interactionScore(edgeAim, true)).toBeGreaterThan(-Infinity);
    expect(interactionScore(tooFar, true)).toBe(-Infinity);
    expect(interactionScore(tooFarOffAim, true)).toBe(-Infinity);
  });

  it('直视倒地队友时救援优先于普通拾取', () => {
    const ally = candidate('ally', {}, 1.8, 0.82, 0.24);
    const item = candidate('item', {}, 1.2, 0.84);
    expect(chooseInteractionCandidate([item, ally], null)).toBe(ally);
  });

  it('装备比较明确区分空栏位, 升级, 同级和降级', () => {
    expect(equipmentComparison(null, null, 2)).toEqual({ text: '空栏位 · 直接装备', tone: 'positive' });
    expect(equipmentComparison('一级头盔', 1, 2).tone).toBe('positive');
    expect(equipmentComparison('二级头盔', 2, 2).tone).toBe('neutral');
    expect(equipmentComparison('三级头盔', 3, 2).tone).toBe('warning');
  });

  it('提示距离统一为一位小数并钳制负值', () => {
    expect(interactionDistanceText(1.26)).toBe('1.3 米');
    expect(interactionDistanceText(-1)).toBe('0.0 米');
  });

  it('自动拾取只包含消耗品且不自动装备武器护具和背包', () => {
    for (const kind of [
      'ammoRifle', 'ammoSmg', 'ammoSniper', 'ammoPistol', 'ammoShotgun',
      'bandage', 'medkit', 'drink', 'frag', 'smoke', 'flash',
    ] as const) {
      expect(isAutomaticPickupKind(kind)).toBe(true);
    }
    for (const kind of ['rifle', 'reddot', 'pack3', 'helmet3', 'vest3'] as const) {
      expect(isAutomaticPickupKind(kind)).toBe(false);
    }
  });

  it('救援会被移动和目标距离过远可靠打断', () => {
    const base = { targetValid: true, reviverIncapacitated: false, reviverSpeed: 0, distance: 1.5 };
    expect(reviveCancellationReason(base)).toBeNull();
    expect(reviveCancellationReason({ ...base, reviverSpeed: 0.21 })).toBe('movement');
    expect(reviveCancellationReason({ ...base, distance: 2.76 })).toBe('range');
    expect(reviveCancellationReason({ ...base, targetValid: false })).toBe('target');
  });

  it('门洞占用检测只阻止与门洞高度和足迹重叠的角色', () => {
    const bounds = { minX: -0.7, minY: 0, minZ: -0.08, maxX: 0.7, maxY: 2, maxZ: 0.08 };
    expect(doorwayOccupied(bounds, [
      { x: 0, y: 0, z: 0.3, radius: 0.42, active: true },
    ])).toBe(true);
    expect(doorwayOccupied(bounds, [
      { x: 0, y: 2.1, z: 0, radius: 0.42, active: true },
      { x: 2, y: 0, z: 0, radius: 0.42, active: true },
      { x: 0, y: 0, z: 0, radius: 0.42, active: false },
    ])).toBe(false);
  });
});
