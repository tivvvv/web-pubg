// 世界: 程序化高度场地形 + 植被/岩石实例化 + 真房屋村庄 + 碰撞与解析射线
import * as THREE from 'three';
import { Noise2D, fbm } from './noise';
import { Buildings } from './buildings';
import { Sky } from './sky';
import type { Collider, DestructibleLike, SurfaceKind } from './types';
import { clamp, mulberry32, smoothstep } from './utils';

export const WORLD_SIZE = 700;
export const WORLD_HALF = 350;
export const WATER_Y = 0.9;

// 河流中心线: z ≈ +80, 正弦蜿蜒 ±22
export function riverZAt(x: number): number {
  return 80 + 22 * Math.sin(x * 0.012 + 1.3);
}

const GRID = 150; // 地形网格分段
const CELL = WORLD_SIZE / GRID;

export interface StaticHit {
  t: number;
  kind: SurfaceKind;
  destruct?: DestructibleLike; // 命中可破坏物(门/窗)时带出
}

export interface Platform {
  minX: number; minZ: number; maxX: number; maxZ: number; top: number;
}

export class World {
  readonly colliders: Collider[] = [];
  readonly cyls: Extract<Collider, { kind: 'cyl' }>[] = [];
  readonly aabbs: Extract<Collider, { kind: 'aabb' }>[] = [];
  readonly platforms: Platform[] = []; // 楼梯踏步等"可站立但无碰撞体"平台
  readonly buildings = new Buildings();
  readonly bushes: { x: number; z: number; r: number }[] = []; // 灌木足迹(隐蔽判定)
  maxTerrainH = 24;

  private heights = new Float32Array((GRID + 1) * (GRID + 1));
  private sun: THREE.DirectionalLight;
  private sky: Sky;
  private timeU = { value: 0 };   // 共享时间 uniform(水波/植被摇摆)
  private camU = { value: new THREE.Vector3() }; // 共享相机 uniform(草距离消退)
  private elapsed = 0;

  constructor(scene: THREE.Scene) {
    const n1 = new Noise2D(1337);
    const n2 = new Noise2D(9001);
    const rawH = (x: number, z: number): number => {
      const d = Math.sqrt(x * x + z * z);
      const mask = smoothstep(360, 242, d); // 岛屿边缘下沉入海
      const base = fbm(n1, x * 0.0062, z * 0.0062, 4) * 12.5;
      const detail = fbm(n2, x * 0.021, z * 0.021, 2) * 2.2;
      let h = (base + detail + 7.0) * mask - 3.4;
      // 西部山地抬升: 滚丘 +8~12m, 平滑融入基础起伏
      const hd = Math.hypot(x + 220, z - 20);
      if (hd < 140) {
        const f = 1 - hd / 140;
        h += 11 * f * f * (0.65 + 0.7 * (fbm(n2, x * 0.03 + 3, z * 0.03 - 5, 2) * 0.5 + 0.5));
      }
      // 河流下切: z≈80 正弦蜿蜒, 河床没入水下(后于抬升, 先于一马平川)
      const rd = Math.abs(z - riverZAt(x));
      if (rd < 14) {
        const t = smoothstep(13, 5, rd); // 0 岸 → 1 河心
        h = h * (1 - t) + -1.6 * t;
      }
      return h;
    };

    // 填充高度栅格
    for (let iz = 0; iz <= GRID; iz++) {
      for (let ix = 0; ix <= GRID; ix++) {
        const x = -WORLD_HALF + ix * CELL;
        const z = -WORLD_HALF + iz * CELL;
        this.heights[iz * (GRID + 1) + ix] = rawH(x, z);
      }
    }

    // 村庄规划 + 地基平整(必须在生成地形几何体之前)
    this.buildings.plan(this);
    this.buildings.flattenTerrain(this);
    let maxH = -100;
    for (let i = 0; i < this.heights.length; i++) {
      const h = this.heights[i] as number;
      if (h > maxH) maxH = h;
    }
    this.maxTerrainH = maxH + 1;

    // 地形网格 + 顶点色
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, GRID, GRID);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const cSand = new THREE.Color(0xd6c188);
    const cSandWet = new THREE.Color(0xa5987a);
    const cGrassA = new THREE.Color(0x679c46);
    const cGrassB = new THREE.Color(0x87b25a);
    const cDry = new THREE.Color(0xa6ac62);
    const cRock = new THREE.Color(0x8d8c86);
    const tmpC = new THREE.Color();
    const grassC = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.getHeight(x, z);
      pos.setY(i, h);
      const sx = (this.getHeight(x + CELL, z) - this.getHeight(x - CELL, z)) / (2 * CELL);
      const sz = (this.getHeight(x, z + CELL) - this.getHeight(x, z - CELL)) / (2 * CELL);
      const slope = Math.sqrt(sx * sx + sz * sz);
      const vary = n2.noise(x * 0.05, z * 0.05) * 0.5 + 0.5;
      // 基底: 湿沙→干沙, 平滑过渡到草地
      tmpC.copy(h < WATER_Y - 0.2 ? cSandWet : cSand);
      grassC.copy(cGrassA).lerp(cGrassB, vary);
      // 大尺度补丁: 偏湿暗 / 偏干黄
      const pn = fbm(n1, x * 0.013 + 7, z * 0.013 - 3, 3);
      if (pn < -0.12) {
        grassC.multiplyScalar(0.82);
        grassC.g *= 1.06;
      } else if (pn > 0.15) {
        grassC.lerp(cDry, smoothstep(0.15, 0.45, pn));
      }
      tmpC.lerp(grassC, smoothstep(WATER_Y + 0.2, WATER_Y + 1.2, h));
      const rockF = Math.max(smoothstep(0.55, 0.95, slope), smoothstep(12, 16, h));
      tmpC.lerp(cRock, rockF);
      // 逐顶点确定性抖动, 打散色带
      const jh = Math.sin(i * 12.9898) * 43758.5453;
      const j = 1 + (jh - Math.floor(jh) - 0.5) * 0.05;
      colors[i * 3] = tmpC.r * j;
      colors[i * 3 + 1] = tmpC.g * j;
      colors[i * 3 + 2] = tmpC.b * j;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    terrain.receiveShadow = true;
    scene.add(terrain);

