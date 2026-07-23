// 机器人共享局部导航：前向可行性采样、障碍绕行、角色避让和卡死恢复。
import * as THREE from 'three';
import { Character, moveChar, SWIM_EXIT_DEPTH } from './character';
import { clamp, turnToward } from './utils';
import { riverZAt, WATER_Y, WORLD_HALF, type World } from './world';
import { random } from './random';

const DETOUR_ANGLES = [0.42, -0.42, 0.78, -0.78, 1.15, -1.15, 1.55, -1.55, 2.15, -2.15] as const;
const DETOUR_RADII = [3.2, 5.5, 8.2] as const;
const NAV_GRID = 11;
const NAV_MID = (NAV_GRID - 1) >> 1;
const NAV_CELL = 1.75;
const NAV_NODES = NAV_GRID * NAV_GRID;
const NAV_DX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const NAV_DZ = [-1, -1, -1, 0, 0, 1, 1, 1] as const;
const SWIM_DIRS = Array.from({ length: 32 }, (_, i) => {
  const a = i / 32 * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)] as const;
});
const SWIM_RADII = [3, 5, 8, 12, 18, 26, 38, 52] as const;

type SwimBankWorld = Pick<World, 'getHeight' | 'pointFree'>;
type EscapeWorld = Pick<World, 'navPointFree'>;

// 长途目标反复被同一组建筑阻断时, 先选择一段逐点可达的局部逃生线, 再重新规划全程路径.
export function findLocalEscape(
  out: THREE.Vector2,
  x: number,
  z: number,
  feetY: number,
  goalX: number,
  goalZ: number,
  world: EscapeWorld,
  allowDrop = false,
): boolean {
  const baseAngle = Math.atan2(goalX - x, goalZ - z);
  const startRemain = Math.hypot(goalX - x, goalZ - z);
  const offsets = [0, 0.52, -0.52, 1.05, -1.05, 1.57, -1.57, Math.PI] as const;
  let bestScore = -Infinity;
  let bestX = x;
  let bestZ = z;
  for (const radius of [1.4, 2.2, 3.2, 5.2, 7.2] as const) {
    for (const offset of offsets) {
      const angle = baseAngle + offset;
      let clear = true;
      for (let distance = 0.45; distance <= radius + 0.01; distance += 0.45) {
        const probeDistance = Math.min(radius, distance);
        const probeX = x + Math.sin(angle) * probeDistance;
        const probeZ = z + Math.cos(angle) * probeDistance;
        if (world.navPointFree(probeX, probeZ, feetY, 0.5, false, false, allowDrop)) continue;
        clear = false;
        break;
      }
      if (!clear) continue;
      const candidateX = x + Math.sin(angle) * radius;
      const candidateZ = z + Math.cos(angle) * radius;
      const progress = startRemain - Math.hypot(goalX - candidateX, goalZ - candidateZ);
      const score = progress * 1.4 + radius * 0.08 - Math.abs(offset) * 0.12;
      if (score <= bestScore) continue;
      bestScore = score;
      bestX = candidateX;
      bestZ = candidateZ;
    }
  }
  if (bestScore === -Infinity) return false;
  out.set(bestX, bestZ);
  return true;
}

// 角色极少数情况下会落进门框/家具复合碰撞的狭小缝隙. 连续移动线不存在时,
// 只向最近的合法站立点做一次短距离脱困, 避免整局在同一位置重复规划.
export function findEmergencyNavPoint(
  out: THREE.Vector2,
  x: number,
  z: number,
  feetY: number,
  goalX: number,
  goalZ: number,
  world: EscapeWorld,
  allowDrop = false,
): boolean {
  const startRemain = Math.hypot(goalX - x, goalZ - z);
  for (const radius of [1.2, 1.8, 2.6, 3.6] as const) {
    let bestScore = -Infinity;
    let bestX = x;
    let bestZ = z;
    for (let i = 0; i < 24; i++) {
      const angle = i / 24 * Math.PI * 2;
      const candidateX = x + Math.sin(angle) * radius;
      const candidateZ = z + Math.cos(angle) * radius;
      if (!world.navPointFree(candidateX, candidateZ, feetY, 0.5, false, false, allowDrop)) continue;
      const progress = startRemain - Math.hypot(goalX - candidateX, goalZ - candidateZ);
      if (progress <= bestScore) continue;
      bestScore = progress;
      bestX = candidateX;
      bestZ = candidateZ;
    }
    if (bestScore === -Infinity) continue;
    out.set(bestX, bestZ);
    return true;
  }
  return false;
}

