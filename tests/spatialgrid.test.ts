import { describe, expect, it } from 'vitest';
import { SpatialPointGrid } from '../src/spatialgrid';

describe('二维空间网格', () => {
  it('只返回当前位置可能接触的对象', () => {
    const grid = new SpatialPointGrid<string>(-100, -100, 100, 100, 20);
    grid.insert('房屋', -12, -8, 12, 8);
    grid.insert('远处岩石', 70, 70, 74, 74);

    expect(grid.at(0, 0)).toContain('房屋');
    expect(grid.at(0, 0)).not.toContain('远处岩石');
    expect(grid.at(72, 72)).toEqual(['远处岩石']);
  });

  it('填充距离保证邻近单元格不会漏掉碰撞体', () => {
    const grid = new SpatialPointGrid<string>(0, 0, 100, 100, 20);
    grid.insert('墙', 20.2, 10, 21, 15, 1);

    expect(grid.at(19.8, 12)).toContain('墙');
    expect(grid.at(-1, 12)).toEqual([]);
  });

  it('区域查询会跨单元格收集并自动去重', () => {
    const grid = new SpatialPointGrid<string>(0, 0, 100, 100, 20);
    grid.insert('长墙', 10, 10, 70, 12);
    grid.insert('箱子', 45, 45, 48, 48);
    const out: string[] = [];

    expect(grid.queryBounds(0, 0, 80, 20, out)).toEqual(['长墙']);
    expect(grid.queryBounds(40, 40, 50, 50, out)).toEqual(['箱子']);
    expect(grid.queryBounds(120, 120, 140, 140, out)).toEqual([]);
  });
});
