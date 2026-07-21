// ─────────────────────────────────────────────────────────────────────────────
// buildings.ts - 数据驱动的建筑原型系统: 平房/双层/露台房/三层楼/谷仓/小卖部/大体育馆
// 组件化构建(墙段开洞/楼梯/护栏/楼板/屋顶), 可破坏门窗/平台/loot 点全部复用同一套
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import type { AabbCollider, DestructibleLike } from './types';
import { riverZAt, type World } from './world';

export interface LootSpot {
  x: number; y: number; z: number;
  premium: boolean; // 高级点位(二楼顶/体育馆/三楼), 偏高级枪
}

export type ArchId = 'cottage1' | 'cottage2' | 'terrace' | 'apartment' | 'barn' | 'shop' | 'gym';

interface HousePlot {
  minX: number; minZ: number; maxX: number; maxZ: number; // 含 2m 外围安全边
  flatH: number;
  arch: ArchId;
  w: number; // 内宽(x)
  d: number; // 内深(z)
}

// 原型表: 尺寸范围与村庄放置权重(gym 特殊定点)
const ARCHS: Record<ArchId, { w: [number, number]; d: [number, number]; weight: number }> = {
  cottage1: { w: [8.2, 10.8], d: [7.4, 9.6], weight: 26 },
  cottage2: { w: [8.8, 11.6], d: [7.8, 10.5], weight: 22 },
  terrace: { w: [10.0, 12.2], d: [8.8, 10.8], weight: 12 },
  apartment: { w: [11.0, 14.0], d: [9.8, 12.0], weight: 8 },
  barn: { w: [10.0, 12.5], d: [8.8, 11.0], weight: 8 },
  shop: { w: [7.2, 9.0], d: [6.0, 7.5], weight: 12 },
  gym: { w: [40, 43], d: [25, 28], weight: 0 },
};
// 调色板: 墙面(白/米/浅红砖/淡蓝/灰绿/原色系), 屋顶(红瓦/灰/锈), 统一装饰色
const WALL_COLORS = [0xe8e4da, 0xd8cbb0, 0xc08a6e, 0xa8bcc8, 0x9aa88e, 0xc9b18a, 0xd3b9a0, 0xc7c3b5];
const ROOF_COLORS = [0xa05545, 0x8a8f96, 0x8a5f3c, 0x9a6a4f];
const FLOOR_C = 0xa3906e;
const FLOOR2_C = 0x96835f;
const RAIL_C = 0x77664c;
const DOOR_C = 0x7a5c38;
const PANE_C = 0xbfe0ea;
const TRIM_C = 0xefe6d0;  // 统一装饰: 窗框/门框/檐口
const FRAME_C = 0x5f5245; // 深色框边
const SHUTTER_C = 0x6a5a48; // 百叶窗板
const SKIRT_C = 0x6f6a5e; // 墙基裙(加深, 接地点缀)
const CRATE_C = 0x9a7f56;

const WT = 0.26;            // 外墙厚
const WT2 = 0.14;           // 上层墙厚
const SLAB_T = 0.24;        // 楼板厚
const WALL_H = 2.9;         // 层高(地板面→墙顶)
const DOOR_W = 1.3, DOOR_H = 2.2;
const WIN_W = 1.15, WIN_SILL = 1.05, WIN_H = 1.05;
const STAIR_STEPS = 9, STAIR_W = 1.5;
const BOUND = 265;
const DOOR_SWING = (100 * Math.PI) / 180; // 开门转角 ~100°
const DOOR_TWEEN = 0.3;                   // 开关门动画时长(秒)

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type BoxFn = (
  tag: 'wall' | 'floor' | 'roof',
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  c: number,
  o?: { collider?: boolean; platform?: boolean },
) => void;

interface Palette { wall: number; roof: number; chimney: boolean; ac: boolean }

interface Op {
  a0: number; a1: number; y0: number; y1: number;
  door?: boolean; doorless?: boolean;
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
  // 门: 铰链开合(窗无此结构)
  group: THREE.Group | null = null;            // 含 pivot(门扇) + 铰链柱
  pivot: THREE.Group | null = null;            // 开门绕其 Y 轴旋转
  open = false;
  openAngle = 0;                               // 全开时的 pivot 转角(带方向)
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
    // 门复位为关闭
    this.open = false;
    if (this.pivot) this.pivot.rotation.y = 0;
  }
}

export class Buildings {
  plots: HousePlot[] = [];
  lootSpots: LootSpot[] = [];
  destructibles: Destructible[] = [];
  root: THREE.Group | null = null;