const BRIDGE_X = [-50, 170] as const;

// Route vehicle river crossings through a bridge approach or bridge exit.
export function findVehicleRiverWaypoint(
  out: THREE.Vector2,
  x: number,
  z: number,
  goalX: number,
  goalZ: number,
): boolean {
  const currentOffset = z - riverZAt(x);
  const goalOffset = goalZ - riverZAt(goalX);
  const currentSide = currentOffset >= 0 ? 1 : -1;
  const goalSide = goalOffset >= 0 ? 1 : -1;

  for (const bridgeX of BRIDGE_X) {
    const bridgeZ = riverZAt(bridgeX);
    if (Math.abs(x - bridgeX) <= 3.2 && Math.abs(z - bridgeZ) <= 20) {
      out.set(bridgeX, bridgeZ + goalSide * 19);
      return true;
    }
  }
  if (currentSide === goalSide) return false;

  let bestX: number = BRIDGE_X[0];
  let bestCost = Infinity;
  for (const bridgeX of BRIDGE_X) {
    const bridgeZ = riverZAt(bridgeX);
    const entryZ = bridgeZ + currentSide * 18;
    const exitZ = bridgeZ + goalSide * 18;
    const cost = Math.hypot(x - bridgeX, z - entryZ) + 36 + Math.hypot(goalX - bridgeX, goalZ - exitZ);
    if (cost >= bestCost) continue;
    bestCost = cost;
    bestX = bridgeX;
  }
  const bestZ = riverZAt(bestX);
  const entryZ = bestZ + currentSide * 18;
  if (Math.hypot(x - bestX, z - entryZ) <= 4.5) out.set(bestX, bestZ + goalSide * 19);
  else out.set(bestX, entryZ);
  return true;
}

// 桥面被侧护栏约束时先走到更接近目标的桥头, 离桥后再恢复原目标.
export function findBridgeExit(
  out: THREE.Vector2,
  x: number,
  z: number,
  goalX: number,
  goalZ: number,
): boolean {
  for (const bridgeX of BRIDGE_X) {
    const centerZ = riverZAt(bridgeX);
    if (Math.abs(x - bridgeX) > 2.35 || Math.abs(z - centerZ) > 14.4) continue;
    const northZ = centerZ + 17;
    const southZ = centerZ - 17;
    const northDistance = Math.hypot(goalX - bridgeX, goalZ - northZ);
    const southDistance = Math.hypot(goalX - bridgeX, goalZ - southZ);
    out.set(bridgeX, northDistance <= southDistance ? northZ : southZ);
    return true;
  }
  return false;
}

