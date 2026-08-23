import * as THREE from 'three';
import { clamp, smoothstep } from './utils';

export interface TerrainSurfaceWeights {
  wetSand: number;
  sand: number;
  meadow: number;
  forest: number;
  dryGrass: number;
  rock: number;
}

export interface NaturalDetailBudget {
  grass: number;
  nearGrass: number;
  understory: number;
  flowers: number;
  shore: number;
  screePerRock: number;
}

export function naturalDetailBudget(hardwareConcurrency: number): NaturalDetailBudget {
  const compact = Number.isFinite(hardwareConcurrency) && hardwareConcurrency <= 4;
  return compact
    ? { grass: 12000, nearGrass: 4200, understory: 1500, flowers: 850, shore: 900, screePerRock: 2 }
    : { grass: 22000, nearGrass: 7600, understory: 2400, flowers: 1400, shore: 1400, screePerRock: 3 };
}

// 统一地表生态权重. 所有颜色和自然物散布都使用同一套高度, 坡度和湿度语义.
export function terrainSurfaceWeights(
  height: number,
  slope: number,
  waterY: number,
  riverDistance: number,
  forestBias: number,
  dryBias: number,
): TerrainSurfaceWeights {
  const wetSand = 1 - smoothstep(waterY - 0.18, waterY + 0.3, height);
  const shore = smoothstep(waterY - 0.1, waterY + 0.15, height) *
    (1 - smoothstep(waterY + 0.28, waterY + 1.45, height));
  const riverSilt = (1 - smoothstep(7, 16, riverDistance)) *
    smoothstep(waterY - 0.1, waterY + 0.25, height) *
    (1 - smoothstep(waterY + 1.8, waterY + 3.2, height));
  const rock = clamp(Math.max(smoothstep(0.48, 0.92, slope), smoothstep(11.5, 17, height)), 0, 1);
  const land = clamp(1 - wetSand - shore * 0.72, 0, 1) * (1 - rock);
  const forest = clamp(forestBias, 0, 1) * land * 0.78;
  const dryGrass = clamp(dryBias, 0, 1) * land * (1 - forest * 0.7) * 0.7;
  const sand = clamp(shore + riverSilt * 0.58, 0, 1) * (1 - rock);
  const meadow = Math.max(0, land - forest - dryGrass);
  const raw = { wetSand, sand, meadow, forest, dryGrass, rock };
  const sum = Object.values(raw).reduce((total, value) => total + value, 0) || 1;
  return {
    wetSand: wetSand / sum,
    sand: sand / sum,
    meadow: meadow / sum,
    forest: forest / sum,
    dryGrass: dryGrass / sum,
    rock: rock / sum,
  };
}

export function shorelineSuitability(height: number, waterY: number, slope: number): number {
  const heightBand = smoothstep(waterY - 0.22, waterY - 0.04, height) *
    (1 - smoothstep(waterY + 0.42, waterY + 0.72, height));
  return clamp(heightBand * (1 - smoothstep(0.35, 0.72, slope)), 0, 1);
}

// 放射状蕨叶. 根部暗, 叶尖亮, 保持低多边形轮廓同时避免十字草片感.
export function makeFernGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < 7; i++) {
    const angle = i / 7 * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const sideX = -dz * 0.09;
    const sideZ = dx * 0.09;
    const tipX = dx * 0.62;
    const tipZ = dz * 0.62;
    positions.push(
      -sideX, 0.03, -sideZ,
      sideX, 0.03, sideZ,
      tipX, 0.3 + (i % 2) * 0.06, tipZ,
    );
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    colors.push(0.46, 0.52, 0.38, 0.46, 0.52, 0.38, 1.02, 1.08, 0.82);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

// 单实例包含茎和四瓣花, 使用顶点色区分叶茎与花冠.
export function makeWildflowerGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];
  const pushTri = (a: number[], b: number[], c: number[], color: number[]): void => {
    positions.push(...a, ...b, ...c);
    colors.push(...color, ...color, ...color);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
  };
  pushTri([-0.025, 0, 0], [0.025, 0, 0], [0.014, 0.55, 0], [0.38, 0.64, 0.3]);
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    pushTri(
      [0, 0.5, 0],
      [dx * 0.17 - dz * 0.07, 0.54, dz * 0.17 + dx * 0.07],
      [dx * 0.17 + dz * 0.07, 0.54, dz * 0.17 - dx * 0.07],
      [1.08, 0.92, 0.62],
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function appendFoliageLobe(
  positions: number[],
  normals: number[],
  colors: number[],
  sourcePosition: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  sourceNormal: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  angle: number,
  tint: readonly [number, number, number],
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let i = 0; i < sourcePosition.count; i++) {
    const localX = sourcePosition.getX(i) * sx;
    const localZ = sourcePosition.getZ(i) * sz;
    positions.push(
      x + cos * localX - sin * localZ,
      y + sourcePosition.getY(i) * sy,
      z + sin * localX + cos * localZ,
    );
    const rawNX = sourceNormal.getX(i) / sx;
    const rawNY = sourceNormal.getY(i) / sy;
    const rawNZ = sourceNormal.getZ(i) / sz;
    const invLength = 1 / Math.max(0.0001, Math.hypot(rawNX, rawNY, rawNZ));
    normals.push(
      (cos * rawNX - sin * rawNZ) * invLength,
      rawNY * invLength,
      (sin * rawNX + cos * rawNZ) * invLength,
    );
    colors.push(...tint);
  }
}

