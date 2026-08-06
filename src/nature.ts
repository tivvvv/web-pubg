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
    ? { grass: 3000, understory: 720, flowers: 480, shore: 620, screePerRock: 2 }
    : { grass: 5000, understory: 1200, flowers: 820, shore: 900, screePerRock: 3 };
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