// 搜索最近可上岸点，优先保持原移动方向，并允许卡住后避开旧岸点。
export function findSwimBank(
  out: THREE.Vector2,
  x: number,
  z: number,
  preferX: number,
  preferZ: number,
  world: SwimBankWorld,
  avoidX?: number,
  avoidZ?: number,
): boolean {
  const pdx = preferX - x;
  const pdz = preferZ - z;
  const pl = Math.hypot(pdx, pdz);
  const pnx = pl > 0.001 ? pdx / pl : 0;
  const pnz = pl > 0.001 ? pdz / pl : 0;
  const adx = avoidX === undefined ? 0 : avoidX - x;
  const adz = avoidZ === undefined ? 0 : avoidZ - z;
  const al = Math.hypot(adx, adz);
  const anx = al > 0.001 ? adx / al : 0;
  const anz = al > 0.001 ? adz / al : 0;
  let fallbackX = x;
  let fallbackZ = z;
  let fallbackScore = -Infinity;
  let forwardBankX = x;
  let forwardBankZ = z;
  let forwardBankScore = -Infinity;
  let anyBankX = x;
  let anyBankZ = z;
  let anyBankScore = -Infinity;

  for (const radius of SWIM_RADII) {
    for (const [dx, dz] of SWIM_DIRS) {
      const tx = clamp(x + dx * radius, -WORLD_HALF + 2, WORLD_HALF - 2);
      const tz = clamp(z + dz * radius, -WORLD_HALF + 2, WORLD_HALF - 2);
      if (al > 0.001 && dx * anx + dz * anz > 0.96) continue;
      const height = world.getHeight(tx, tz);
      const alignment = dx * pnx + dz * pnz;
      const fallbackCandidate = height + alignment * 0.8 - radius * 0.005;
      if (fallbackCandidate > fallbackScore) {
        fallbackScore = fallbackCandidate;
        fallbackX = tx;
        fallbackZ = tz;
      }
      const bankMinH = WATER_Y - SWIM_EXIT_DEPTH + 0.08;
      if (height < bankMinH || height > WATER_Y + 3.6) continue;
      if (!world.pointFree(tx, tz, 0.55, bankMinH, WATER_Y + 3.6)) continue;
      const waterlinePenalty = Math.abs(height - WATER_Y) * 0.2;
      const anyScore = alignment * 0.1 - radius * 0.05 - waterlinePenalty;
      if (anyScore > anyBankScore) {
        anyBankScore = anyScore;
        anyBankX = tx;
        anyBankZ = tz;
      }
      if (alignment >= 0.2) {
        const forwardScore = alignment * 2 - radius * 0.015 - waterlinePenalty;
        if (forwardScore > forwardBankScore) {
          forwardBankScore = forwardScore;
          forwardBankX = tx;
          forwardBankZ = tz;
        }
      }
    }
  }
  if (forwardBankScore > -Infinity) {
    out.set(forwardBankX, forwardBankZ);
    return true;
  }
  if (anyBankScore > -Infinity) {
    out.set(anyBankX, anyBankZ);
    return true;
  }
  out.set(fallbackX, fallbackZ);
  return false;
}

// 游泳状态刚结束时继续向岸内找一个短距离安全点。控制器在到达前暂停索敌，
// 避免角色刚站起就因战斗/跟随目标在水中而立即折返，造成岸边姿态反复切换。
export function findShoreExitPoint(
  out: THREE.Vector2,
  x: number,
  z: number,
  bankX: number,
  bankZ: number,
  world: SwimBankWorld,
): boolean {
  let dx = bankX - x;
  let dz = bankZ - z;
  const length = Math.hypot(dx, dz);
  if (length < 0.05) return false;
  dx /= length;
  dz /= length;
  const sideX = -dz;
  const sideZ = dx;
  // 游泳状态允许在浅滩提前结束, 但后续离岸目标必须是真正高出水面的干地.
  // 否则角色会站在浅水阈值边缘, 被地形和邻居碰撞反复切回游泳状态.
  const bankMinH = WATER_Y + 0.02;
  for (const forward of [6.4, 5.2, 4, 3.2, 2.4, 1.6, 0.8, 0] as const) {
    for (const lateral of [0, 0.8, -0.8, 1.6, -1.6] as const) {
      const tx = clamp(bankX + dx * forward + sideX * lateral, -WORLD_HALF + 2, WORLD_HALF - 2);
      const tz = clamp(bankZ + dz * forward + sideZ * lateral, -WORLD_HALF + 2, WORLD_HALF - 2);
      const height = world.getHeight(tx, tz);
      if (height < bankMinH || height > WATER_Y + 3.6) continue;
      if (!world.pointFree(tx, tz, 0.55, bankMinH, WATER_Y + 3.6)) continue;
      out.set(tx, tz);
      return true;
    }
  }
  return false;
}

export interface NavOptions {
  stopDistance?: number;
  turnRate?: number;
  allowWater?: boolean;
  allowDrop?: boolean;
  neighbors?: readonly Character[];
}

