// Bot AI: 游走/拾取 ↔ 交战 状态机; 赤手空拳开局, 优先找枪, 近身用近战
import * as THREE from 'three';
import {
  CANOPY_DEPLOY_VELOCITY, Character, moveChar, stepAirDescentVelocity, SWIM_EXIT_DEPTH, SWIM_SPRINT_SPEED,
} from './character';
import type { AmmoType, MeleeId, WeaponId } from './types';
import { WEAPONS } from './weapons';
import { WATER_Y } from './world';
import { isMeleeKind, isWeaponKind, type LootItem } from './loot';
import { armorFromLoot, isArmorKind } from './armor';
import { isPackKind, packLevelFromLoot } from './backpack';
import { magSizeOf } from './attachments';
import { angleDiff, clamp, rand, randInt, turnToward } from './utils';
import { probeVault, startVault, updateVaultMotion } from './vault';
import type { Game } from './game';
import {
  AgentNavigator, findBridgeExit, findCoverPoint, findEmergencyNavPoint, findLocalEscape, findSwimBank,
  findVehicleRiverWaypoint,
} from './botnav';
import {
  chooseCombatMode, chooseStrategicMode, preferredCombatRange, selectCombatGunSlot,
  shouldDeploySmoke, shouldExitVehicle, shouldSeekVehicle, shouldTacticalReload, zoneRotationUrgency,
  type BotCombatMode, type BotStrategicMode, type ZoneRotationUrgency,
} from './bottactics';
import { autoLootDeathCrate } from './deathcrate';
import { findTacticalRouteWaypoint, type TacticalRoute } from './tactics';
import { random } from './random';
import { driveVehicleStep, seatWorld, VEHICLE_SPEC, type Vehicle } from './vehicles';

const ENGAGE_DIST = 92;
// bot 降落伞配色(哑光低饱和, 按角色 id 轮换; 队友另用绿色系)
const BOT_CANOPIES = [0x7a8a6a, 0x6e7a8a, 0x8a7a5e, 0x5e7a72, 0x7d6f8a, 0x8a6e62] as const;

