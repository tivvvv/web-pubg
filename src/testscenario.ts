import * as THREE from 'three';
import { canAttach, emptyAttachments, magSizeOf } from './attachments';
import { ARMORS } from './armor';
import { findSwimBank } from './botnav';
import { LOOT_CAP } from './loot';
import type { Game } from './game';
import { VEHICLE_SPEC } from './vehicles';
import { MELEE, WEAPONS } from './weapons';
import { riverZAt, WATER_Y } from './world';
import { parseRandomSeed, setRandomSeed } from './random';
import { REGIONS, regionOrWilderness } from './regions';
import type { AttachmentId, GunState } from './types';
import {
  MatchStabilityMonitor, parseBoundedTestInteger, validateRoundReset,
  type StabilityActorSample, type StabilityResourceSnapshot,
} from './stability';

export const SCENARIO_IDS = [
  'stairs', 'swim', 'combat', 'bottactics', 'botvehicle', 'squadcommand', 'stability', 'parachute', 'vehicle', 'deathcrate', 'bombardment', 'revive', 'zone', 'endgame', 'defeat', 'maptour',
] as const;
export type ScenarioId = typeof SCENARIO_IDS[number];

const SCENARIO_TEXT: Record<ScenarioId, string> = {
  stairs: '楼梯回归: 检查楼层接缝, 楼梯净空和上下楼碰撞',
  swim: '游泳回归: 检查入水姿态, Shift 加速和连续上岸',
  combat: '枪战回归: M416 + 全套配件, 检查 ADS, 后坐和命中反馈',
  bottactics: '机器人战术: 同时检查交战, 恢复, 搜索和圈外转移',
  botvehicle: '机器人载具: 检查搜车, 上车, 长途转移, 绕障和到点下车',
  squadcommand: '小队指令: 检查前往, 警戒, 集火, 跟随和三人队形',
  stability: '长局稳定性: 固定种子加速整局, 检查卡住, 非法状态和重开泄漏',
  parachute: '空降回归: 玩家和队友同高度自由落体, 检查速度和开伞时机',
  vehicle: '载具回归: F 上车, WASD 驾驶, 低速 F 下车并检查碰撞和仪表',
  deathcrate: '死亡盒回归: F 搜索盒子, 自动装备武器护具并遵守负重上限',
  bombardment: '轰炸区回归: 检查预警边界和小地图, 使用 phase=active 检查落弹',
  revive: '救援回归: F 救援倒地队友, 检查 8 秒读条和站立恢复',
  zone: '毒圈回归: 圈外持续受伤, 进入圈内后立即停止伤害',
  endgame: '结算回归: 淘汰最后一名敌人后进入胜利界面',
  defeat: '失败回归: 玩家被淘汰后进入失败界面并可重新开始',
  maptour: '地图巡查: 使用 region=区域 id 依次检查六区主地标, 补给点和转移路线',
};

export function parseScenarioId(value: string | null): ScenarioId {
  return SCENARIO_IDS.includes(value as ScenarioId) ? value as ScenarioId : 'combat';
}