export interface NavResult {
  reached: boolean;
  blocked: boolean;
  stuckFor: number;
  moved: number;
}

function segmentFree(
  world: World,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  feetY: number,
  allowWater: boolean,
  swimExit: boolean,
  allowDrop: boolean,
  maxProbe = 8,
): boolean {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) return true;
  const probeD = Math.min(d, maxProbe);
  const steps = Math.max(2, Math.ceil(probeD / 0.8));
  const nx = dx / d;
  const nz = dz / d;
  let sampleY = feetY;
  for (let i = 1; i <= steps; i++) {
    const s = probeD * (i / steps);
    const x = x0 + nx * s;
    const z = z0 + nz * s;
    if (!world.navPointFree(x, z, sampleY, 0.5, allowWater, swimExit, allowDrop)) return false;
    const h = world.groundHeight(x, z, sampleY + 0.16);
    if (allowDrop || h > sampleY - 1.45) sampleY = h;
  }
  return true;
}

export class AgentNavigator {
  private detour = new THREE.Vector2();
  private detourT = 0;
  private side = random() < 0.5 ? -1 : 1;
  private goalX = Infinity;
  private goalZ = Infinity;
  private progressT = 0;
  private lastX = 0;
  private lastZ = 0;
  private stuckT = 0;
  private recoveryT = 0;
  private gridCost = new Float32Array(NAV_NODES);
  private gridY = new Float32Array(NAV_NODES);
  private gridParent = new Int16Array(NAV_NODES);
  private gridClosed = new Uint8Array(NAV_NODES);
  private gridPath = new Int16Array(NAV_NODES);

  reset(c?: Character): void {
    this.detourT = 0;
    this.progressT = 0;
    this.stuckT = 0;
    this.recoveryT = 0;
    this.goalX = Infinity;
    this.goalZ = Infinity;
    if (c) {
      this.lastX = c.pos.x;
      this.lastZ = c.pos.z;
    }
  }

