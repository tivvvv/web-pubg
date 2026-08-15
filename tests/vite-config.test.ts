import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, resolvePort } from '../vite.config';

describe('项目运行端口配置', () => {
  it('未配置时使用 Vite 默认端口', () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
    expect(resolvePort('')).toBe(DEFAULT_PORT);
    expect(resolvePort('   ')).toBe(DEFAULT_PORT);
  });

  it('读取有效的自定义端口', () => {
    expect(resolvePort('3000')).toBe(3000);
    expect(resolvePort(' 4173 ')).toBe(4173);
    expect(resolvePort('65535')).toBe(65535);
  });

  it('拒绝无效端口', () => {
    for (const value of ['0', '65536', '-1', '3000.5', 'abc']) {
      expect(() => resolvePort(value)).toThrow('APP_PORT 必须是 1 到 65535 之间的整数');
    }
  });
});