export function parseCombatMagazine(value: string | null, capacity: number): number {
  if (value === null) return capacity;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return capacity;
  return Math.min(capacity, Math.floor(parsed));
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
  panel.dataset.mapSiteCount = String(game.world.mapSites.length);
  panel.dataset.mapLootSpotCount = String(game.world.mapLootSpots.length);
  const regionIds = [...REGIONS.map((region) => region.id), 'wilderness'];
  const countByRegion = (points: readonly { x: number; z: number }[]): string => JSON.stringify(
    Object.fromEntries(regionIds.map((id) => [
      id,
      points.filter((point) => regionOrWilderness(point.x, point.z).id === id).length,
    ])),
  );
  panel.dataset.regionLootCounts = countByRegion(
    game.loot.items.filter((item) => item.active).map((item) => ({
      x: item.group.position.x,
      z: item.group.position.z,
    })),
  );
  panel.dataset.regionDropCounts = countByRegion(
    game.bots.map((bot) => ({ x: bot.dropTarget.x, z: bot.dropTarget.z })),
  );
  panel.dataset.botDropTargets = JSON.stringify(
    game.bots.map((bot) => ({ x: Number(bot.dropTarget.x.toFixed(1)), z: Number(bot.dropTarget.z.toFixed(1)) })),
  );
  panel.dataset.regionVehicleCounts = countByRegion(
    game.vehicles.list.map((vehicle) => ({ x: vehicle.pos.x, z: vehicle.pos.z })),
  );
  if (id === 'maptour') {
    const requested = new URLSearchParams(window.location.search).get('region');
    const site = game.world.mapSites.find((candidate) => candidate.region === requested) ?? game.world.mapSites[0];
    if (site) {
      panel.dataset.mapSiteId = site.id;
      panel.dataset.mapSiteX = site.resolvedX.toFixed(1);
      panel.dataset.mapSiteZ = site.resolvedZ.toFixed(1);
    }
  }
  const player = game.playerCtl?.char;
  if (player) {
    const stats = game.world.collisionIndexStatsAt(player.pos.x, player.pos.z);
    panel.dataset.localCollisionCandidates = String(stats.localCylinders + stats.localBoxes);
    panel.dataset.totalCollisionObjects = String(stats.totalCylinders + stats.totalBoxes);
  }
  panel.innerHTML = `<strong>TEST / ${id.toUpperCase()}</strong><span>${SCENARIO_TEXT[id]}</span>`;
  document.body.appendChild(panel);
  const publishCharacter = (): void => {
    if (!panel.isConnected) return;
    const controller = game.playerCtl;
    const character = controller?.char;
    if (controller && character) {
      panel.dataset.characterAction = character.reviveTarget ? 'revive' : character.actionPose ?? 'none';
      panel.dataset.characterReload = character.reload01.toFixed(3);
      panel.dataset.characterHeld = character.parts.held ? 'true' : 'false';
      panel.dataset.characterSwimming = String(character.swimming);
      panel.dataset.characterSpeed = character.speed2d.toFixed(2);
      panel.dataset.characterAirPose = character.airPose ?? 'none';
      panel.dataset.characterKnocked = String(character.knocked);
      panel.dataset.characterDriving = String(controller.driving !== null);
      panel.dataset.cameraBlend = controller.cameraBlend.toFixed(3);
      panel.dataset.cameraDistance = controller.cameraDistance.toFixed(3);
      panel.dataset.cameraFov = controller.camera.fov.toFixed(2);
      panel.dataset.interactionKind = controller.interactionTargetKind ?? 'none';
      panel.dataset.cameraPosition = [
        controller.camera.position.x,
        controller.camera.position.y,
        controller.camera.position.z,
      ].map((value) => value.toFixed(2)).join(',');
    }
    window.requestAnimationFrame(publishCharacter);
  };
  window.requestAnimationFrame(publishCharacter);
  if (id === 'combat') {
    const publishCombat = (): void => {
      if (!panel.isConnected) return;
      const controller = game.playerCtl;
      const character = controller?.char;
      const gun = character?.heldGun();
      const target = game.bots[0]?.char;
      if (controller && character && gun) {
        panel.dataset.combatWeapon = gun.def.id;
        panel.dataset.combatMagazine = String(gun.mag);
        panel.dataset.combatReserve = String(character.ammo[gun.def.ammo]);
        panel.dataset.combatMuzzle = gun.att.muzzle ?? 'none';
        panel.dataset.combatSight = gun.att.sight ?? 'none';
        panel.dataset.combatReloading = String(controller.reloading);
        panel.dataset.combatSpread = controller.spreadRad.toFixed(5);
        panel.dataset.combatShotRecent = String(game.nowSec - character.lastShotT < 0.5);
        panel.dataset.combatLoudShotRecent = String(game.nowSec - character.lastLoudShotT < 0.5);
      }
      if (target) {
        panel.dataset.combatTargetHp = Math.max(0, target.hp).toFixed(1);
        panel.dataset.combatTargetAlive = String(target.alive);
      }
      window.requestAnimationFrame(publishCombat);
    };
    window.requestAnimationFrame(publishCombat);
  }
  if (id === 'bottactics') {
    const stateHistory = game.bots.slice(0, 4).map(() => new Set<string>());
    const publishTactics = (): void => {
      if (!panel.isConnected) return;
      const bots = game.bots.slice(0, 4);
      for (let i = 0; i < bots.length; i++) {
        const bot = bots[i];
        if (bot) stateHistory[i]?.add(bot.tacticalState);
      }
      panel.dataset.botStates = bots.map((bot) => bot.tacticalState).join('|');
      panel.dataset.botStateHistory = stateHistory.map((states) => [...states].join(',')).join('|');
      panel.dataset.botHealth = bots.map((bot) => Math.round(bot.char.hp)).join('|');
      panel.dataset.botPositions = bots.map((bot) => `${bot.char.pos.x.toFixed(1)},${bot.char.pos.z.toFixed(1)}`).join('|');
      panel.dataset.botSpeeds = bots.map((bot) => bot.char.speed2d.toFixed(2)).join('|');
      panel.dataset.botSmoke = bots.map((bot) => bot.char.throwables.smoke).join('|');
      window.requestAnimationFrame(publishTactics);
    };
    window.requestAnimationFrame(publishTactics);
  }
  if (id === 'botvehicle') {
    const vehicleStateHistory = new Set<string>();
    const publishVehicleTactics = (): void => {
      if (!panel.isConnected) return;
      const bot = game.bots[0];
      const vehicle = game.vehicles.list[0];
      if (bot && vehicle) {
        vehicleStateHistory.add(bot.tacticalState);
        panel.dataset.botVehicleState = bot.tacticalState;
        panel.dataset.botVehicleStateHistory = [...vehicleStateHistory].join(',');
        panel.dataset.botVehicleDriver = vehicle.driver?.name ?? '';
        panel.dataset.botVehicleSpeed = vehicle.speed.toFixed(2);
        panel.dataset.botVehiclePosition = `${vehicle.pos.x.toFixed(1)},${vehicle.pos.z.toFixed(1)}`;
        panel.dataset.botVehicleHp = Math.round(vehicle.hp).toString();
        panel.dataset.botVehicleZoneDistance = Math.max(
          0,
          Math.hypot(vehicle.pos.x - game.zone.center.x, vehicle.pos.z - game.zone.center.y) - game.zone.radius,
        ).toFixed(1);
      }
      window.requestAnimationFrame(publishVehicleTactics);
    };
    window.requestAnimationFrame(publishVehicleTactics);
  }
  if (id === 'parachute') {
    const publishParachute = (): void => {
      if (!panel.isConnected) return;
      const controller = game.playerCtl;
      const character = controller?.char;
      if (controller && character) {
        panel.dataset.playerDescent = controller.descent ?? 'landed';
        panel.dataset.playerGrounded = String(character.grounded);
        panel.dataset.playerAirPose = character.airPose ?? 'none';
        panel.dataset.playerHeight = character.pos.y.toFixed(2);
        panel.dataset.playerLegL = [
          character.parts.legL.rotation.x,
          character.parts.legL.rotation.y,
          character.parts.legL.rotation.z,
        ].map((angle) => angle.toFixed(4)).join(',');
        panel.dataset.playerLegR = [
          character.parts.legR.rotation.x,
          character.parts.legR.rotation.y,
          character.parts.legR.rotation.z,
        ].map((angle) => angle.toFixed(4)).join(',');
      }
      window.requestAnimationFrame(publishParachute);
    };
    window.requestAnimationFrame(publishParachute);
  }
  if (id === 'squadcommand') {
    const orderHistory = new Set<string>();
    const stateHistory = game.squadMates.map(() => new Set<string>());
    const publishSquadCommand = (): void => {
      if (!panel.isConnected) return;
      const order = game.squadOrder;
      orderHistory.add(order.kind);
      for (let i = 0; i < game.squadMates.length; i++) {
        const mate = game.squadMates[i];
        if (mate) stateHistory[i]?.add(mate.commandState);
      }
      panel.dataset.squadOrder = order.kind;
      panel.dataset.squadOrderHistory = [...orderHistory].join(',');
      panel.dataset.squadStates = game.squadMates.map((mate) => mate.commandState).join('|');
      panel.dataset.squadStateHistory = stateHistory.map((states) => [...states].join(',')).join('|');
      panel.dataset.squadDistances = game.squadMates.map((mate) => mate.commandDistance.toFixed(2)).join('|');
      panel.dataset.squadPositions = game.squadMates
        .map((mate) => `${mate.char.pos.x.toFixed(1)},${mate.char.pos.z.toFixed(1)}`)
        .join('|');
      panel.dataset.squadTarget = `${order.x.toFixed(1)},${order.z.toFixed(1)}`;
      const focus = order.targetId > 0 ? game.chars.find((char) => char.id === order.targetId) : null;
      panel.dataset.squadFocusHp = focus ? Math.max(0, focus.hp).toFixed(1) : '';
      window.requestAnimationFrame(publishSquadCommand);
    };
    window.requestAnimationFrame(publishSquadCommand);
  }
  if (id === 'stability') beginStabilityMonitoring(panel, game);
}

