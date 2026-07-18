// ─────────────────────────────────────────────────────────────────────────────
// buildings.ts — 真·房屋系统：村庄聚集的平房/双层楼、可破坏门窗、楼梯与二层平台
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import type { AabbCollider, DestructibleLike } from './types';
import type { World } from './world';

export interface LootSpot {
  x: number; y: number; z: number;
  premium: boolean; // 二楼点位，偏高级枪
}

interface HousePlot {
  minX: number; minZ: number; maxX: number; maxZ: number; // 含 2m 外围安全边
  flatH: number;
  floors: 1 | 2;
}

// 村庄/房屋调色板
const WALL_COLORS = [0xd8cbb0, 0xc9b18a, 0xd3b9a0, 0xc7c3b5, 0xd9c9a4];
const ROOF_COLORS = [0x9a6a4f, 0x8a8f96, 0x7c6a55];
const FLOOR_C = 0xa3906e;
const FLOOR2_C = 0x96835f;
const RAIL_C = 0x77664c;
const DOOR_C = 0x7a5c38;
const PANE_C = 0xbfe0ea;

const WT = 0.26;            // 外墙厚
const WT2 = 0.14;           // 二层墙厚
const SLAB_T = 0.24;        // 楼板厚
const WALL_H = 2.7;         // 一层墙高（地板面→顶）
const DOOR_W = 1.2, DOOR_H = 2.1;
const WIN_W = 1.05, WIN_SILL = 1.0, WIN_H = 1.0;
const STAIR_STEPS = 9, STAIR_W = 1.35;
const BOUND = 265;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Destructible implements DestructibleLike {
  alive = true;
  hp: number;
  readonly kind: 'door' | 'window';
  readonly maxHp: number;
  readonly mesh: THREE.Mesh;
  readonly collider: AabbCollider;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  constructor(
    kind: 'door' | 'window',
    maxHp: number,
    mesh: THREE.Mesh,
    collider: AabbCollider,
    cx: number, cy: number, cz: number,
  ) {
    this.kind = kind;
    this.maxHp = maxHp;
    this.hp = maxHp;
    this.mesh = mesh;
    this.collider = collider;
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
  }
  reset(intact: boolean): void {
    this.alive = intact;
    this.hp = intact ? this.maxHp : 0;
    this.mesh.visible = intact;
    this.collider.off = !intact;
  }
}

export class Buildings {
  plots: HousePlot[] = [];
  lootSpots: LootSpot[] = [];
  destructibles: Destructible[] = [];
  root: THREE.Group | null = null;

