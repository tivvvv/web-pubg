export const WORLD_SIZE = 700;
export const WORLD_HALF = WORLD_SIZE / 2;
export const WATER_Y = 0.9;

export function riverZAt(x: number): number {
  return 80 + 22 * Math.sin(x * 0.012 + 1.3);
}

export const ROAD_PATHS: readonly (readonly [number, number])[][] = [
  [[-92, -96], [-66, -72], [-58, -20], [-52, 36], [-50, 66], [-50, 112], [-44, 164], [-40, 246]],
  [[-142, -26], [-98, -23], [-58, -20], [-8, -18], [42, -12], [98, -18], [152, -31], [178, -38], [194, -43]],
  [[178, -38], [194, -82], [203, -140], [205, -209]],
  [[-84, -20], [-136, -7], [-181, 9], [-228, 20]],
  [[-58, -20], [-46, -68], [-30, -112], [-16, -158], [-10, -170], [0, -180], [10, -190], [10, -200], [20, -200]],
  [[178, -38], [171, 18], [170, 64], [170, 112], [134, 160], [70, 190], [-40, 200]],
];

export function roadIntersectsRect(
  minX: number, minZ: number, maxX: number, maxZ: number, clearance = 0,
): boolean {
  const x0 = minX - clearance;
  const z0 = minZ - clearance;
  const x1 = maxX + clearance;
  const z1 = maxZ + clearance;
  for (const path of ROAD_PATHS) {
    for (let index = 0; index < path.length - 1; index++) {
      const a = path[index] as readonly [number, number];
      const b = path[index + 1] as readonly [number, number];
      let near = 0;
      let far = 1;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      let separated = false;
      for (const [p, q] of [
        [-dx, a[0] - x0], [dx, x1 - a[0]],
        [-dz, a[1] - z0], [dz, z1 - a[1]],
      ] as const) {
        if (Math.abs(p) < 0.000001) {
          if (q < 0) separated = true;
          continue;
        }
        const ratio = q / p;
        if (p < 0) near = Math.max(near, ratio);
        else far = Math.min(far, ratio);
        if (near > far) separated = true;
      }
      if (!separated && near <= far) return true;
    }
  }
  return false;
}
