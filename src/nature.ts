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
  understory: number;
  flowers: number;
  shore: number;
  screePerRock: number;
}

export function naturalDetailBudget(hardwareConcurrency: number): NaturalDetailBudget {
  const compact = Number.isFinite(hardwareConcurrency) && hardwareConcurrency <= 4;
  return compact
    ? { grass: 4500, understory: 1000, flowers: 700, shore: 800, screePerRock: 2 }
    : { grass: 7500, understory: 1600, flowers: 1100, shore: 1200, screePerRock: 3 };
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

// 四层不规则枝盘组成一棵完整松冠。相比叠放巨大圆锥，近景能读出枝层、间隙和树梢轮廓。
export function makePineCanopyGeometry(segments = 10): THREE.BufferGeometry {
  const positions: number[] = [];
  const tiers = [
    { base: 0.2, top: 0.56, radius: 1 },
    { base: 0.4, top: 0.73, radius: 0.82 },
    { base: 0.59, top: 0.87, radius: 0.61 },
    { base: 0.75, top: 1, radius: 0.38 },
  ] as const;
  tiers.forEach((tier, tierIndex) => {
    const tipX = Math.sin(tierIndex * 2.1) * 0.035;
    const tipZ = Math.cos(tierIndex * 1.7) * 0.035;
    for (let i = 0; i < segments; i++) {
      const a0 = i / segments * Math.PI * 2;
      const a1 = (i + 1) / segments * Math.PI * 2;
      const r0 = tier.radius * (0.91 + Math.sin(i * 2.37 + tierIndex) * 0.08);
      const r1 = tier.radius * (0.91 + Math.sin((i + 1) * 2.37 + tierIndex) * 0.08);
      const x0 = Math.cos(a0) * r0;
      const z0 = Math.sin(a0) * r0;
      const x1 = Math.cos(a1) * r1;
      const z1 = Math.sin(a1) * r1;
      positions.push(
        x0, tier.base, z0,
        x1, tier.base, z1,
        tipX, tier.top, tipZ,
        x1, tier.base + 0.012, z1,
        x0, tier.base + 0.012, z0,
        0, tier.base + 0.035, 0,
      );
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// 多团低多边形叶簇合并为单个树冠，保留块面风格但打破规则球体轮廓。
export function makeBroadleafCrownGeometry(): THREE.BufferGeometry {
  const source = new THREE.DodecahedronGeometry(1, 0);
  const sourcePosition = source.getAttribute('position');
  const lobes = [
    [-0.52, 0.24, 0.02, 0.7, 0.62, 0.72],
    [0.42, 0.28, 0.14, 0.78, 0.7, 0.72],
    [-0.02, 0.55, -0.28, 0.84, 0.76, 0.82],
    [-0.18, 0.43, 0.48, 0.68, 0.64, 0.7],
    [0.22, 0.78, 0.04, 0.58, 0.56, 0.58],
  ] as const;
  const positions: number[] = [];
  for (const [ox, oy, oz, sx, sy, sz] of lobes) {
    for (let i = 0; i < sourcePosition.count; i++) {
      positions.push(
        sourcePosition.getX(i) * sx + ox,
        sourcePosition.getY(i) * sy + oy,
        sourcePosition.getZ(i) * sz + oz,
      );
    }
  }
  source.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
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
