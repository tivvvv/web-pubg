// 静态二维空间网格: 把全图碰撞扫描缩小到角色所在单元格, 不改变精确碰撞判定.
const EMPTY_ITEMS: readonly never[] = Object.freeze([]);

export class SpatialPointGrid<T> {
  private readonly minX: number;
  private readonly minZ: number;
  private readonly maxX: number;
  private readonly maxZ: number;
  private readonly cellSize: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly cells: (T[] | undefined)[];
  private readonly seen = new Set<T>();

  constructor(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    cellSize: number,
  ) {
    if (cellSize <= 0 || maxX <= minX || maxZ <= minZ) throw new Error('无效空间网格范围');
    this.minX = minX;
    this.minZ = minZ;
    this.maxX = maxX;
    this.maxZ = maxZ;
    this.cellSize = cellSize;
    this.columns = Math.ceil((maxX - minX) / cellSize);
    this.rows = Math.ceil((maxZ - minZ) / cellSize);
    this.cells = new Array(this.columns * this.rows);
  }

  insert(item: T, minX: number, minZ: number, maxX: number, maxZ: number, padding = 0): void {
    const x0 = this.columnAt(minX - padding, true);
    const x1 = this.columnAt(maxX + padding, true);
    const z0 = this.rowAt(minZ - padding, true);
    const z1 = this.rowAt(maxZ + padding, true);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const idx = z * this.columns + x;
        const cell = this.cells[idx] ?? (this.cells[idx] = []);
        cell.push(item);
      }
    }
  }

  at(x: number, z: number): readonly T[] {
    const column = this.columnAt(x, false);
    const row = this.rowAt(z, false);
    if (column < 0 || row < 0) return EMPTY_ITEMS;
    return this.cells[row * this.columns + column] ?? EMPTY_ITEMS;
  }

  queryBounds(minX: number, minZ: number, maxX: number, maxZ: number, out: T[]): readonly T[] {
    out.length = 0;
    if (maxX < this.minX || minX > this.maxX || maxZ < this.minZ || minZ > this.maxZ) return out;
    const x0 = this.columnAt(minX, true);
    const x1 = this.columnAt(maxX, true);
    const z0 = this.rowAt(minZ, true);
    const z1 = this.rowAt(maxZ, true);
    this.seen.clear();
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const cell = this.cells[z * this.columns + x];
        if (!cell) continue;
        for (const item of cell) {
          if (this.seen.has(item)) continue;
          this.seen.add(item);
          out.push(item);
        }
      }
    }
    return out;
  }

  private columnAt(x: number, clampToGrid: boolean): number {
    if (!clampToGrid && (x < this.minX || x > this.maxX)) return -1;
    return Math.max(0, Math.min(this.columns - 1, Math.floor((x - this.minX) / this.cellSize)));
  }

  private rowAt(z: number, clampToGrid: boolean): number {
    if (!clampToGrid && (z < this.minZ || z > this.maxZ)) return -1;
    return Math.max(0, Math.min(this.rows - 1, Math.floor((z - this.minZ) / this.cellSize)));
  }
}