    // 水面(高光 + 顶点波浪 + 法线微扰)
    const waterMat = new THREE.MeshPhongMaterial({
      color: 0x2e6f93,
      specular: 0x99ccee,
      shininess: 90,
      transparent: true,
      opacity: 0.8,
    });
    const timeU = this.timeU;
    waterMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
  objectNormal = normalize(objectNormal + vec3(
    0.045 * cos(position.x * 0.05 + uTime * 0.8),
    0.045 * sin(position.y * 0.07 + uTime * 0.6),
    0.0));`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
  // 只向下波动(峰值 ≤ 0): 波峰永不越过水线, 避免在略高于水面的浅滩上"涨"出蓝色假水面
  transformed.z += (sin(position.x * 0.08 + uTime * 1.2) + cos(position.y * 0.06 + uTime * 0.9)) * 0.022 - 0.045;`,
        );
    };
    waterMat.customProgramCacheKey = () => 'water-bob';
    const water = new THREE.Mesh(new THREE.PlaneGeometry(1800, 1800, 48, 48), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_Y;
    scene.add(water);

    // 天空 / 雾 / 光照(雾色与天穹地平线一致; 金色暖阳)
    scene.fog = new THREE.Fog(0xead9c4, 150, 640);
    const hemi = new THREE.HemisphereLight(0xd8e6f5, 0x767a55, 0.82);
    scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xffdfb0, 2.35);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -60;
    this.sun.shadow.camera.right = 60;
    this.sun.shadow.camera.top = 60;
    this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 280;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.sky = new Sky(scene);

    this.buildStatics(scene);
  }

  // 把矩形内地形压平到 h, 边缘 margin 内平滑过渡(作用于高度栅格)
  flattenRect(minX: number, minZ: number, maxX: number, maxZ: number, h: number, margin: number): void {
    const W = GRID + 1;
    for (let iz = 0; iz <= GRID; iz++) {
      for (let ix = 0; ix <= GRID; ix++) {
        const x = -WORLD_HALF + ix * CELL;
        const z = -WORLD_HALF + iz * CELL;
        if (x < minX - margin || x > maxX + margin || z < minZ - margin || z > maxZ + margin) continue;
        const dx = Math.max(minX - x, 0, x - maxX);
        const dz = Math.max(minZ - z, 0, z - maxZ);
        const dist = Math.hypot(dx, dz);
        const idx = iz * W + ix;
        if (dist <= 0.001) {
          this.heights[idx] = h;
        } else {
          const t = smoothstep(0, margin, dist);
          this.heights[idx] = h + ((this.heights[idx] as number) - h) * t;
        }
      }
    }
  }

  // 双线性插值地形高度
  getHeight(x: number, z: number): number {
    const gx = clamp((x + WORLD_HALF) / CELL, 0, GRID - 0.0001);
    const gz = clamp((z + WORLD_HALF) / CELL, 0, GRID - 0.0001);
    const ix = gx | 0;
    const iz = gz | 0;
    const fx = gx - ix;
    const fz = gz - iz;
    const W = GRID + 1;
    const h00 = this.heights[iz * W + ix] as number;
    const h10 = this.heights[iz * W + ix + 1] as number;
    const h01 = this.heights[(iz + 1) * W + ix] as number;
    const h11 = this.heights[(iz + 1) * W + ix + 1] as number;
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  }

  private slopeAt(x: number, z: number): number {
    const sx = (this.getHeight(x + 2, z) - this.getHeight(x - 2, z)) / 4;
    const sz = (this.getHeight(x, z + 2) - this.getHeight(x, z - 2)) / 4;
    return Math.sqrt(sx * sx + sz * sz);
  }

  addCollider(c: Collider): void {
    this.colliders.push(c);
    if (c.kind === 'cyl') this.cyls.push(c);
    else this.aabbs.push(c);
  }

  // 点是否落在任一房屋地块内(含 margin)
  inPlot(x: number, z: number, margin: number): boolean {
    for (const p of this.buildings.plots) {
      if (x > p.minX - margin && x < p.maxX + margin && z > p.minZ - margin && z < p.maxZ + margin) return true;
    }
    return false;
  }

  // 点是否落在任一灌木足迹内(隐蔽判定, 线性扫描 ~300 项成本可忽略)
  inBush(x: number, z: number): boolean {
    for (const b of this.bushes) {
      const dx = x - b.x;
      const dz = z - b.z;
      if (dx * dx + dz * dz < b.r * b.r) return true;
    }
    return false;
  }

  private buildStatics(scene: THREE.Scene): void {
    const rng = mulberry32(424242);
    const m4 = new THREE.Matrix4();
    const q0 = new THREE.Quaternion();
    const vPos = new THREE.Vector3();
    const vScale = new THREE.Vector3();

    // ---- 房屋村庄(先生成, 树木岩石随后避开) ----
    this.buildings.build(scene, this);

    // ---- 树木(松树 60% + 阔叶 40%, 树干/碰撞体逻辑不变; 北境密林加密) ----
    const treeCap = 470; // 全图 350 + 密林加密 120
    const upY = new THREE.Vector3(0, 1, 0);
    const trunkMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.2, 0.34, 3.4, 6),
      new THREE.MeshLambertMaterial({ color: 0x6b4a2e }),
      treeCap,
    );
    const canopyMat = new THREE.MeshLambertMaterial({ color: 0x3f7a33 });
    const canopyMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(1.7, 4.4, 7), canopyMat, treeCap);
    const broadMat = new THREE.MeshLambertMaterial({ color: 0x568c3f });
    const broadMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.9, 1), broadMat, treeCap);
    this.addSway(canopyMat, 0.09, -2.0, 2.5);
    this.addSway(broadMat, 0.09, -1.5, 2.0);
    trunkMesh.castShadow = true;
    canopyMesh.castShadow = true;
    broadMesh.castShadow = true;
    const placedPts: number[] = [];
    const canopyC = new THREE.Color();
    let pineCount = 0;
    let broadCount = 0;
    let treeCount = 0;
    const tryTree = (x: number, z: number): boolean => {
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.8 || h > 13 || this.slopeAt(x, z) > 0.6) return false;
      if (this.inPlot(x, z, 2.5)) return false;
      for (let i = 0; i < placedPts.length; i += 2) {
        const dx = x - (placedPts[i] as number);
        const dz = z - (placedPts[i + 1] as number);
        if (dx * dx + dz * dz < 8.4) return false;
      }
      placedPts.push(x, z);
      const s = 0.8 + rng() * 0.55;
      q0.setFromAxisAngle(upY, rng() * Math.PI * 2);
      if (rng() < 0.6) {
        // 松树: 锥形树冠
        vPos.set(x, h + 1.7 * s, z);
        vScale.set(s, s, s);
        m4.compose(vPos, q0, vScale);
        trunkMesh.setMatrixAt(treeCount, m4);
        vPos.set(x, h + (3.4 + 2.0) * s, z);
        m4.compose(vPos, q0, vScale);
        canopyMesh.setMatrixAt(pineCount, m4);
        const g = 0.75 + rng() * 0.5;
        canopyC.setRGB(0.22 * g, 0.42 * g, 0.18 * g);
        canopyMesh.setColorAt(pineCount, canopyC);
        pineCount++;
      } else {
        // 阔叶: 树干压矮, 扁球形树冠
        const st = s * 0.75;
        vPos.set(x, h + 1.7 * st, z);
        vScale.set(s, st, s);
        m4.compose(vPos, q0, vScale);
        trunkMesh.setMatrixAt(treeCount, m4);
        const cs = s * 1.15;
        vPos.set(x, h + 3.4 * st + 1.15 * cs, z);
        vScale.set(cs, cs * 0.8, cs);
        m4.compose(vPos, q0, vScale);
        broadMesh.setMatrixAt(broadCount, m4);
        const g = 0.7 + rng() * 0.55;
        canopyC.setRGB(0.3 * g, 0.5 * g, 0.2 * g);
        broadMesh.setColorAt(broadCount, canopyC);
        broadCount++;
      }
      treeCount++;
      this.addCollider({ kind: 'cyl', x, z, r: 0.42 * s, y0: h - 0.5, y1: h + 3.4 * s, tag: 'tree' });
      return true;
    };
    // 先撒密林加密树(z<-150 带状), 再全图散布
    for (let t = 0; t < 1600 && treeCount < 130; t++) {
      tryTree((rng() * 2 - 1) * 320, -160 - rng() * 170);
    }
    for (let t = 0; t < 4000 && treeCount < treeCap; t++) {
      tryTree((rng() * 2 - 1) * 330, (rng() * 2 - 1) * 330);
    }
    trunkMesh.count = treeCount;
    canopyMesh.count = pineCount;
    broadMesh.count = broadCount;
    trunkMesh.instanceMatrix.needsUpdate = true;
    canopyMesh.instanceMatrix.needsUpdate = true;
    broadMesh.instanceMatrix.needsUpdate = true;
    if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
    if (broadMesh.instanceColor) broadMesh.instanceColor.needsUpdate = true;
    trunkMesh.computeBoundingSphere();
    canopyMesh.computeBoundingSphere();
    broadMesh.computeBoundingSphere();
    scene.add(trunkMesh);
    scene.add(canopyMesh);
    scene.add(broadMesh);

    // ---- 岩石(西部山地加密) ----
    const rockCap = 200; // 全图 120 + 山地加密 80
    const rockMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshLambertMaterial({ color: 0x8f8f8b }),
      rockCap,
    );
    rockMesh.castShadow = true;
    rockMesh.receiveShadow = true;
    let rockCount = 0;
    const tryRock = (x: number, z: number): boolean => {
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.3 || h > 15) return false;
      if (this.inPlot(x, z, 2.5)) return false;
      const s = 0.7 + rng() * 1.7;
      const sy = s * (0.55 + rng() * 0.4);
      vPos.set(x, h + sy * 0.25, z);
      vScale.set(s * (0.8 + rng() * 0.5), sy, s * (0.8 + rng() * 0.5));
      q0.setFromEuler(new THREE.Euler(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4));
      m4.compose(vPos, q0, vScale);
      rockMesh.setMatrixAt(rockCount, m4);
      const g = 0.82 + rng() * 0.3;
      canopyC.setRGB(0.56 * g, 0.56 * g, 0.55 * g);
      rockMesh.setColorAt(rockCount, canopyC);
      rockCount++;
      this.addCollider({ kind: 'cyl', x, z, r: s * 0.92, y0: h - 1, y1: h + sy * 0.95, tag: 'rock' });
      return true;
    };
    // 山地加密岩
    for (let t = 0; t < 900 && rockCount < 80; t++) {
      tryRock(-220 + (rng() * 2 - 1) * 120, 20 + (rng() * 2 - 1) * 120);
    }
    for (let t = 0; t < 2000 && rockCount < rockCap; t++) {
      tryRock((rng() * 2 - 1) * 330, (rng() * 2 - 1) * 330);
    }
    rockMesh.count = rockCount;
    rockMesh.instanceMatrix.needsUpdate = true;
    if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
    scene.add(rockMesh);

    // ---- 灌木丛(无碰撞体: 子弹/移动均可穿过, 供隐蔽判定; 密林加密) ----
    const bushCap = 420; // 全图 300 + 密林加密 120
    const bushGeo = new THREE.IcosahedronGeometry(1, 1);
    const BUSH_COLORS = [0x2f5c2a, 0x3f7a33, 0x5c6e2e, 0x8a9438];
    const bushMeshes: THREE.InstancedMesh[] = [];
    for (let layer = 0; layer < 3; layer++) {
      const bm = new THREE.MeshLambertMaterial({ color: 0xffffff });
      this.addSway(bm, 0.07, -1.0, 1.2, true, false, 180, 200);
      const mesh = new THREE.InstancedMesh(bushGeo, bm, bushCap);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      bushMeshes.push(mesh);
      scene.add(mesh);
    }
    const bushPts: number[] = [];
    let bushCount = 0;
    const tryBush = (x: number, z: number): boolean => {
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.5 || h > 13 || this.slopeAt(x, z) > 0.5) return false;
      if (this.inPlot(x, z, 2.5)) return false;
      for (let i = 0; i < bushPts.length; i += 2) {
        const dx = x - (bushPts[i] as number);
        const dz = z - (bushPts[i + 1] as number);
        if (dx * dx + dz * dz < 6.2) return false;
      }
      bushPts.push(x, z);
      const s = 0.6 + rng() * 0.45; // 幅宽 1.2~2.0, 高 0.9~1.4
      const colorIdx = Math.floor(rng() * BUSH_COLORS.length);
      const q2 = new THREE.Quaternion().setFromAxisAngle(upY, rng() * Math.PI * 2);
      for (let layer = 0; layer < 3; layer++) {
        const ls = s * (layer === 0 ? 1 : layer === 1 ? 0.72 : 0.52);
        const lx = x + (layer === 1 ? 0.32 * s : layer === 2 ? -0.26 * s : 0);
        const lz = z + (layer === 1 ? 0.2 * s : layer === 2 ? -0.18 * s : 0);
        const ly = h + (layer === 0 ? 0.45 : layer === 1 ? 0.62 : 0.78) * s;
        vPos.set(lx, ly, lz);
        vScale.set(ls, ls * 0.75, ls);
        m4.compose(vPos, q2, vScale);
        const mesh = bushMeshes[layer] as THREE.InstancedMesh;
        mesh.setMatrixAt(bushCount, m4);
        canopyC.setHex(BUSH_COLORS[colorIdx] as number).multiplyScalar(0.85 + rng() * 0.3);
        mesh.setColorAt(bushCount, canopyC);
      }
      this.bushes.push({ x, z, r: s * 1.5 });
      bushCount++;
      return true;
    };
    // 密林加密灌木(z<-150)
    for (let t = 0; t < 1200 && bushCount < 130; t++) {
      tryBush((rng() * 2 - 1) * 320, -160 - rng() * 170);
    }
    for (let t = 0; t < bushCap * 8 && bushCount < bushCap; t++) {
      tryBush((rng() * 2 - 1) * 330, (rng() * 2 - 1) * 330);
    }

    // ---- 草丛(纯装饰: 无碰撞体, 不挡子弹/视线) ----
    const grassCap = navigator.hardwareConcurrency <= 4 ? 2600 : 4500;
    const grassGeo = makeGrassGeo();
    const grassMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.addSway(grassMat, 0.06, 0.0, 0.55, true, true);
    const grassMesh = new THREE.InstancedMesh(grassGeo, grassMat, grassCap + 800);
    grassMesh.receiveShadow = true;
    const cG1 = new THREE.Color(0x5e9440); // 与地形草地同管线(sRGB→线性)
    const cG2 = new THREE.Color(0xa8ad5e);
    let grassCount = 0;
    for (let t = 0; t < grassCap * 4 && grassCount < grassCap; t++) {
      // 按簇散布: 每簇 5-9 丛, 视觉成团而不是均匀稀点
      const cx = (rng() * 2 - 1) * 330;
      const cz = (rng() * 2 - 1) * 330;
      const ch = this.getHeight(cx, cz);
      if (ch < WATER_Y + 0.4 || ch > 12 || this.slopeAt(cx, cz) > 0.55) continue;
      if (this.inPlot(cx, cz, 1.5)) continue;
      const n = 5 + Math.floor(rng() * 5);
      for (let k = 0; k < n && grassCount < grassCap; k++) {
        const x = cx + (rng() * 2 - 1) * 2.6;
        const z = cz + (rng() * 2 - 1) * 2.6;
        const h = this.getHeight(x, z);
        if (h < WATER_Y + 0.4 || h > 12 || this.slopeAt(x, z) > 0.55) continue;
        if (this.inPlot(x, z, 1.5)) continue;
        const s = 0.9 + rng() * 0.6;
        vPos.set(x, h - 0.02, z);
        vScale.set(s, s, s);
        q0.setFromAxisAngle(upY, rng() * Math.PI * 2);
        m4.compose(vPos, q0, vScale);
        grassMesh.setMatrixAt(grassCount, m4);
        const gy = rng();
        canopyC.copy(cG1).lerp(cG2, gy * gy); // 绿→干黄, 偏绿居多
        grassMesh.setColorAt(grassCount, canopyC);
        grassCount++;
      }
    }
    grassMesh.count = grassCount;
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;
    grassMesh.computeBoundingSphere();
    scene.add(grassMesh);

    // 密林下植被加密草(z<-150 带状, 下植被感)
    let forestGrass = 0;
    for (let t = 0; t < 5000 && forestGrass < 800; t++) {
      const x = (rng() * 2 - 1) * 320;
      const z = -160 - rng() * 170;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.4 || h > 12 || this.slopeAt(x, z) > 0.55) continue;
      if (this.inPlot(x, z, 1.5)) continue;
      const s = 0.9 + rng() * 0.6;
      vPos.set(x, h - 0.02, z);
      vScale.set(s, s, s);
      q0.setFromAxisAngle(upY, rng() * Math.PI * 2);
      m4.compose(vPos, q0, vScale);
      grassMesh.setMatrixAt(grassCount + forestGrass, m4);
      canopyC.copy(cG1).lerp(cG2, rng() * rng());
      grassMesh.setColorAt(grassCount + forestGrass, canopyC);
      forestGrass++;
    }
    grassMesh.count = grassCount + forestGrass;
    grassMesh.instanceMatrix.needsUpdate = true;
    if (grassMesh.instanceColor) grassMesh.instanceColor.needsUpdate = true;

    // ---- 农田作物行(南部农场, 黄绿短苗, 纯装饰) ----
    const cropGeo = makeGrassGeo();
    const cropMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.addSway(cropMat, 0.06, 0.0, 0.55, true, true);
    const cropCap = 1500;
    const cropMesh = new THREE.InstancedMesh(cropGeo, cropMat, cropCap);
    cropMesh.receiveShadow = true;
    const cropC = new THREE.Color();
    let cropCount = 0;
    for (let rz = -18; rz <= 18 && cropCount < cropCap; rz += 2.4) {
      for (let rx = -26; rx <= 26 && cropCount < cropCap; rx += 0.95) {
        const x = -40 + rx + (rng() * 2 - 1) * 0.2;
        const z = 195 + rz + (rng() * 2 - 1) * 0.2;
        const h = this.getHeight(x, z);
        if (h < WATER_Y + 0.4 || h > 12 || this.slopeAt(x, z) > 0.5) continue;
        if (this.inPlot(x, z, 1.2)) continue;
        const s = 0.6 + rng() * 0.3;
        vPos.set(x, h - 0.02, z);
        vScale.set(s, s * 1.15, s);
        q0.setFromAxisAngle(upY, rng() * Math.PI * 2);
        m4.compose(vPos, q0, vScale);
        cropMesh.setMatrixAt(cropCount, m4);
        cropC.setHex(0x8fa540).lerp(new THREE.Color(0xb5b048), rng());
        cropMesh.setColorAt(cropCount, cropC);
        cropCount++;
      }
    }
    cropMesh.count = cropCount;
    cropMesh.instanceMatrix.needsUpdate = true;
    if (cropMesh.instanceColor) cropMesh.instanceColor.needsUpdate = true;
    cropMesh.computeBoundingSphere();
    scene.add(cropMesh);

    // ---- 干草捆(农场掩体, 圆柱碰撞) ----
    const baleMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1.05, 1.05, 1.5, 10),
      new THREE.MeshLambertMaterial({ color: 0xc2a54e }),
      14,
    );
    baleMesh.castShadow = true;
    baleMesh.receiveShadow = true;
    let baleCount = 0;
    for (let t = 0; t < 300 && baleCount < 12; t++) {
      const x = -40 + (rng() * 2 - 1) * 85;
      const z = 200 + (rng() * 2 - 1) * 85;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.4 || h > 12 || this.slopeAt(x, z) > 0.5) continue;
      if (this.inPlot(x, z, 1.5)) continue;
      vPos.set(x, h + 1.02, z);
      vScale.set(1, 1, 1);
      q0.setFromEuler(new THREE.Euler(Math.PI / 2, 0, rng() * Math.PI));
      m4.compose(vPos, q0, vScale);
      baleMesh.setMatrixAt(baleCount, m4);
      baleCount++;
      this.addCollider({ kind: 'cyl', x, z, r: 1.05, y0: h - 0.2, y1: h + 1.4, tag: 'rock' });
    }
    baleMesh.count = baleCount;
    baleMesh.instanceMatrix.needsUpdate = true;
    scene.add(baleMesh);

    // ---- 渔村小船(搁浅, 装饰+圆碰撞) ----
    const boatMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0x7a5c38 }),
      9,
    );
    boatMesh.castShadow = true;
    let boatCount = 0;
    for (let t = 0; t < 200 && boatCount < 3; t++) {
      const x = 200 + (rng() * 2 - 1) * 40;
      const z = -222 + (rng() * 2 - 1) * 25;
      const h = this.getHeight(x, z);
      if (h < WATER_Y - 0.1 || h > WATER_Y + 1.2) continue; // 搁浅带
      if (this.inPlot(x, z, 2)) continue;
      const rotY = rng() * Math.PI * 2;
      q0.setFromAxisAngle(upY, rotY);
      // 船体(拉长) + 翘头
      vPos.set(x, h + 0.3, z);
      vScale.set(3.2, 0.62, 1.15);
      m4.compose(vPos, q0, vScale);
      boatMesh.setMatrixAt(boatCount * 3, m4);
      vPos.set(x + Math.sin(rotY) * 1.8, h + 0.48, z + Math.cos(rotY) * 1.8);
      vScale.set(0.8, 0.5, 0.9);
      m4.compose(vPos, q0, vScale);
      boatMesh.setMatrixAt(boatCount * 3 + 1, m4);
      vPos.set(x, h + 0.62, z);
      vScale.set(0.5, 0.35, 0.6);
      m4.compose(vPos, q0, vScale);
      boatMesh.setMatrixAt(boatCount * 3 + 2, m4);
      boatCount++;
      this.addCollider({ kind: 'cyl', x, z, r: 1.7, y0: h - 0.3, y1: h + 0.9, tag: 'rock' });
    }
    boatMesh.count = boatCount * 3;
    boatMesh.instanceMatrix.needsUpdate = true;
    scene.add(boatMesh);

    // ---- 双桥(木板面+护栏+桥墩, 可走平台) ----
    this.addBridge(scene, -50);
    this.addBridge(scene, 170);
  }

  // 单座桥: 桥面(floor 可走) + 两端踏步 + 侧护栏 + 桥墩, ≤20 AABB
  private addBridge(scene: THREE.Scene, bx: number): void {
    const rzC = riverZAt(bx);
    const z0 = rzC - 14;
    const z1 = rzC + 14;
    const hBank0 = this.getHeight(bx, z0 - 3);
    const hBank1 = this.getHeight(bx, z1 + 3);
    // 桥面贴近较低岸 +0.5 (高岸下坡自然接上, 低岸 1~2 级踏步)
    const deckY = Math.min(hBank0, hBank1) + 0.5;
    const wood = new THREE.MeshLambertMaterial({ color: 0x8a6a42 });
    const box = (
      tag: 'wall' | 'floor', x0: number, y0: number, z0_: number, x1: number, y1: number, z1_: number,
      opts: { collider?: boolean; platform?: boolean } = {},
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1_ - z0_), wood);
      mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0_ + z1_) / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      if (opts.collider !== false) {
        this.addCollider({ kind: 'aabb', minX: x0, minY: y0, minZ: z0_, maxX: x1, maxY: y1, maxZ: z1_, tag });
      }
      if (opts.platform) {
        this.platforms.push({ minX: x0, minZ: z0_, maxX: x1, maxZ: z1_, top: y1 });
      }
      return mesh;
    };
    // 桥面(可走)
    box('floor', bx - 2, deckY - 0.24, z0, bx + 2, deckY, z1, { platform: true });
    // 两端踏步(从桥面降到岸, 每级 ≤0.45)
    for (const [ze, dir] of [[z0, -1], [z1, 1]] as const) {
      const bankH = this.getHeight(bx, ze + dir * 3);
      const drop = deckY - bankH;
      if (drop > 0.4) {
        const steps = Math.min(3, Math.ceil(drop / 0.42));
        for (let i = 0; i < steps; i++) {
          const top = deckY - ((i + 1) * drop) / (steps + 1);
          const zc = ze + dir * (0.8 + i * 1.1);
          box('floor', bx - 2, top - 0.2, zc - 0.6, bx + 2, top, zc + 0.6, { collider: false, platform: true });
        }
      }
    }
    // 侧护栏(矮碰撞)
    box('wall', bx - 2.12, deckY, z0, bx - 1.92, deckY + 0.85, z1);
    box('wall', bx + 1.92, deckY, z0, bx + 2.12, deckY + 0.85, z1);
    // 桥墩(入水立柱)
    for (const pz of [z0 + 4.5, z1 - 4.5]) {
      for (const px of [bx - 1.5, bx + 1.5]) {
        const bedH = this.getHeight(px, pz);
        box('wall', px - 0.18, bedH - 0.5, pz - 0.18, px + 0.18, deckY - 0.2, pz + 0.18);
      }
    }
  }

  // 植被顶点位移摇摆(InstancedMesh 顶点着色器注入, 零 CPU 逐帧开销)
  // fade=true 时按与相机距离把实例缩成退化三角形(远距消退)
  // upNormal=true 时片元法线强制朝上(双面草叶背光面不发黑, 与地形光照一致)
  private addSway(
    mat: THREE.Material,
    amp: number,
    lo: number,
    hi: number,
    fade = false,
    upNormal = false,
    fadeNear = 95,
    fadeFar = 120,
  ): void {
    const timeU = this.timeU;
    const camU = this.camU;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeU;
      shader.uniforms.uCamPos = camU;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uCamPos;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
#ifdef USE_INSTANCING
  vec2 swayIP = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  float swayPhase = swayIP.x * 0.37 + swayIP.y * 0.53;
  float swayW = smoothstep(${lo.toFixed(2)}, ${hi.toFixed(2)}, transformed.y);
  transformed.x += sin(uTime * 1.15 + swayPhase) * ${amp.toFixed(3)} * swayW;
  transformed.z += cos(uTime * 0.9 + swayPhase * 1.31) * ${amp.toFixed(3)} * swayW;
  ${fade ? `transformed *= 1.0 - smoothstep(${fadeNear.toFixed(1)}, ${fadeFar.toFixed(1)}, distance(swayIP, uCamPos.xz));` : ''}
#endif`,
        );
      if (upNormal) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`,
        );
      }
    };
    mat.customProgramCacheKey = () => `sway:${amp}:${lo}:${hi}:${fade}:${upNormal}:${fadeNear}:${fadeFar}`;
  }

  // 每帧视觉更新: 水面波浪 / 植被摇摆 / 云漂移(所有相机状态下都执行)
  updateVisuals(dt: number, camPos: THREE.Vector3): void {
    this.elapsed += dt;
    this.timeU.value = this.elapsed;
    this.camU.value.copy(camPos);
    this.sky.update(dt, camPos);
  }

  // 阴影相机跟随玩家
  updateShadow(px: number, pz: number): void {
    this.sun.position.set(px + 85, 72, pz + 42); // 低角度金色阳光(与天穹日盘同向)
    this.sun.target.position.set(px, 0, pz);
    this.sun.target.updateMatrixWorld();
  }

  // ---- 物理查询 ----

  // 站立高度: 地形 + 可站立 AABB 顶面 + 平台(楼梯踏步), 仅取 ≤ feetY+0.45 的台阶容忍内
  groundHeight(x: number, z: number, feetY: number): number {
    let g = this.getHeight(x, z);
    for (const b of this.aabbs) {
      if (b.off) continue;
      if (x < b.minX - 0.06 || x > b.maxX + 0.06 || z < b.minZ - 0.06 || z > b.maxZ + 0.06) continue;
      if (b.maxY <= feetY + 0.45 && b.maxY > g) g = b.maxY;
    }
    for (const p of this.platforms) {
      if (x < p.minX - 0.06 || x > p.maxX + 0.06 || z < p.minZ - 0.06 || z > p.maxZ + 0.06) continue;
      if (p.top <= feetY + 0.45 && p.top > g) g = p.top;
    }
    return g;
  }

  // 2D 圆 vs 静态碰撞体推出(仅竖直障碍: 墙/门/窗; 地板屋顶只作站立面不参与推挤)
  resolveCollision(p: THREE.Vector3, r: number): void {
    for (const c of this.cyls) {
      if (p.y > c.y1 - 0.05) continue;
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const rr = r + c.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      if (d < 0.0001) {
        p.x += rr;
      } else {
        p.x = c.x + (dx / d) * rr;
        p.z = c.z + (dz / d) * rr;
      }
    }
    for (const b of this.aabbs) {
      if (b.off) continue;
      if (b.tag === 'floor' || b.tag === 'roof') continue;
      if (p.y >= b.maxY - 0.02 || p.y + 1.7 <= b.minY) continue;
      const cx = clamp(p.x, b.minX, b.maxX);
      const cz = clamp(p.z, b.minZ, b.maxZ);
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r) continue;
      if (d2 > 0.000001) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
      } else {
        // 圆心在盒内: 沿最小穿透轴推出
        const pushW = Math.min(p.x - b.minX + r, b.maxX - p.x + r);
        const pushD = Math.min(p.z - b.minZ + r, b.maxZ - p.z + r);
        if (pushW < pushD) {
          p.x = p.x - b.minX < b.maxX - p.x ? b.minX - r : b.maxX + r;
        } else {
          p.z = p.z - b.minZ < b.maxZ - p.z ? b.minZ - r : b.maxZ + r;
        }
      }
    }
    // 世界边界
    p.x = clamp(p.x, -WORLD_HALF + 1, WORLD_HALF - 1);
    p.z = clamp(p.z, -WORLD_HALF + 1, WORLD_HALF - 1);
  }

  // 地形射线(步进 + 二分), 返回 t 或 Infinity
  raycastTerrain(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number {
    if (o.y > this.maxTerrainH && d.y >= 0) return Infinity;
    const step = 2.2;
    let t = 0;
    let prevT = 0;
    let prevDy = o.y - this.getHeight(o.x, o.z);
    if (prevDy <= 0) return 0;
    while (t < maxT) {
      t = Math.min(t + step, maxT);
      const x = o.x + d.x * t;
      const z = o.z + d.z * t;
      const dy = o.y + d.y * t - this.getHeight(x, z);
      if (dy <= 0) {
        // 二分细化
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) / 2;
          const md = o.y + d.y * mid - this.getHeight(o.x + d.x * mid, o.z + d.z * mid);
          if (md <= 0) hi = mid;
          else lo = mid;
        }
        return (lo + hi) / 2;
      }
      prevDy = dy;
      prevT = t;
      if (o.y + d.y * t > this.maxTerrainH && d.y > 0) return Infinity;
    }
    return Infinity;
  }

  // 静态碰撞体射线, 命中返回 true 并填充 out
  raycastStatics(o: THREE.Vector3, d: THREE.Vector3, maxT: number, out: StaticHit): boolean {
    let best = maxT;
    let kind: SurfaceKind | null = null;
    let destruct: DestructibleLike | undefined;
    for (const c of this.cyls) {
      const ox = o.x - c.x;
      const oz = o.z - c.z;
      const a = d.x * d.x + d.z * d.z;
      if (a < 1e-9) continue;
      const b = 2 * (ox * d.x + oz * d.z);
      const cc = ox * ox + oz * oz - c.r * c.r;
      const disc = b * b - 4 * a * cc;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = (-b - sq) / (2 * a);
      if (t < 0) t = (-b + sq) / (2 * a); // 起点在圆内
      if (t < 0 || t >= best) continue;
      const y = o.y + d.y * t;
      if (y < c.y0 || y > c.y1) continue;
      best = t;
      kind = c.tag;
      destruct = undefined;
    }
    for (const b of this.aabbs) {
      if (b.off) continue;
      const t = rayAABB(o, d, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
      if (t >= 0 && t < best) {
        best = t;
        kind = b.tag;
        destruct = b.destruct;
      }
    }
    if (kind === null) return false;
    out.t = best;
    out.kind = kind;
    out.destruct = destruct;
    return true;
  }

  // 视线检测: 仅地形 + 建筑构件阻挡(树木半透明遮挡忽略, 提升 AI 手感)
  isLOSBlocked(a: THREE.Vector3, b: THREE.Vector3, tmpDir: THREE.Vector3): boolean {
    tmpDir.subVectors(b, a);
    const len = tmpDir.length();
    if (len < 0.001) return false;
    tmpDir.divideScalar(len);
    if (this.raycastTerrain(a, tmpDir, len) < len) return true;
    for (const box of this.aabbs) {
      if (box.off) continue;
      const t = rayAABB(a, tmpDir, box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
      if (t >= 0 && t < len) return true;
    }
    return false;
  }

  // 出生点/巡点是否可用(陆地且不被碰撞体占据)
  pointFree(x: number, z: number, r: number, minH = WATER_Y + 0.7, maxH = 14): boolean {
    const h = this.getHeight(x, z);
    if (h < minH || h > maxH) return false;
    for (const c of this.cyls) {
      const dx = x - c.x;
      const dz = z - c.z;
      const rr = r + c.r;
      if (dx * dx + dz * dz < rr * rr) return false;
    }
    for (const b of this.aabbs) {
      if (b.off) continue;
      const cx = clamp(x, b.minX, b.maxX);
      const cz = clamp(z, b.minZ, b.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  }
}

// 草丛几何体: 5 叶片丛(圆盘内散布), 根深暗/尖亮(顶点色围绕 1.0, 与 instanceColor 相乘)
// 法线统一朝上 —— 让叶片接受与地形一致的光照, 避免逆光黑刺
function makeGrassGeo(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const nrm: number[] = [];
  const rng = mulberry32(9917);
  for (let b = 0; b < 5; b++) {
    const a = rng() * Math.PI * 2;
    const rr = rng() * 0.16;
    const ox = Math.cos(a) * rr;
    const oz = Math.sin(a) * rr;
    const fa = rng() * Math.PI * 2;
    const dx = Math.cos(fa);
    const dz = Math.sin(fa);
    const h = 0.38 + rng() * 0.24;
    const w = 0.05 + rng() * 0.02;
    const lean = 0.1 + rng() * 0.12; // 叶尖微后仰
    const bx = -dz * w;
    const bz = dx * w;
    pos.push(ox - bx, 0, oz - bz, ox + bx, 0, oz + bz, ox + dx * lean, h, oz + dz * lean);
    nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    col.push(0.62, 0.62, 0.62, 0.62, 0.62, 0.62, 1.12, 1.12, 1.1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// 射线 vs AABB(slab), 未命中返回 -1
export function rayAABB(
  o: THREE.Vector3,
  d: THREE.Vector3,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number {
  let tmin = 0;
  let tmax = Infinity;
  // X
  if (Math.abs(d.x) < 1e-9) {
    if (o.x < minX || o.x > maxX) return -1;
  } else {
    let t1 = (minX - o.x) / d.x;
    let t2 = (maxX - o.x) / d.x;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Y
  if (Math.abs(d.y) < 1e-9) {
    if (o.y < minY || o.y > maxY) return -1;
  } else {
    let t1 = (minY - o.y) / d.y;
    let t2 = (maxY - o.y) / d.y;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // Z
  if (Math.abs(d.z) < 1e-9) {
    if (o.z < minZ || o.z > maxZ) return -1;
  } else {
    let t1 = (minZ - o.z) / d.z;
    let t2 = (maxZ - o.z) / d.z;
    if (t1 > t2) {
      const tt = t1;
      t1 = t2;
      t2 = tt;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}