  move(
    c: Character,
    goalX: number,
    goalZ: number,
    speed: number,
    dt: number,
    world: World,
    options: NavOptions = {},
  ): NavResult {
    const stop = options.stopDistance ?? 1.15;
    const allowWater = options.allowWater ?? true;
    const allowDrop = options.allowDrop ?? false;
    const goalShift = Math.hypot(goalX - this.goalX, goalZ - this.goalZ);
    if (goalShift > 7) this.detourT = 0;
    this.goalX = goalX;
    this.goalZ = goalZ;

    const gx = goalX - c.pos.x;
    const gz = goalZ - c.pos.z;
    const goalDist = Math.hypot(gx, gz);
    if (goalDist <= stop) {
      moveChar(c, 0, 0, dt, world);
      this.stuckT = Math.max(0, this.stuckT - dt * 2);
      return { reached: true, blocked: false, stuckFor: this.stuckT, moved: 0 };
    }

    this.detourT = Math.max(0, this.detourT - dt);
    let tx = goalX;
    let tz = goalZ;
    const directClear = segmentFree(
      world, c.pos.x, c.pos.z, goalX, goalZ, c.pos.y, allowWater, c.swimming, allowDrop,
    );
    if (this.detourT > 0) {
      const dd = Math.hypot(this.detour.x - c.pos.x, this.detour.y - c.pos.z);
      if (dd > 0.8 && (!directClear || this.detourT > 0.22)) {
        tx = this.detour.x;
        tz = this.detour.y;
      } else {
        this.detourT = 0;
      }
    }
    if ((!directClear && this.detourT <= 0) || (this.stuckT > 0.65 && this.detourT <= 0.25)) {
      if (this.chooseDetour(c, goalX, goalZ, world, allowWater, allowDrop)) {
        tx = this.detour.x;
        tz = this.detour.y;
      }
    }

    let dx = tx - c.pos.x;
    let dz = tz - c.pos.z;
    let d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;

    // 角色间只做轻量侧向分离，避免两个机器人互相顶住又频繁换路。
    if (options.neighbors) {
      let ax = 0;
      let az = 0;
      for (const o of options.neighbors) {
        if (o === c || !o.alive || !o.group.visible || Math.abs(o.pos.y - c.pos.y) > 1.8) continue;
        const ox = c.pos.x - o.pos.x;
        const oz = c.pos.z - o.pos.z;
        const od = Math.hypot(ox, oz);
        if (od < 0.01 || od > 2.2) continue;
        const f = (2.2 - od) / 2.2;
        ax += (ox / od) * f;
        az += (oz / od) * f;
      }
      dx += ax * 0.7;
      dz += az * 0.7;
      d = Math.hypot(dx, dz) || 1;
      dx /= d;
      dz /= d;
    }

    if (this.recoveryT > 0) {
      this.recoveryT = Math.max(0, this.recoveryT - dt);
      const rx = dz * this.side - dx * 0.25;
      const rz = -dx * this.side - dz * 0.25;
      const rl = Math.hypot(rx, rz) || 1;
      dx = rx / rl;
      dz = rz / rl;
    }

    c.yaw = turnToward(c.yaw, Math.atan2(dx, dz), (options.turnRate ?? 4.5) * dt);
    const oldX = c.pos.x;
    const oldZ = c.pos.z;
    moveChar(c, dx * speed, dz * speed, dt, world, speed);
    const moved = Math.hypot(c.pos.x - oldX, c.pos.z - oldZ);

    this.progressT += dt;
    if (this.progressT >= 0.55) {
      const progress = Math.hypot(c.pos.x - this.lastX, c.pos.z - this.lastZ);
      const expected = speed * this.progressT;
      if (goalDist > stop + 0.8 && progress < Math.max(0.16, expected * 0.1)) {
        this.stuckT += this.progressT;
      } else {
        this.stuckT = Math.max(0, this.stuckT - this.progressT * 1.5);
      }
      this.lastX = c.pos.x;
      this.lastZ = c.pos.z;
      this.progressT = 0;
      if (this.stuckT > 1.5 && this.recoveryT <= 0) {
        this.side *= -1;
        this.recoveryT = 0.5;
        this.detourT = 0;
        this.stuckT = 0.9;
      }
    }

    return { reached: false, blocked: !directClear, stuckFor: this.stuckT, moved };
  }

