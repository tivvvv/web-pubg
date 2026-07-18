// 世界: 程序化高度场地形 + 植被/岩石实例化 + 真房屋村庄 + 碰撞与解析射线
import * as THREE from 'three';
import { Noise2D, fbm } from './noise';
import { Buildings } from './buildings';
import type { Collider, DestructibleLike, SurfaceKind } from './types';
import { clamp, mulberry32, smoothstep } from './utils';

export const WORLD_SIZE = 700;
export const WORLD_HALF = 350;
export const WATER_Y = 0.9;

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
  maxTerrainH = 24;

  private heights = new Float32Array((GRID + 1) * (GRID + 1));
  private sun: THREE.DirectionalLight;

  constructor(scene: THREE.Scene) {
    const n1 = new Noise2D(1337);
    const n2 = new Noise2D(9001);
    const rawH = (x: number, z: number): number => {
      const d = Math.sqrt(x * x + z * z);
      const mask = smoothstep(360, 242, d); // 岛屿边缘下沉入海
      const base = fbm(n1, x * 0.0062, z * 0.0062, 4) * 12.5;
      const detail = fbm(n2, x * 0.021, z * 0.021, 2) * 2.2;
      return (base + detail + 7.0) * mask - 3.4;
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
    const cRock = new THREE.Color(0x8d8c86);
    const tmpC = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = this.getHeight(x, z);
      pos.setY(i, h);
      const sx = (this.getHeight(x + CELL, z) - this.getHeight(x - CELL, z)) / (2 * CELL);
      const sz = (this.getHeight(x, z + CELL) - this.getHeight(x, z - CELL)) / (2 * CELL);
      const slope = Math.sqrt(sx * sx + sz * sz);
      const vary = n2.noise(x * 0.05, z * 0.05) * 0.5 + 0.5;
      if (h < WATER_Y - 0.2) {
        tmpC.copy(cSandWet);
      } else if (h < WATER_Y + 0.65) {
        tmpC.copy(cSand);
      } else {
        tmpC.copy(cGrassA).lerp(cGrassB, vary);
      }
      const rockF = Math.max(smoothstep(0.55, 0.95, slope), smoothstep(12, 16, h));
      tmpC.lerp(cRock, rockF);
      const shade = 0.92 + vary * 0.12;
      colors[i * 3] = tmpC.r * shade;
      colors[i * 3 + 1] = tmpC.g * shade;
      colors[i * 3 + 2] = tmpC.b * shade;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    terrain.receiveShadow = true;
    scene.add(terrain);

    // 水面
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(1800, 1800),
      new THREE.MeshLambertMaterial({ color: 0x2f6f8f, transparent: true, opacity: 0.8 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_Y;
    scene.add(water);

    // 天空 / 雾 / 光照
    scene.background = new THREE.Color(0x87b7dd);
    scene.fog = new THREE.Fog(0xa8c6de, 150, 640);
    const hemi = new THREE.HemisphereLight(0xbfd9f2, 0x5f7048, 0.9);
    scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -60;
    this.sun.shadow.camera.right = 60;
    this.sun.shadow.camera.top = 60;
    this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 280;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun);
    scene.add(this.sun.target);

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

  private buildStatics(scene: THREE.Scene): void {
    const rng = mulberry32(424242);
    const m4 = new THREE.Matrix4();
    const q0 = new THREE.Quaternion();
    const vPos = new THREE.Vector3();
    const vScale = new THREE.Vector3();

    // ---- 房屋村庄(先生成, 树木岩石随后避开) ----
    this.buildings.build(scene, this);

    // ---- 树木 ----
    const treeCap = 350;
    const trunkMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.2, 0.34, 3.4, 6),
      new THREE.MeshLambertMaterial({ color: 0x6b4a2e }),
      treeCap,
    );
    const canopyMesh = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.7, 4.4, 7),
      new THREE.MeshLambertMaterial({ color: 0x3f7a33 }),
      treeCap,
    );
    trunkMesh.castShadow = true;
    canopyMesh.castShadow = true;
    const placedPts: number[] = [];
    const canopyC = new THREE.Color();
    let treeCount = 0;
    for (let t = 0; t < 4000 && treeCount < treeCap; t++) {
      const x = (rng() * 2 - 1) * 330;
      const z = (rng() * 2 - 1) * 330;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.8 || h > 13 || this.slopeAt(x, z) > 0.6) continue;
      if (this.inPlot(x, z, 2.5)) continue;
      let ok = true;
      for (let i = 0; i < placedPts.length; i += 2) {
        const dx = x - (placedPts[i] as number);
        const dz = z - (placedPts[i + 1] as number);
        if (dx * dx + dz * dz < 8.4) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      placedPts.push(x, z);
      const s = 0.8 + rng() * 0.55;
      vPos.set(x, h + 1.7 * s, z);
      vScale.set(s, s, s);
      q0.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
      m4.compose(vPos, q0, vScale);
      trunkMesh.setMatrixAt(treeCount, m4);
      vPos.set(x, h + (3.4 + 2.0) * s, z);
      m4.compose(vPos, q0, vScale);
      canopyMesh.setMatrixAt(treeCount, m4);
      const g = 0.75 + rng() * 0.5;
      canopyC.setRGB(0.22 * g, 0.42 * g, 0.18 * g);
      canopyMesh.setColorAt(treeCount, canopyC);
      treeCount++;
      this.addCollider({ kind: 'cyl', x, z, r: 0.42 * s, y0: h - 0.5, y1: h + 3.4 * s, tag: 'tree' });
    }
    trunkMesh.count = treeCount;
    canopyMesh.count = treeCount;
    trunkMesh.instanceMatrix.needsUpdate = true;
    canopyMesh.instanceMatrix.needsUpdate = true;
    if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;
    scene.add(trunkMesh);
    scene.add(canopyMesh);

    // ---- 岩石 ----
    const rockCap = 120;
    const rockMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshLambertMaterial({ color: 0x8f8f8b }),
      rockCap,
    );
    rockMesh.castShadow = true;
    rockMesh.receiveShadow = true;
    let rockCount = 0;
    for (let t = 0; t < 2000 && rockCount < rockCap; t++) {
      const x = (rng() * 2 - 1) * 330;
      const z = (rng() * 2 - 1) * 330;
      const h = this.getHeight(x, z);
      if (h < WATER_Y + 0.3 || h > 15) continue;
      if (this.inPlot(x, z, 2.5)) continue;
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
    }
    rockMesh.count = rockCount;
    rockMesh.instanceMatrix.needsUpdate = true;
    if (rockMesh.instanceColor) rockMesh.instanceColor.needsUpdate = true;
    scene.add(rockMesh);
  }

  // 阴影相机跟随玩家
  updateShadow(px: number, pz: number): void {
    this.sun.position.set(px + 70, 100, pz + 40);
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
