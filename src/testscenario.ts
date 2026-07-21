import * as THREE from 'three';
import { emptyAttachments } from './attachments';
import { ARMORS } from './armor';
import { findSwimBank } from './botnav';
import type { Game } from './game';
import { VEHICLE_SPEC } from './vehicles';
import { MELEE, WEAPONS } from './weapons';
import { riverZAt, WATER_Y } from './world';

export const SCENARIO_IDS = [
  'stairs', 'swim', 'combat', 'parachute', 'vehicle', 'deathcrate', 'bombardment', 'revive',
] as const;
export type ScenarioId = typeof SCENARIO_IDS[number];

const SCENARIO_TEXT: Record<ScenarioId, string> = {
  stairs: '楼梯回归: 检查楼层接缝, 楼梯净空和上下楼碰撞',
  swim: '游泳回归: 检查入水姿态, Shift 加速和连续上岸',
  combat: '枪战回归: M416 + 全套配件, 检查 ADS, 后坐和命中反馈',
  parachute: '空降回归: 玩家和队友同高度自由落体, 检查速度和开伞时机',
  vehicle: '载具回归: F 上车, WASD 驾驶, 低速 F 下车并检查碰撞和仪表',
  deathcrate: '死亡盒回归: F 搜索盒子, 自动装备武器护具并遵守负重上限',
  bombardment: '轰炸区回归: 检查预警边界和小地图, 使用 phase=active 检查落弹',
  revive: '救援回归: F 救援倒地队友, 检查 8 秒读条和站立恢复',
};

export function parseScenarioId(value: string | null): ScenarioId {
  return SCENARIO_IDS.includes(value as ScenarioId) ? value as ScenarioId : 'combat';
}

function scenarioFromUrl(): ScenarioId | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('test') !== '1') return null;
  return parseScenarioId(params.get('scenario'));
}

function showScenarioPanel(id: ScenarioId, game: Game): void {
  const panel = document.createElement('aside');
  panel.id = 'test-scenario-panel';
  panel.dataset.scenario = id;
  panel.dataset.tacticalCoverCount = String(game.world.tacticalCoverCount);
  const player = game.playerCtl?.char;
  if (player) {
    const stats = game.world.collisionIndexStatsAt(player.pos.x, player.pos.z);
    panel.dataset.localCollisionCandidates = String(stats.localCylinders + stats.localBoxes);
    panel.dataset.totalCollisionObjects = String(stats.totalCylinders + stats.totalBoxes);
  }
  panel.innerHTML = `<strong>TEST / ${id.toUpperCase()}</strong><span>${SCENARIO_TEXT[id]}</span>`;
  document.body.appendChild(panel);
}

function parkEnemies(game: Game): void {
  for (const bot of game.bots) {
    bot.jumpS = Number.POSITIVE_INFINITY;
    bot.descent = null;
    bot.trainingIdle = true;
    bot.char.group.visible = false;
    bot.char.airPose = 'sit';
  }
}

function parkSquad(game: Game): void {
  for (const mate of game.squadMates) {
    mate.descent = null;
    mate.char.alive = false;
    mate.char.group.visible = false;
  }
}

function setGroundPlayer(game: Game, x: number, z: number): void {
  const player = game.playerCtl;
  if (!player) return;
  const c = player.char;
  player.descent = null;
  player.vy = 0;
  c.airPose = null;
  c.alive = true;
  c.hp = 100;
  c.knocked = false;
  c.setStance('stand');
  c.stanceF = 0;
  c.group.visible = true;
  c.removeCanopy();
  c.pos.set(x, game.world.groundHeight(x, z, game.world.getHeight(x, z) + 2.5), z);
  c.groundH = c.pos.y;
  c.grounded = true;
  c.swimming = false;
}

const TEST_LANES = [
  [-142, 126, -122, 126],
  [82, 116, 102, 116],
  [74, -112, 94, -112],
] as const;

function testLane(game: Game): readonly [number, number, number, number] {
  return TEST_LANES.find(([x0, z0, x1, z1]) => {
    for (let i = 0; i <= 10; i++) {
      const f = i / 10;
      const x = x0 + (x1 - x0) * f;
      const z = z0 + (z1 - z0) * f;
      if (!game.world.pointFree(x, z, 0.65, WATER_Y + 0.2, 16)) return false;
    }
    return true;
  }) ?? TEST_LANES[0];
}