  private chooseDetour(
    c: Character,
    goalX: number,
    goalZ: number,
    world: World,
    allowWater: boolean,
    allowDrop: boolean,
  ): boolean {
    if (this.chooseGridDetour(
      c,
      goalX,
      goalZ,
      world,
      allowWater,
      allowDrop,
      this.stuckT > 0.65,
    )) return true;
    const goalYaw = Math.atan2(goalX - c.pos.x, goalZ - c.pos.z);
    const currentGoalD = Math.hypot(goalX - c.pos.x, goalZ - c.pos.z);
    let bestScore = -Infinity;
    let bestX = 0;
    let bestZ = 0;
    for (const radius of DETOUR_RADII) {
      for (let i = 0; i < DETOUR_ANGLES.length; i++) {
        const signed = (DETOUR_ANGLES[i] as number) * this.side;
        const a = goalYaw + signed;
        const x = c.pos.x + Math.sin(a) * radius;
        const z = c.pos.z + Math.cos(a) * radius;
        if (!world.navPointFree(x, z, c.pos.y, 0.52, allowWater, c.swimming, allowDrop)) continue;
        if (!segmentFree(
          world, c.pos.x, c.pos.z, x, z, c.pos.y, allowWater, c.swimming, allowDrop, radius,
        )) continue;
        const remain = Math.hypot(goalX - x, goalZ - z);
        const progress = currentGoalD - remain;
        const turnPenalty = Math.abs(signed) * 0.6;
        const depth = world.getHeight(x, z) < 0.35 ? 1.2 : 0;
        const score = progress * 1.8 - turnPenalty - radius * 0.04 - depth;
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
          bestZ = z;
        }
      }
    }
    if (bestScore === -Infinity) return false;
    this.detour.set(bestX, bestZ);
    this.detourT = clamp(0.7 + Math.hypot(bestX - c.pos.x, bestZ - c.pos.z) * 0.13, 0.8, 1.8);
    return true;
  }

  private chooseGridDetour(
    c: Character,
    goalX: number,
    goalZ: number,
    world: World,
    allowWater: boolean,
    allowDrop: boolean,
    forceEscape: boolean,
  ): boolean {
    const cell = allowDrop ? 2.35 : NAV_CELL;
    const costs = this.gridCost;
    const ys = this.gridY;
    const parents = this.gridParent;
    const closed = this.gridClosed;
    costs.fill(Infinity);
    ys.fill(c.pos.y);
    parents.fill(-1);
    closed.fill(0);
    const start = NAV_MID * NAV_GRID + NAV_MID;
    costs[start] = 0;
    let best = -1;
    let bestScore = -Infinity;
    let escapeBest = -1;
    let escapeScore = -Infinity;
    const startRemain = Math.hypot(goalX - c.pos.x, goalZ - c.pos.z);

    for (let expanded = 0; expanded < NAV_NODES; expanded++) {
      let node = -1;
      let nodeCost = Infinity;
      for (let i = 0; i < NAV_NODES; i++) {
        if (!closed[i] && costs[i] < nodeCost) {
          node = i;
          nodeCost = costs[i];
        }
      }
      if (node < 0) break;
      closed[node] = 1;
      const ix = node % NAV_GRID;
      const iz = Math.floor(node / NAV_GRID);
      const x = c.pos.x + (ix - NAV_MID) * cell;
      const z = c.pos.z + (iz - NAV_MID) * cell;
      if (node !== start) {
        const remain = Math.hypot(goalX - x, goalZ - z);
        const displacement = Math.hypot(x - c.pos.x, z - c.pos.z);
        const progress = startRemain - remain;
        const gl = remain || 1;
        const lookNx = (goalX - x) / gl;
        const lookNz = (goalZ - z) / gl;
        let clearSteps = 0;
        for (let s = 0.8; s <= 4.21; s += 0.85) {
          if (!world.navPointFree(
            x + lookNx * s,
            z + lookNz * s,
            ys[node] as number,
            0.5,
            allowWater,
            c.swimming,
            allowDrop,
          )) break;
          clearSteps++;
        }
        const clear1 = clearSteps >= 3;
        const clear2 = clearSteps >= 5;
        const escapeBonus = clear2 ? 9 : clear1 ? 2.5 : 0;
        const score = progress * 1.4 - nodeCost * 0.3 + escapeBonus;
        if (score > bestScore) {
          bestScore = score;
          best = node;
        }
        const fallbackScore = displacement - nodeCost * 0.12 - remain * 0.015;
        if (fallbackScore > escapeScore) {
          escapeScore = fallbackScore;
          escapeBest = node;
        }
      }

      for (let n = 0; n < NAV_DX.length; n++) {
        const nx = ix + (NAV_DX[n] as number);
        const nz = iz + (NAV_DZ[n] as number);
        if (nx < 0 || nx >= NAV_GRID || nz < 0 || nz >= NAV_GRID) continue;
        const ni = nz * NAV_GRID + nx;
        if (closed[ni]) continue;
        const px = c.pos.x + (nx - NAV_MID) * cell;
        const pz = c.pos.z + (nz - NAV_MID) * cell;
        const nodeY = ys[node] as number;
        if (!world.navPointFree(px, pz, nodeY, 0.5, allowWater, c.swimming, allowDrop)) continue;
        // 对角移动要求两个相邻正交格也可走，禁止从墙角或家具角穿过去。
        const ddx = NAV_DX[n] as number;
        const ddz = NAV_DZ[n] as number;
        if (ddx !== 0 && ddz !== 0) {
          const sx = c.pos.x + (ix + ddx - NAV_MID) * cell;
          const sz = c.pos.z + (iz - NAV_MID) * cell;
          const tx = c.pos.x + (ix - NAV_MID) * cell;
          const tz = c.pos.z + (iz + ddz - NAV_MID) * cell;
          if (!world.navPointFree(sx, sz, nodeY, 0.5, allowWater, c.swimming, allowDrop) ||
            !world.navPointFree(tx, tz, nodeY, 0.5, allowWater, c.swimming, allowDrop)) continue;
        }
        const step = ddx !== 0 && ddz !== 0 ? 1.414 : 1;
        const nextCost = nodeCost + step;
        if (nextCost >= costs[ni]) continue;
        costs[ni] = nextCost;
        parents[ni] = node;
        const h = world.groundHeight(px, pz, nodeY + 0.16);
        ys[ni] = h < WATER_Y - 0.55 && allowWater ? nodeY : h;
      }
    }

    if (best < 0 || bestScore < 0.2) {
      if (!forceEscape || escapeBest < 0 || escapeScore < 1.2) return false;
      best = escapeBest;
    }
    let count = 0;
    let node = best;
    while (node >= 0 && node !== start && count < NAV_NODES) {
      this.gridPath[count++] = node;
      node = parents[node] as number;
    }
    if (node !== start || count <= 0) return false;
    // 取离起点约 3 格的路径点，既能平滑绕角，也不会每帧追逐遥远的过期点。
    const pick = this.gridPath[Math.max(0, count - Math.min(3, count))] as number;
    const px = pick % NAV_GRID;
    const pz = Math.floor(pick / NAV_GRID);
    this.detour.set(
      c.pos.x + (px - NAV_MID) * cell,
      c.pos.z + (pz - NAV_MID) * cell,
    );
    this.detourT = 1.15;
    return true;
  }
}