function stabilityResources(game: Game): StabilityResourceSnapshot {
  return {
    characters: game.chars.length,
    bots: game.bots.length,
    lootItems: game.loot.items.filter((item) => item.active).length,
    lootPool: game.loot.items.length,
    vehicles: game.vehicles.list.length,
    sceneChildren: game.scene.children.length,
    activeDeathCrates: game.deathCrates.crates.filter((crate) => crate.active).length,
    deathCratePool: game.deathCrates.crates.length,
  };
}

function stabilityActors(game: Game): StabilityActorSample[] {
  return game.bots.map((bot) => {
    const c = bot.char;
    const active = bot.jumpS < 0 && bot.descent === null && c.group.visible && c.grounded && !c.swimming && !c.knocked;
    const combatProgress = game.nowSec - c.lastShotT <= 2;
    return {
      id: c.id,
      name: c.name,
      alive: c.alive,
      active,
      trackMovement: active && bot.hasNavigationIntent && !combatProgress,
      x: c.pos.x,
      y: c.pos.y,
      z: c.pos.z,
      hp: c.hp,
      mode: bot.tacticalState,
    };
  });
}

function setupStability(game: Game): void {
  parkSquad(game);
  const player = game.playerCtl;
  if (player) {
    player.descent = null;
    player.vy = 0;
    player.char.alive = false;
    player.char.hp = 0;
    player.char.airPose = null;
    player.char.group.visible = false;
    player.char.removeCanopy();
  }
  game.zoneArmed = true;
}

