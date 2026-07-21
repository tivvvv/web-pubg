import { emptyAttachments } from './attachments';
import type { Game } from './game';
import { WEAPONS } from './weapons';
import { riverZAt, WATER_Y } from './world';

type ScenarioId = 'stairs' | 'swim' | 'combat' | 'parachute';

const SCENARIO_TEXT: Record<ScenarioId, string> = {
  stairs: '楼梯回归: 检查楼层接缝, 楼梯净空和上下楼碰撞',
  swim: '游泳回归: 检查入水姿态, Shift 加速和连续上岸',
  combat: '枪战回归: M416 + 全套配件, 检查 ADS, 后坐和命中反馈',
  parachute: '空降回归: 玩家和队友同高度自由落体, 检查速度和开伞时机',
};

function scenarioFromUrl(): ScenarioId | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('test') !== '1') return null;
  const id = params.get('scenario');
  return id === 'stairs' || id === 'swim' || id === 'combat' || id === 'parachute' ? id : 'combat';
}

function showScenarioPanel(id: ScenarioId): void {
  const panel = document.createElement('aside');
  panel.id = 'test-scenario-panel';
  panel.innerHTML = `<strong>TEST / ${id.toUpperCase()}</strong><span>${SCENARIO_TEXT[id]}</span>`;
  document.body.appendChild(panel);
}

function parkEnemies(game: Game): void {
  for (const bot of game.bots) {
    bot.jumpS = Number.POSITIVE_INFINITY;
    bot.descent = null;
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
  c.group.visible = true;
  c.removeCanopy();
  c.pos.set(x, game.world.groundHeight(x, z, game.world.getHeight(x, z) + 2.5), z);
  c.groundH = c.pos.y;
  c.grounded = true;
  c.swimming = false;
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
  player.yaw = Math.PI;
  player.pitch = 0.06;
  const c = player.char;
  c.airPose = null;
  c.group.visible = true;
  c.pos.set(x, WATER_Y - 0.78, z);
  c.groundH = WATER_Y - 0.03;
  c.grounded = false;
  c.swimming = true;
}

function setupCombat(game: Game): void {
  const sightParam = new URLSearchParams(window.location.search).get('sight');
  const sight = sightParam === 'reddot' || sightParam === 'scope4' ? sightParam : 'scope2';
  const lanes = [
    [-142, 126, -122, 126],
    [82, 116, 102, 116],
    [74, -112, 94, -112],
  ] as const;
  const lane = lanes.find(([x0, z0, x1, z1]) => {
    for (let i = 0; i <= 10; i++) {
      const f = i / 10;
      const x = x0 + (x1 - x0) * f;
      const z = z0 + (z1 - z0) * f;
      if (!game.world.pointFree(x, z, 0.65, WATER_Y + 0.2, 16)) return false;
    }
    return true;
  }) ?? lanes[0];
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
  else setupParachute(game);
  if (id === 'combat' && new URLSearchParams(window.location.search).get('ads') === '1') game.input.rmb = true;
  showScenarioPanel(id);
}