const coverEye = new THREE.Vector3();
const coverTarget = new THREE.Vector3();
const coverDir = new THREE.Vector3();

// 从角色附近找一个真正遮断目标视线的可站立点，供换弹、低血量和救援战术使用。
export function findCoverPoint(
  out: THREE.Vector2,
  c: Character,
  target: Character,
  world: World,
  maxRadius = 15,
): boolean {
  target.chestPos(coverTarget);
  let bestScore = -Infinity;
  let bestX = 0;
  let bestZ = 0;
  for (let ring = 1; ring <= 3; ring++) {
    const r = maxRadius * (ring / 3);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const x = c.pos.x + Math.sin(a) * r;
      const z = c.pos.z + Math.cos(a) * r;
      if (!world.navPointFree(x, z, c.pos.y, 0.52, false)) continue;
      const y = world.groundHeight(x, z, c.pos.y + 0.16);
      coverEye.set(x, y + 1.25, z);
      if (!world.isLOSBlocked(coverEye, coverTarget, coverDir)) continue;
      const travel = Math.hypot(x - c.pos.x, z - c.pos.z);
      const threatD = Math.hypot(x - target.pos.x, z - target.pos.z);
      const score = threatD * 0.08 - travel * 0.22;
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestZ = z;
      }
    }
  }
  if (bestScore === -Infinity) return false;
  out.set(bestX, bestZ);
  return true;
}

// 小队 AI 开火前检查友军是否站在枪线内，避免近距离互相扫射。
export function allyBlocksShot(
  shooter: Character,
  target: Character,
  chars: readonly Character[],
): boolean {
  const dx = target.pos.x - shooter.pos.x;
  const dz = target.pos.z - shooter.pos.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 0.01) return false;
  for (const c of chars) {
    if (c === shooter || c === target || !c.alive || c.team !== shooter.team) continue;
    if (Math.abs(c.pos.y - shooter.pos.y) > 2) continue;
    const t = clamp(((c.pos.x - shooter.pos.x) * dx + (c.pos.z - shooter.pos.z) * dz) / len2, 0, 1);
    if (t <= 0.03 || t >= 0.97) continue;
    const px = shooter.pos.x + dx * t;
    const pz = shooter.pos.z + dz * t;
    if (Math.hypot(c.pos.x - px, c.pos.z - pz) < c.radius + 0.32) return true;
  }
  return false;
}