function beginStabilityMonitoring(panel: HTMLElement, game: Game): void {
  const search = window.location.search;
  const rounds = parseBoundedTestInteger(search, 'rounds', 2, 1, 3);
  const baseSeed = parseRandomSeed(search, 1337) ?? 1337;
  const deadline = parseBoundedTestInteger(search, 'deadline', 390, 240, 480);
  const baseline = stabilityResources(game);
  const accumulatedIssues = new Set<string>();
  const issueDiagnostics = new Map<string, string>();
  const roundResults: string[] = [];
  let round = 1;
  let monitor = new MatchStabilityMonitor(10, 0.8);

  const publish = (): void => {
    if (!panel.isConnected) return;
    const actors = stabilityActors(game);
    const summary = monitor.update(game.nowSec, actors);
    for (const issue of summary.issues) {
      const key = `round${round}:${issue}`;
      accumulatedIssues.add(key);
      if (!issueDiagnostics.has(key)) {
        issueDiagnostics.set(key, game.bots.map((bot) => {
          const c = bot.char;
          let freeMask = '';
          for (let direction = 0; direction < 16; direction++) {
            const angle = direction / 16 * Math.PI * 2;
            const x = c.pos.x + Math.cos(angle) * 1.75;
            const z = c.pos.z + Math.sin(angle) * 1.75;
            freeMask += game.world.navPointFree(x, z, c.pos.y, 0.5, false, false, true) ? '1' : '0';
          }
          const stats = game.world.collisionIndexStatsAt(c.pos.x, c.pos.z);
          return `${bot.navigationDiagnostic},${freeMask},${stats.localCylinders},${stats.localBoxes}`;
        }).join('|'));
      }
    }
    panel.dataset.stabilityStatus = 'running';
    panel.dataset.stabilitySeed = String(baseSeed + round - 1);
    panel.dataset.stabilityRound = `${round}/${rounds}`;
    panel.dataset.stabilityElapsed = game.nowSec.toFixed(1);
    panel.dataset.stabilityAlive = String(summary.alive);
    panel.dataset.stabilityZone = `${game.zone.phase}:${game.zone.state}`;
    panel.dataset.stabilityTransitions = String(summary.transitions);
    panel.dataset.stabilityMaxStuck = summary.maxStagnantSec.toFixed(2);
    panel.dataset.stabilityIssues = [...accumulatedIssues].join('|');
    panel.dataset.stabilityDiagnostics = [...issueDiagnostics].map(([issue, detail]) => `${issue}:${detail}`).join(';');
    panel.dataset.stabilitySteps = String(game.simulationSteps);
    panel.dataset.stabilityActors = actors
      .filter((actor) => actor.alive)
      .map((actor) => {
        const elevation = actor.y - game.world.getHeight(actor.x, actor.z);
        return `${actor.name},${actor.x.toFixed(1)},${actor.y.toFixed(1)},${actor.z.toFixed(1)},${actor.hp.toFixed(0)},${actor.mode},${actor.trackMovement ? 1 : 0},${elevation.toFixed(1)}`;
      })
      .join('|');

    const timedOut = game.nowSec >= deadline && summary.alive > 1;
    const completed = summary.alive <= 1 && game.nowSec >= 20;
    if (timedOut) accumulatedIssues.add(`round${round}:timeout:${summary.alive}`);
    if (timedOut || completed) {
      roundResults.push(`${round},${game.nowSec.toFixed(1)},${summary.alive},${summary.transitions}`);
      if (!timedOut && round < rounds) {
        round++;
        setRandomSeed((baseSeed + round - 1) >>> 0);
        game.startMatch();
        setupStability(game);
        for (const issue of validateRoundReset(baseline, stabilityResources(game), game.bots.length, LOOT_CAP)) {
          accumulatedIssues.add(`round${round}:${issue}`);
        }
        monitor = new MatchStabilityMonitor(10, 0.8);
        panel.dataset.stabilityRoundResults = roundResults.join(';');
        window.requestAnimationFrame(publish);
        return;
      }
      const finalResources = stabilityResources(game);
      panel.dataset.stabilityStatus = accumulatedIssues.size === 0 && !timedOut ? 'passed' : 'failed';
      panel.dataset.stabilityIssues = [...accumulatedIssues].join('|');
      panel.dataset.stabilityRoundResults = roundResults.join(';');
      panel.dataset.stabilityResources = [
        finalResources.characters,
        finalResources.bots,
        finalResources.lootItems,
        finalResources.lootPool,
        finalResources.vehicles,
        finalResources.sceneChildren,
        finalResources.activeDeathCrates,
        finalResources.deathCratePool,
      ].join(',');
      return;
    }
    window.requestAnimationFrame(publish);
  };
  window.requestAnimationFrame(publish);
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
  const params = new URLSearchParams(window.location.search);
  const requestedArch = params.get('arch');
  const arch = requestedArch === 'cottage1' || requestedArch === 'terrace' || requestedArch === 'apartment' ||
    requestedArch === 'barn' || requestedArch === 'shop' || requestedArch === 'gym'
    ? requestedArch
    : 'cottage2';
  const plot = game.world.buildings.plots.find((candidate) => candidate.arch === arch);
  if (!plot) {
    setGroundPlayer(game, -60, -20);
    return;
  }
  if (params.get('view') === 'entrance') {
    const x = (plot.minX + plot.maxX) / 2;
    const inside = params.get('side') === 'inside';
    const z = plot.minZ + 2 + (inside ? 2.1 : -2.1);
    setGroundPlayer(game, x, z);
    const player = game.playerCtl;
    if (player) {
      player.yaw = inside ? Math.PI : 0;
      player.pitch = 0.02;
      if (params.get('open') === '1' || params.get('open') === 'both') {
        const doors = game.world.buildings.destructibles.filter((candidate) =>
          candidate.kind === 'door' && Math.abs(candidate.cz - (plot.minZ + 2)) < 0.25 &&
          Math.abs(candidate.cx - x) < (params.get('open') === 'both' ? 2 : 1.2),
        );
        for (const door of doors) game.openDoor(door, player.char);
      }
    }
    return;
  }
  if (params.get('traverse') === 'up') {
    const ix0 = plot.minX + 2;
    const ix1 = plot.maxX - 2;
    const iz0 = plot.minZ + 2;
    const iz1 = plot.maxZ - 2;
    const secondFlight = arch === 'apartment' && params.get('flight') === '2';
    const x = secondFlight ? ix1 - 0.14 - 0.9 : ix0 + 0.14 + 0.9;
    const z = secondFlight ? iz0 + 1.6 - 0.32 : iz1 - 1.6 + 0.32;
    setGroundPlayer(game, x, z);
    const player = game.playerCtl;
    if (player) {
      if (secondFlight) {
        const f2 = plot.flatH + 0.28 + 2.9 + 0.24;
        const floorY = game.world.groundHeight(x, z, f2 + 0.2);
        player.char.pos.y = floorY;
        player.char.groundH = floorY;
      }
      player.yaw = secondFlight ? 0 : Math.PI;
      player.pitch = 0.03;
      game.input.keys.add('KeyW');
      window.setTimeout(() => game.input.keys.delete('KeyW'), 1500);
    }
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
    if (params.get('bombardment') === 'cross') {
      const centerX = (plot.minX + plot.maxX) / 2;
      const centerZ = (plot.minZ + plot.maxZ) / 2;
      game.zoneArmed = true;
      game.bombardment.setTestArea(game, centerX + game.bombardment.radius, centerZ, 'active');
    }
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
    for (let d = Math.min(12, len); d >= 3; d -= 0.5) {
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
  const params = new URLSearchParams(window.location.search);
  if (params.get('auto') === '1') {
    game.input.keys.add('KeyW');
    game.input.keys.add('ShiftLeft');
  }
}

function setupCombat(game: Game): void {
  const params = new URLSearchParams(window.location.search);
  const weaponParam = params.get('weapon');
  const weaponId = weaponParam && weaponParam in WEAPONS ? weaponParam as keyof typeof WEAPONS : 'rifle';
  const def = WEAPONS[weaponId];
  const sightParam = params.get('sight');
  let sight: AttachmentId | null = sightParam === 'reddot' || sightParam === 'scope4' ? sightParam : 'scope2';
  if (!canAttach(weaponId, sight)) sight = canAttach(weaponId, 'reddot') ? 'reddot' : null;
  const muzzleParam = params.get('muzzle');
  const requestedMuzzle = muzzleParam === 'suppressor' || muzzleParam === 'none' ? muzzleParam : 'comp';
  const muzzle: AttachmentId | null =
    requestedMuzzle !== 'none' && canAttach(weaponId, requestedMuzzle) ? requestedMuzzle : null;
  const useExtendedMag = canAttach(weaponId, 'extmag');
  const lane = testLane(game);
  const [playerX, playerZ, targetX, targetZ] = lane;
  setGroundPlayer(game, playerX, playerZ);
  const player = game.playerCtl;
  if (!player) return;
  const c = player.char;
  const gun: GunState = {
    def,
    mag: def.magSize,
    att: { ...emptyAttachments(), sight, mag: useExtendedMag ? 'extmag' as const : null, muzzle },
  };
  gun.mag = magSizeOf(gun);
  gun.mag = parseCombatMagazine(params.get('mag'), gun.mag);
  c.guns[0] = gun;
  c.ammo[def.ammo] = Math.max(60, def.magSize * 6);
  c.curSlot = 0;
  const action = params.get('action');
  if (action === 'interact' || action === 'pickup' || action === 'equip' || action === 'heal' || action === 'drink') {
    c.beginAction(action, params.get('hold') === '1' ? 3 : 0.5);
  }
  player.yaw = Math.atan2(targetX - playerX, targetZ - playerZ);

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
  player.pitch = Math.atan2(
    target.char.pos.y + target.char.chestHeight() - (c.pos.y + c.eyeHeight()),
    Math.hypot(targetX - playerX, targetZ - playerZ),
  );
  const requestedBurst = Math.min(12, Math.max(0, Math.floor(Number(params.get('burst')) || 0)));
  if (requestedBurst > 0) {
    const stopMagazine = Math.max(0, gun.mag - requestedBurst);
    const runBurst = (): void => {
      if (!target.char.alive || gun.mag <= stopMagazine) {
        game.input.lmb = false;
        return;
      }
      game.input.lmb = true;
      window.requestAnimationFrame(runBurst);
    };
    window.setTimeout(() => window.requestAnimationFrame(runBurst), 600);
  }
}

function setupBotTactics(game: Game): void {
  setGroundPlayer(game, 0, 180);
  const player = game.playerCtl;
  if (player) {
    player.yaw = Math.PI;
    player.pitch = 0.04;
  }
  game.zone.center.set(0, 0);
  game.zone.nextCenter.set(0, 0);
  game.zone.radius = 200;
  game.zone.nextRadius = 200;
  game.zone.state = 'done';
  game.zoneArmed = true;

  const placements = [
    [-100, -100],
    [-80, -100],
    [100, 100],
    [220, 0],
  ] as const;
  for (let i = 0; i < placements.length; i++) {
    const bot = game.bots[i];
    const placement = placements[i];
    if (!bot || !placement) continue;
    const [x, z] = placement;
    bot.jumpS = -1;
    bot.descent = null;
    bot.trainingIdle = false;
    bot.char.alive = true;
    bot.char.hp = i === 0 ? 37 : i === 2 ? 40 : 100;
    bot.char.airPose = null;
    bot.char.group.visible = true;
    bot.char.pos.set(x, game.world.groundHeight(x, z, 30), z);
    bot.char.groundH = bot.char.pos.y;
    bot.char.grounded = true;
    bot.char.guns[0] = { def: WEAPONS.rifle, mag: 30, att: emptyAttachments() };
    bot.char.ammo.rifle = 90;
    bot.char.curSlot = 0;
  }
  const recovering = game.bots[2];
  if (recovering) recovering.char.heals.bandage = 2;
  const smokeCover = game.bots[0];
  if (smokeCover) smokeCover.char.throwables.smoke = 1;
}

function setupVehicle(game: Game): void {
  const lane = testLane(game);
  const dir = laneDirection(lane);
  setGroundPlayer(game, lane[0], lane[1]);
  const player = game.playerCtl;
  const requestedKind = new URLSearchParams(window.location.search).get('kind');
  const vehicle = game.vehicles.list.find((candidate) => candidate.kind === requestedKind) ?? game.vehicles.list[0];
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
  if (new URLSearchParams(window.location.search).get('drive') === '1') {
    player.enterVehicle(vehicle, game);
  }
}

function setupBotVehicle(game: Game): void {
  setGroundPlayer(game, 145, -145);
  const player = game.playerCtl;
  if (player) {
    player.char.alive = false;
    player.char.hp = 0;
    player.char.group.visible = false;
  }
  const bot = game.bots[0];
  const vehicle = game.vehicles.list[0];
  if (!bot || !vehicle) return;
  let botX = -142;
  let botZ = 126;
  let dirX = 1;
  let dirZ = 0;
  const bridgeRoute = new URLSearchParams(window.location.search).get('route') === 'bridge';
  let laneFound = bridgeRoute;
  let laneLength = 105;
  if (bridgeRoute) {
    const bridgeZ = riverZAt(-50);
    botX = -50;
    botZ = bridgeZ + 25;
    dirX = 0;
    dirZ = -1;
    laneLength = 70;
  }
  const directions = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [0.707, 0.707], [0.707, -0.707], [-0.707, 0.707], [-0.707, -0.707],
  ] as const;
  for (let x = -240; x <= 240 && !laneFound; x += 40) {
    for (let z = -240; z <= 240 && !laneFound; z += 40) {
      for (const direction of directions) {
        let previousGround = game.world.getHeight(x, z);
        let clear = previousGround >= WATER_Y + 0.1;
        for (let distance = 0; clear && distance <= laneLength; distance += 5) {
          const px = x + direction[0] * distance;
          const pz = z + direction[1] * distance;
          const ground = game.world.getHeight(px, pz);
          clear = Math.abs(ground - previousGround) < 2.2 && game.world.pointFree(px, pz, 1.65, WATER_Y + 0.1, 18);
          previousGround = ground;
        }
        if (!clear) continue;
        botX = x;
        botZ = z;
        dirX = direction[0];
        dirZ = direction[1];
        laneFound = true;
        break;
      }
    }
  }
  bot.jumpS = -1;
  bot.descent = null;
  bot.trainingIdle = false;
  bot.char.alive = true;
  bot.char.hp = 100;
  bot.char.airPose = null;
  bot.char.group.visible = true;
  bot.char.pos.set(botX, game.world.groundHeight(botX, botZ, 30), botZ);
  bot.char.groundH = bot.char.pos.y;
  bot.char.grounded = true;
  bot.char.guns[0] = { def: WEAPONS.rifle, mag: 30, att: emptyAttachments() };
  bot.char.ammo.rifle = 120;
  bot.char.curSlot = 0;

  const vehicleX = botX + dirX * 5;
  const vehicleZ = botZ + dirZ * 5;
  vehicle.pos.set(vehicleX, game.world.groundHeight(vehicleX, vehicleZ, 30), vehicleZ);
  vehicle.yaw = Math.atan2(dirX, dirZ);
  vehicle.speed = 0;
  vehicle.hp = VEHICLE_SPEC[vehicle.kind].hp;
  vehicle.driver = null;
  vehicle.claimedBy = null;
  vehicle.passengers.fill(null);
  vehicle.dead = false;
  vehicle.exploded = false;
  vehicle.burnT = -1;
  vehicle.group.visible = true;
  vehicle.sync();

  game.zone.center.set(botX + dirX * laneLength, botZ + dirZ * laneLength);
  game.zone.nextCenter.copy(game.zone.center);
  game.zone.radius = 18;
  game.zone.nextRadius = 18;
  game.zone.state = 'done';
  game.zoneArmed = true;

  if (new URLSearchParams(window.location.search).get('contact') === '1') {
    const enemy = game.bots[1];
    if (enemy) {
      const enemyX = game.zone.center.x;
      const enemyZ = game.zone.center.y;
      enemy.jumpS = -1;
      enemy.descent = null;
      enemy.trainingIdle = true;
      enemy.char.alive = true;
      enemy.char.hp = 100;
      enemy.char.airPose = null;
      enemy.char.group.visible = true;
      enemy.char.pos.set(enemyX, game.world.groundHeight(enemyX, enemyZ, 30), enemyZ);
      enemy.char.groundH = enemy.char.pos.y;
      enemy.char.grounded = true;
    }
  }
}

function setupSquadCommand(game: Game): void {
  const lane = testLane(game);
  const direction = laneDirection(lane);
  setGroundPlayer(game, lane[0], lane[1]);
  const player = game.playerCtl;
  if (!player) return;
  player.yaw = direction.yaw;
  player.pitch = 0.04;
  const rightX = direction.z;
  const rightZ = -direction.x;
  for (let i = 0; i < game.squadMates.length; i++) {
    const mate = game.squadMates[i];
    if (!mate) continue;
    const side = (i - 1) * 2.2;
    const x = lane[0] - direction.x * 3.5 + rightX * side;
    const z = lane[1] - direction.z * 3.5 + rightZ * side;
    mate.descent = null;
    mate.char.alive = true;
    mate.char.hp = 100;
    mate.char.knocked = false;
    mate.char.airPose = null;
    mate.char.group.visible = true;
    mate.char.pos.set(x, game.world.groundHeight(x, z, 30), z);
    mate.char.groundH = mate.char.pos.y;
    mate.char.grounded = true;
    mate.char.swimming = false;
    mate.char.guns[0] = { def: WEAPONS.rifle, mag: 30, att: emptyAttachments() };
    mate.char.ammo.rifle = 120;
    mate.char.curSlot = 0;
  }
  const order = new URLSearchParams(window.location.search).get('order');
  if (order === 'focus' || order === 'aim') {
    const enemy = game.bots[0];
    if (!enemy) return;
    const enemyX = order === 'aim' ? lane[0] + direction.x * 9 : lane[2];
    const enemyZ = order === 'aim' ? lane[1] + direction.z * 9 : lane[3];
    enemy.jumpS = -1;
    enemy.descent = null;
    enemy.trainingIdle = true;
    enemy.char.alive = true;
    enemy.char.hp = order === 'aim' ? 1000 : 100;
    enemy.char.airPose = null;
    enemy.char.group.visible = true;
    enemy.char.pos.set(enemyX, game.world.groundHeight(enemyX, enemyZ, 30), enemyZ);
    enemy.char.groundH = enemy.char.pos.y;
    enemy.char.grounded = true;
    if (order === 'focus') {
      game.issueSquadOrder('focus', enemyX, enemyZ, enemy.char.id);
    } else {
      player.pitch = Math.atan2(
        enemy.char.pos.y + enemy.char.chestHeight() - (player.char.pos.y + player.char.eyeHeight()),
        Math.hypot(enemyX - lane[0], enemyZ - lane[1]),
      );
    }
  } else if (order === 'hold') {
    game.issueSquadOrder('hold');
  } else {
    game.issueSquadOrder('move', lane[2], lane[3]);
  }
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
  if (new URLSearchParams(window.location.search).get('auto') === '1') {
    game.knock.startRevive(player.char, mate.char);
  }
  player.yaw = dir.yaw;
  player.pitch = 0.08;
}

function setupParachute(game: Game): void {
  parkEnemies(game);
  const player = game.playerCtl;
  if (!player) return;
  // 固定落在经过碰撞检查的旱地测试通道，避免落入河中后游泳姿态干扰落地动画验收。
  const lane = testLane(game);
  const x = (lane[0] + lane[2]) * 0.5;
  const z = (lane[1] + lane[3]) * 0.5;
  const y = game.world.getHeight(x, z) + 190;
  player.descent = 'freefall';
  player.vy = -2;
  player.char.pos.set(x, y, z);
  player.char.swimming = false;
  player.char.swimDip = 0;
  player.char.grounded = false;
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
    mate.char.swimming = false;
    mate.char.swimDip = 0;
    mate.char.grounded = false;
    mate.char.airPose = 'fall';
    mate.char.group.visible = true;
  }
}

