import { afterEach, describe, expect, it } from 'vitest';
import { createSeededRandom, currentRandomSeed, parseRandomSeed, random, setRandomSeed } from '../src/random';

afterEach(() => setRandomSeed(null));

describe('可复现对局随机源', () => {
  it('相同种子生成相同序列', () => {
    const first = createSeededRandom(20260722);
    const second = createSeededRandom(20260722);
    expect(Array.from({ length: 8 }, first)).toEqual(Array.from({ length: 8 }, second));
  });

  it('重设种子后全局随机源回到同一起点', () => {
    setRandomSeed(77);
    const first = [random(), random(), random()];
    setRandomSeed(77);
    expect([random(), random(), random()]).toEqual(first);
    expect(currentRandomSeed()).toBe(77);
  });

  it('仅接受有限数字种子并转换为无符号整数', () => {
    expect(parseRandomSeed('?seed=42')).toBe(42);
    expect(parseRandomSeed('?seed=-1')).toBe(0xffffffff);
    expect(parseRandomSeed('?seed=bad', 9)).toBe(9);
    expect(parseRandomSeed('', 11)).toBe(11);
  });
});