// 多团枝叶组成宽展松冠. 闭合叶簇替代巨型三角锥, 避免树干阴影穿到树冠表面形成黑块.
export function makePineCanopyGeometry(segments = 10): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const sourceGeometry = new THREE.IcosahedronGeometry(1, 1);
  const sourcePosition = sourceGeometry.getAttribute('position');
  const sourceNormal = sourceGeometry.getAttribute('normal');
  const tiers = [
    { y: 0.27, radial: 0.48, sx: 0.42, sy: 0.082, sz: 0.22, count: 8 },
    { y: 0.47, radial: 0.39, sx: 0.36, sy: 0.078, sz: 0.2, count: 7 },
    { y: 0.65, radial: 0.3, sx: 0.3, sy: 0.072, sz: 0.17, count: 6 },
    { y: 0.8, radial: 0.2, sx: 0.23, sy: 0.066, sz: 0.14, count: 5 },
  ] as const;
  tiers.forEach((tier, tierIndex) => {
    const count = Math.max(4, Math.round(tier.count * segments / 10));
    for (let i = 0; i < count; i++) {
      const angle = i / count * Math.PI * 2 + tierIndex * 0.46;
      const wobble = 0.9 + Math.sin(i * 2.37 + tierIndex) * 0.1;
      const shade = 0.78 + (Math.sin(i * 1.73 + tierIndex * 2.1) + 1) * 0.09;
      appendFoliageLobe(
        positions, normals, colors, sourcePosition, sourceNormal,
        Math.cos(angle) * tier.radial * wobble, tier.y, Math.sin(angle) * tier.radial * wobble,
        tier.sx * wobble, tier.sy * (0.92 + (i % 3) * 0.08), tier.sz, angle,
        [shade * 0.94, shade, shade * 0.92],
      );
    }
  });
  appendFoliageLobe(
    positions, normals, colors, sourcePosition, sourceNormal,
    0.02, 0.92, 0, 0.18, 0.18, 0.18, 0, [0.92, 0.98, 0.9],
  );
  sourceGeometry.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

// 窄高寒地松冠. 紧凑叶簇向上收拢, 与宽展松冠形成明显品种差异.
export function makeColumnarPineCanopyGeometry(segments = 9): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const sourceGeometry = new THREE.IcosahedronGeometry(1, 1);
  const sourcePosition = sourceGeometry.getAttribute('position');
  const sourceNormal = sourceGeometry.getAttribute('normal');
  const tiers = [
    { y: 0.23, radial: 0.3, sx: 0.27, sy: 0.16, sz: 0.18, count: 5 },
    { y: 0.41, radial: 0.25, sx: 0.24, sy: 0.15, sz: 0.17, count: 5 },
    { y: 0.58, radial: 0.2, sx: 0.2, sy: 0.14, sz: 0.15, count: 5 },
    { y: 0.73, radial: 0.14, sx: 0.17, sy: 0.13, sz: 0.13, count: 4 },
    { y: 0.86, radial: 0.08, sx: 0.13, sy: 0.11, sz: 0.11, count: 4 },
  ] as const;
  tiers.forEach((tier, tierIndex) => {
    const count = Math.max(4, Math.round(tier.count * segments / 9));
    for (let i = 0; i < count; i++) {
      const angle = i / count * Math.PI * 2 + tierIndex * 0.57;
      const wobble = 0.92 + Math.sin(i * 2.71 + tierIndex) * 0.08;
      const shade = 0.8 + (Math.sin(i * 1.91 + tierIndex * 2.35) + 1) * 0.08;
      appendFoliageLobe(
        positions, normals, colors, sourcePosition, sourceNormal,
        Math.cos(angle) * tier.radial * wobble, tier.y, Math.sin(angle) * tier.radial * wobble,
        tier.sx * wobble, tier.sy, tier.sz, angle,
        [shade * 0.92, shade, shade * 0.96],
      );
    }
  });
  appendFoliageLobe(
    positions, normals, colors, sourcePosition, sourceNormal,
    0.015, 0.96, 0, 0.12, 0.17, 0.12, 0, [0.9, 0.98, 0.94],
  );
  sourceGeometry.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