function setupZone(game: Game): void {
  const lane = testLane(game);
  const centerX = lane[0];
  const centerZ = lane[1];
  const radius = 8;
  game.zone.center.set(centerX, centerZ);
  game.zone.nextCenter.set(centerX, centerZ);
  game.zone.radius = radius;
  game.zone.nextRadius = radius;
  game.zoneArmed = true;
  game.zone.update(0);
  setGroundPlayer(game, centerX + radius + 2, centerZ);
  const player = game.playerCtl;
  if (player) {
    player.yaw = -Math.PI / 2;
    player.pitch = 0.04;
  }
}

function setupEndgame(game: Game): void {
  const lane = testLane(game);
  const [playerX, playerZ, targetX, targetZ] = lane;
  setGroundPlayer(game, playerX, playerZ);
  const player = game.playerCtl;
  if (!player) return;
  player.char.guns[0] = {
    def: WEAPONS.dmr,
    mag: 20,
    att: { ...emptyAttachments(), sight: 'scope2', mag: 'extmag', muzzle: 'comp' },
  };
  player.char.ammo.rifle = 90;
  player.char.curSlot = 0;
  player.yaw = Math.atan2(targetX - playerX, targetZ - playerZ);
  for (const bot of game.bots) {
    bot.char.alive = false;
    bot.char.group.visible = false;
  }
  const target = game.bots[0];
  if (!target) return;
  target.trainingIdle = true;
  target.char.alive = true;
  target.char.hp = 10;
  target.char.airPose = null;
  target.char.group.visible = true;
  target.char.pos.set(targetX, game.world.groundHeight(targetX, targetZ, 30), targetZ);
  target.char.groundH = target.char.pos.y;
  target.char.grounded = true;
  player.pitch = Math.atan2(
    target.char.pos.y + target.char.chestHeight() - (player.char.pos.y + player.char.eyeHeight()),
    Math.hypot(targetX - playerX, targetZ - playerZ),
  );
}

