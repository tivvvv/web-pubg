import { describe, expect, it, vi } from 'vitest';
import { Character, separateCharacterBodies } from '../src/character';

function character(name: string, x: number, y: number, z: number): Character {
  const c = new Character(name, false, 0x4477aa);
  c.pos.set(x, y, z);
  c.airPose = null;
  c.group.visible = true;
  return c;
}

describe('角色软碰撞', () => {
  it('同层重叠角色会稳定分开并重新执行静态碰撞约束', () => {
    const a = character('A', 0, 2, 0);
    const b = character('B', 0, 2, 0);
    const resolve = vi.fn();

    expect(separateCharacterBodies([a, b], resolve)).toBeGreaterThan(0);
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)).toBeGreaterThanOrEqual(
      a.radius + b.radius - 0.001,
    );
    expect(resolve).toHaveBeenCalledWith(a);
    expect(resolve).toHaveBeenCalledWith(b);
  });

  it('不同楼层和乘车角色不会互相推挤', () => {
    const lower = character('一楼', 0, 2, 0);
    const upper = character('二楼', 0, 5, 0);
    const rider = character('乘员', 0, 2, 0);
    rider.airPose = 'sit';
    const resolve = vi.fn();

    expect(separateCharacterBodies([lower, upper, rider], resolve)).toBe(0);
    expect(lower.pos.x).toBe(0);
    expect(upper.pos.x).toBe(0);
    expect(rider.pos.x).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('静态碰撞修正会在后续分离轮次继续收敛', () => {
    const a = character('门左', 0, 2, 0);
    const b = character('门右', 0.2, 2, 0);
    const resolve = (c: Character): void => {
      c.pos.x = Math.max(0, c.pos.x);
    };

    separateCharacterBodies([a, b], resolve, 3);
    expect(a.pos.x).toBeGreaterThanOrEqual(0);
    expect(b.pos.x).toBeGreaterThan(a.pos.x);
  });
});
