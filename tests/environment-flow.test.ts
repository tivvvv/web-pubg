import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { phaseAt, timeText, WEATHER_KINDS } from '../src/environment';
import { Sky } from '../src/sky';

describe('时段显示边界', () => {
  it('全天时段在边界点稳定切换', () => {
    expect([
      phaseAt(0), phaseAt(5), phaseAt(8), phaseAt(11), phaseAt(14), phaseAt(17), phaseAt(19.5), phaseAt(23.5),
    ]).toEqual(['深夜', '清晨', '上午', '正午', '下午', '黄昏', '夜晚', '深夜']);
  });

  it('小时和分钟始终使用两位格式', () => {
    expect(timeText(0)).toBe('00:00');
    expect(timeText(7.25)).toBe('07:15');
    expect(timeText(16.8)).toBe('16:48');
    expect(timeText(23.999)).toBe('23:59');
  });

  it('天气轮换包含独立降雪而不是复用雨天', () => {
    expect(WEATHER_KINDS).toContain('snow');
    expect(new Set(WEATHER_KINDS).size).toBe(6);
  });

  it('天空拥有分层云和可复用流星池', () => {
    const scene = new THREE.Scene();
    new Sky(scene);
    expect(scene.getObjectByName('sky-atmosphere-dome')).toBeDefined();
    expect(scene.children.filter((child) => child.name === 'sky-cloud')).toHaveLength(28);
    expect(scene.children.filter((child) => child.name === 'night-meteor')).toHaveLength(3);
  });
});