function setupDefeat(game: Game): void {
  const lane = testLane(game);
  setGroundPlayer(game, lane[0], lane[1]);
  const player = game.playerCtl;
  if (!player) return;
  game.damageChar(player.char, 200, false, null, '测试伤害', true);
}

function setupMapTour(game: Game): void {
  const requested = new URLSearchParams(window.location.search).get('region');
  const site = game.world.mapSites.find((candidate) => candidate.region === requested) ?? game.world.mapSites[0];
  if (!site) {
    setGroundPlayer(game, -60, -20);
    return;
  }
  let spawnX = site.resolvedX;
  let spawnZ = site.resolvedZ + 12;
  let found = false;
  for (let ring = 16; ring <= 28 && !found; ring += 3) {
    for (let step = 0; step < 16; step++) {
      const angle = step / 16 * Math.PI * 2;
      const x = site.resolvedX + Math.cos(angle) * ring;
      const z = site.resolvedZ + Math.sin(angle) * ring;
      if (!game.world.pointFree(x, z, 0.65, WATER_Y + 0.2, 17)) continue;
      const cameraX = x + Math.cos(angle) * 5.5;
      const cameraZ = z + Math.sin(angle) * 5.5;
      if (!game.world.pointFree(cameraX, cameraZ, 0.5, WATER_Y + 0.2, 17)) continue;
      let viewClear = true;
      for (const fraction of [0.2, 0.38, 0.55, 0.65]) {
        const probeX = x + (site.resolvedX - x) * fraction;
        const probeZ = z + (site.resolvedZ - z) * fraction;
        if (game.world.pointFree(probeX, probeZ, 0.32, WATER_Y + 0.2, 17)) continue;
        viewClear = false;
        break;
      }
      if (!viewClear) continue;
      spawnX = x;
      spawnZ = z;
      found = true;
      break;
    }
  }
  setGroundPlayer(game, spawnX, spawnZ);
  const player = game.playerCtl;
  if (!player) return;
  player.yaw = Math.atan2(site.resolvedX - spawnX, site.resolvedZ - spawnZ);
  player.pitch = 0.04;
}

