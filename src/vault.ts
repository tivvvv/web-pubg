// ─────────────────────────────────────────────────────────────────────────────
// vault.ts — 翻越(翻窗/翻矮墙): 探测 → 起翻 → 脚本位移, 玩家/bot/队友共用
// 规则: 障碍顶高于脚 0.7~1.3m, 沿翻越方向厚度 ≤0.7m, 落点 3.5m 内有地面且胶囊无碰撞
// ─────────────────────────────────────────────────────────────────────────────
import type { Character } from './character';
import type { World } from './world';
import type { AabbCollider, DestructibleLike } from './types';

export interface VaultProbe {
  topY: number;          // 翻越顶点(障碍顶 + 余量)
  landX: number;
  landY: number;
  landZ: number;
  win: DestructibleLike | null; // 路径穿过的整窗(翻越时碎裂)
  obstacle: AabbCollider;
}

const MIN_H = 0.7;   // 障碍顶最低高差
const MAX_H = 1.3;   // 障碍顶最高高差
const MAX_THICK = 0.7; // 可翻越厚度
const REACH = 1.35;  // 探测距离
const MAX_DROP = 3.5; // 落点最大落差

// 探测正前方的可翻越障碍(含窗台段/护栏/矮墙); 命中返回落点与穿窗信息
export function probeVault(c: Character, dirX: number, dirZ: number, world: World): VaultProbe | null {
  const L = Math.hypot(dirX, dirZ);
  if (L < 0.01) return null;
  const dx = dirX / L;
  const dz = dirZ / L;
  for (let d = 0.3; d <= REACH; d += 0.15) {
    const px = c.pos.x + dx * d;
    const pz = c.pos.z + dz * d;
    for (const b of world.aabbs) {
      if (b.off || b.tag === 'door' || b.tag === 'window') continue;
      if (px < b.minX - 0.05 || px > b.maxX + 0.05 || pz < b.minZ - 0.05 || pz > b.maxZ + 0.05) continue;
      const rel = b.maxY - c.pos.y;
      if (rel < MIN_H || rel > MAX_H) return null;
      // 厚度沿翻越方向(轴对齐盒近似)
      const thick = Math.abs(dx) > Math.abs(dz) ? b.maxX - b.minX : b.maxZ - b.minZ;
      if (thick > MAX_THICK) return null;
      // 落点: 障碍中心再沿翻越方向过半厚 + 0.55m
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const proj = (cx - c.pos.x) * dx + (cz - c.pos.z) * dz;
      const landDist = proj + thick / 2 + 0.55;
      const landX = c.pos.x + dx * landDist;
      const landZ = c.pos.z + dz * landDist;
      const topY = b.maxY + 0.32;
      const landY = world.groundHeight(landX, landZ, topY + 0.3);
      if (topY - landY > MAX_DROP) return null;
      if (!capsuleFree(world, landX, landY, landZ, b)) return null;
      // 路径穿过的整窗(一并碎裂)
      const win = windowBetween(world, c.pos.x, c.pos.z, landX, landZ);
      return { topY, landX, landY, landZ, win, obstacle: b };
    }
  }
  return null;
}

// 路径与整窗相交检测(翻窗碎玻璃用): 2D 线段-AABB slab 相交
function windowBetween(world: World, x0: number, z0: number, x1: number, z1: number): DestructibleLike | null {
  const dx = x1 - x0;
  const dz = z1 - z0;
  for (const d of world.buildings.destructibles) {
    if (d.kind !== 'window' || !d.alive) continue;
    const b = d.collider;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    // x 轴
    if (Math.abs(dx) < 1e-9) {
      if (x0 < b.minX || x0 > b.maxX) ok = false;
    } else {
      let ta = (b.minX - x0) / dx;
      let tb = (b.maxX - x0) / dx;
      if (ta > tb) { const tt = ta; ta = tb; tb = tt; }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) ok = false;
    }
    // z 轴
    if (ok) {
      if (Math.abs(dz) < 1e-9) {
        if (z0 < b.minZ || z0 > b.maxZ) ok = false;
      } else {
        let ta = (b.minZ - z0) / dz;
        let tb = (b.maxZ - z0) / dz;
        if (ta > tb) { const tt = ta; ta = tb; tb = tt; }
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) ok = false;
      }
    }
    if (ok) return d;
  }
  return null;
}

// 落点胶囊(半径 0.42, 高 1.7)与碰撞体无交叠(忽略被翻越的盒子本身)
function capsuleFree(world: World, x: number, y: number, z: number, skip: AabbCollider): boolean {
  for (const b of world.aabbs) {
    if (b.off || b === skip) continue;
    if (b.maxY < y + 0.1 || b.minY > y + 1.6) continue;
    const cx = Math.max(b.minX, Math.min(x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
    const ddx = x - cx;
    const ddz = z - cz;
    if (ddx * ddx + ddz * ddz < 0.42 * 0.42) return false;
  }
  for (const c of world.cyls) {
    if (y + 1.6 < c.y0 || y > c.y1) continue;
    const ddx = x - c.x;
    const ddz = z - c.z;
    const rr = 0.42 + c.r;
    if (ddx * ddx + ddz * ddz < rr * rr) return false;
  }
  return true;
}

// 起翻: 写入脚本位移(0.7s 上弧到落点)
export function startVault(c: Character, p: VaultProbe): void {
  c.vault = {
    t: 0, dur: 0.7,
    x0: c.pos.x, y0: c.pos.y, z0: c.pos.z,
    x1: p.landX, y1: p.landY, z1: p.landZ,
    topY: p.topY,
  };
  c.vy = 0;
  c.grounded = false;
}

// 推进翻越位移; 返回 true 表示仍在翻越中(调用方跳过常规移动)
export function updateVaultMotion(c: Character, dt: number): boolean {
  const v = c.vault;
  if (!v) return false;
  v.t += dt;
  const k = Math.min(1, v.t / v.dur);
  c.pos.x = v.x0 + (v.x1 - v.x0) * k;
  c.pos.z = v.z0 + (v.z1 - v.z0) * k;
  if (k < 0.45) {
    const e = 1 - (1 - k / 0.45) * (1 - k / 0.45); // easeOut 上升到顶点
    c.pos.y = v.y0 + (v.topY - v.y0) * e;
  } else {
    const e = (k - 0.45) / 0.55; // easeIn 下落
    c.pos.y = v.topY + (v.y1 - v.topY) * e * e;
  }
  c.speed2d = Math.hypot(v.x1 - v.x0, v.z1 - v.z0) / v.dur;
  c.groundH = c.pos.y;
  if (k >= 1) {
    c.pos.y = v.y1;
    c.vy = 0;
    c.grounded = true;
    c.speed2d = 0;
    c.vault = null;
    c.vaultCd = 0.4;
  }
  return true;
}