// 多团细分叶簇合并为单个树冠，保留清晰轮廓并通过平滑法线消除近景大三角切面。
export function makeBroadleafCrownGeometry(): THREE.BufferGeometry {
  const source = new THREE.IcosahedronGeometry(1, 1);
  const sourcePosition = source.getAttribute('position');
  const sourceNormal = source.getAttribute('normal');
  const lobes = [
    [-0.58, 0.22, 0.02, 0.72, 0.62, 0.72, -0.18],
    [0.46, 0.26, 0.14, 0.8, 0.7, 0.74, 0.28],
    [-0.04, 0.54, -0.3, 0.86, 0.76, 0.82, 0.08],
    [-0.22, 0.44, 0.48, 0.7, 0.64, 0.72, -0.24],
    [0.24, 0.78, 0.05, 0.62, 0.58, 0.62, 0.2],
    [-0.62, 0.64, -0.24, 0.54, 0.5, 0.58, 0.12],
    [0.68, 0.58, -0.2, 0.58, 0.54, 0.6, -0.16],
    [0.03, 0.9, 0.3, 0.5, 0.48, 0.54, 0.3],
  ] as const;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  for (let lobeIndex = 0; lobeIndex < lobes.length; lobeIndex++) {
    const [ox, oy, oz, sx, sy, sz, angle] = lobes[lobeIndex] as typeof lobes[number];
    const shade = 0.79 + (Math.sin(lobeIndex * 1.81) + 1) * 0.085;
    appendFoliageLobe(
      positions, normals, colors, sourcePosition, sourceNormal,
      ox, oy, oz, sx, sy, sz, angle, [shade * 0.96, shade, shade * 0.9],
    );
  }
  source.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

// 偏冠阔叶树. 叶簇向一侧展开并保留枝间空隙, 用于草原和风口的识别性轮廓.
export function makeWindshapedCrownGeometry(): THREE.BufferGeometry {
  const source = new THREE.IcosahedronGeometry(1, 1);
  const sourcePosition = source.getAttribute('position');
  const sourceNormal = source.getAttribute('normal');
  const lobes = [
    [-0.68, 0.12, 0.02, 0.64, 0.5, 0.58, -0.12],
    [-0.12, 0.28, -0.18, 0.78, 0.62, 0.72, 0.2],
    [0.5, 0.4, 0.06, 0.84, 0.58, 0.66, -0.18],
    [1.08, 0.48, 0.2, 0.6, 0.44, 0.56, 0.26],
    [0.28, 0.72, -0.16, 0.58, 0.5, 0.52, -0.1],
    [0.76, 0.78, -0.2, 0.5, 0.46, 0.5, 0.18],
    [-0.34, 0.62, 0.24, 0.5, 0.46, 0.5, -0.22],
  ] as const;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  for (let lobeIndex = 0; lobeIndex < lobes.length; lobeIndex++) {
    const [ox, oy, oz, sx, sy, sz, angle] = lobes[lobeIndex] as typeof lobes[number];
    const shade = 0.8 + (Math.sin(lobeIndex * 1.67) + 1) * 0.08;
    appendFoliageLobe(
      positions, normals, colors, sourcePosition, sourceNormal,
      ox, oy, oz, sx, sy, sz, angle, [shade, shade * 0.98, shade * 0.84],
    );
  }
  source.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

export function makeDistantRidgeGeometry(seedOffset = 0): THREE.BufferGeometry {
  const segments = 12;
  const positions: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = i / segments * Math.PI * 2;
    const a1 = (i + 1) / segments * Math.PI * 2;
    const wobble0 = 0.82 + Math.sin(i * 2.17 + seedOffset) * 0.16;
    const wobble1 = 0.82 + Math.sin((i + 1) * 2.17 + seedOffset) * 0.16;
    const crown0 = 0.26 + Math.sin(i * 1.67 + seedOffset) * 0.08;
    const crown1 = 0.26 + Math.sin((i + 1) * 1.67 + seedOffset) * 0.08;
    const top0 = 0.72 + Math.sin(i * 1.31 + seedOffset) * 0.16;
    const top1 = 0.72 + Math.sin((i + 1) * 1.31 + seedOffset) * 0.16;
    const b0 = [Math.cos(a0) * wobble0, 0, Math.sin(a0) * wobble0];
    const b1 = [Math.cos(a1) * wobble1, 0, Math.sin(a1) * wobble1];
    const t0 = [Math.cos(a0) * crown0, top0, Math.sin(a0) * crown0];
    const t1 = [Math.cos(a1) * crown1, top1, Math.sin(a1) * crown1];
    positions.push(
      ...b0, ...b1, ...t1,
      ...b0, ...t1, ...t0,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