function signedAngleDelta(current: number, target: number): number {
  let delta = (target - current) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export class BotController {
  readonly char: Character;
  trainingIdle = false; // 固定测试场景专用, 普通对局始终为 false
  private state: 'wander' | 'engage' = 'wander';
  private target: Character | null = null;
  private scanT: number;
  private reactT = 0;
  private burstLeft = 0;
  private shotT = 0;
  private burstCd = 0;
  private fireTimer = 0;
  private reloadT = 0;
  private losT = 0;
  private losOk = false;
  private lostT = 0;
  private strafeDir = 1;
  private repathT = 0;
  private vaultProbeT = 0; // 翻越探测节流
  private moveTarget = new THREE.Vector3();
  private hasMoveTarget = false;
  private swimBank = new THREE.Vector2();
  private bridgeWaypoint = new THREE.Vector2();
  private swimRepathT = 0;
  private swimStuckT = 0;
  private swimLastX = 0;
  private swimLastZ = 0;
  private hasSwimBank = false;
  private lastKnown = new THREE.Vector3();
  // 破门: 被门/窗挡路计时
  private blockT = 0;
  private blockCheckT = 0;
  private blockedDoor: import('./types').DestructibleLike | null = null;
  // 手雷: 每局最多扔 1 颗; stillT 记录目标静止时长
  private fragUsed = false;
  private smokeUsed = false;
  private stillT = 0;
  private fragOut = { x: 0, z: 0 };
  private healCd = 0; // bot 恢复品使用冷却(即时结算, 冷却模拟读条间隔)
  private engageCrouch = false; // 本次交战是否蹲下对枪(索敌成功时 15% 掷定)
  private navigator = new AgentNavigator();
  private tacticPoint = new THREE.Vector2();
  private tacticT = 0;
  private tacticMode: BotCombatMode = 'advance';
  private navigationIntent = false;
  private combatStuckT = 0;
  private strategicStuckT = 0;
  private strategicProgressT = 0;
  private strategicProgressX = 0;
  private strategicProgressZ = 0;
  private lastNavMoved = 0;
  private lastNavBlocked = false;
  private lastNavStuck = 0;
  private rotationAttempt = 0;
  private strategicMode: BotStrategicMode = 'loot';
  private postCombatT = 0;
  private searchOrigin = new THREE.Vector3();
  private searchStep = 0;
  private routeSide = random() < 0.5 ? -1 : 1;
  private routeRole: TacticalRoute['role'] = 'advance';
  private lootScanT = 0;
  private lootTarget: LootItem | null = null;
  private blockedLoot: LootItem | null = null;
  private blockedLootT = 0;
  private investigateT = 0;
  private driving: Vehicle | null = null;
  private vehicleTarget: Vehicle | null = null;
  private vehicleClaimT = 0;
  private vehicleCooldown = 0;
  private vehicleStuckT = 0;
  private vehicleProgressT = 0;
  private vehicleProgress = 0;
  private vehicleRecoveryT = 0;
  private vehicleRecoverySide = 1;
  private vehicleDetourT = 0;
  private vehicleDetourYaw = 0;
  private vehicleWaypoint = new THREE.Vector2();
  private vehicleProbe = new THREE.Vector3();
  // 空降状态: 高空自由落体 → 开伞滑翔 → 落地(null 恢复正常 AI)
  descent: 'freefall' | 'canopy' | null = null;
  jumpS = -1;          // ≥0 = 还在机上, 到达该航线里程即跳伞
  vy = 0;
  readonly dropTarget = new THREE.Vector3();

  private eye = new THREE.Vector3();
  private tgtPos = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private aim = new THREE.Vector3();

  constructor(name: string, shirtColor: number) {
    this.char = new Character(name, false, shirtColor);
    this.scanT = random() * 0.3;
    const roleRoll = random();
    this.routeRole = roleRoll < 0.34 ? 'advance' : roleRoll < 0.67 ? 'flank' : 'defend';
  }

  get tacticalState(): string {
    if (this.driving) return 'vehicle:drive';
    if (this.vehicleTarget) return 'vehicle:board';
    return this.state === 'engage' ? `combat:${this.tacticMode}` : this.strategicMode;
  }

  get hasNavigationIntent(): boolean {
    return this.navigationIntent;
  }

  get navigationDiagnostic(): string {
    const loot = this.lootTarget;
    const blocked = this.blockedLoot;
    return [
      this.char.id,
      this.tacticalState,
      this.char.pos.x.toFixed(1),
      this.char.pos.z.toFixed(1),
      this.char.pos.y.toFixed(1),
      this.char.speed2d.toFixed(2),
      this.char.grounded ? 'ground' : 'air',
      this.hasMoveTarget ? this.moveTarget.x.toFixed(1) : '-',
      this.hasMoveTarget ? this.moveTarget.z.toFixed(1) : '-',
      this.strategicStuckT.toFixed(1),
      this.lastNavMoved.toFixed(3),
      this.lastNavBlocked ? 'blocked' : 'clear',
      this.lastNavStuck.toFixed(1),
      loot ? `${loot.kind}@${loot.group.position.x.toFixed(1)},${loot.group.position.z.toFixed(1)}` : '-',
      blocked ? `${blocked.kind}@${blocked.group.position.x.toFixed(1)},${blocked.group.position.z.toFixed(1)}` : '-',
    ].join(',');
  }

  update(dt: number, game: Game): void {
    const c = this.char;
    this.navigationIntent = false;
    if (!c.alive) {
      this.releaseVehicleTarget();
      if (this.driving) this.exitVehicle(game, true);
      // 空中被击杀: 继续坠地
      if (this.descent) {
        c.pos.y += this.vy * dt;
        const g = game.world.groundHeight(c.pos.x, c.pos.z, c.pos.y);
        if (c.pos.y <= g) this.finishDescent(g);
      }
      return;
    }
    if (this.trainingIdle) {
      c.speed2d = 0;
      c.grounded = true;
      return;
    }
    // 舱内等待: 跟随飞机(隐藏), 到达出舱里程跳伞
    if (this.jumpS >= 0) {
      game.flightPoint(c.pos, Math.min(game.planeS, this.jumpS));
      if (game.planeS >= this.jumpS) {
        this.jumpS = -1;
        this.descent = 'freefall';
        this.vy = -2;
        c.airPose = 'fall';
        c.group.visible = true;
      }
      return;
    }
    // 空降阶段: 自由落体/滑翔, 落地后恢复正常 AI
    if (this.descent) {
      this.updateDescent(dt, game);
      return;
    }
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.postCombatT = Math.max(0, this.postCombatT - dt);
    this.blockedLootT = Math.max(0, this.blockedLootT - dt);
    if (this.blockedLoot && (!this.blockedLoot.active || this.blockedLootT <= 0)) this.blockedLoot = null;
    this.vehicleCooldown = Math.max(0, this.vehicleCooldown - dt);
    if (this.driving) {
      this.scanT -= dt;
      if (this.scanT <= 0) {
        this.scanT = 0.25 + random() * 0.08;
        this.scan(game);
      }
      this.updateVehicleDrive(dt, game);
      return;
    }
    // 闪避驶来载具(便宜版: 侧向急躲)
    if (this.dodgeVehicle(dt, game)) return;
    // 游泳状态: 深水中只朝岸游, 不索敌/开火/拾取
    const wasSwimming = c.swimming;
    game.updateSwim(c);
    if (c.swimming) {
      if (!wasSwimming) {
        this.navigator.reset(c);
        this.hasSwimBank = false;
        this.swimRepathT = 0;
        this.swimStuckT = 0;
        this.swimLastX = c.pos.x;
        this.swimLastZ = c.pos.z;
      }
      this.swimToBank(dt, game);
      return;
    }
    if (wasSwimming) {
      this.navigator.reset(c);
    }
    // 翻越中: 脚本位移
    c.vaultCd = Math.max(0, c.vaultCd - dt);
    if (updateVaultMotion(c, dt)) return;
    // 预警开始就优先离开轰炸区, 进入轰炸阶段后全速逃生
    if (this.fleeBombardment(dt, game)) return;
    // 换弹(仅枪械, 消耗对应类型弹药)
    const gun = c.heldGun();
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0 && gun) {
        const need = magSizeOf(gun) - gun.mag;
        const take = Math.min(need, c.ammo[gun.def.ammo]);
        gun.mag += take;
        c.ammo[gun.def.ammo] -= take;
      }
    } else if (gun && gun.mag <= 0 && c.ammo[gun.def.ammo] > 0) {
      this.reloadT = gun.def.reloadTime;
    }

    // 交错扫描: 每 0.25s 左右找一次目标
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.25 + random() * 0.08;
      this.scan(game);
    }

    // 手雷威胁: 6m 内有活着的雷, 掉头全速跑
    if (this.fleeGrenade(dt, game)) return;

    this.healCd = Math.max(0, this.healCd - dt);
    if (this.state === 'engage' && this.target) {
      this.updateEngage(dt, game);
    } else {
      this.updateWander(dt, game);
    }

    // 被门/窗挡路 >1s: 开枪或挥刀破门
    this.updateDoorBreak(dt, game);

    // 拾取: 弹药/恢复品/投掷物直接拿; 武器/护具/背包按需按 F 逻辑拿(bot 自动)
    const item = game.loot.nearest(c.pos.x, c.pos.y, c.pos.z, 1.9);
    if (item) {
      const k = item.kind;
      if (!isWeaponKind(k) && !isArmorKind(k) && !isPackKind(k)) {
        game.applyAutoPickup(c, item);
      } else if (isArmorKind(k)) {
        if (this.wantsArmor(k)) game.tryPickupArmor(c, item);
      } else if (isPackKind(k)) {
        const lv = packLevelFromLoot(k);
        if (lv && (!c.pack || c.pack.level < lv)) game.tryPickupPack(c, item);
      } else if (this.wantsWeapon(k)) {
        game.tryPickupWeapon(c, item);
      }
      if (item === this.lootTarget && !item.active) this.lootTarget = null;
    }
  }

  // 游泳中: 朝目标岸(渡河)或最近岸(地形上坡方向)游, 不打斗
  private swimToBank(dt: number, game: Game): void {
    const c = this.char;
    if (!this.hasSwimBank) {
      const preferX = this.hasMoveTarget ? this.moveTarget.x : c.pos.x + Math.sin(c.yaw) * 20;
      const preferZ = this.hasMoveTarget ? this.moveTarget.z : c.pos.z + Math.cos(c.yaw) * 20;
      findSwimBank(this.swimBank, c.pos.x, c.pos.z, preferX, preferZ, game.world);
      this.hasSwimBank = true;
      this.swimRepathT = 0.75;
      this.swimLastX = c.pos.x;
      this.swimLastZ = c.pos.z;
    }

    let dx = this.swimBank.x - c.pos.x;
    let dz = this.swimBank.y - c.pos.z;
    const bankDepth = WATER_Y - game.world.getHeight(this.swimBank.x, this.swimBank.y);
    if (Math.hypot(dx, dz) < 1.5 && bankDepth >= 0.9) {
      const preferX = this.hasMoveTarget ? this.moveTarget.x : c.pos.x + Math.sin(c.yaw) * 20;
      const preferZ = this.hasMoveTarget ? this.moveTarget.z : c.pos.z + Math.cos(c.yaw) * 20;
      findSwimBank(this.swimBank, c.pos.x, c.pos.z, preferX, preferZ, game.world);
      dx = this.swimBank.x - c.pos.x;
      dz = this.swimBank.y - c.pos.z;
    }

    this.swimRepathT -= dt;
    if (this.swimRepathT <= 0) {
      const progress = Math.hypot(c.pos.x - this.swimLastX, c.pos.z - this.swimLastZ);
      this.swimStuckT = progress < 0.4 ? this.swimStuckT + 0.75 : 0;
      this.swimLastX = c.pos.x;
      this.swimLastZ = c.pos.z;
      this.swimRepathT = 0.75;
      if (this.swimStuckT >= 1.5) {
        const oldX = this.swimBank.x;
        const oldZ = this.swimBank.y;
        const preferX = this.hasMoveTarget ? this.moveTarget.x : c.pos.x + Math.sin(c.yaw) * 20;
        const preferZ = this.hasMoveTarget ? this.moveTarget.z : c.pos.z + Math.cos(c.yaw) * 20;
        findSwimBank(this.swimBank, c.pos.x, c.pos.z, preferX, preferZ, game.world, oldX, oldZ);
        this.swimStuckT = 0;
        dx = this.swimBank.x - c.pos.x;
        dz = this.swimBank.y - c.pos.z;
      }
    }
    const d = Math.hypot(dx, dz) || 1;
    const localDepth = WATER_Y - game.world.getHeight(c.pos.x, c.pos.z);
    const localStandH = game.world.groundHeight(c.pos.x, c.pos.z, c.pos.y + 0.3);
    const reachedShore = localDepth <= SWIM_EXIT_DEPTH || localStandH >= WATER_Y - SWIM_EXIT_DEPTH;
    const swimSpeed = reachedShore
      ? 0
      : bankDepth < SWIM_EXIT_DEPTH
        ? Math.min(SWIM_SPRINT_SPEED, d * 2.5)
        : SWIM_SPRINT_SPEED;
    this.navigator.move(
      c,
      this.swimBank.x,
      this.swimBank.y,
      swimSpeed,
      dt,
      game.world,
      { stopDistance: 0.25, turnRate: 4.2, allowWater: true, neighbors: game.chars },
    );
    c.swimAcc += c.speed2d * dt;
    if (c.swimAcc > 1.7) {
      c.swimAcc = 0;
      game.soundAt(c.pos, (dd, p) => game.audio.swimStrokeAt(dd, p));
    }
  }

  // 是否想要这件护具: 空槽或更高等级
  private wantsArmor(kind: import('./types').LootKind): boolean {
    const info = armorFromLoot(kind);
    if (!info) return false;
    const cur = info.kind === 'helmet' ? this.char.helmet : this.char.vest;
    return !cur || cur.level < info.level;
  }

  // 最优枪缺少一个基础弹匣的总弹量 → 返回所需弹种(bot 寻弹用)
  private needsAmmoType(): AmmoType | null {
    const c = this.char;
    const slot = c.bestGunSlot();
    if (slot < 0) return null;
    const g = c.guns[slot];
    if (!g) return null;
    const t = g.def.ammo;
    return g.mag + c.ammo[t] >= g.def.magSize ? null : t;
  }

  private rotationUrgency(game: Game): ZoneRotationUrgency {
    if (!game.zoneArmed) return 'none';
    const c = this.char;
    const hasNext = game.zone.nextRadius < game.zone.radius - 0.5;
    const center = hasNext ? game.zone.nextCenter : game.zone.center;
    const radius = hasNext ? game.zone.nextRadius : game.zone.radius;
    const safeRadius = Math.max(3, radius - 4);
    const distanceOutsideNext = Math.max(0, Math.hypot(c.pos.x - center.x, c.pos.z - center.y) - safeRadius);
    return zoneRotationUrgency({
      outsideCurrent: game.zone.isOutside(c.pos.x, c.pos.z),
      distanceOutsideNext,
      state: game.zone.state,
      timer: game.zone.timer,
    });
  }

  private pickRotationPoint(game: Game, out: THREE.Vector2): void {
    const c = this.char;
    const hasNext = game.zone.nextRadius < game.zone.radius - 0.5;
    const center = hasNext ? game.zone.nextCenter : game.zone.center;
    const radius = hasNext ? game.zone.nextRadius : game.zone.radius;
    const dx = c.pos.x - center.x;
    const dz = c.pos.z - center.y;
    const attemptOffset = this.rotationAttempt === 0
      ? 0
      : Math.ceil(this.rotationAttempt / 2) * 0.52 * (this.rotationAttempt % 2 === 0 ? -1 : 1);
    const baseAngle = Math.atan2(dz, dx) + attemptOffset;
    for (let ring = 0; ring < 3; ring++) {
      const targetRadius = Math.max(2, radius * (0.68 - ring * 0.18));
      for (let step = 0; step < 8; step++) {
        const offset = step === 0 ? 0 : Math.ceil(step / 2) * 0.34 * (step % 2 === 0 ? -1 : 1);
        const angle = baseAngle + offset;
        const x = center.x + Math.cos(angle) * targetRadius;
        const z = center.y + Math.sin(angle) * targetRadius;
        if (!game.world.pointFree(x, z, 0.55, WATER_Y + 0.2, 17)) continue;
        out.set(x, z);
        return;
      }
    }
    out.set(center.x, center.y);
  }

  // 将近战术移动点限制在当前安全区和可站立地面内, 避免岸边或墙角持续追逐不可达目标.
  private pickCombatMovePoint(game: Game, desiredX: number, desiredZ: number, distance: number): void {
    const c = this.char;
    const dx = desiredX - c.pos.x;
    const dz = desiredZ - c.pos.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.2) {
      this.tacticPoint.set(c.pos.x, c.pos.z);
      return;
    }
    const nx = dx / length;
    const nz = dz / length;
    const safeRadius = Math.max(1.5, game.zone.radius - 1.1);
    const offsets = [0, 0.42, -0.42, 0.84, -0.84, 1.26, -1.26, Math.PI] as const;
    const radii = [Math.min(distance, length), Math.min(distance * 0.65, length), Math.min(2.8, length)] as const;
    let bestScore = -Infinity;
    let bestX = c.pos.x;
    let bestZ = c.pos.z;
    for (const radius of radii) {
      if (radius < 0.6) continue;
      for (const offset of offsets) {
        const cos = Math.cos(offset);
        const sin = Math.sin(offset);
        const dirX = nx * cos - nz * sin;
        const dirZ = nx * sin + nz * cos;
        const x = c.pos.x + dirX * radius;
        const z = c.pos.z + dirZ * radius;
        if (game.zoneArmed && Math.hypot(x - game.zone.center.x, z - game.zone.center.y) > safeRadius) continue;
        const elevated = c.pos.y - game.world.getHeight(c.pos.x, c.pos.z) > 1.6;
        if (!game.world.navPointFree(x, z, c.pos.y, 0.52, false, false, elevated)) continue;
        const alignment = dirX * nx + dirZ * nz;
        const score = alignment * 3 + radius * 0.12;
        if (score <= bestScore) continue;
        bestScore = score;
        bestX = x;
        bestZ = z;
      }
    }
    this.tacticPoint.set(bestX, bestZ);
  }

  private hasUsableGun(): boolean {
    const c = this.char;
    return c.guns.some((gun) => gun !== null && gun.mag + c.ammo[gun.def.ammo] > 0);
  }

  private tryRecover(): boolean {
    const c = this.char;
    if (this.healCd > 0) return false;
    if (c.hp < 40 && c.heals.medkit > 0) {
      c.heals.medkit--;
      c.hp = 100;
      this.healCd = 4;
      return true;
    }
    if (c.hp < 75 && c.heals.bandage > 0) {
      c.heals.bandage--;
      c.hp = Math.min(75, c.hp + 15);
      this.healCd = 2;
      return true;
    }
    if (c.hp < 92 && c.heals.drink > 0) {
      c.heals.drink--;
      c.hp = Math.min(100, c.hp + 40);
      this.healCd = 2;
      return true;
    }
    return false;
  }

  private pickSearchPoint(game: Game): void {
    const c = this.char;
    for (let attempt = 0; attempt < 8; attempt++) {
      const step = this.searchStep + attempt;
      const radius = 4 + Math.min(16, step * 2.2);
      const angle = c.id * 0.71 + step * 2.399963;
      const x = this.searchOrigin.x + Math.cos(angle) * radius;
      const z = this.searchOrigin.z + Math.sin(angle) * radius;
      if (game.zone.isOutside(x, z) || !game.world.pointFree(x, z, 0.5, WATER_Y + 0.2, 16)) continue;
      this.searchStep = step + 1;
      this.moveTarget.set(x, 0, z);
      this.hasMoveTarget = true;
      this.repathT = 1.8;
      return;
    }
    this.moveTarget.copy(this.searchOrigin);
    this.hasMoveTarget = true;
    this.repathT = 1.2;
    this.searchStep++;
  }

  private tryPostCombatLoot(game: Game): boolean {
    const c = this.char;
    const crate = game.deathCrates.nearest(c.pos.x, c.pos.y, c.pos.z, 18);
    if (!crate) return false;
    if (game.zoneArmed && game.zone.isOutside(crate.group.position.x, crate.group.position.z)) return false;
    const distance = Math.hypot(crate.group.position.x - c.pos.x, crate.group.position.z - c.pos.z);
    if (distance <= 2.6) {
      autoLootDeathCrate(c, crate);
      game.deathCrates.consumeIfEmpty(crate);
      this.postCombatT = 0;
      this.hasMoveTarget = false;
      return true;
    }
    this.moveTarget.copy(crate.group.position);
    this.hasMoveTarget = true;
    this.repathT = 2.2;
    return true;
  }

  private setLootTarget(game: Game, item: LootItem): boolean {
    if (game.zoneArmed && game.zone.isOutside(item.group.position.x, item.group.position.z)) return false;
    if (item === this.blockedLoot && this.blockedLootT > 0) return false;
    this.lootTarget = item;
    this.moveTarget.copy(item.group.position);
    this.hasMoveTarget = true;
    this.repathT = 2.5;
    return true;
  }

  // 附近有活手雷: 反向全速逃离
  private fleeGrenade(dt: number, game: Game): boolean {
    const c = this.char;
    if (!game.grenades.nearestLiveFrag(c.pos.x, c.pos.y, c.pos.z, 6, this.fragOut)) return false;
    this.releaseVehicleTarget();
    const dx = c.pos.x - this.fragOut.x;
    const dz = c.pos.z - this.fragOut.z;
    const d = Math.hypot(dx, dz) || 1;
    this.navigator.move(
      c,
      c.pos.x + (dx / d) * 15,
      c.pos.z + (dz / d) * 15,
      6.2,
      dt,
      game.world,
      { stopDistance: 0.5, turnRate: 8, neighbors: game.chars },
    );
    return true;
  }

  private fleeBombardment(dt: number, game: Game): boolean {
    const c = this.char;
    if (!game.bombardment.escapeVector(c.pos.x, c.pos.z, game.tmpV2)) return false;
    this.releaseVehicleTarget();
    const speed = game.bombardment.state === 'active' ? 6.4 : 5.8;
    c.setStance('stand');
    this.navigator.move(
      c,
      c.pos.x + game.tmpV2.x * 22,
      c.pos.z + game.tmpV2.y * 22,
      speed,
      dt,
      game.world,
      { stopDistance: 0.5, turnRate: 7, neighbors: game.chars },
    );
    return true;
  }

  // 空降物理: 逼近终端速度, 缓推向投放点, 70m 自动开伞, 触地恢复
  private updateDescent(dt: number, game: Game): void {
    const c = this.char;
    const phase = this.descent;
    if (!phase) return;
    c.swimming = false;
    c.swimDip = 0;
    c.grounded = false;
    this.vy = stepAirDescentVelocity(this.vy, phase, dt);
    const dx = this.dropTarget.x - c.pos.x;
    const dz = this.dropTarget.z - c.pos.z;
    const dl = Math.hypot(dx, dz);
    const hv = this.descent === 'freefall' ? 7 : 5;
    if (dl > 1) {
      const push = Math.min(hv, dl * 0.5) * dt;
      c.pos.x += (dx / dl) * push;
      c.pos.z += (dz / dl) * push;
    }
    c.pos.y += this.vy * dt;
    if (dl > 2) c.yaw = Math.atan2(dx, dz);
    const agl = c.pos.y - game.world.getHeight(c.pos.x, c.pos.z);
    if (this.descent === 'freefall' && agl <= 70) {
      this.descent = 'canopy';
      this.vy = CANOPY_DEPLOY_VELOCITY;
      c.airPose = 'canopy';
      c.attachCanopy(BOT_CANOPIES[c.id % BOT_CANOPIES.length] as number);
    }
    const g = game.world.groundHeight(c.pos.x, c.pos.z, c.pos.y);
    if (c.pos.y <= g) this.finishDescent(g);
  }

  // 落地: 恢复站立/AI, 卸伞
  private finishDescent(groundY: number): void {
    const c = this.char;
    c.pos.y = groundY;
    c.vy = 0;
    this.vy = 0;
    this.descent = null;
    c.airPose = null;
    c.stance = 'stand';
    c.stanceF = 0;
    c.removeCanopy();
    this.navigator.reset(c);
  }

  // 闪避驶来载具: 车速>5 且朝我来(13m 内) → 侧向急躲
  private dodgeVehicle(dt: number, game: Game): boolean {
    const c = this.char;
    for (const v of game.vehicles.list) {
      if (Math.abs(v.speed) < 5) continue;
      const dx = c.pos.x - v.pos.x;
      const dz = c.pos.z - v.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 13) continue;
      const sign = v.speed >= 0 ? 1 : -1;
      const hx = Math.sin(v.yaw) * sign;
      const hz = Math.cos(v.yaw) * sign;
      if ((dx * hx + dz * hz) / (d || 1) < 0.55) continue; // 不朝我来
      const side = dx * hz - dz * hx > 0 ? 1 : -1;
      moveChar(c, hz * side * 4.8, -hx * side * 4.8, dt, game.world);
      return true;
    }
    return false;
  }

  private releaseVehicleTarget(): void {
    const target = this.vehicleTarget;
    if (target?.claimedBy === this.char) target.claimedBy = null;
    this.vehicleTarget = null;
    this.vehicleClaimT = 0;
  }

  private enterVehicle(v: Vehicle): void {
    const c = this.char;
    if (v.dead || v.burnT >= 0 || v.driver || c.knocked || !c.alive) {
      this.releaseVehicleTarget();
      return;
    }
    if (v.claimedBy === c) v.claimedBy = null;
    this.vehicleTarget = null;
    v.driver = c;
    this.driving = v;
    v.speed = Math.abs(v.speed) < 0.5 ? 0 : v.speed;
    c.airPose = 'sit';
    c.setStance('stand');
    c.stanceF = 0;
    c.moveLean = 0;
    c.vault = null;
    seatWorld(v, c.pos);
    c.yaw = v.yaw;
    this.vehicleStuckT = 0;
    this.vehicleProgressT = 0;
    this.vehicleProgress = 0;
    this.vehicleRecoveryT = 0;
    this.vehicleDetourT = 0;
    this.navigator.reset(c);
  }

  private exitVehicle(game: Game, forced: boolean): void {
    const v = this.driving;
    if (!v) return;
    const c = this.char;
    const offsets = [
      [Math.cos(v.yaw) * 2.2, -Math.sin(v.yaw) * 2.2],
      [-Math.cos(v.yaw) * 2.2, Math.sin(v.yaw) * 2.2],
      [-Math.sin(v.yaw) * 2.4, -Math.cos(v.yaw) * 2.4],
      [Math.sin(v.yaw) * 2.4, Math.cos(v.yaw) * 2.4],
    ] as const;
    let exitX = v.pos.x + offsets[0][0];
    let exitZ = v.pos.z + offsets[0][1];
    for (const [ox, oz] of offsets) {
      const x = v.pos.x + ox;
      const z = v.pos.z + oz;
      const ground = game.world.groundHeight(x, z, v.pos.y + 1.4);
      if (ground < WATER_Y - 0.05 || !game.world.navPointFree(x, z, v.pos.y, 0.5, false, false, true)) continue;
      exitX = x;
      exitZ = z;
      break;
    }
    c.pos.set(exitX, game.world.groundHeight(exitX, exitZ, v.pos.y + 1.4), exitZ);
    c.airPose = null;
    c.setStance('stand');
    c.stanceF = 0;
    c.vy = 0;
    c.moveLean = 0;
    c.speed2d = 0;
    if (v.driver === c) v.driver = null;
    v.speed = 0;
    this.driving = null;
    this.vehicleCooldown = forced ? 8 : 14;
    this.vehicleStuckT = 0;
    this.vehicleRecoveryT = 0;
    this.vehicleDetourT = 0;
    this.navigator.reset(c);
  }

  forceExitVehicle(game: Game): void {
    this.releaseVehicleTarget();
    this.exitVehicle(game, true);
  }

  private updateVehicleApproach(
    dt: number,
    game: Game,
    rotation: ZoneRotationUrgency,
    goalDistance: number,
  ): boolean {
    const c = this.char;
    let target = this.vehicleTarget;
    if (target && (target.dead || target.burnT >= 0 || target.driver ||
      (target.claimedBy && target.claimedBy !== c && target.claimedBy.alive))) {
      this.releaseVehicleTarget();
      target = null;
    }
    if (!target) {
      const candidate = game.vehicles.nearestClaimable(c.pos.x, c.pos.z, rotation === 'immediate' ? 58 : 42, c);
      if (!candidate) return false;
      const vehicleDistance = Math.hypot(candidate.pos.x - c.pos.x, candidate.pos.z - c.pos.z);
      if (!shouldSeekVehicle({
        mode: this.strategicMode,
        rotation,
        goalDistance,
        vehicleDistance,
        hp: c.hp,
        hasUsableGun: this.hasUsableGun(),
        cooldown: this.vehicleCooldown,
      })) return false;
      candidate.claimedBy = c;
      this.vehicleTarget = candidate;
      this.vehicleClaimT = 13;
      target = candidate;
      this.navigator.reset(c);
    }

    const targetDistance = Math.hypot(target.pos.x - c.pos.x, target.pos.z - c.pos.z);
    if (!shouldSeekVehicle({
      mode: this.strategicMode,
      rotation,
      goalDistance,
      vehicleDistance: targetDistance,
      hp: c.hp,
      hasUsableGun: this.hasUsableGun(),
      cooldown: 0,
    })) {
      this.releaseVehicleTarget();
      return false;
    }
    this.vehicleClaimT -= dt;
    if (this.vehicleClaimT <= 0) {
      this.releaseVehicleTarget();
      this.vehicleCooldown = 8;
      return false;
    }
    if (targetDistance <= 2.55) {
      this.enterVehicle(target);
      return true;
    }
    const nav = this.navigator.move(c, target.pos.x, target.pos.z, 5.5, dt, game.world, {
      stopDistance: 2.4,
      turnRate: 6,
      allowWater: false,
      neighbors: game.chars,
    });
    this.navigationIntent = !nav.reached;
    if (nav.reached) this.enterVehicle(target);
    return true;
  }

  private vehicleDirectionClear(v: Vehicle, yaw: number, lookAhead: number, game: Game): boolean {
    const spec = VEHICLE_SPEC[v.kind];
    let previousY = v.pos.y;
    const steps = 3;
    for (let step = 1; step <= steps; step++) {
      const distance = lookAhead * step / steps;
      const x = v.pos.x + Math.sin(yaw) * distance;
      const z = v.pos.z + Math.cos(yaw) * distance;
      const ground = game.world.groundHeight(x, z, previousY + 2.2);
      if (ground < WATER_Y - 0.05 || Math.abs(ground - previousY) > 2.8) return false;
      this.vehicleProbe.set(x, ground, z);
      if (game.world.resolveVehicle(this.vehicleProbe, spec.radius + 0.18) &&
        Math.hypot(this.vehicleProbe.x - x, this.vehicleProbe.z - z) > 0.08) return false;
      for (const other of game.vehicles.list) {
        if (other === v || other.dead) continue;
        const safe = spec.radius + VEHICLE_SPEC[other.kind].radius + 1.2;
        if (Math.hypot(x - other.pos.x, z - other.pos.z) < safe) return false;
      }
      previousY = ground;
    }
    return true;
  }

  private chooseVehicleYaw(v: Vehicle, goalX: number, goalZ: number, game: Game): number {
    const desired = Math.atan2(goalX - v.pos.x, goalZ - v.pos.z);
    const lookAhead = clamp(4.5 + Math.abs(v.speed) * 0.48, 5, 13);
    const offsets = [0, 0.28, -0.28, 0.55, -0.55, 0.9, -0.9, 1.25, -1.25, 1.65, -1.65] as const;
    let bestYaw = v.yaw + this.vehicleRecoverySide * 1.3;
    let bestScore = Infinity;
    for (const offset of offsets) {
      const yaw = desired + offset;
      if (!this.vehicleDirectionClear(v, yaw, lookAhead, game)) continue;
      const score = Math.abs(offset) * 1.8 + Math.abs(signedAngleDelta(v.yaw, yaw)) * 0.35;
      if (score >= bestScore) continue;
      bestScore = score;
      bestYaw = yaw;
    }
    return bestYaw;
  }

  private updateVehicleDrive(dt: number, game: Game): void {
    const v = this.driving;
    if (!v || v.driver !== this.char || v.dead) {
      this.exitVehicle(game, true);
      return;
    }
    let goalX = this.moveTarget.x;
    let goalZ = this.moveTarget.z;
    if (!this.hasMoveTarget) {
      this.pickRotationPoint(game, this.vehicleWaypoint);
      goalX = this.vehicleWaypoint.x;
      goalZ = this.vehicleWaypoint.y;
      this.moveTarget.set(goalX, 0, goalZ);
      this.hasMoveTarget = true;
    }
    const enemyDistance = this.target?.alive
      ? Math.hypot(this.target.pos.x - v.pos.x, this.target.pos.z - v.pos.z)
      : Infinity;
    if (this.target?.alive && enemyDistance > 52) {
      goalX = this.target.pos.x;
      goalZ = this.target.pos.z;
    }
    const goalDistance = Math.hypot(goalX - v.pos.x, goalZ - v.pos.z);
    const exitWanted = shouldExitVehicle({
      goalDistance,
      enemyDistance,
      hpFraction: v.hp / VEHICLE_SPEC[v.kind].hp,
      stuckFor: this.vehicleStuckT,
      burning: v.burnT >= 0,
    });
    if (exitWanted && Math.abs(v.speed) <= 2.2) {
      this.exitVehicle(game, false);
      if (goalDistance <= 11) this.hasMoveTarget = false;
      return;
    }

    let driveGoalX = goalX;
    let driveGoalZ = goalZ;
    if (findVehicleRiverWaypoint(this.vehicleWaypoint, v.pos.x, v.pos.z, goalX, goalZ)) {
      driveGoalX = this.vehicleWaypoint.x;
      driveGoalZ = this.vehicleWaypoint.y;
    }
    let throttle = exitWanted ? -1 : 1;
    let steer = 0;
    let handbrake = exitWanted;
    if (this.vehicleRecoveryT > 0) {
      this.vehicleRecoveryT = Math.max(0, this.vehicleRecoveryT - dt);
      throttle = -1;
      steer = this.vehicleRecoverySide;
      handbrake = false;
    } else {
      this.vehicleDetourT = Math.max(0, this.vehicleDetourT - dt);
      const selectedYaw = this.vehicleDetourT > 0
        ? this.vehicleDetourYaw
        : this.chooseVehicleYaw(v, driveGoalX, driveGoalZ, game);
      const delta = signedAngleDelta(v.yaw, selectedYaw);
      steer = clamp(delta / 0.55, -1, 1);
      if (Math.abs(delta) > 1.15 && Math.abs(v.speed) > 4) throttle = -1;
      else if (Math.abs(delta) > 0.75) throttle = 0.35;
      if (goalDistance < 25 && !exitWanted) throttle = Math.min(throttle, 0.55);
    }
    const result = driveVehicleStep(v, this.char, { throttle, steer, handbrake }, dt, game);
    if (result.stalled) return;

    this.navigationIntent = !exitWanted && goalDistance > 11;
    this.vehicleProgress += result.distance;
    this.vehicleProgressT += dt;
    if (result.collision) this.vehicleStuckT += dt * 1.5;
    if (this.vehicleProgressT >= 1) {
      if (this.vehicleProgress < 0.9 && goalDistance > 14) this.vehicleStuckT += this.vehicleProgressT;
      else this.vehicleStuckT = Math.max(0, this.vehicleStuckT - this.vehicleProgressT * 0.65);
      this.vehicleProgressT = 0;
      this.vehicleProgress = 0;
      if (this.vehicleStuckT >= 2.2 && this.vehicleRecoveryT <= 0 && !exitWanted) {
        this.vehicleRecoveryT = 1.15;
        this.vehicleRecoverySide *= -1;
        this.vehicleDetourT = 2.4;
        this.vehicleDetourYaw = v.yaw + this.vehicleRecoverySide * 1.05;
      }
    }
  }

  // 是否想要地上这件武器
  private wantsWeapon(kind: WeaponId | Exclude<MeleeId, 'fists'>): boolean {
    const c = this.char;
    if (isMeleeKind(kind)) return !c.hasGun() && c.melee.def.id === 'fists';
    if (!c.hasGun()) return true;
    if (kind === 'pistol') return false;
    let minTier = 99;
    for (const g of c.guns) {
      if (g && g.def.tier < minTier) minTier = g.def.tier;
    }
    return WEAPONS[kind].tier > minTier;
  }

  private scan(game: Game): void {
    const c = this.char;
    // 非交战时使用综合最优枪, 交战时按目标距离选枪
    const currentDistance = this.target?.alive
      ? Math.hypot(this.target.pos.x - c.pos.x, this.target.pos.z - c.pos.z)
      : -1;
    const best = currentDistance >= 0
      ? selectCombatGunSlot(c.guns, c.ammo, currentDistance)
      : c.bestGunSlot();
    if (this.reloadT <= 0) c.curSlot = best >= 0 ? best : 3;

    c.eyePos(this.eye);
    let nearest: Character | null = null;
    let bestScore = ENGAGE_DIST;
    let heard: Character | null = null;
    let heardScore = Infinity;
    for (const other of game.chars) {
      if (!other.alive || other === c) continue;
      const d = Math.hypot(other.pos.x - c.pos.x, other.pos.z - c.pos.z);
      const shotAge = game.nowSec - other.lastLoudShotT;
      if (shotAge >= 0 && shotAge < 1.4 && d < 115) {
        const score = d + shotAge * 18;
        if (score < heardScore) {
          heard = other;
          heardScore = score;
        }
      }
      // 灌木隐蔽: 目标在灌木足迹内按姿态压缩可侦距离; 开火暴露 2s 恢复常规
      let detect = ENGAGE_DIST;
      if (game.world.inBush(other.pos.x, other.pos.z) && game.nowSec - other.lastShotT > 2) {
        if (other.stance === 'prone') detect = other.speed2d < 0.3 ? 12 : 40;
        else if (other.stance === 'crouch') detect = other.speed2d < 0.3 ? 40 : 65;
      }
      if (d >= detect) continue;
      other.chestPos(this.tgtPos);
      if (game.isLOSBlocked(this.eye, this.tgtPos, this.dir)) continue;
      // 保持当前目标并优先反击最近攻击者，防止多人交火时每 0.25 秒来回切目标。
      let score = d;
      if (other === this.target) score -= 12;
      if (other.id === c.lastAttackerId) score -= 18;
      if (other.knocked) score += 10;
      if (score >= bestScore) continue;
      nearest = other;
      bestScore = score;
    }
    if (nearest) {
      if (this.target !== nearest) {
        this.target = nearest;
        this.reactT = rand(0.3, 0.8);
        this.burstLeft = 0;
        this.burstCd = 0;
        this.engageCrouch = random() < 0.15; // 15% 概率本次交战蹲下对枪
        this.tacticT = 0;
        this.navigator.reset(c);
      }
      const distance = Math.hypot(nearest.pos.x - c.pos.x, nearest.pos.z - c.pos.z);
      const combatSlot = selectCombatGunSlot(c.guns, c.ammo, distance);
      if (combatSlot >= 0 && this.reloadT <= 0) c.curSlot = combatSlot;
      this.state = 'engage';
      this.losOk = true;
      this.lostT = 0;
    } else if (this.state === 'engage') {
      // 目标暂不可见, 交给 lostT 逻辑
      this.losOk = false;
    } else if (heard) {
      this.moveTarget.copy(heard.pos);
      this.searchOrigin.copy(heard.pos);
      this.searchStep = 0;
      this.hasMoveTarget = true;
      this.investigateT = 5.5;
      this.repathT = 2.2;
    }
  }

  private updateEngage(dt: number, game: Game): void {
    const c = this.char;
    this.releaseVehicleTarget();
    this.lootTarget = null;
    this.strategicStuckT = 0;
    this.strategicProgressT = 0;
    const t = this.target as Character;
    if (!t.alive) {
      this.lastKnown.copy(t.pos);
      this.moveTarget.copy(t.pos);
      this.searchOrigin.copy(t.pos);
      this.searchStep = 0;
      this.postCombatT = 8;
      this.target = null;
      this.state = 'wander';
      this.hasMoveTarget = true;
      this.repathT = 2.5;
      c.setStance('stand');
      this.navigator.reset(c);
      return;
    }
    const dx = t.pos.x - c.pos.x;
    const dz = t.pos.z - c.pos.z;
    const dist = Math.hypot(dx, dz);
    const desiredYaw = Math.atan2(dx, dz);
    const combatSlot = selectCombatGunSlot(c.guns, c.ammo, dist);
    if (combatSlot >= 0 && this.reloadT <= 0) c.curSlot = combatSlot;
    const held = c.heldGun();
    const meleeOnly = !held;
    const preferred = preferredCombatRange(held?.def.id ?? null);
    // 周期性 LOS 复核
    this.losT -= dt;
    if (this.losT <= 0) {
      this.losT = 0.35;
      c.eyePos(this.eye);
      t.chestPos(this.tgtPos);
      this.losOk = !game.isLOSBlocked(this.eye, this.tgtPos, this.dir);
    }
    if (this.losOk) {
      this.lostT = 0;
      this.lastKnown.copy(t.pos);
    } else {
      this.lostT += dt;
      if (this.lostT > 2.5 || dist > ENGAGE_DIST + 20) {
        this.target = null;
        this.state = 'wander';
        c.setStance('stand');
        this.moveTarget.copy(this.lastKnown);
        this.searchOrigin.copy(this.lastKnown);
        this.searchStep = 0;
        this.hasMoveTarget = true;
        this.repathT = rand(2, 4);
        this.investigateT = 6;
        this.navigator.reset(c);
        return;
      }
    }

    // 扔雷: 持步枪/冲锋枪, 目标在 8-30m 且几乎静止超过 2.5s, 扔出唯一一颗手雷
    const gunId = c.heldGun()?.def.id;
    if (!this.fragUsed && c.throwables.frag > 0 && this.losOk &&
      (gunId === 'rifle' || gunId === 'akm' || gunId === 'dmr' || gunId === 'smg') && dist >= 8 && dist <= 30) {
      if (t.speed2d < 0.6) this.stillT += dt; else this.stillT = 0;
      if (this.stillT > 2.5) {
        this.throwFrag(t, dist, game);
        return;
      }
    } else {
      this.stillT = 0;
    }

    // 战术移动按毒圈, 视野, 血量, 换弹和武器射程选择稳定目标点.
    // 目标点短时间保持, 避免逐帧左右翻转.
    const rotation = this.rotationUrgency(game);
    const terminalDuel = game.zone.state === 'done' && game.aliveCount <= 3;
    if (!terminalDuel && shouldDeploySmoke({
      hasSmoke: c.throwables.smoke > 0,
      alreadyUsed: this.smokeUsed,
      hp: c.hp,
      reloading: this.reloadT > 0,
      rotation,
      hasLineOfSight: this.losOk,
      distance: dist,
    })) {
      this.throwSmokeScreen(t, dist, game);
      return;
    }
    this.tacticT -= dt;
    const shouldRefreshTactic = this.tacticT <= 0 ||
      (rotation === 'immediate' && this.tacticMode !== 'rotate');
    if (shouldRefreshTactic) {
      this.tacticT = rand(0.75, 1.35);
      this.strafeDir = random() < 0.35 ? -this.strafeDir : this.strafeDir;
      let coverAvailable = false;
      const wantsCover = !meleeOnly && (this.reloadT > 0 || c.hp < 42);
      if (wantsCover && findCoverPoint(this.tacticPoint, c, t, game.world, 14) &&
        !game.zone.isOutside(this.tacticPoint.x, this.tacticPoint.y)) {
        coverAvailable = true;
      }
      this.tacticMode = chooseCombatMode({
        rotation,
        terminalDuel,
        hp: c.hp,
        reloading: this.reloadT > 0,
        hasLineOfSight: this.losOk,
        coverAvailable,
        meleeOnly,
        distance: dist,
        preferredRange: preferred,
      });
      if (this.tacticMode !== 'rotate') this.rotationAttempt = 0;
      const nx = dx / (dist || 1);
      const nz = dz / (dist || 1);
      if (this.tacticMode === 'rotate') {
        this.pickRotationPoint(game, this.tacticPoint);
      } else if (this.tacticMode === 'search') {
        this.tacticPoint.set(
          this.lastKnown.x - nz * this.strafeDir * Math.min(11, dist * 0.35),
          this.lastKnown.z + nx * this.strafeDir * Math.min(11, dist * 0.35),
        );
      } else if (this.tacticMode === 'advance') {
        this.tacticPoint.set(t.pos.x, t.pos.z);
      } else if (this.tacticMode === 'retreat') {
        this.pickCombatMovePoint(game, c.pos.x - nx * 10, c.pos.z - nz * 10, 10);
      } else if (this.tacticMode === 'strafe') {
        this.pickCombatMovePoint(
          game,
          c.pos.x - nz * this.strafeDir * 7,
          c.pos.z + nx * this.strafeDir * 7,
          7,
        );
      }
    }

    let combatGoalX = c.pos.x;
    let combatGoalZ = c.pos.z;
    let stopDistance = 1.1;
    let combatSpeed = meleeOnly ? 5.4 : 3.8;
    combatGoalX = this.tacticPoint.x;
    combatGoalZ = this.tacticPoint.y;
    if (this.tacticMode === 'rotate') {
      combatSpeed = 5.7;
    } else if (this.tacticMode === 'advance') {
      combatGoalX = t.pos.x;
      combatGoalZ = t.pos.z;
      stopDistance = preferred;
      combatSpeed = meleeOnly ? 5.4 : dist > preferred * 1.8 ? 5.0 : 4.1;
    } else if (this.tacticMode === 'cover') {
      combatSpeed = 5.2;
    } else if (this.tacticMode === 'search') {
      combatSpeed = 4.8;
    } else if (this.tacticMode === 'retreat') {
      combatSpeed = 4.9;
    }
    if (findBridgeExit(this.bridgeWaypoint, c.pos.x, c.pos.z, combatGoalX, combatGoalZ)) {
      combatGoalX = this.bridgeWaypoint.x;
      combatGoalZ = this.bridgeWaypoint.y;
      stopDistance = 0.9;
    }
    const allowCombatWater = this.tacticMode === 'advance' ||
      (this.tacticMode === 'rotate' && rotation === 'immediate');
    const allowCombatDrop = c.pos.y - game.world.getHeight(c.pos.x, c.pos.z) > 1.6;
    if (allowCombatWater) {
      this.moveTarget.set(combatGoalX, 0, combatGoalZ);
      this.hasMoveTarget = true;
    }
    const nav = this.navigator.move(
      c,
      combatGoalX,
      combatGoalZ,
      combatSpeed,
      dt,
      game.world,
      {
        stopDistance,
        turnRate: meleeOnly ? 6.5 : 4.8,
        allowWater: allowCombatWater,
        allowDrop: allowCombatDrop,
        neighbors: game.chars,
      },
    );
    this.navigationIntent = !nav.reached;
    if (nav.reached || nav.moved >= 0.025) {
      this.combatStuckT = Math.max(0, this.combatStuckT - dt * 2);
      if (nav.reached) this.rotationAttempt = 0;
    } else if (this.navigationIntent) {
      this.combatStuckT += dt;
      if (this.combatStuckT >= 2.2) {
        this.combatStuckT = 0;
        this.routeSide *= -1;
        if (this.tacticMode === 'rotate') {
          this.rotationAttempt = (this.rotationAttempt + 1) % 8;
          this.tacticT = 0;
        } else {
          const invDist = 1 / (dist || 1);
          const sideX = -dz * invDist * this.routeSide;
          const sideZ = dx * invDist * this.routeSide;
          this.pickCombatMovePoint(game, c.pos.x + sideX * 7, c.pos.z + sideZ * 7, 7);
          this.tacticMode = 'search';
          this.tacticT = 1.6;
        }
        this.navigator.reset(c);
      }
    }
    if (nav.reached && this.tacticMode === 'cover' && !this.losOk) this.tryRecover();
    const reloadGun = c.heldGun();
    if (this.reloadT <= 0 && shouldTacticalReload(
      reloadGun,
      reloadGun ? c.ammo[reloadGun.def.ammo] : 0,
      true,
      this.losOk,
    ) && (this.tacticMode === 'cover' || this.tacticMode === 'search' || this.tacticMode === 'retreat')) {
      this.reloadT = reloadGun?.def.reloadTime ?? 0;
    }
    // 交战姿态仅在掩体/稳固射击点使用，移动和近战保持站立。
    if (!meleeOnly && this.engageCrouch && dist > 20 && (nav.reached || this.tacticMode === 'cover')) {
      c.setStance('crouch');
    } else {
      c.setStance('stand');
    }
    if (this.losOk && !meleeOnly) {
      c.yaw = turnToward(c.yaw, desiredYaw, 7.5 * dt);
    }

    // 攻击
    if (this.reactT > 0) {
      this.reactT -= dt;
      return;
    }
    if (this.tacticMode === 'rotate' && rotation === 'immediate' && game.zone.state !== 'done' && dist > 12) return;
    // 交战中被可翻越障碍(窗台/矮墙)挡住且目标在对面: 翻越过去
    this.vaultProbeT -= dt;
    if (this.vaultProbeT <= 0) {
      this.vaultProbeT = 0.3;
      if (nav.blocked && !c.vault && c.vaultCd <= 0 && dist > 1.6) {
        const probe = probeVault(c, combatGoalX - c.pos.x, combatGoalZ - c.pos.z, game.world);
        if (probe) {
          const dLand = Math.hypot(probe.landX - t.pos.x, probe.landZ - t.pos.z);
          if (dLand < dist - 1) {
            if (probe.win && probe.win.alive) game.hitDestructible(probe.win, 999, c.pos);
            startVault(c, probe);
            game.soundAt(c.pos, (dd, p) => game.audio.melee(dd, p));
            return;
          }
        }
      }
    }
    if (meleeOnly) {
      if (dist < c.melee.def.range * 1.05) {
        c.yaw = turnToward(c.yaw, desiredYaw, 10 * dt);
        if (angleDiff(c.yaw, desiredYaw) < 0.3) game.meleeAttack(c);
      }
      return;
    }
    const gun = c.heldGun();
    if (!gun || this.reloadT > 0 || !this.losOk) return;
    if (angleDiff(c.yaw, desiredYaw) > 0.22) return;
    if (gun.def.id === 'shotgun' && dist > 26) return; // 霰弹只在近距离开火(远则继续逼近)

    if (this.burstLeft > 0) {
      this.shotT -= dt;
      if (this.shotT <= 0 && this.fireTimer <= 0) {
        this.fireAt(t, dist, game);
        this.burstLeft--;
        this.shotT = gun.def.fireInterval * rand(1.35, 1.9);
        if (this.burstLeft <= 0) this.burstCd = rand(0.5, 1.1);
      }
    } else {
      this.burstCd -= dt;
      if (this.burstCd <= 0) {
        this.burstLeft = gun.def.auto ? randInt(3, 6) : 1;
      }
    }
  }

  // 扔手雷: 出手点略向前, 目标点 ±2.5m 随机偏移, 上抬量随距离
  private throwFrag(t: Character, dist: number, game: Game): void {
    const c = this.char;
    c.chestPos(this.eye);
    const nx = (t.pos.x - c.pos.x) / (dist || 1);
    const nz = (t.pos.z - c.pos.z) / (dist || 1);
    this.eye.x += nx * 0.4;
    this.eye.z += nz * 0.4;
    const tx = t.pos.x + (random() - 0.5) * 5;
    const tz = t.pos.z + (random() - 0.5) * 5;
    const dx = tx - this.eye.x;
    const dz = tz - this.eye.z;
    const dl = Math.hypot(dx, dz) || 1;
    const up = 0.35 + dist * 0.008;
    this.dir.set(dx / dl, up, dz / dl).normalize();
    const speed = clamp(dist * 0.85, 8, 13);
    game.throwGrenade(c, 'frag', this.eye, this.dir, speed);
    c.throwables.frag--;
    this.fragUsed = true;
    c.swingT = 1;
  }

  private throwSmokeScreen(t: Character, dist: number, game: Game): void {
    const c = this.char;
    c.chestPos(this.eye);
    const dx = t.pos.x - c.pos.x;
    const dz = t.pos.z - c.pos.z;
    const dl = Math.hypot(dx, dz) || 1;
    this.eye.x += dx / dl * 0.35;
    this.eye.z += dz / dl * 0.35;
    this.dir.set(dx / dl, 0.5, dz / dl).normalize();
    game.throwGrenade(c, 'smoke', this.eye, this.dir, clamp(dist * 0.42, 7, 11));
    c.throwables.smoke--;
    this.smokeUsed = true;
    c.swingT = 1;
  }

  private fireAt(t: Character, dist: number, game: Game): void {
    const c = this.char;
    const gun = c.heldGun();
    if (!gun || gun.mag <= 0) return;
    c.eyePos(this.eye);
    t.chestPos(this.aim);
    // 距离/移动相关误差
    const sigma = 0.028 + dist * 0.00055 + (t.speed2d > 5 ? 0.024 : 0) + (t.isPlayer ? 0.007 : 0);
    const errR = dist * Math.tan(sigma) * Math.sqrt(random());
    const errA = random() * Math.PI * 2;
    this.aim.x += Math.cos(errA) * errR;
    this.aim.z += Math.sin(errA) * errR;
    this.aim.y += (random() - 0.5) * errR * 0.7;
    this.dir.subVectors(this.aim, this.eye).normalize();
    if (game.fireWeapon(c, this.eye, this.dir, 0)) {
      this.fireTimer = gun.def.fireInterval;
      if (gun.mag <= 0 && c.ammo[gun.def.ammo] > 0) this.reloadT = gun.def.reloadTime;
    }
  }

  // 被门/窗挡路: 关着的门停顿 ~0.4s 后开门通过; 窗(或近战冲锋时)累计 1s 直接破坏
  private updateDoorBreak(dt: number, game: Game): void {
    const c = this.char;
    const rage = this.state === 'engage' && !c.heldGun(); // 近战冲锋: 直接砸
    const wantsMove =
      (this.state === 'wander' && this.hasMoveTarget) || this.state === 'engage' || rage;
    this.blockCheckT -= dt;
    if (this.blockCheckT <= 0) {
      this.blockCheckT = 0.15;
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      this.blockedDoor = wantsMove ? game.findBlockingDoor(c, fx, fz) : null;
      if (!this.blockedDoor) this.blockT = 0;
    }
    const d = this.blockedDoor;
    if (!d || !d.alive || !wantsMove || d.collider.off) {
      this.blockT = 0;
      return;
    }
    this.blockT += dt;
    // 关着的门: 非狂暴状态下开门而不是砸门
    if (d.kind === 'door' && !rage) {
      if (this.blockT > 0.4) {
        game.openDoor(d);
        this.blockedDoor = null;
        this.blockT = 0;
      }
      return;
    }
    if (this.blockT <= 1.0) return;
    // 面向目标破坏物开火/挥刀
    c.yaw = Math.atan2(d.cx - c.pos.x, d.cz - c.pos.z);
    const gun = c.heldGun();
    if (gun && gun.mag > 0) {
      if (this.fireTimer <= 0) {
        c.eyePos(this.eye);
        this.aim.set(d.cx, d.cy, d.cz);
        this.dir.subVectors(this.aim, this.eye).normalize();
        if (game.fireWeapon(c, this.eye, this.dir, 0)) {
          this.fireTimer = gun.def.fireInterval * 1.6;
          if (gun.mag <= 0 && c.ammo[gun.def.ammo] > 0) this.reloadT = gun.def.reloadTime;
        }
      }
    } else {
      game.meleeAttack(c);
    }
    if (!d.alive) {
      this.blockedDoor = null;
      this.blockT = 0;
    }
  }

  private updateWander(dt: number, game: Game): void {
    const c = this.char;
    if (this.lootTarget && !this.lootTarget.active) {
      this.lootTarget = null;
      this.hasMoveTarget = false;
      this.repathT = 0;
    }
    this.repathT -= dt;
    this.lootScanT -= dt;
    this.investigateT = Math.max(0, this.investigateT - dt);
    const bestSlot = c.bestGunSlot();
    const tier = bestSlot >= 0 ? (c.guns[bestSlot]?.def.tier ?? 0) : 0;
    const needAmmo = this.needsAmmoType();
    const hasHeal = c.heals.bandage + c.heals.medkit + c.heals.drink > 0;
    const needsGear = tier < 2 || needAmmo !== null || !c.helmet || !c.vest || !c.pack;
    const rotation = this.rotationUrgency(game);
    this.strategicMode = chooseStrategicMode({
      rotation,
      hp: c.hp,
      hasHeal,
      hasGun: c.hasGun(),
      hasAmmo: this.hasUsableGun(),
      needsGear,
      recentThreat: this.investigateT > 0,
      postCombat: this.postCombatT > 0,
    });
    if (this.strategicMode !== 'rotate' && this.strategicMode !== 'hunt' && this.strategicMode !== 'patrol') {
      this.releaseVehicleTarget();
    }
    if (this.strategicMode !== 'loot') this.lootTarget = null;

    let targetDist = this.hasMoveTarget
      ? Math.hypot(this.moveTarget.x - c.pos.x, this.moveTarget.z - c.pos.z)
      : Infinity;
    const needsNewTarget = !this.hasMoveTarget || this.repathT <= 0 || targetDist < 2.5;

    if (this.strategicMode === 'recover') {
      this.strategicStuckT = 0;
      this.strategicProgressT = 0;
      c.setStance('crouch');
      moveChar(c, 0, 0, dt, game.world);
      this.tryRecover();
      return;
    }
    c.setStance('stand');

    if (this.strategicMode === 'rotate' && needsNewTarget) {
      this.pickRotationPoint(game, game.tmpV2);
      this.moveTarget.set(game.tmpV2.x, 0, game.tmpV2.y);
      this.hasMoveTarget = true;
      this.repathT = rotation === 'immediate' ? 2.5 : 4.5;
      this.navigator.reset(c);
    } else if (this.strategicMode === 'postcombat') {
      if (!this.tryPostCombatLoot(game)) this.postCombatT = 0;
    } else if (this.strategicMode === 'hunt' && needsNewTarget) {
      this.pickSearchPoint(game);
    } else if (this.strategicMode === 'patrol' && needsNewTarget) {
      this.repathT = rand(4, 9);
      this.pickWanderPoint(game);
    }

    // 搜索阶段优先恢复品, 弹药和可用武器, 再补护具与背包.
    let gearFound = false;
    if (rotation === 'none' && this.strategicMode === 'loot' && this.lootScanT <= 0) {
      this.lootScanT = tier === 0 ? 0.35 : 0.75;
      if (c.hp < 65 && !hasHeal) {
        const item = game.loot.nearestRecovery(c.pos.x, c.pos.y, c.pos.z, 42);
        if (item) gearFound = this.setLootTarget(game, item);
      }
      if (!gearFound && needAmmo) {
        const ai = game.loot.nearestAmmoOfType(c.pos.x, c.pos.y, c.pos.z, 45, needAmmo);
        if (ai) gearFound = this.setLootTarget(game, ai);
      }
      if (!gearFound && tier < 3) {
        const item = game.loot.nearestWeapon(c.pos.x, c.pos.y, c.pos.z, tier === 0 ? 50 : 16);
        if (item) {
          const k = item.kind;
          if (isWeaponKind(k) && this.wantsWeapon(k)) {
            gearFound = this.setLootTarget(game, item);
          }
        }
      }
      if (!gearFound && (!c.helmet || !c.vest || c.helmet.level < 3 || c.vest.level < 3)) {
        const ai = game.loot.nearestArmor(c.pos.x, c.pos.y, c.pos.z, 26);
        if (ai && this.wantsArmor(ai.kind)) gearFound = this.setLootTarget(game, ai);
      }
      if (!gearFound && (!c.pack || c.pack.level < 3)) {
        const item = game.loot.nearestPack(c.pos.x, c.pos.y, c.pos.z, 24);
        const level = item ? packLevelFromLoot(item.kind) : null;
        if (item && level && level > (c.pack?.level ?? 0)) {
          gearFound = this.setLootTarget(game, item);
        }
      }

      // 空投好奇: 被抽中的附近 bot 改道去摸空投
      if (!gearFound) {
        const cp = game.airdrop.investigatePoint(c.id);
        if (cp && (!game.zoneArmed || !game.zone.isOutside(cp.x, cp.z))) {
          this.moveTarget.set(cp.x, 0, cp.z);
          this.hasMoveTarget = true;
          this.repathT = 3;
        }
      }
    }
    if (this.strategicMode === 'loot' && needsNewTarget && !gearFound) {
      this.repathT = rand(3.5, 7);
      this.pickWanderPoint(game);
    }

    if (bestSlot >= 0 && this.reloadT <= 0 && c.curSlot >= 3) c.curSlot = bestSlot;
    const reloadGun = c.heldGun();
    if (this.reloadT <= 0 && shouldTacticalReload(
      reloadGun,
      reloadGun ? c.ammo[reloadGun.def.ammo] : 0,
      false,
      false,
    )) {
      this.reloadT = reloadGun?.def.reloadTime ?? 0;
    }

    targetDist = this.hasMoveTarget
      ? Math.hypot(this.moveTarget.x - c.pos.x, this.moveTarget.z - c.pos.z)
      : Infinity;
    if (this.hasMoveTarget && this.updateVehicleApproach(dt, game, rotation, targetDist)) {
      this.strategicStuckT = 0;
      this.strategicProgressT = 0;
      return;
    }

    if (this.hasMoveTarget) {
      if (this.strategicProgressT <= 0) {
        this.strategicProgressX = c.pos.x;
        this.strategicProgressZ = c.pos.z;
      }
      const dx = this.moveTarget.x - c.pos.x;
      const dz = this.moveTarget.z - c.pos.z;
      const bridgeExit = findBridgeExit(
        this.bridgeWaypoint,
        c.pos.x,
        c.pos.z,
        this.moveTarget.x,
        this.moveTarget.z,
      );
      const navGoalX = bridgeExit ? this.bridgeWaypoint.x : this.moveTarget.x;
      const navGoalZ = bridgeExit ? this.bridgeWaypoint.y : this.moveTarget.z;
      const speed = this.strategicMode === 'rotate'
        ? rotation === 'immediate' ? 5.7 : 5.1
        : this.strategicMode === 'hunt' ? 4.7
          : tier === 0 ? 4.6 : 4.0;
      const nav = this.navigator.move(
        c,
        navGoalX,
        navGoalZ,
        speed,
        dt,
        game.world,
        {
          stopDistance: 1.25,
          turnRate: 4.5,
          allowDrop: c.pos.y - game.world.getHeight(c.pos.x, c.pos.z) > 1.6,
          neighbors: game.chars,
        },
      );
      this.lastNavMoved = nav.moved;
      this.lastNavBlocked = nav.blocked;
      this.lastNavStuck = nav.stuckFor;
      this.navigationIntent = !nav.reached;
      this.strategicProgressT += dt;
      if (nav.reached) {
        this.strategicStuckT = 0;
        this.strategicProgressT = 0;
        this.rotationAttempt = 0;
      } else if (nav.moved < 0.025) {
        this.strategicStuckT += dt;
      }
      if (!nav.reached && this.strategicProgressT >= 4) {
        const netMovement = Math.hypot(
          c.pos.x - this.strategicProgressX,
          c.pos.z - this.strategicProgressZ,
        );
        if (netMovement < 0.8) this.strategicStuckT = Math.max(this.strategicStuckT, this.strategicProgressT);
        else this.strategicStuckT = Math.max(0, this.strategicStuckT - this.strategicProgressT * 1.2);
        this.strategicProgressT = 0;
      }
      if (this.strategicStuckT >= 4) {
        const allowDrop = c.pos.y - game.world.getHeight(c.pos.x, c.pos.z) > 1.6;
        const localEscape = findLocalEscape(
          this.tacticPoint,
          c.pos.x,
          c.pos.z,
          c.pos.y,
          navGoalX,
          navGoalZ,
          game.world,
          allowDrop,
        );
        const emergencyEscape = !localEscape && !c.swimming && !c.vault && findEmergencyNavPoint(
          this.tacticPoint,
          c.pos.x,
          c.pos.z,
          c.pos.y,
          navGoalX,
          navGoalZ,
          game.world,
          allowDrop,
        );
        if (emergencyEscape) {
          c.pos.x = this.tacticPoint.x;
          c.pos.z = this.tacticPoint.y;
          c.pos.y = game.world.groundHeight(c.pos.x, c.pos.z, c.pos.y + 0.4);
          c.groundH = c.pos.y;
          c.grounded = true;
          c.speed2d = 0;
        }
        this.strategicStuckT = 0;
        this.strategicProgressT = 0;
        if (this.strategicMode === 'loot' && this.lootTarget) {
          this.blockedLoot = this.lootTarget;
          this.blockedLootT = 18;
        }
        this.lootTarget = null;
        this.hasMoveTarget = localEscape && !emergencyEscape;
        if (localEscape) {
          this.moveTarget.set(this.tacticPoint.x, 0, this.tacticPoint.y);
          this.repathT = 1.25;
        } else {
          this.repathT = 0;
        }
        this.lootScanT = Math.max(this.lootScanT, 4);
        this.routeSide *= -1;
        this.rotationAttempt = (this.rotationAttempt + 1) % 8;
        this.navigator.reset(c);
      }
      if (nav.reached && !bridgeExit) this.hasMoveTarget = false;
      this.vaultProbeT -= dt;
      if (nav.blocked && this.vaultProbeT <= 0 && !c.vault && c.vaultCd <= 0) {
        this.vaultProbeT = 0.35;
        const probe = probeVault(c, dx, dz, game.world);
        if (probe) {
          if (probe.win?.alive) game.hitDestructible(probe.win, 999, c.pos);
          startVault(c, probe);
          game.soundAt(c.pos, (dd, p) => game.audio.melee(dd, p));
        }
      }
    } else {
      this.strategicStuckT = 0;
      this.strategicProgressT = 0;
      moveChar(c, 0, 0, dt, game.world);
    }
  }

  private pickWanderPoint(game: Game): void {
    const c = this.char;
    const bestSlot = c.bestGunSlot();
    const bestGun = bestSlot >= 0 ? c.guns[bestSlot] : null;
    this.routeRole = !bestGun
      ? 'advance'
      : c.hp < 60 || bestGun.def.id === 'dmr' || bestGun.def.id === 'sniper'
        ? 'defend'
        : this.routeRole;
    if (random() < 0.65) {
      let foundRoute = findTacticalRouteWaypoint(game.tmpV2, c.pos.x, c.pos.z, this.routeRole, this.routeSide, 115) ||
        findTacticalRouteWaypoint(game.tmpV2, c.pos.x, c.pos.z, null, this.routeSide, 115);
      if (!foundRoute) {
        this.routeSide *= -1;
        foundRoute = findTacticalRouteWaypoint(game.tmpV2, c.pos.x, c.pos.z, this.routeRole, this.routeSide, 115) ||
          findTacticalRouteWaypoint(game.tmpV2, c.pos.x, c.pos.z, null, this.routeSide, 115);
      }
      if (foundRoute && !game.zone.isOutside(game.tmpV2.x, game.tmpV2.y) &&
        game.world.pointFree(game.tmpV2.x, game.tmpV2.y, 0.5, WATER_Y + 0.4, 14)) {
        this.moveTarget.set(game.tmpV2.x, 0, game.tmpV2.y);
        this.hasMoveTarget = true;
        return;
      }
    }
    // 随圈缩紧, 点位逐渐偏向圈中心
    const pull = Math.min(0.75, Math.max(0, 1 - game.zone.radius / 300));
    for (let i = 0; i < 4; i++) {
      const a = random() * Math.PI * 2;
      const d = rand(15, 55);
      let x = c.pos.x + Math.cos(a) * d;
      let z = c.pos.z + Math.sin(a) * d;
      x += (game.zone.center.x - x) * pull * random();
      z += (game.zone.center.y - z) * pull * random();
      if (!game.zone.isOutside(x, z) && game.world.pointFree(x, z, 0.5, WATER_Y + 0.4, 14)) {
        this.moveTarget.set(x, 0, z);
        this.hasMoveTarget = true;
        return;
      }
    }
    // 找不到就直接朝圈心走
    game.zone.randomPointInside(game.tmpV2, 0.5);
    this.moveTarget.set(game.tmpV2.x, 0, game.tmpV2.y);
    this.hasMoveTarget = true;
  }
}

export const BOT_NAMES = [
  '伏地魔', '突击手', '刚枪王', '快递员', '盒子精', '跑毒仔', '苟分佬', '枪神',
  '萌新', '大佬', '草丛伦', '天命圈', '平底锅', '三级头', '空投猎手', '幻影坦克',
  '雷神', '鹰眼', '毒奶', '吃鸡少年', '人体描边', '万事屋', '夜猫子',
];
