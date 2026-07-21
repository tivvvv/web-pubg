import { describe, expect, it } from 'vitest';
import { phaseAt, timeText } from '../src/environment';

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
});