export function applyTestScenarioFromUrl(game: Game): void {
  const id = scenarioFromUrl();
  if (!id) return;
  if (id === 'stability') setRandomSeed(parseRandomSeed(window.location.search, 1337) ?? 1337);
  game.startMatch();
  if (id !== 'stability') parkEnemies(game);
  if (id !== 'parachute' && id !== 'stability' && id !== 'squadcommand') parkSquad(game);
  if (id === 'stairs') setupStairs(game);
  else if (id === 'swim') setupSwim(game);
  else if (id === 'combat') setupCombat(game);
  else if (id === 'bottactics') setupBotTactics(game);
  else if (id === 'botvehicle') setupBotVehicle(game);
  else if (id === 'squadcommand') setupSquadCommand(game);
  else if (id === 'stability') setupStability(game);
  else if (id === 'parachute') setupParachute(game);
  else if (id === 'vehicle') setupVehicle(game);
  else if (id === 'deathcrate') setupDeathCrate(game);
  else if (id === 'bombardment') setupBombardment(game);
  else if (id === 'revive') setupRevive(game);
  else if (id === 'zone') setupZone(game);
  else if (id === 'endgame') setupEndgame(game);
  else if (id === 'defeat') setupDefeat(game);
  else setupMapTour(game);
  if (id === 'combat' && new URLSearchParams(window.location.search).get('ads') === '1') game.input.rmb = true;
  if (id === 'endgame') game.input.rmb = true;
  showScenarioPanel(id, game);
}