function laneDirection(lane: readonly [number, number, number, number]): { x: number; z: number; yaw: number } {
  const dx = lane[2] - lane[0];
  const dz = lane[3] - lane[1];
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len, yaw: Math.atan2(dx, dz) };
}

function setupStairs(game: Game): void {
  const plot = game.world.buildings.plots.find((candidate) => candidate.arch === 'cottage2');
  if (!plot) {
    setGroundPlayer(game, -60, -20);
    return;
  }
  const x = plot.minX + 2 + 0.14 + 0.9;
  const z = plot.minZ + 2 + 1.6;
  setGroundPlayer(game, x, z);
  const player = game.playerCtl;
  if (player) {
    const floorY = game.world.groundHeight(x, z, plot.flatH + 0.45);
    player.char.pos.y = floorY;
    player.char.groundH = floorY;
    player.yaw = -Math.PI / 2;
    player.pitch = 0.04;
  }
}

function setupSwim(game: Game): void {
  const x = 0;
  const z = riverZAt(x);
  const player = game.playerCtl;
  if (!player) return;
  player.descent = null;
  player.vy = 0;
  const bank = new THREE.Vector2();
  const foundBank = findSwimBank(bank, x, z, x, z + 80, game.world);
  let swimX = x;
  let swimZ = z;
  if (foundBank) {
    const dx = bank.x - x;
    const dz = bank.y - z;
    const len = Math.hypot(dx, dz) || 1;
    // 从岸点向河心回退到深水, 保证场景开始时确实处于游泳状态且能连续上岸.
    for (let d = 3; d <= Math.min(12, len); d += 0.5) {
      const sx = bank.x - dx / len * d;
      const sz = bank.y - dz / len * d;
      if (WATER_Y - game.world.getHeight(sx, sz) > 1.35) {
        swimX = sx;
        swimZ = sz;
        break;
      }
    }
    player.yaw = Math.atan2(bank.x - swimX, bank.y - swimZ);
  } else {
    player.yaw = Math.PI;
  }
  player.pitch = 0.06;
  const c = player.char;
  c.airPose = null;
  c.group.visible = true;
  c.pos.set(swimX, WATER_Y - 0.78, swimZ);
  c.groundH = WATER_Y - 0.03;
  c.grounded = false;
  c.swimming = true;
}

function setupCombat(game: Game): void {
  const sightParam = new URLSearchParams(window.location.search).get('sight');
  const sight = sightParam === 'reddot' || sightParam === 'scope4' ? sightParam : 'scope2';
  const lane = testLane(game);
  const [playerX, playerZ, targetX, targetZ] = lane;
  setGroundPlayer(game, playerX, playerZ);
  const player = game.playerCtl;
  if (!player) return;
  const c = player.char;
  c.guns[0] = {
    def: WEAPONS.rifle,
    mag: 40,
    att: { ...emptyAttachments(), sight, mag: 'extmag', muzzle: 'comp' },
  };
  c.ammo.rifle = 180;
  c.curSlot = 0;
  player.yaw = Math.atan2(targetX - playerX, targetZ - playerZ);
  player.pitch = 0.02;

  const target = game.bots[0];
  if (!target) return;
  target.jumpS = -1;
  target.descent = null;
  target.trainingIdle = true;
  target.char.airPose = null;
  target.char.group.visible = true;
  target.char.pos.set(targetX, game.world.groundHeight(targetX, targetZ, 30), targetZ);
  target.char.groundH = target.char.pos.y;
  target.char.grounded = true;
}

function setupVehicle(game: Game): void {
  const lane = testLane(game);
  const dir = laneDirection(lane);
  setGroundPlayer(game, lane[0], lane[1]);
  const player = game.playerCtl;
  const vehicle = game.vehicles.list[0];
  if (!player || !vehicle) return;
  const x = lane[0] + dir.x * 2.2;
  const z = lane[1] + dir.z * 2.2;
  vehicle.pos.set(x, game.world.groundHeight(x, z, 30), z);
  vehicle.yaw = dir.yaw;
  vehicle.speed = 0;
  vehicle.hp = VEHICLE_SPEC[vehicle.kind].hp;
  vehicle.driver = null;
  vehicle.passengers.fill(null);
  vehicle.dead = false;
  vehicle.exploded = false;
  vehicle.burnT = -1;
  vehicle.group.visible = true;
  vehicle.sync();
  player.yaw = dir.yaw;
  player.pitch = 0.02;
}