  private doorGeoX = new THREE.BoxGeometry(0.1, DOOR_H, DOOR_W);
  private doorGeoZ = new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.1);
  private paneGeoX = new THREE.BoxGeometry(0.06, WIN_H, WIN_W);
  private paneGeoZ = new THREE.BoxGeometry(WIN_W, WIN_H, 0.06);
  private doorMat = new THREE.MeshLambertMaterial({ color: DOOR_C });
  private paneMat = new THREE.MeshLambertMaterial({
    color: PANE_C, transparent: true, opacity: 0.55, depthWrite: false,
  });

  // ── 村庄规划（确定性种子）───────────────────────────────────────────────
  plan(world: World): void {
    const rng = mulberry32(20240);
    const taken: { x: number; z: number }[] = [];
    const centers: { x: number; z: number }[] = [];
    for (let tries = 0; tries < 320 && centers.length < 7; tries++) {
      const x = (rng() * 2 - 1) * 245;
      const z = (rng() * 2 - 1) * 245;
      const h = world.getHeight(x, z);
      if (h < 3 || h > 9.5) continue;              // 避水避峰
      if (centers.some((c) => Math.hypot(c.x - x, c.z - z) < 135)) continue;
      centers.push({ x, z });
    }
    const boxOk = (minX: number, minZ: number, maxX: number, maxZ: number) => {
      if (minX < -BOUND || maxX > BOUND || minZ < -BOUND || maxZ > BOUND) return false;
      for (const t of taken) {
        if (!(maxX < t.x - 9 || minX > t.x + 9 || maxZ < t.z - 9 || minZ > t.z + 9)) return false;
      }
      return true;
    };
    const footprintAt = (cx: number, cz: number): HousePlot | null => {
      const w = 6.2 + rng() * 3.6;   // 6.2..9.8
      const d = 5.6 + rng() * 3.2;   // 5.6..8.8
      const minX = cx - w / 2 - 2, maxX = cx + w / 2 + 2;
      const minZ = cz - d / 2 - 2, maxZ = cz + d / 2 + 2;
      if (!boxOk(minX, minZ, maxX, maxZ)) return null;
      // 平整高度：内区五角均值
      const ix0 = cx - w / 2, ix1 = cx + w / 2, iz0 = cz - d / 2, iz1 = cz + d / 2;
      const hs = [
        world.getHeight(cx, cz),
        world.getHeight(ix0 + 0.5, iz0 + 0.5), world.getHeight(ix1 - 0.5, iz0 + 0.5),
        world.getHeight(ix0 + 0.5, iz1 - 0.5), world.getHeight(ix1 - 0.5, iz1 - 0.5),
      ];
      const avg = hs.reduce((a, b) => a + b, 0) / hs.length;
      const flatH = Math.min(10, Math.max(2.4, avg));
      if (hs.some((h) => Math.abs(h - flatH) > 4.5)) return null; // 坡太陡
      return { minX, minZ, maxX, maxZ, flatH, floors: rng() < 0.6 ? 1 : 2 };
    };
    for (const c of centers) {
      const n = 2 + Math.floor(rng() * 4); // 2..5
      for (let i = 0; i < n && this.plots.length < 24; i++) {
        for (let t = 0; t < 14; t++) {
          const px = c.x + (rng() * 2 - 1) * 26;
          const pz = c.z + (rng() * 2 - 1) * 26;
          const p = footprintAt(px, pz);
          if (!p) continue;
          this.plots.push(p);
          taken.push({ x: px, z: pz });
          break;
        }
      }
    }
    // 兜底：不足 18 栋就随机补撒
    for (let t = 0; t < 500 && this.plots.length < 18; t++) {
      const p = footprintAt((rng() * 2 - 1) * 240, (rng() * 2 - 1) * 240);
      if (!p) continue;
      this.plots.push(p);
      taken.push({ x: (p.minX + p.maxX) / 2, z: (p.minZ + p.maxZ) / 2 });
    }
  }

  flattenTerrain(world: World): void {
    for (const p of this.plots) {
      world.flattenRect(p.minX, p.minZ, p.maxX, p.maxZ, p.flatH, 5);
    }
  }

  // ── 场景构建 ────────────────────────────────────────────────────────────
  build(scene: THREE.Scene, world: World): void {
    interface Inst { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; c: THREE.Color }
    const insts: Inst[] = [];
    const col = new THREE.Color();
    const box = (
      tag: 'wall' | 'floor' | 'roof',
      x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
      color: number,
      opts: { collider?: boolean; platform?: boolean } = {},
    ) => {
      col.setHex(color);
      const jitter = 0.94 + ((insts.length * 7919) % 13) / 100;
      insts.push({ x0, y0, z0, x1, y1, z1, c: col.clone().multiplyScalar(jitter) });
      if (opts.collider !== false) {
        world.addCollider({ kind: 'aabb', minX: x0, minY: y0, minZ: z0, maxX: x1, maxY: y1, maxZ: z1, tag });
      }
      if (opts.platform) {
        world.platforms.push({ minX: x0, minZ: z0, maxX: x1, maxZ: z1, top: y1 });
      }
    };

    this.plots.forEach((plot, idx) => this.addHouse(world, plot, idx, box));

    // 合并实例化为一个 InstancedMesh
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, insts.length));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const t = new THREE.Vector3();
    insts.forEach((b, i) => {
      t.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      s.set(Math.max(0.02, b.x1 - b.x0), Math.max(0.02, b.y1 - b.y0), Math.max(0.02, b.z1 - b.z0));
      m.compose(t, q, s);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, b.c);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root = new THREE.Group();
    this.root.add(mesh);
    for (const d of this.destructibles) this.root.add(d.mesh);
    scene.add(this.root);
  }

  // 每局重开时恢复门窗：窗全恢复；门 30% 概率预破坏
  reset(): void {
    for (const d of this.destructibles) {
      d.reset(d.kind === 'window' ? true : Math.random() >= 0.3);
    }
  }

  // ── 单栋房屋 ────────────────────────────────────────────────────────────
  private addHouse(
    world: World, plot: HousePlot, plotIdx: number,
    box: (tag: 'wall' | 'floor' | 'roof', x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number, o?: { collider?: boolean; platform?: boolean }) => void,
  ): void {
    const wallC = WALL_COLORS[plotIdx % WALL_COLORS.length];
    const roofC = ROOF_COLORS[Math.floor(Math.abs(plot.minX * 7 + plot.minZ * 3)) % ROOF_COLORS.length];
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const f1 = plot.flatH + 0.28;                 // 一层地板面
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const wt1 = f1 + WALL_H;                      // 一层墙顶

    type Op = { a0: number; a1: number; y0: number; y1: number; door?: boolean };
    // 沿轴放一面带洞口的墙：整高段 + 窗台段 + 过梁段，洞口挂门/窗可破坏物
    const wallSegs = (
      axis: 'x' | 'z', fixed: number, a0: number, a1: number,
      y0: number, y1: number, ops: Op[], c: number, th: number,
    ) => {
      const addBoxAt = (s0: number, s1: number, t0: number, t1: number) => {
        if (s1 - s0 < 0.03 || t1 - t0 < 0.03) return;
        if (axis === 'x') box('wall', s0, t0, fixed - th / 2, s1, t1, fixed + th / 2, c);
        else box('wall', fixed - th / 2, t0, s0, fixed + th / 2, t1, s1, c);
      };
      const sorted = [...ops].sort((p, q) => p.a0 - q.a0);
      let cur = a0;
      for (const op of sorted) {
        addBoxAt(cur, op.a0, y0, y1);                 // 洞口左侧整高段
        if (!op.door) addBoxAt(op.a0, op.a1, y0, op.y0); // 窗台段（门洞直通地板）
        addBoxAt(op.a0, op.a1, op.y1, y1);            // 过梁段
        cur = op.a1;
      }
      addBoxAt(cur, a1, y0, y1);
      for (const op of sorted) {
        const midA = (op.a0 + op.a1) / 2, midY = (op.y0 + op.y1) / 2;
        if (op.door) this.addDoor(world, axis, fixed, op.a0, op.a1, op.y0, op.y1, midA, midY);
        else this.addPane(world, axis, fixed, op.a0, op.a1, op.y0, op.y1, midA, midY);
      }
    };

    // 首层洞口：北墙(z=iz0)置门；南墙放窗（大房偶发第二个门）；东西墙各一窗
    const w = ix1 - ix0, d = iz1 - iz0;
    const doorA0 = ix0 + w / 2 - DOOR_W / 2;
    const northOps: Op[] = [{ a0: doorA0, a1: doorA0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true }];
    const southOps: Op[] = [];
    if (w > 8 && (plotIdx * 13) % 5 === 0) {
      const s0 = ix0 + w * 0.22;
      southOps.push({ a0: s0, a1: s0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true });
    } else {
      const s0 = ix0 + w / 2 - WIN_W / 2;
      southOps.push({ a0: s0, a1: s0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    }
    const win = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    const buried = f1 - 0.9; // 墙基埋入地基, 防止地形插值凸起露出缝隙
    wallSegs('x', iz0, ix0, ix1, buried, wt1, northOps, wallC, WT);
    wallSegs('x', iz1, ix0, ix1, buried, wt1, southOps, wallC, WT);
    wallSegs('z', ix0, iz0, iz1, buried, wt1, [win(iz0 + d * 0.3)], wallC, WT);
    wallSegs('z', ix1, iz0, iz1, buried, wt1, [win(iz0 + d * 0.62)], wallC, WT);
    // 首层 loot 点（2 个，避开西墙楼梯区）
    this.lootSpots.push(
      { x: ix0 + w * 0.25, y: f1, z: iz0 + d * 0.35, premium: false },
      { x: ix1 - w * 0.2, y: f1, z: iz1 - d * 0.25, premium: false },
    );

    if (plot.floors === 1) {
      box('roof', ix0 - 0.15, wt1, iz0 - 0.15, ix1 + 0.15, wt1 + 0.22, iz1 + 0.15, roofC);
      return;
    }

    // ── 双层 ──
    const f2 = wt1 + SLAB_T;                      // 二层地板面
    const rise = (f2 - f1) / STAIR_STEPS;         // ≈0.327 < 0.45 台阶容忍 ✓
    const stairX0 = ix0 + 0.14, stairX1 = stairX0 + STAIR_W; // 紧贴西墙内面, 不留夹缝
    const holeZ0 = iz0 + 1.0;                     // 楼梯井北缘（顶部小平台由此接 slab B）
    const run = (iz1 - 0.6 - holeZ0) / STAIR_STEPS;
    for (let i = 0; i < STAIR_STEPS; i++) {
      const zTop = iz1 - 0.6 - i * run;           // 从南墙根向北逐级升高
      const top = f1 + rise * (i + 1);
      // 踏步：只进 platform（站立面），不进碰撞体，避免侧向推挤
      box('floor', stairX0, f1, zTop - run, stairX1, top, zTop, FLOOR2_C, { collider: false, platform: true });
    }
    // 楼板：A 大块（井东侧全宽）+ B 条块（井北侧，楼梯顶落脚的过渡平台）
    box('floor', stairX1, wt1, iz0, ix1, f2, iz1, FLOOR2_C);
    box('floor', ix0, wt1, iz0, stairX1, f2, holeZ0, FLOOR2_C);
    // 二层 loot（premium，偏高级枪）
    this.lootSpots.push(
      { x: ix0 + w * 0.5, y: f2, z: iz0 + d * 0.3, premium: true },
      { x: ix1 - w * 0.22, y: f2, z: iz1 - d * 0.2, premium: true },
    );
    // 护栏：仅井东缘（北缘是下楼梯通道，西缘即外墙）
    box('wall', stairX1, f2, holeZ0, stairX1 + 0.08, f2 + 0.95, iz1, RAIL_C);
    // 上层墙（薄）+ 窗
    const uwt = f2 + 2.5;
    const win2 = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f2 + 0.9, y1: f2 + 0.9 + WIN_H });
    wallSegs('x', iz0, ix0, ix1, f2, uwt, [win2(ix0 + w * 0.35)], wallC, WT2);
    wallSegs('x', iz1, ix0, ix1, f2, uwt, [win2(ix0 + w * 0.55)], wallC, WT2);
    wallSegs('z', ix0, iz0, iz1, f2, uwt, [win2(iz0 + d * 0.4)], wallC, WT2);
    wallSegs('z', ix1, iz0, iz1, f2, uwt, [win2(iz0 + d * 0.55)], wallC, WT2);
    box('roof', ix0 - 0.12, uwt, iz0 - 0.12, ix1 + 0.12, uwt + 0.22, iz1 + 0.12, roofC);
  }

  private addDoor(
    world: World, axis: 'x' | 'z', fixed: number,
    a0: number, a1: number, y0: number, y1: number, midA: number, midY: number,
  ): void {
    const t = 0.1;
    const c: AabbCollider = axis === 'x'
      ? { kind: 'aabb', minX: a0, minY: y0, minZ: fixed - t / 2, maxX: a1, maxY: y1, maxZ: fixed + t / 2, tag: 'door' }
      : { kind: 'aabb', minX: fixed - t / 2, minY: y0, minZ: a0, maxX: fixed + t / 2, maxY: y1, maxZ: a1, tag: 'door' };
    world.addCollider(c);
    const mesh = new THREE.Mesh(axis === 'x' ? this.doorGeoX : this.doorGeoZ, this.doorMat);
    mesh.position.set(axis === 'x' ? midA : fixed, midY, axis === 'x' ? fixed : midA);
    mesh.castShadow = true;
    const d = new Destructible('door', 80, mesh, c, (c.minX + c.maxX) / 2, midY, (c.minZ + c.maxZ) / 2);
    c.destruct = d;
    this.destructibles.push(d);
  }

  private addPane(
    world: World, axis: 'x' | 'z', fixed: number,
    a0: number, a1: number, y0: number, y1: number, midA: number, midY: number,
  ): void {
    const t = 0.06;
    const c: AabbCollider = axis === 'x'
      ? { kind: 'aabb', minX: a0, minY: y0, minZ: fixed - t / 2, maxX: a1, maxY: y1, maxZ: fixed + t / 2, tag: 'window' }
      : { kind: 'aabb', minX: fixed - t / 2, minY: y0, minZ: a0, maxX: fixed + t / 2, maxY: y1, maxZ: a1, tag: 'window' };
    world.addCollider(c);
    const mesh = new THREE.Mesh(axis === 'x' ? this.paneGeoX : this.paneGeoZ, this.paneMat);
    mesh.position.set(axis === 'x' ? midA : fixed, midY, axis === 'x' ? fixed : midA);
    const d = new Destructible('window', 30, mesh, c, (c.minX + c.maxX) / 2, midY, (c.minZ + c.maxZ) / 2);
    c.destruct = d;
    this.destructibles.push(d);
  }
}