  // 门/窗几何体按墙的走向区分: AlongX 用于沿 X 延伸的墙(南/北墙), AlongZ 用于沿 Z 延伸的墙(东/西墙)
  private doorGeoAlongX = new THREE.BoxGeometry(DOOR_W, DOOR_H, 0.1);
  private doorGeoAlongZ = new THREE.BoxGeometry(0.1, DOOR_H, DOOR_W);
  private paneGeoAlongX = new THREE.BoxGeometry(WIN_W, WIN_H, 0.06);
  private paneGeoAlongZ = new THREE.BoxGeometry(0.06, WIN_H, WIN_W);
  private postGeoAlongX = new THREE.BoxGeometry(0.09, DOOR_H, WT + 0.06);
  private postGeoAlongZ = new THREE.BoxGeometry(WT + 0.06, DOOR_H, 0.09);
  private doorMat = new THREE.MeshStandardMaterial({ color: DOOR_C, roughness: 0.88 });
  private postMat = new THREE.MeshStandardMaterial({ color: 0x5e4629, roughness: 0.94 });
  private doorTrimMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.92 }); // 门板拼缝
  private knobMat = new THREE.MeshStandardMaterial({ color: 0xb8a06a, roughness: 0.35, metalness: 0.45 }); // 门把手
  // 门扇细节共享几何(拼缝/把手板/把手珠, 按墙走向两套)
  private trimGeoX = new THREE.BoxGeometry(0.05, DOOR_H * 0.88, 0.02);
  private trimGeoZ = new THREE.BoxGeometry(0.02, DOOR_H * 0.88, 0.05);
  private handleGeoX = new THREE.BoxGeometry(0.1, 0.05, 0.05);
  private handleGeoZ = new THREE.BoxGeometry(0.05, 0.05, 0.1);
  private plateGeoX = new THREE.BoxGeometry(0.09, 0.16, 0.02);
  private plateGeoZ = new THREE.BoxGeometry(0.02, 0.16, 0.09);
  private paneMat = new THREE.MeshStandardMaterial({
    color: PANE_C, transparent: true, opacity: 0.48, depthWrite: false, roughness: 0.2, metalness: 0.12,
  });

  // ── 区域规划 (确定性种子; 城区/竞技场/农场/密林/山地/渔村定点) ──────────────
  plan(world: World): void {
    const rng = mulberry32(20240);
    const taken: { minX: number; minZ: number; maxX: number; maxZ: number }[] = [];
    // AABB 间净距 clear 米
    const boxOk = (minX: number, minZ: number, maxX: number, maxZ: number, clear: number) => {
      if (minX < -BOUND || maxX > BOUND || minZ < -BOUND || maxZ > BOUND) return false;
      for (const t of taken) {
        if (maxX + clear > t.minX && minX - clear < t.maxX && maxZ + clear > t.minZ && minZ - clear < t.maxZ) return false;
      }
      return true;
    };
    const footprintAt = (cx: number, cz: number, arch: ArchId, slopeTol: number, clear: number): HousePlot | null => {
      const spec = ARCHS[arch];
      const w = spec.w[0] + rng() * (spec.w[1] - spec.w[0]);
      const d = spec.d[0] + rng() * (spec.d[1] - spec.d[0]);
      const minX = cx - w / 2 - 2, maxX = cx + w / 2 + 2;
      const minZ = cz - d / 2 - 2, maxZ = cz + d / 2 + 2;
      if (!boxOk(minX, minZ, maxX, maxZ, clear)) return null;
      // 河道禁建(桥位另算)
      const rd = Math.abs(cz - riverZAt(cx));
      if (rd < 15 + d / 2) return null;
      // 平整高度: 内区五角均值
      const ix0 = cx - w / 2, ix1 = cx + w / 2, iz0 = cz - d / 2, iz1 = cz + d / 2;
      const hs = [
        world.getHeight(cx, cz),
        world.getHeight(ix0 + 0.5, iz0 + 0.5), world.getHeight(ix1 - 0.5, iz0 + 0.5),
        world.getHeight(ix0 + 0.5, iz1 - 0.5), world.getHeight(ix1 - 0.5, iz1 - 0.5),
      ];
      const avg = hs.reduce((a, b) => a + b, 0) / hs.length;
      const flatH = Math.min(10, Math.max(2.4, avg));
      if (hs.some((h) => Math.abs(h - flatH) > slopeTol)) return null; // 坡太陡
      return { minX, minZ, maxX, maxZ, flatH, arch, w, d };
    };
    const tryPlace = (arch: ArchId, cx: number, cz: number, maxR: number, slopeTol = 4.5, clear = 7): boolean => {
      for (let t = 0; t < 40; t++) {
        const a = rng() * Math.PI * 2;
        const d = rng() * maxR;
        const p = footprintAt(cx + Math.cos(a) * d, cz + Math.sin(a) * d, arch, slopeTol, clear);
        if (p) {
          this.plots.push(p);
          taken.push({ minX: p.minX, minZ: p.minZ, maxX: p.maxX, maxZ: p.maxZ });
          return true;
        }
      }
      return false;
    };

    // 中央城区 (-60,-20, r~90): 行列式 12 栋 - 三层×2 露台×3 小店×2 其余民居
    const townArchs: ArchId[] = [
      'apartment', 'apartment', 'terrace', 'terrace', 'terrace',
      'shop', 'shop', 'cottage2', 'cottage2', 'cottage1', 'cottage1', 'cottage2',
    ];
    for (const arch of townArchs) {
      // 双街布局: x≈-82 或 x≈-38 两排, z 散开
      const streetX = rng() < 0.5 ? -82 : -38;
      const placed = tryPlace(arch, streetX + (rng() * 2 - 1) * 14, -20 + (rng() * 2 - 1) * 60, 26, 4.5, 5);
      if (!placed) tryPlace(arch, -60, -20, 82, 4.8, 3.5);
    }

    // 东部竞技场 (+180,-40): 体育馆地标 + 2 民居
    tryPlace('gym', 180, -40, 18, 5.5, 13);
    tryPlace('cottage1', 180 + 30, -40 + 22, 16, 4.5, 8);
    tryPlace('cottage2', 180 - 28, -40 - 20, 16, 4.5, 8);

    // 南部农场 (-40,+200, r~100): 谷仓×3 + 民居×2
    tryPlace('barn', -40, 200, 70);
    tryPlace('barn', -40, 200, 70);
    tryPlace('barn', -40, 200, 70);
    tryPlace('cottage1', -40, 200, 70);
    tryPlace('cottage2', -40, 200, 70);

    // 北境密林 (z<-150): 仅 1 谷仓 + 1 民居
    tryPlace('barn', 0, -170, 80);
    tryPlace('cottage1', 30, -180, 80);

    // 西部山地 (-220,+20): 1 民居(狙击高地)
    tryPlace('cottage1', -220, 20, 50, 6);

    // 东北渔村 (+200,-220): 3~4 民居
    tryPlace('cottage1', 200, -220, 45, 5);
    tryPlace('cottage2', 200, -220, 45, 5);
    tryPlace('cottage1', 200, -220, 45, 5);
    tryPlace('cottage2', 200, -220, 45, 5);
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
    const box: BoxFn = (tag, x0, y0, z0, x1, y1, z1, color, opts = {}) => {
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

    this.plots.forEach((plot, idx) => {
      const rng = mulberry32(idx * 97 + 11);
      const palette: Palette = {
        wall: WALL_COLORS[Math.floor(rng() * WALL_COLORS.length)] as number,
        roof: ROOF_COLORS[Math.floor(rng() * ROOF_COLORS.length)] as number,
        chimney: rng() < 0.4,
        ac: rng() < 0.3,
      };
      switch (plot.arch) {
        case 'cottage1': this.addCottage(world, plot, palette, box, false); break;
        case 'cottage2': this.addCottage(world, plot, palette, box, true); break;
        case 'terrace': this.addTerrace(world, plot, palette, box); break;
        case 'apartment': this.addApartment(world, plot, palette, box); break;
        case 'barn': this.addBarn(world, plot, palette, box); break;
        case 'shop': this.addShop(world, plot, palette, box); break;
        case 'gym': this.addGym(world, plot, palette, box); break;
      }
      if (plot.arch !== 'gym') this.addInteriorDetails(world, plot, box, idx);
      this.addYardCover(plot, box, idx);
    });

    this.sanitizeLootSpots(world);

    // 合并实例化为一个 InstancedMesh
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
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
    for (const d of this.destructibles) this.root.add(d.group ?? d.mesh);
    scene.add(this.root);
  }

  // 每局重开时恢复门窗: 窗全恢复; 门 30% 概率预破坏
  reset(): void {
    for (const d of this.destructibles) {
      d.reset(d.kind === 'window' ? true : Math.random() >= 0.3);
    }
  }

  // ═══════════════ 组件构建器(全原型复用) ═══════════════

  // 沿轴放一面带洞口的墙: 整高段 + 窗台段 + 过梁段, 洞口挂门/窗可破坏物
  // interior: 室内方向符号(+1/-1, 垂直于墙指向屋内), 决定门向内开的方向
  private wallRun(
    world: World, box: BoxFn,
    axis: 'x' | 'z', fixed: number, a0: number, a1: number,
    y0: number, y1: number, ops: Op[], c: number, th: number, interior: 1 | -1,
  ): void {
    const addBoxAt = (s0: number, s1: number, t0: number, t1: number) => {
      if (s1 - s0 < 0.03 || t1 - t0 < 0.03) return;
      if (axis === 'x') box('wall', s0, t0, fixed - th / 2, s1, t1, fixed + th / 2, c);
      else box('wall', fixed - th / 2, t0, s0, fixed + th / 2, t1, s1, c);
    };
    const sorted = [...ops].sort((p, q) => p.a0 - q.a0);
    let cur = a0;
    for (const op of sorted) {
      addBoxAt(cur, op.a0, y0, y1);                 // 洞口左侧整高段
      if (!op.door) addBoxAt(op.a0, op.a1, y0, op.y0); // 窗台段 (门洞直通地板)
      addBoxAt(op.a0, op.a1, op.y1, y1);            // 过梁段
      cur = op.a1;
    }
    addBoxAt(cur, a1, y0, y1);
    for (const op of sorted) {
      const midA = (op.a0 + op.a1) / 2, midY = (op.y0 + op.y1) / 2;
      if (op.door) {
        if (!op.doorless) this.addDoor(world, box, axis, fixed, op.a0, op.a1, op.y0, op.y1, midY, interior);
      } else {
        this.addWindow(world, box, axis, fixed, op.a0, op.a1, op.y0, op.y1, midA, midY);
      }
    }
  }

  // 楼梯: 平台踏步(不进碰撞体), zFrom→zTo 逐级升高至 f1+steps*rise
  private stairs(box: BoxFn, x0: number, x1: number, zFrom: number, zTo: number, f1: number, rise: number, c: number): void {
    const run = (zTo - zFrom) / STAIR_STEPS;
    for (let i = 0; i < STAIR_STEPS; i++) {
      const z0 = Math.min(zFrom + i * run, zFrom + (i + 1) * run);
      const z1 = Math.max(zFrom + i * run, zFrom + (i + 1) * run);
      box('floor', x0, f1, z0, x1, f1 + rise * (i + 1), z1, c, { collider: false, platform: true });
      if (i === 1 || i === 4 || i === 7) {
        const zm = (z0 + z1) / 2;
        const top = f1 + rise * (i + 1);
        box('wall', x1 - 0.05, top, zm - 0.04, x1 + 0.05, top + 0.82, zm + 0.04, RAIL_C, { collider: false });
      }
    }
  }

  // 矮护栏(阻挡移动, 上方子弹可过)
  private rail(box: BoxFn, x0: number, z0: number, x1: number, z1: number, y: number, h: number): void {
    box('wall', x0, y, z0, x1, y + h, z1, RAIL_C);
  }

  // 房间隔断和家具都参与碰撞，既让室内更像正式空间，也形成可利用的近战掩体。
  private addInteriorDetails(world: World, plot: HousePlot, box: BoxFn, idx: number): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    const household = plot.arch === 'cottage1' || plot.arch === 'cottage2' || plot.arch === 'terrace' || plot.arch === 'apartment';
    const multistory = plot.arch === 'cottage2' || plot.arch === 'terrace' || plot.arch === 'apartment';
    let lootX = (ix0 + ix1) / 2;
    let lootZ = (iz0 + iz1) / 2;

    // 一层隔间为西侧楼梯保留完整通道，隔墙不再横穿踏步。
    if (household) {
      const splitZ = iz0 + d * 0.58;
      const wallX0 = multistory ? ix0 + STAIR_W + 0.72 : ix0;
      const doorX = wallX0 + (ix1 - wallX0) * 0.48;
      this.wallRun(world, box, 'x', splitZ, wallX0, ix1, f1, f1 + WALL_H - 0.28, [
        { a0: doorX - DOOR_W / 2, a1: doorX + DOOR_W / 2, y0: f1, y1: f1 + DOOR_H, door: true },
      ], 0xd2c6af, WT2, -1);
    }

    // 多层建筑的箱堆按楼梯井方向分开放置，避免压住上下楼出口。
    if (multistory) {
      const floors = plot.arch === 'apartment' ? 2 : 1;
      for (let floor = 1; floor <= floors; floor++) {
        const fy = f1 + floor * (WALL_H + SLAB_T);
        const cx = plot.arch === 'apartment'
          ? (floor === 1 ? ix0 + w * 0.48 : ix0 + w * 0.34)
          : ix1 - 1.15;
        const cz = iz0 + (floor === 1 ? 1.35 : 1.5);
        box('wall', cx - 0.45, fy, cz - 0.45, cx + 0.45, fy + 0.78, cz + 0.45, CRATE_C);
        if (floor === floors) {
          box('wall', cx - 0.28, fy + 0.78, cz - 0.28, cx + 0.36, fy + 1.34, cz + 0.36, CRATE_C);
        }
      }
    }

    if (household) {
      // 餐桌固定在入口房的东北角，与门、楼梯和隔墙均保持通行距离。
      const tx = ix1 - 1.55;
      const tz = iz0 + 1.55;
      box('wall', tx - 0.72, f1 + 0.68, tz - 0.44, tx + 0.72, f1 + 0.8, tz + 0.44, 0x806548);
      for (const sx of [-0.57, 0.57]) for (const sz of [-0.31, 0.31]) {
        box('wall', tx + sx - 0.045, f1, tz + sz - 0.045, tx + sx + 0.045, f1 + 0.68, tz + sz + 0.045, 0x554334, { collider: false });
      }
      // 南侧房间的置物架贴东墙布置，不再与餐桌或楼梯重叠。
      const shelfX = ix1 - 0.48;
      const shelfZ = iz1 - 1.35;
      box('wall', shelfX - 0.32, f1, shelfZ - 0.78, shelfX + 0.32, f1 + 1.75, shelfZ + 0.78, 0x71604c);
      for (const sy of [0.42, 0.92, 1.42]) {
        box('wall', shelfX - 0.4, f1 + sy, shelfZ - 0.84, shelfX + 0.4, f1 + sy + 0.06, shelfZ + 0.84, 0x9b815e, { collider: false });
      }
      // 平房偶数编号增加床铺；多层房西侧必须完整留给楼梯。
      if (plot.arch === 'cottage1' && idx % 2 === 0) {
        const bedZ = iz1 - 1.8;
        box('wall', ix0 + 0.65, f1, bedZ - 0.9, ix0 + 1.9, f1 + 0.48, bedZ + 0.9, 0x726957);
        box('wall', ix0 + 0.68, f1 + 0.48, bedZ - 0.88, ix0 + 1.87, f1 + 0.62, bedZ + 0.88, 0x9b8f73, { collider: false });
      }
      lootX = tx - 1.05;
      lootZ = tz + 0.85;
    } else if (plot.arch === 'shop') {
      // 商店保留原有柜台，只在后墙增加货架，避免重复家具穿插。
      const sx0 = ix1 - 2.35;
      box('wall', sx0, f1, iz1 - 0.5, ix1 - 0.45, f1 + 1.65, iz1 - 0.18, 0x71604c);
      for (const sy of [0.45, 0.95, 1.45]) {
        box('wall', sx0 - 0.06, f1 + sy, iz1 - 0.56, ix1 - 0.39, f1 + sy + 0.06, iz1 - 0.12, 0x9b815e, { collider: false });
      }
      lootX = sx0 - 0.55;
      lootZ = iz1 - 1.0;
    } else if (plot.arch === 'barn') {
      // 谷仓西后侧为工具台，东后侧继续保留原有干草垛。
      box('wall', ix0 + 0.5, f1 + 0.7, iz1 - 0.7, ix0 + 2.75, f1 + 0.84, iz1 - 0.28, 0x806548);
      for (const x of [ix0 + 0.68, ix0 + 2.57]) {
        box('wall', x - 0.06, f1, iz1 - 0.58, x + 0.06, f1 + 0.7, iz1 - 0.4, 0x554334, { collider: false });
      }
      lootX = ix0 + 3.35;
      lootZ = iz1 - 1.0;
    }
    // 家具旁追加一个拾取点，让新增房间真正参与搜刮路线。
    this.lootSpots.push({ x: lootX, y: f1, z: lootZ, premium: false });
  }

  // 家具和隔墙生成后统一校正拾取点，避免物资刷进实体或门板中。
  private sanitizeLootSpots(world: World): void {
    const radius = 0.2;
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, 0], [0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75],
      [1.1, 1.1], [-1.1, 1.1], [1.1, -1.1], [-1.1, -1.1],
      [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5],
    ];
    const blocked = (x: number, y: number, z: number): boolean => world.aabbs.some((c) => {
      if (c.off || c.tag === 'floor' || c.tag === 'roof') return false;
      if (y + 0.8 < c.minY || y > c.maxY) return false;
      const dx = Math.max(c.minX - x, 0, x - c.maxX);
      const dz = Math.max(c.minZ - z, 0, z - c.maxZ);
      return dx * dx + dz * dz < radius * radius;
    });
    const accepted: LootSpot[] = [];
    for (const spot of this.lootSpots) {
      const plot = this.plots.find((p) => (
        spot.x > p.minX + 2 && spot.x < p.maxX - 2
        && spot.z > p.minZ + 2 && spot.z < p.maxZ - 2
      ));
      if (!plot) continue;
      for (const [dx, dz] of offsets) {
        const x = spot.x + dx;
        const z = spot.z + dz;
        if (x < plot.minX + 2.5 || x > plot.maxX - 2.5 || z < plot.minZ + 2.5 || z > plot.maxZ - 2.5) continue;
        if (blocked(x, spot.y, z)) continue;
        if (accepted.some((p) => Math.abs(p.y - spot.y) < 0.9 && Math.hypot(p.x - x, p.z - z) < 0.65)) continue;
        accepted.push({ ...spot, x, z });
        break;
      }
    }
    this.lootSpots = accepted;
  }

  // 院墙、围栏和外部箱堆为房屋之间补充连续掩体，并在入口方向留出明确缺口。
  private addYardCover(plot: HousePlot, box: BoxFn, idx: number): void {
    const y = plot.flatH;
    if (plot.arch === 'barn') {
      box('wall', plot.minX + 0.3, y, plot.maxZ - 0.55, plot.maxX - 0.3, y + 0.9, plot.maxZ - 0.35, 0x80633f);
      for (let x = plot.minX + 0.5; x < plot.maxX - 0.4; x += 2.2) {
        box('wall', x, y, plot.maxZ - 0.68, x + 0.12, y + 1.25, plot.maxZ - 0.22, 0x57432c, { collider: false });
      }
    } else if (idx % 3 === 0) {
      const c = plot.arch === 'apartment' ? 0x77746b : 0x8b806b;
      box('wall', plot.minX + 0.35, y, plot.maxZ - 0.55, plot.minX + (plot.maxX - plot.minX) * 0.43, y + 0.82, plot.maxZ - 0.3, c);
      box('wall', plot.minX + (plot.maxX - plot.minX) * 0.62, y, plot.maxZ - 0.55, plot.maxX - 0.35, y + 0.82, plot.maxZ - 0.3, c);
      box('wall', plot.maxX - 0.55, y, plot.minZ + 0.5, plot.maxX - 0.3, y + 0.82, plot.maxZ - 0.3, c);
    }
    // 外墙角箱堆，保持离正门至少 2m。
    const cx = plot.minX + 0.55;
    const cz = plot.minZ + 0.7;
    box('wall', cx, y, cz, cx + 0.9, y + 0.72, cz + 0.9, CRATE_C);
    if (idx % 2 === 1) box('wall', cx + 0.18, y + 0.72, cz + 0.15, cx + 0.86, y + 1.32, cz + 0.83, CRATE_C);
  }

  // 阶梯坡屋顶(3 级: 檐口→中段→脊, ridge 沿 x 走向) + 屋脊压条
  private gableRoof(box: BoxFn, ix0: number, iz0: number, ix1: number, iz1: number, yBase: number, c: number): void {
    const dz = iz1 - iz0;
    box('roof', ix0 - 0.18, yBase, iz0 - 0.18, ix1 + 0.18, yBase + 0.2, iz1 + 0.18, c);
    box('roof', ix0 - 0.1, yBase + 0.2, iz0 + dz * 0.16, ix1 + 0.1, yBase + 0.42, iz1 - dz * 0.16, c);
    box('roof', ix0 - 0.02, yBase + 0.42, iz0 + dz * 0.34, ix1 + 0.02, yBase + 0.64, iz1 - dz * 0.34, c);
    const zm = (iz0 + iz1) / 2;
    box('roof', ix0 - 0.06, yBase + 0.64, zm - 0.16, ix1 + 0.06, yBase + 0.76, zm + 0.16, FRAME_C, { collider: false });
  }

  // 墙基裙(一周, 纯装饰)
  private skirt(box: BoxFn, ix0: number, iz0: number, ix1: number, iz1: number, yBase: number): void {
    const t = 0.06;
    box('wall', ix0 - t, yBase, iz0 - t, ix1 + t, yBase + 0.32, iz0, SKIRT_C, { collider: false });
    box('wall', ix0 - t, yBase, iz1, ix1 + t, yBase + 0.32, iz1 + t, SKIRT_C, { collider: false });
    box('wall', ix0 - t, yBase, iz0, ix0, yBase + 0.32, iz1, SKIRT_C, { collider: false });
    box('wall', ix1, yBase, iz0, ix1 + t, yBase + 0.32, iz1, SKIRT_C, { collider: false });
  }

  // 烟囱 / 空调盒(纯装饰)
  private extras(box: BoxFn, p: Palette, ix0: number, iz0: number, ix1: number, roofY: number, w: number): void {
    if (p.chimney) {
      box('wall', ix0 + w * 0.72, roofY, iz0 + 0.5, ix0 + w * 0.72 + 0.36, roofY + 0.95, iz0 + 0.86, 0x7a6a58, { collider: false });
    }
    if (p.ac) {
      box('wall', ix1 + 0.02, roofY - 1.6, iz0 + 1.1, ix1 + 0.3, roofY - 1.28, iz0 + 1.5, 0xb8bcc0, { collider: false });
    }
    // 屋顶通风帽、检修箱和宽楼的储水箱，形成更丰富的天际线。
    box('wall', ix0 + w * 0.28, roofY, iz0 + 0.65, ix0 + w * 0.28 + 0.28, roofY + 0.42, iz0 + 0.93, 0x737b79, { collider: false });
    box('wall', ix0 + w * 0.44, roofY, iz0 + 0.78, ix0 + w * 0.44 + 0.42, roofY + 0.28, iz0 + 1.18, 0x909795, { collider: false });
    if (w > 8) {
      box('wall', ix0 + w * 0.58, roofY, iz0 + 0.55, ix0 + w * 0.58 + 0.82, roofY + 0.72, iz0 + 1.35, 0x667579, { collider: false });
    }
  }

  // 门 + 门框(装饰框边)
  private addDoor(
    world: World, box: BoxFn, axis: 'x' | 'z', fixed: number,
    a0: number, a1: number, y0: number, y1: number, midY: number,
    interior: 1 | -1,
  ): void {
    // 门框: 两侧柱 + 顶楣(纯装饰)
    const ft = 0.1;
    if (axis === 'x') {
      box('wall', a0 - 0.06, y0, fixed - ft, a0 + 0.02, y1 + 0.06, fixed + ft, FRAME_C, { collider: false });
      box('wall', a1 - 0.02, y0, fixed - ft, a1 + 0.06, y1 + 0.06, fixed + ft, FRAME_C, { collider: false });
      box('wall', a0 - 0.06, y1, fixed - ft, a1 + 0.06, y1 + 0.08, fixed + ft, FRAME_C, { collider: false });
    } else {
      box('wall', fixed - ft, y0, a0 - 0.06, fixed + ft, y1 + 0.06, a0 + 0.02, FRAME_C, { collider: false });
      box('wall', fixed - ft, y0, a1 - 0.02, fixed + ft, y1 + 0.06, a1 + 0.06, FRAME_C, { collider: false });
      box('wall', fixed - ft, y1, a0 - 0.06, fixed + ft, y1 + 0.08, a1 + 0.06, FRAME_C, { collider: false });
    }
    const t = 0.1;
    const c: AabbCollider = axis === 'x'
      ? { kind: 'aabb', minX: a0, minY: y0, minZ: fixed - t / 2, maxX: a1, maxY: y1, maxZ: fixed + t / 2, tag: 'door' }
      : { kind: 'aabb', minX: fixed - t / 2, minY: y0, minZ: a0, maxX: fixed + t / 2, maxY: y1, maxZ: a1, tag: 'door' };
    world.addCollider(c);
    // 铰链结构: group 定位在铰链边(a0 端), pivot 承载门扇, 开门 = pivot 绕 Y 旋转
    const group = new THREE.Group();
    group.position.set(axis === 'x' ? a0 : fixed, y0, axis === 'x' ? fixed : a0);
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(axis === 'x' ? this.doorGeoAlongX : this.doorGeoAlongZ, this.doorMat);
    mesh.position.set(axis === 'x' ? DOOR_W / 2 : 0, DOOR_H / 2, axis === 'x' ? 0 : DOOR_W / 2);
    mesh.castShadow = true;
    // 门板细节(挂在门扇网格下, 破坏隐藏/铰链旋转自动跟随): 竖拼缝 ×2 + 把手
    {
      const trimGeo = axis === 'x' ? this.trimGeoX : this.trimGeoZ;
      const handleGeo = axis === 'x' ? this.handleGeoX : this.handleGeoZ;
      const plateGeo = axis === 'x' ? this.plateGeoX : this.plateGeoZ;
      for (const off of [-DOOR_W / 6, DOOR_W / 6]) {
        const seam = new THREE.Mesh(trimGeo, this.doorTrimMat);
        seam.position.set(axis === 'x' ? off : 0.056, -0.05, axis === 'x' ? 0.056 : off);
        mesh.add(seam);
      }
      // 把手在远离铰链侧(局部坐标铰链在 -DOOR_W/2 侧)
      const hx = DOOR_W / 2 - 0.18;
      const plate = new THREE.Mesh(plateGeo, this.doorTrimMat);
      plate.position.set(axis === 'x' ? hx : 0.056, -0.12, axis === 'x' ? 0.056 : hx);
      mesh.add(plate);
      const knob = new THREE.Mesh(handleGeo, this.knobMat);
      knob.position.set(axis === 'x' ? hx : 0.08, -0.12, axis === 'x' ? 0.08 : hx);
      mesh.add(knob);
    }
    pivot.add(mesh);
    // 铰链柱: 门被炸毁后仍留在原地
    const post = new THREE.Mesh(axis === 'x' ? this.postGeoAlongX : this.postGeoAlongZ, this.postMat);
    post.position.y = DOOR_H / 2;
    post.castShadow = true;
    group.add(pivot);
    group.add(post);
    const d = new Destructible('door', 80, mesh, c, (c.minX + c.maxX) / 2, midY, (c.minZ + c.maxZ) / 2);
    d.group = group;
    d.pivot = pivot;
    // 开门朝屋内: 沿 X 走向的墙取 -interior, 沿 Z 走向取 +interior
    d.openAngle = (axis === 'x' ? -interior : interior) * DOOR_SWING;
    c.destruct = d;
    this.destructibles.push(d);
  }

  // 窗 + 窗框嵌条(装饰)
  private addWindow(
    world: World, box: BoxFn, axis: 'x' | 'z', fixed: number,
    a0: number, a1: number, y0: number, y1: number, midA: number, midY: number,
  ): void {
    // 窗框: 上下左右四条细边(纯装饰)
    const ft = 0.09;
    if (axis === 'x') {
      box('wall', a0 - 0.03, y0 - 0.03, fixed - ft, a1 + 0.03, y0 + 0.03, fixed + ft, FRAME_C, { collider: false });
      box('wall', a0 - 0.03, y1 - 0.03, fixed - ft, a1 + 0.03, y1 + 0.03, fixed + ft, FRAME_C, { collider: false });
      box('wall', a0 - 0.03, y0, fixed - ft, a0 + 0.03, y1, fixed + ft, FRAME_C, { collider: false });
      box('wall', a1 - 0.03, y0, fixed - ft, a1 + 0.03, y1, fixed + ft, FRAME_C, { collider: false });
    } else {
      box('wall', fixed - ft, y0 - 0.03, a0 - 0.03, fixed + ft, y0 + 0.03, a1 + 0.03, FRAME_C, { collider: false });
      box('wall', fixed - ft, y1 - 0.03, a0 - 0.03, fixed + ft, y1 + 0.03, a1 + 0.03, FRAME_C, { collider: false });
      box('wall', fixed - ft, y0, a0 - 0.03, fixed + ft, y1, a0 + 0.03, FRAME_C, { collider: false });
      box('wall', fixed - ft, y0, a1 - 0.03, fixed + ft, y1, a1 + 0.03, FRAME_C, { collider: false });
    }
    const t = 0.06;
    // 窗台挑檐 + 部分窗户百叶板(纯装饰, 位置确定性抽样)
    const st = 0.16;
    const withShutters = Math.floor(Math.abs(a0 * 7 + fixed * 3)) % 3 === 0;
    if (axis === 'x') {
      box('wall', a0 - 0.12, y0 - 0.08, fixed - st, a1 + 0.12, y0, fixed + st, TRIM_C, { collider: false });
      if (withShutters) {
        box('wall', a0 - 0.34, y0, fixed - 0.04, a0 - 0.06, y1, fixed + 0.04, SHUTTER_C, { collider: false });
        box('wall', a1 + 0.06, y0, fixed - 0.04, a1 + 0.34, y1, fixed + 0.04, SHUTTER_C, { collider: false });
      }
    } else {
      box('wall', fixed - st, y0 - 0.08, a0 - 0.12, fixed + st, y0, a1 + 0.12, TRIM_C, { collider: false });
      if (withShutters) {
        box('wall', fixed - 0.04, y0, a0 - 0.34, fixed + 0.04, y1, a0 - 0.06, SHUTTER_C, { collider: false });
        box('wall', fixed - 0.04, y0, a1 + 0.06, fixed + 0.04, y1, a1 + 0.34, SHUTTER_C, { collider: false });
      }
    }
    const c: AabbCollider = axis === 'x'
      ? { kind: 'aabb', minX: a0, minY: y0, minZ: fixed - t / 2, maxX: a1, maxY: y1, maxZ: fixed + t / 2, tag: 'window' }
      : { kind: 'aabb', minX: fixed - t / 2, minY: y0, minZ: a0, maxX: fixed + t / 2, maxY: y1, maxZ: a1, tag: 'window' };
    world.addCollider(c);
    const mesh = new THREE.Mesh(axis === 'x' ? this.paneGeoAlongX : this.paneGeoAlongZ, this.paneMat);
    mesh.position.set(axis === 'x' ? midA : fixed, midY, axis === 'x' ? fixed : midA);
    const d = new Destructible('window', 30, mesh, c, (c.minX + c.maxX) / 2, midY, (c.minZ + c.maxZ) / 2);
    c.destruct = d;
    this.destructibles.push(d);
  }

  // ═══════════════ 原型: 平房/双层(原两种, 加艺术细节) ═══════════════
  private addCottage(world: World, plot: HousePlot, p: Palette, box: BoxFn, two: boolean): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    const idx = this.plots.indexOf(plot);
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const wt1 = f1 + WALL_H;

    const doorA0 = ix0 + w / 2 - DOOR_W / 2;
    const northOps: Op[] = [{ a0: doorA0, a1: doorA0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true }];
    const southOps: Op[] = [];
    if (w > 8 && (idx * 13) % 5 === 0) {
      const s0 = ix0 + w * 0.22;
      southOps.push({ a0: s0, a1: s0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true });
    } else {
      const s0 = ix0 + w / 2 - WIN_W / 2;
      southOps.push({ a0: s0, a1: s0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    }
    const win = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    const buried = f1 - 0.9;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, wt1, northOps, p.wall, WT, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, wt1, southOps, p.wall, WT, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, wt1, [win(iz0 + d * 0.3)], p.wall, WT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, wt1, [win(iz0 + d * 0.62)], p.wall, WT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    // 转角壁柱(部分房屋, 纯装饰)
    if (idx % 2 === 0) {
      for (const [cx, cz] of [[ix0, iz0], [ix1, iz0], [ix0, iz1], [ix1, iz1]] as const) {
        box('wall', cx - 0.09, buried, cz - 0.09, cx + 0.09, wt1, cz + 0.09, TRIM_C, { collider: false });
      }
    }
    // 门阶(可站立小平台)
    box('floor', doorA0 - 0.15, f1 - 0.14, iz0 - 0.75, doorA0 + DOOR_W + 0.15, f1 - 0.02, iz0, TRIM_C, { collider: false, platform: true });
    this.lootSpots.push(
      { x: ix0 + w * 0.25, y: f1, z: iz0 + d * 0.35, premium: false },
      { x: ix1 - w * 0.2, y: f1, z: iz1 - d * 0.25, premium: false },
    );

    if (!two) {
      this.gableRoof(box, ix0, iz0, ix1, iz1, wt1, p.roof);
      this.extras(box, p, ix0, iz0, ix1, wt1 + 0.2, w);
      return;
    }

    // ── 双层 ──
    const f2 = wt1 + SLAB_T;
    const rise = (f2 - f1) / STAIR_STEPS;
    const stairX0 = ix0 + 0.14, stairX1 = stairX0 + STAIR_W;
    const holeZ0 = iz0 + 1.0;
    this.stairs(box, stairX0, stairX1, iz1 - 0.6, holeZ0 + 0.15, f1, rise, FLOOR2_C);
    box('floor', stairX1, wt1, iz0, ix1, f2, iz1, FLOOR2_C);
    box('floor', ix0, wt1, iz0, stairX1, f2, holeZ0, FLOOR2_C);
    this.lootSpots.push(
      { x: ix0 + w * 0.5, y: f2, z: iz0 + d * 0.3, premium: true },
      { x: ix1 - w * 0.22, y: f2, z: iz1 - d * 0.2, premium: true },
    );
    this.rail(box, stairX1, holeZ0, stairX1 + 0.08, iz1, f2, 0.95);
    const uwt = f2 + WALL_H - 0.15;
    const win2 = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f2 + 0.9, y1: f2 + 0.9 + WIN_H });
    this.wallRun(world, box, 'x', iz0, ix0, ix1, f2, uwt, [win2(ix0 + w * 0.35)], p.wall, WT2, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, f2, uwt, [win2(ix0 + w * 0.55)], p.wall, WT2, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, f2, uwt, [win2(iz0 + d * 0.4)], p.wall, WT2, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, f2, uwt, [win2(iz0 + d * 0.55)], p.wall, WT2, -1);
    this.gableRoof(box, ix0, iz0, ix1, iz1, uwt, p.roof);
    this.extras(box, p, ix0, iz0, ix1, uwt + 0.2, w);
  }

  // ═══════════════ 原型: 露台房(二层带露天平台, 狙击点) ═══════════════
  private addTerrace(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const wt1 = f1 + WALL_H;

    const doorA0 = ix0 + w / 2 - DOOR_W / 2;
    const win = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    const buried = f1 - 0.9;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, wt1, [{ a0: doorA0, a1: doorA0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true }], p.wall, WT, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, wt1, [win(ix0 + w * 0.3), win(ix0 + w * 0.62)], p.wall, WT, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, wt1, [win(iz0 + d * 0.35)], p.wall, WT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, wt1, [win(iz0 + d * 0.55)], p.wall, WT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    box('floor', doorA0 - 0.15, f1 - 0.14, iz0 - 0.75, doorA0 + DOOR_W + 0.15, f1 - 0.02, iz0, TRIM_C, { collider: false, platform: true });
    this.lootSpots.push(
      { x: ix0 + w * 0.25, y: f1, z: iz0 + d * 0.35, premium: false },
      { x: ix1 - w * 0.2, y: f1, z: iz1 - d * 0.3, premium: false },
    );

    // 楼梯 1F→2F(西墙), 一层顶板全覆盖 = 露台地面
    const f2 = wt1 + SLAB_T;
    const rise = (f2 - f1) / STAIR_STEPS;
    const stairX0 = ix0 + 0.14, stairX1 = stairX0 + STAIR_W;
    const holeZ0 = iz0 + 1.0;
    this.stairs(box, stairX0, stairX1, iz1 - 0.6, holeZ0 + 0.15, f1, rise, FLOOR2_C);
    box('floor', stairX1, wt1, iz0, ix1, f2, iz1, FLOOR2_C);
    box('floor', ix0, wt1, iz0, stairX1, f2, holeZ0, FLOOR2_C);
    this.rail(box, stairX1, holeZ0, stairX1 + 0.08, iz1, f2, 0.95);

    // 二层房间占北 55%: 房间南墙(zRoom)开门通向露台
    const zRoom = iz0 + d * 0.55;
    const uwt = f2 + WALL_H - 0.15;
    const win2 = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f2 + 0.9, y1: f2 + 0.9 + WIN_H });
    // 房间北墙(外墙延伸) + 东西墙(北段) + 房间南墙(带门)
    this.wallRun(world, box, 'x', iz0, ix0, ix1, f2, uwt, [win2(ix0 + w * 0.4)], p.wall, WT2, 1);
    const roomDoorA0 = ix0 + w * 0.55;
    this.wallRun(world, box, 'x', zRoom, ix0, ix1, f2, uwt, [{ a0: roomDoorA0, a1: roomDoorA0 + DOOR_W, y0: f2, y1: f2 + DOOR_H, door: true }], p.wall, WT2, -1);
    this.wallRun(world, box, 'z', ix0, iz0, zRoom, f2, uwt, [win2(iz0 + d * 0.25)], p.wall, WT2, 1);
    this.wallRun(world, box, 'z', ix1, iz0, zRoom, f2, uwt, [win2(iz0 + d * 0.3)], p.wall, WT2, -1);
    // 房间顶(小坡屋顶)
    this.gableRoof(box, ix0, iz0, ix1, zRoom + 0.1, uwt, p.roof);

    // 露台护栏(南缘 + 东西南段, 矮碰撞)
    this.rail(box, ix0, iz1 - 0.08, ix1, iz1, f2, 0.95);
    this.rail(box, ix0, zRoom, ix0 + 0.08, iz1, f2, 0.95);
    this.rail(box, ix1 - 0.08, zRoom, ix1, iz1, f2, 0.95);
    this.lootSpots.push(
      { x: ix0 + w * 0.5, y: f2, z: iz0 + d * 0.25, premium: true },
      { x: ix0 + w * 0.5, y: f2, z: zRoom + d * 0.2, premium: true }, // 露台狙击位
    );
    this.extras(box, p, ix0, iz0, ix1, uwt + 0.2, w);
  }

  // ═══════════════ 原型: 三层楼(双跑楼梯, 顶层高级物资) ═══════════════
  private addApartment(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const wt1 = f1 + WALL_H;

    const win = (a0: number, fy: number): Op => ({ a0, a1: a0 + WIN_W, y0: fy + WIN_SILL, y1: fy + WIN_SILL + WIN_H });
    const buried = f1 - 0.9;
    const doorA0 = ix0 + w / 2 - DOOR_W / 2;
    // 1F: 每面两窗(北墙为门)
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, wt1, [{ a0: doorA0, a1: doorA0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true }], p.wall, WT, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, wt1, [win(ix0 + w * 0.22, f1), win(ix0 + w * 0.62, f1)], p.wall, WT, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, wt1, [win(iz0 + d * 0.25, f1), win(iz0 + d * 0.6, f1)], p.wall, WT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, wt1, [win(iz0 + d * 0.3, f1), win(iz0 + d * 0.65, f1)], p.wall, WT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    box('floor', doorA0 - 0.15, f1 - 0.14, iz0 - 0.75, doorA0 + DOOR_W + 0.15, f1 - 0.02, iz0, TRIM_C, { collider: false, platform: true });
    this.lootSpots.push(
      { x: ix0 + w * 0.3, y: f1, z: iz0 + d * 0.35, premium: false },
      { x: ix1 - w * 0.25, y: f1, z: iz1 - d * 0.3, premium: false },
    );

    // 跑梯 1: 西墙 1F→2F(北端上)
    const f2 = wt1 + SLAB_T;
    const rise = (f2 - f1) / STAIR_STEPS;
    const s1x0 = ix0 + 0.14, s1x1 = s1x0 + STAIR_W;
    const hole1Z0 = iz0 + 1.0;
    this.stairs(box, s1x0, s1x1, iz1 - 0.6, hole1Z0 + 0.15, f1, rise, FLOOR2_C);
    box('floor', s1x1, wt1, iz0, ix1, f2, iz1, FLOOR2_C);
    box('floor', ix0, wt1, iz0, s1x1, f2, hole1Z0, FLOOR2_C);
    this.rail(box, s1x1, hole1Z0, s1x1 + 0.08, iz1, f2, 0.95);

    // 2F 墙 + 窗(南北两面双窗, 东西单窗)
    const win2 = (a0: number): Op => win(a0, f2);
    this.wallRun(world, box, 'x', iz0, ix0, ix1, f2, f2 + WALL_H, [win2(ix0 + w * 0.25), win2(ix0 + w * 0.6)], p.wall, WT2, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, f2, f2 + WALL_H, [win2(ix0 + w * 0.3), win2(ix0 + w * 0.65)], p.wall, WT2, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, f2, f2 + WALL_H, [win2(iz0 + d * 0.45)], p.wall, WT2, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, f2, f2 + WALL_H, [win2(iz0 + d * 0.5)], p.wall, WT2, -1);
    this.lootSpots.push(
      { x: ix0 + w * 0.5, y: f2, z: iz0 + d * 0.35, premium: false },
      { x: ix1 - w * 0.2, y: f2, z: iz1 - d * 0.25, premium: false },
    );

    // 跑梯 2: 东墙 2F→3F(南端上, 与跑梯1对角)
    const wt2 = f2 + WALL_H;
    const f3 = wt2 + SLAB_T;
    const rise2 = (f3 - f2) / STAIR_STEPS;
    const s2x1 = ix1 - 0.14, s2x0 = s2x1 - STAIR_W;
    const hole2Z1 = iz1 - 1.0;
    this.stairs(box, s2x0, s2x1, iz0 + 0.6, hole2Z1 - 0.15, f2, rise2, FLOOR2_C);
    // 3F 板: 西全宽 + 东南角北部条(留出跑梯2井口)
    box('floor', ix0, wt2, iz0, s2x0, f3, iz1, FLOOR2_C);
    box('floor', s2x0, wt2, iz0, ix1, f3, hole2Z1, FLOOR2_C);
    this.rail(box, s2x0 - 0.08, hole2Z1, s2x0, iz1, f3, 0.95);

    // 3F 墙 + 窗(南北双窗, 东西单窗) + 顶层高级物资
    const win3 = (a0: number): Op => win(a0, f3);
    this.wallRun(world, box, 'x', iz0, ix0, ix1, f3, f3 + WALL_H, [win3(ix0 + w * 0.25), win3(ix0 + w * 0.6)], p.wall, WT2, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, f3, f3 + WALL_H, [win3(ix0 + w * 0.3), win3(ix0 + w * 0.65)], p.wall, WT2, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, f3, f3 + WALL_H, [win3(iz0 + d * 0.45)], p.wall, WT2, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, f3, f3 + WALL_H, [win3(iz0 + d * 0.5)], p.wall, WT2, -1);
    this.lootSpots.push(
      { x: ix0 + w * 0.4, y: f3, z: iz0 + d * 0.35, premium: true },
      { x: ix1 - w * 0.3, y: f3, z: iz1 - d * 0.3, premium: true },
    );
    this.gableRoof(box, ix0, iz0, ix1, iz1, f3 + WALL_H, p.roof);
    this.extras(box, p, ix0, iz0, ix1, f3 + WALL_H + 0.2, w);
  }

  // ═══════════════ 原型: 谷仓(高大单空间, 大门洞) ═══════════════
  private addBarn(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    const wallTop = f1 + 4.2; // 高墙
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const buried = f1 - 0.9;
    const openA0 = ix0 + w / 2 - 1.3;
    // 北面 2.6m 大门洞(无门扇), 高窗透气
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, wallTop, [
      { a0: openA0, a1: openA0 + 2.6, y0: f1, y1: f1 + 3.2, door: true, doorless: true },
      { a0: ix0 + w * 0.2, a1: ix0 + w * 0.2 + 0.9, y0: f1 + 3.4, y1: f1 + 4.0 },
    ], p.wall, WT, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, wallTop, [{ a0: ix0 + w * 0.45, a1: ix0 + w * 0.45 + 0.9, y0: f1 + 3.4, y1: f1 + 4.0 }], p.wall, WT, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, wallTop, [], p.wall, WT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, wallTop, [], p.wall, WT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    // 内部: 干草垛(可站上)
    box('wall', ix0 + w * 0.6, f1, iz1 - d * 0.35, ix0 + w * 0.9, f1 + 0.55, iz1 - d * 0.1, 0xc2a54e);
    box('wall', ix0 + w * 0.68, f1 + 0.55, iz1 - d * 0.32, ix0 + w * 0.86, f1 + 1.0, iz1 - d * 0.14, 0xc2a54e);
    // 加高阶梯坡屋顶
    const dz = iz1 - iz0;
    box('roof', ix0 - 0.2, wallTop, iz0 - 0.2, ix1 + 0.2, wallTop + 0.24, iz1 + 0.2, p.roof);
    box('roof', ix0 - 0.12, wallTop + 0.24, iz0 + dz * 0.14, ix1 + 0.12, wallTop + 0.5, iz1 - dz * 0.14, p.roof);
    box('roof', ix0 - 0.04, wallTop + 0.5, iz0 + dz * 0.32, ix1 + 0.04, wallTop + 0.76, iz1 - dz * 0.32, p.roof);
    this.lootSpots.push(
      { x: ix0 + w * 0.25, y: f1, z: iz0 + d * 0.4, premium: false },
      { x: ix1 - w * 0.25, y: f1, z: iz1 - d * 0.3, premium: false },
    );
    this.extras(box, p, ix0, iz0, ix1, wallTop + 0.24, w);
  }

  // ═══════════════ 原型: 小卖部(单间, 开放门面+雨棚) ═══════════════
  private addShop(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, FLOOR_C);
    const wt1 = f1 + WALL_H;
    const openA0 = ix0 + w / 2 - 1.2;
    const win = (a0: number): Op => ({ a0, a1: a0 + WIN_W, y0: f1 + WIN_SILL, y1: f1 + WIN_SILL + WIN_H });
    const buried = f1 - 0.9;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, wt1, [
      { a0: openA0, a1: openA0 + 2.4, y0: f1, y1: f1 + 2.4, door: true, doorless: true },
    ], p.wall, WT, 1);
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, wt1, [win(ix0 + w / 2 - WIN_W / 2)], p.wall, WT, -1);
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, wt1, [win(iz0 + d * 0.45)], p.wall, WT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, wt1, [], p.wall, WT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);
    // 雨棚 + 柜台
    box('roof', openA0 - 0.5, f1 + 2.5, iz0 - 1.3, openA0 + 2.9, f1 + 2.66, iz0 + 0.1, p.roof, { collider: false });
    box('wall', openA0 - 0.45, f1, iz0 - 1.25, openA0 - 0.3, f1 + 2.5, iz0 - 1.1, TRIM_C);
    box('wall', openA0 + 2.75, f1, iz0 - 1.25, openA0 + 2.9, f1 + 2.5, iz0 - 1.1, TRIM_C);
    box('wall', ix0 + w * 0.2, f1, iz0 + d * 0.42, ix0 + w * 0.8, f1 + 0.95, iz0 + d * 0.52, RAIL_C);
    this.gableRoof(box, ix0, iz0, ix1, iz1, wt1, p.roof);
    this.lootSpots.push(
      { x: ix0 + w * 0.5, y: f1, z: iz0 + d * 0.7, premium: false },
      { x: ix1 - w * 0.25, y: f1, z: iz1 - d * 0.25, premium: false },
    );
  }

  // ═══════════════ 原型: 大体育馆(~40×25, 开阔大厅/高窗/看台/高级物资) ═══════════════
  private addGym(world: World, plot: HousePlot, p: Palette, box: BoxFn): void {
    const ix0 = plot.minX + 2, ix1 = plot.maxX - 2, iz0 = plot.minZ + 2, iz1 = plot.maxZ - 2;
    const w = ix1 - ix0, d = iz1 - iz0;
    const f1 = plot.flatH + 0.28;
    const wallTop = f1 + 8.6;
    const GWT = 0.35; // 体育馆墙厚
    box('floor', ix0, f1 - 0.28, iz0, ix1, f1, iz1, 0xa8a294);
    const buried = f1 - 0.9;
    const hiWin = (a0: number): Op => ({ a0, a1: a0 + 1.3, y0: f1 + 5.4, y1: f1 + 6.6 });
    // 北墙: 中央双开门(2×1.2 门扇) + 高窗×3
    const doorA0 = ix0 + w / 2 - DOOR_W;
    this.wallRun(world, box, 'x', iz0, ix0, ix1, buried, wallTop, [
      hiWin(ix0 + w * 0.18),
      { a0: doorA0, a1: doorA0 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true },
      { a0: doorA0 + DOOR_W, a1: doorA0 + DOOR_W * 2, y0: f1, y1: f1 + DOOR_H, door: true },
      hiWin(ix0 + w * 0.74),
    ], p.wall, GWT, 1);
    // 南墙: 3m 无门大洞 + 高窗×2
    this.wallRun(world, box, 'x', iz1, ix0, ix1, buried, wallTop, [
      hiWin(ix0 + w * 0.22),
      { a0: ix0 + w / 2 - 1.5, a1: ix0 + w / 2 + 1.5, y0: f1, y1: f1 + 3.4, door: true, doorless: true },
      hiWin(ix0 + w * 0.72),
    ], p.wall, GWT, -1);
    // 东西墙: 各一扇小门 + 高窗×2
    this.wallRun(world, box, 'z', ix0, iz0, iz1, buried, wallTop, [
      hiWin(iz0 + d * 0.25),
      { a0: iz0 + d * 0.5 - DOOR_W / 2, a1: iz0 + d * 0.5 + DOOR_W / 2, y0: f1, y1: f1 + DOOR_H, door: true },
      hiWin(iz0 + d * 0.72),
    ], p.wall, GWT, 1);
    this.wallRun(world, box, 'z', ix1, iz0, iz1, buried, wallTop, [
      hiWin(iz0 + d * 0.28),
      { a0: iz0 + d * 0.55, a1: iz0 + d * 0.55 + DOOR_W, y0: f1, y1: f1 + DOOR_H, door: true },
      hiWin(iz0 + d * 0.75),
    ], p.wall, GWT, -1);
    this.skirt(box, ix0, iz0, ix1, iz1, f1 - 0.28);

    // 壁柱(外墙装饰, 每 ~4m)
    for (let x = ix0 + 2; x < ix1 - 1; x += 4.2) {
      box('wall', x - 0.17, buried, iz0 - GWT / 2 - 0.1, x + 0.17, wallTop, iz0 - GWT / 2 + 0.06, TRIM_C, { collider: false });
      box('wall', x - 0.17, buried, iz1 - GWT / 2 + 0.06, x + 0.17, wallTop, iz1 + GWT / 2 + 0.1, TRIM_C, { collider: false });
    }
    for (let z = iz0 + 2; z < iz1 - 1; z += 4.2) {
      box('wall', ix0 - GWT / 2 - 0.1, buried, z - 0.17, ix0 - GWT / 2 + 0.06, wallTop, z + 0.17, TRIM_C, { collider: false });
      box('wall', ix1 - GWT / 2 + 0.06, buried, z - 0.17, ix1 + GWT / 2 + 0.1, wallTop, z + 0.17, TRIM_C, { collider: false });
    }

    // 入口雨棚(北门) + 双柱
    box('roof', doorA0 - 0.8, f1 + 3.3, iz0 - 2.3, doorA0 + DOOR_W * 2 + 0.8, f1 + 3.48, iz0 + 0.1, p.roof);
    box('wall', doorA0 - 0.65, f1, iz0 - 2.15, doorA0 - 0.5, f1 + 3.3, iz0 - 2.0, TRIM_C);
    box('wall', doorA0 + DOOR_W * 2 + 0.5, f1, iz0 - 2.15, doorA0 + DOOR_W * 2 + 0.65, f1 + 3.3, iz0 - 2.0, TRIM_C);

    // 屋顶: 边缘板 + 中央抬升脊(长向 60% × 深向 60%)
    box('roof', ix0 - 0.3, wallTop, iz0 - 0.3, ix1 + 0.3, wallTop + 0.28, iz1 + 0.3, p.roof);
    box('roof', ix0 + w * 0.2, wallTop + 0.28, iz0 + d * 0.2, ix1 - w * 0.2, wallTop + 1.55, iz1 - d * 0.2, p.roof);
    // 侧墙与抬升段之间的竖带(遮缝)
    box('wall', ix0 + w * 0.2, wallTop + 0.28, iz0 + d * 0.2, ix1 - w * 0.2, wallTop + 1.55, iz0 + d * 0.24, p.roof);
    box('wall', ix0 + w * 0.2, wallTop + 0.28, iz1 - d * 0.24, ix1 - w * 0.2, wallTop + 1.55, iz1 - d * 0.2, p.roof);

    // 看台(南侧三级平台, 可行走)
    const blX0 = ix0 + w * 0.55, blX1 = ix0 + w * 0.92;
    box('floor', blX0, f1, iz1 - 1.3, blX1, f1 + 0.45, iz1 - 0.2, 0x8f8a80, { collider: false, platform: true });
    box('floor', blX0, f1, iz1 - 2.4, blX1, f1 + 0.9, iz1 - 1.3, 0x8f8a80, { collider: false, platform: true });
    box('floor', blX0, f1, iz1 - 3.5, blX1, f1 + 1.35, iz1 - 2.4, 0x8f8a80, { collider: false, platform: true });

    // 散装箱体(场内掩体) + 箱体箍带
    const rng = mulberry32(777);
    for (let i = 0; i < 8; i++) {
      const s = 0.8 + rng() * 0.5;
      const cx = ix0 + 3 + rng() * (w - 6);
      const cz = iz0 + 3 + rng() * (d * 0.55);
      box('wall', cx, f1, cz, cx + s, f1 + s, cz + s, CRATE_C);
      box('wall', cx - 0.02, f1 + s - 0.07, cz + s * 0.3, cx + s + 0.02, f1 + s + 0.02, cz + s * 0.7, 0x6a5a42, { collider: false });
    }
    // 大厅顶部横梁(沿短向, 5 根)
    for (let i = 0; i < 5; i++) {
      const bx = ix0 + w * (0.14 + i * 0.18);
      box('wall', bx - 0.18, wallTop - 0.7, iz0 + 0.3, bx + 0.18, wallTop - 0.3, iz1 - 0.3, 0x5a4a38, { collider: false });
    }
    // 墙面色幅(南北墙点缀) + 入口门牌
    const BANNERS = [0xa03a30, 0x3a6ea5, 0xc2a54e];
    for (let i = 0; i < 3; i++) {
      const bx = ix0 + w * (0.25 + i * 0.25);
      const c = BANNERS[i] as number;
      box('wall', bx - 0.8, f1 + 3.2, iz0 + GWT / 2, bx + 0.8, f1 + 6.2, iz0 + GWT / 2 + 0.06, c, { collider: false });
      box('wall', bx - 0.8, f1 + 3.2, iz1 - GWT / 2 - 0.06, bx + 0.8, f1 + 6.2, iz1 - GWT / 2, c, { collider: false });
    }
    // 入口门牌(北门雨棚上方)
    box('wall', doorA0 - 0.6, f1 + 3.7, iz0 - 0.3, doorA0 + DOOR_W * 2 + 0.6, f1 + 4.4, iz0 + GWT / 2, 0xd8cba8, { collider: false });
    box('wall', doorA0 - 0.45, f1 + 3.85, iz0 - 0.34, doorA0 + DOOR_W * 2 + 0.45, f1 + 4.25, iz0 + GWT / 2 + 0.04, 0x8a4a3a, { collider: false });

    // loot: 大厅 4 普通 + 看台/中区 4 高级
    this.lootSpots.push(
      { x: ix0 + w * 0.15, y: f1, z: iz0 + d * 0.2, premium: false },
      { x: ix0 + w * 0.45, y: f1, z: iz0 + d * 0.3, premium: false },
      { x: ix1 - w * 0.15, y: f1, z: iz0 + d * 0.5, premium: false },
      { x: ix0 + w * 0.3, y: f1, z: iz1 - d * 0.15, premium: false },
      { x: ix0 + w * 0.6, y: f1, z: iz0 + d * 0.35, premium: true },
      { x: ix1 - w * 0.2, y: f1, z: iz0 + d * 0.25, premium: true },
      { x: ix0 + w * 0.75, y: f1 + 1.35, z: iz1 - 2.9, premium: true }, // 看台顶
      { x: ix0 + w * 0.5, y: f1, z: iz0 + d * 0.55, premium: true },
    );
  }

  // 开/关门(游戏层包装发声); 关门只在门完好时允许
  setDoorOpen(d: Destructible, open: boolean): boolean {
    if (d.kind !== 'door' || !d.alive || d.open === open) return false;
    d.open = open;
    d.collider.off = open; // 开门: 通行/子弹/视线全通过; 关门: 恢复阻挡
    return true;
  }

  // 门扇开关动画: ~0.3s 内旋到目标角
  update(dt: number): void {
    const speed = DOOR_SWING / DOOR_TWEEN;
    for (const d of this.destructibles) {
      if (d.kind !== 'door' || !d.pivot) continue;
      const target = d.open && d.alive ? d.openAngle : 0;
      const cur = d.pivot.rotation.y;
      if (cur === target) continue;
      const delta = target - cur;
      const step = Math.min(speed * dt, Math.abs(delta));
      d.pivot.rotation.y = cur + Math.sign(delta) * step;
    }
  }
}