function setupDeathCrate(game: Game): void {
  const lane = testLane(game);
  const dir = laneDirection(lane);
  setGroundPlayer(game, lane[0], lane[1]);
  const player = game.playerCtl;
  const donor = game.bots[0]?.char;
  if (!player || !donor) return;
  const x = lane[0] + dir.x * 1.6;
  const z = lane[1] + dir.z * 1.6;
  donor.pos.set(x, game.world.groundHeight(x, z, 30), z);
  donor.guns[0] = {
    def: WEAPONS.akm,
    mag: 40,
    att: { ...emptyAttachments(), sight: 'scope4', mag: 'extmag', muzzle: 'comp' },
  };
  donor.melee = { def: MELEE.pan };
  donor.ammo.rifle = 90;
  donor.heals.bandage = 5;
  donor.heals.medkit = 1;
  donor.heals.drink = 2;
  donor.throwables.frag = 1;
  donor.throwables.smoke = 1;
  donor.pack = { level: 3 };
  donor.helmet = { level: 3, durability: ARMORS.helmet[3].maxDurability };
  donor.vest = { level: 3, durability: ARMORS.vest[3].maxDurability };
  game.deathCrates.spawn(donor, donor.pos.y);
  donor.alive = false;
  donor.group.visible = false;
  player.yaw = dir.yaw;
  player.pitch = 0.08;
}

function setupBombardment(game: Game): void {
  const lane = testLane(game);
  const dir = laneDirection(lane);
  setGroundPlayer(game, lane[0], lane[1]);
  const player = game.playerCtl;
  if (!player) return;
  player.yaw = dir.yaw;
  player.pitch = 0.08;
  game.zoneArmed = true;
  const phase = new URLSearchParams(window.location.search).get('phase') === 'active' ? 'active' : 'warning';
  game.bombardment.setTestArea(game, lane[2], lane[3], phase);
}

function setupRevive(game: Game): void {
  const lane = testLane(game);
  const dir = laneDirection(lane);
  setGroundPlayer(game, lane[0], lane[1]);
  const player = game.playerCtl;
  const mate = game.squadMates[0];
  if (!player || !mate) return;
  const x = lane[0] + dir.x * 1.55;
  const z = lane[1] + dir.z * 1.55;
  mate.descent = null;
  mate.char.alive = true;
  mate.char.airPose = null;
  mate.char.pos.set(x, game.world.groundHeight(x, z, 30), z);
  mate.char.groundH = mate.char.pos.y;
  mate.char.grounded = true;
  mate.char.group.visible = true;
  game.knock.knockDown(mate.char, null, false);
  player.yaw = dir.yaw;
  player.pitch = 0.08;
}

function setupParachute(game: Game): void {
  parkEnemies(game);
  const player = game.playerCtl;
  if (!player) return;
  const x = -40;
  const z = 170;
  const y = game.world.getHeight(x, z) + 190;
  player.descent = 'freefall';
  player.vy = -2;
  player.char.pos.set(x, y, z);
  player.char.airPose = 'fall';
  player.char.group.visible = true;
  player.yaw = 0;
  for (let i = 0; i < game.squadMates.length; i++) {
    const mate = game.squadMates[i];
    if (!mate) continue;
    mate.char.alive = true;
    mate.descent = 'freefall';
    mate.vy = -2;
    mate.char.pos.set(x + (i - 1) * 3, y, z + 4);
    mate.char.airPose = 'fall';
    mate.char.group.visible = true;
  }
}

export function applyTestScenarioFromUrl(game: Game): void {
  const id = scenarioFromUrl();
  if (!id) return;
  game.startMatch();
  parkEnemies(game);
  if (id !== 'parachute') parkSquad(game);
  if (id === 'stairs') setupStairs(game);
  else if (id === 'swim') setupSwim(game);
  else if (id === 'combat') setupCombat(game);
  else if (id === 'parachute') setupParachute(game);
  else if (id === 'vehicle') setupVehicle(game);
  else if (id === 'deathcrate') setupDeathCrate(game);
  else if (id === 'bombardment') setupBombardment(game);
  else setupRevive(game);
  if (id === 'combat' && new URLSearchParams(window.location.search).get('ads') === '1') game.input.rmb = true;
  showScenarioPanel(id, game);
}
