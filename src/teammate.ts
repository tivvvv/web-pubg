// ─────────────────────────────────────────────────────────────────────────────
// teammate.ts - 队友 AI: 跟随/交战/乘车/跳伞; 与 enemy BotController 共享战斗原语
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import {
  CANOPY_DEPLOY_VELOCITY, Character, moveChar, stepAirDescentVelocity, SWIM_SPRINT_SPEED,
} from './character';
import type { Game } from './game';
import type { PlayerController } from './player';
import { isGunKind, isWeaponKind, type LootItem } from './loot';
import { armorFromLoot, isArmorKind } from './armor';
import { isPackKind, packLevelFromLoot } from './backpack';
import { ATTACHMENTS, attachFromLoot, canAttach, isAttachKind, magSizeOf } from './attachments';
import { seatWorldAt, type Vehicle } from './vehicles';
import { random } from './random';
import { probeVault, startVault, updateVaultMotion } from './vault';
import { THROWABLES, WEAPONS, ammoTypeFromLoot } from './weapons';
import { angleDiff, rand, turnToward } from './utils';
import { AgentNavigator, allyBlocksShot, findCoverPoint, findSwimBank } from './botnav';
import type { DestructibleLike } from './types';
import { WATER_Y } from './world';
import { squadFormationTarget, type SquadMateOrderState } from './squadcommands';
import { reloadDuration } from './gunplay';

const ENGAGE_RANGE = 60;
const FOCUS_RANGE = 180;

export class TeammateController {
  readonly char: Character;
  descent: 'plane' | 'freefall' | 'canopy' | null = null;
  vy = 0;
  riding: Vehicle | null = null;
  seatIdx = -1;
  commandState: SquadMateOrderState = 'following';
  private followAng: number;
  private followDist: number;
  private jumpSlot: number;
  private target: Character | null = null;
  private lostT = 0;
  private scanT = 0;
  private fireTimer = 0;
  private burstLeft = 0;
  private burstCd = 0;
  private shotT = 0;
  private reloadT = 0;
  private reactT = 0;
  private healCd = 0;
  private stuckT = 0;
  private vaultProbeT = 0; // 翻越探测节流
  private strafeDir = 1;
  private navigator = new AgentNavigator();
  private tacticPoint = new THREE.Vector2();
  private tacticT = 0;
  private tacticMode: 'advance' | 'strafe' | 'retreat' | 'cover' | 'search' = 'advance';
  private losOk = false;
  private lastKnown = new THREE.Vector3();
  private lootTarget: LootItem | null = null;
  private lootScanT = 0;
  private swimBank = new THREE.Vector2();
  private hasSwimBank = false;
  private swimRepathT = 0;
  private swimLastX = 0;
  private swimLastZ = 0;
  private blockedDoor: DestructibleLike | null = null;
  private blockCheckT = 0;
  private blockT = 0;
  private fragOut = { x: 0, z: 0 };
  private eye = new THREE.Vector3();
  private tgt = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private aim = new THREE.Vector3();
  private commandSerial = -1;
  private commandAnchor = new THREE.Vector2();

  constructor(name: string, shirtColor: number, jumpSlot = 1) {
    this.char = new Character(name, false, shirtColor);
    this.char.team = 'squad';
    this.followAng = (jumpSlot - 1) * 0.68;
    this.followDist = rand(4, 9);
    this.jumpSlot = jumpSlot;
  }

  get commandDistance(): number {
    return Math.hypot(this.commandAnchor.x - this.char.pos.x, this.commandAnchor.y - this.char.pos.z);
  }

  update(dt: number, game: Game): void {
    const c = this.char;
    if (!c.alive) {
      // 空中被击杀: 继续坠地
      if (this.descent) {
        c.pos.y += this.vy * dt;
        const g = game.world.groundHeight(c.pos.x, c.pos.z, c.pos.y);
        if (c.pos.y <= g) this.finishDescent(g);
      }
      return;
    }
    const player = game.playerCtl;
    if (!player) return;
    this.syncSquadOrder(game);

    // ---- 空降 ----
    if (this.descent) {
      this.commandState = 'descent';
      this.updateDescent(dt, game);
      return;
    }
    this.fireTimer = Math.max(0, this.fireTimer - dt);

    // ---- 载具乘降 ----
    const pv = player.driving;
    if (this.riding) {
      const rv = this.riding;
      if (!pv || pv.dead || rv !== pv) {
        // 玩家下车/车毁 → 下车归队
        game.leaveSeat(rv, this.seatIdx);
        this.riding = null;
        this.seatIdx = -1;
        c.airPose = null;
        const rx = Math.cos(rv.yaw);
        const rz = -Math.sin(rv.yaw);
        c.pos.set(rv.pos.x + rx * 2.0, 0, rv.pos.z + rz * 2.0);
        c.pos.y = game.world.groundHeight(c.pos.x, c.pos.z, rv.pos.y + 1);
        this.navigator.reset(c);
      } else {
        this.commandState = 'riding';
        seatWorldAt(rv, this.seatIdx + 1, c.pos); // 0=驾驶位, 乘客从 1 起
        c.yaw = rv.yaw;
        return; // 乘车不开火
      }
    } else if (pv && !pv.dead && c.pos.distanceTo(pv.pos) < 25) {
      const seat = game.freeSeat(pv);
      if (seat >= 0) {
        this.commandState = 'riding';
        seatWorldAt(pv, seat + 1, this.tgt);
        const d = Math.hypot(this.tgt.x - c.pos.x, this.tgt.z - c.pos.z);
        if (d > 2.0) {
          this.navigator.move(c, this.tgt.x, this.tgt.z, 5.6, dt, game.world, {
            stopDistance: 1.8,
            turnRate: 6,
            neighbors: game.chars,
          });
        } else {
          this.riding = pv;
          this.seatIdx = seat;
          game.boardSeat(pv, seat, c);
          c.airPose = 'sit';
        }
        return;
      }
    }

    // ---- 翻越中: 脚本位移 ----
    c.vaultCd = Math.max(0, c.vaultCd - dt);
    if (updateVaultMotion(c, dt)) return;

    // ---- 游泳: 跟随玩家渡河, 不交战不拾取 ----
    const wasSwimming = c.swimming;
    game.updateSwim(c);
    if (c.swimming) {
      this.commandState = 'swimming';
      if (!wasSwimming) {
        this.hasSwimBank = false;
        this.swimRepathT = 0;
        this.swimLastX = c.pos.x;
        this.swimLastZ = c.pos.z;
        this.navigator.reset(c);
      }
      this.swimToBank(dt, game, player, c.knocked ? 1.2 : SWIM_SPRINT_SPEED);
      return;
    }
    if (wasSwimming) {
      this.navigator.reset(c);
    }

    // ---- 倒地: 缓慢爬离伤害来源(圈外优先爬向圈心) ----
    if (c.knocked) {
      this.commandState = 'knocked';
      this.updateKnocked(dt, game);
      return;
    }

    // 轰炸预警优先于跟随和交战, 队友会立即向红区外撤离
    if (this.fleeBombardment(dt, game)) {
      this.commandState = 'safety';
      return;
    }
    if (this.fleeGrenade(dt, game)) {
      this.commandState = 'safety';
      return;
    }

    // ---- 救援友军(优先玩家, 25m 内有敌先战斗; 第二队友自然掩护) ----
    {
      let ally: Character | null = null;
      const pc = game.playerCtl?.char;
      if (pc?.knocked) ally = pc;
      if (!ally) ally = game.knock.nearestKnocked(c.pos.x, c.pos.z, 70, c);
      if (ally && (ally.rescuerId === 0 || ally.rescuerId === c.id)) {
        let enemyNear = false;
        for (const o of game.chars) {
          if (!o.alive || o.team !== 'enemy') continue;
          const enemyD = Math.hypot(o.pos.x - c.pos.x, o.pos.z - c.pos.z);
          if (enemyD >= 25) continue;
          c.eyePos(this.eye);
          o.chestPos(this.tgt);
          if (enemyD < 8 || !game.isLOSBlocked(this.eye, this.tgt, this.dir)) {
            enemyNear = true;
            break;
          }
        }
        if (!enemyNear) {
          const dx = ally.pos.x - c.pos.x;
          const dz = ally.pos.z - c.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          if (d > 2.0) {
            this.navigator.move(c, ally.pos.x, ally.pos.z, 5.5, dt, game.world, {
              stopDistance: 1.8,
              turnRate: 6,
              neighbors: game.chars,
            });
            this.updateDoorBreak(dt, game, true);
          } else if (!c.reviveTarget) {
            game.knock.startRevive(c, ally);
          }
          this.commandState = 'reviving';
          return;
        }
      }
    }

    // ---- 换弹/治疗 ----
    const gun = c.heldGun();
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0 && gun) {
        const take = Math.min(magSizeOf(gun) - gun.mag, c.ammo[gun.def.ammo]);
        gun.mag += take;
        c.ammo[gun.def.ammo] -= take;
      }
    } else if (gun && gun.mag <= 0 && c.ammo[gun.def.ammo] > 0) {
      this.reloadT = reloadDuration(gun, true);
    }
    this.healCd -= dt;
    if (this.healCd <= 0 && !this.target && !c.knocked) {
      if (c.hp < 60) {
        if (c.heals.medkit > 0 && c.hp < 35) {
          c.heals.medkit--;
          c.hp = 100;
          this.healCd = 4;
        } else if (c.heals.bandage > 0) {
          c.heals.bandage--;
          c.hp = Math.min(75, c.hp + 15);
          this.healCd = 2;
        }
      } else if (c.heals.drink > 0 && c.hp < 92) {
        c.heals.drink--;
        c.hp = Math.min(100, c.hp + 40);
        this.healCd = 2;
      }
    }

    // ---- 索敌(优先玩家附近) ----
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.25;
      this.scan(game);
    }
    if (this.target) {
      this.commandState = game.squadOrder.kind === 'focus' && game.squadOrder.targetId === this.target.id
        ? 'focusing'
        : 'engaging';
      this.combat(dt, game);
    } else {
      // 非交战: 先执行玩家指令, 默认状态才顺路拾取并跟随.
      if (!this.executeSquadOrder(dt, game)) {
        if (this.lootNear(dt, game)) this.commandState = 'looting';
        else {
          this.commandState = 'following';
          this.follow(dt, game, player);
        }
      }
    }
    const followGap = Math.hypot(player.char.pos.x - c.pos.x, player.char.pos.z - c.pos.z);
    const wantsMove = !c.reviveTarget && (this.target !== null || this.lootTarget !== null || followGap > 3);
    this.updateDoorBreak(dt, game, wantsMove);
  }

  private syncSquadOrder(game: Game): void {
    const order = game.squadOrder;
    if (order.serial === this.commandSerial) return;
    this.commandSerial = order.serial;
    this.lootTarget = null;
    this.navigator.reset(this.char);
    if (order.kind === 'move') {
      const target = squadFormationTarget(order.x, order.z, order.yaw, this.jumpSlot);
      this.setCommandAnchor(game, target.x, target.z);
    } else if (order.kind === 'hold') {
      this.commandAnchor.set(this.char.pos.x, this.char.pos.z);
    } else if (order.kind === 'focus') {
      const focus = game.chars.find((candidate) => candidate.id === order.targetId && candidate.alive);
      if (focus) {
        this.target = focus;
        this.lastKnown.copy(focus.pos);
      }
    }
  }

  private setCommandAnchor(game: Game, targetX: number, targetZ: number): void {
    for (let ring = 0; ring <= 4; ring++) {
      const radius = ring * 1.3;
      const steps = ring === 0 ? 1 : 10;
      for (let step = 0; step < steps; step++) {
        const angle = (step / steps) * Math.PI * 2 + this.jumpSlot * 0.4;
        const x = targetX + Math.cos(angle) * radius;
        const z = targetZ + Math.sin(angle) * radius;
        const y = game.world.getHeight(x, z);
        if (!game.world.navPointFree(x, z, y + 0.1, 0.5, false, false, true)) continue;
        this.commandAnchor.set(x, z);
        return;
      }
    }
    this.commandAnchor.set(targetX, targetZ);
  }

  private executeSquadOrder(dt: number, game: Game): boolean {
    const order = game.squadOrder;
    const c = this.char;
    if (order.kind === 'focus') {
      this.commandState = 'focusing';
      const d = Math.hypot(order.x - c.pos.x, order.z - c.pos.z);
      if (d > 24) {
        this.navigator.move(c, order.x, order.z, 5.6, dt, game.world, {
          stopDistance: 20,
          turnRate: 6,
          allowWater: false,
          neighbors: game.chars,
        });
        this.updateDoorBreak(dt, game, true);
      } else {
        moveChar(c, 0, 0, dt, game.world);
      }
      return true;
    }
    if (order.kind !== 'move' && order.kind !== 'hold') return false;
    const distance = this.commandDistance;
    const stopDistance = order.kind === 'move' ? 1.6 : 1.1;
    if (distance > stopDistance) {
      this.commandState = 'moving';
      const nav = this.navigator.move(
        c,
        this.commandAnchor.x,
        this.commandAnchor.y,
        order.kind === 'move' ? 5.9 : 4.8,
        dt,
        game.world,
        { stopDistance, turnRate: 6, allowWater: false, neighbors: game.chars },
      );
      this.updateDoorBreak(dt, game, true);
      if (nav.reached) this.commandState = 'holding';
    } else {
      this.commandState = 'holding';
      moveChar(c, 0, 0, dt, game.world);
      c.setStance(c.heldGun() ? 'crouch' : 'stand');
      c.yaw = turnToward(c.yaw, order.yaw, 2.8 * dt);
    }
    return true;
  }

  // ---- 空降物理(跟随玩家落点) ----
  private updateDescent(dt: number, game: Game): void {
    const c = this.char;
    const player = game.playerCtl;
    c.swimming = false;
    c.swimDip = 0;
    c.grounded = false;
    if (this.descent === 'plane') {
      if (!player) return;
      c.group.visible = false;
      c.pos.copy(player.char.pos);
      c.yaw = player.char.yaw;
      if (player.descent === 'plane') return;
      const fwdX = Math.sin(player.yaw);
      const fwdZ = Math.cos(player.yaw);
      const rightX = -fwdZ;
      const rightZ = fwdX;
      const side = (this.jumpSlot - 1) * 2.2;
      const ahead = this.jumpSlot === 1 ? 3.4 : 2.7;
      c.pos.x += fwdX * ahead + rightX * side;
      c.pos.z += fwdZ * ahead + rightZ * side;
      c.group.visible = true;
      c.airPose = 'fall';
      this.descent = 'freefall';
      this.vy = -2;
    }
    const phase = this.descent;
    if (!phase) return;
    this.vy = stepAirDescentVelocity(this.vy, phase, dt);
    const p = player?.char.pos;
    if (p) {
      const dx = p.x - c.pos.x;
      const dz = p.z - c.pos.z;
      const dl = Math.hypot(dx, dz);
      const hv = this.descent === 'freefall' ? 12 : 8;
      if (dl > 12) {
        c.pos.x += (dx / dl) * hv * dt;
        c.pos.z += (dz / dl) * hv * dt;
      }
      if (dl > 2) c.yaw = Math.atan2(dx, dz);
    }
    c.pos.y += this.vy * dt;
    const agl = c.pos.y - game.world.getHeight(c.pos.x, c.pos.z);
    if (this.descent === 'freefall' && agl <= 70) {
      this.descent = 'canopy';
      this.vy = CANOPY_DEPLOY_VELOCITY;
      c.airPose = 'canopy';
      c.attachCanopy(0x9ab86a);
    }
    const g = game.world.groundHeight(c.pos.x, c.pos.z, c.pos.y);
    if (c.pos.y <= g) this.finishDescent(g);
  }

  private fleeBombardment(dt: number, game: Game): boolean {
    const c = this.char;
    if (!game.bombardment.escapeVector(c.pos.x, c.pos.z, game.tmpV2)) return false;
    const speed = game.bombardment.state === 'active' ? 6.5 : 5.8;
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
    this.updateDoorBreak(dt, game, true);
    return true;
  }

  private fleeGrenade(dt: number, game: Game): boolean {
    const c = this.char;
    if (!game.grenades.nearestLiveFrag(c.pos.x, c.pos.y, c.pos.z, 6, this.fragOut)) return false;
    const dx = c.pos.x - this.fragOut.x;
    const dz = c.pos.z - this.fragOut.z;
    const d = Math.hypot(dx, dz) || 1;
    this.navigator.move(
      c,
      c.pos.x + (dx / d) * 15,
      c.pos.z + (dz / d) * 15,
      6.3,
      dt,
      game.world,
      { stopDistance: 0.5, turnRate: 8, neighbors: game.chars },
    );
    this.updateDoorBreak(dt, game, true);
    return true;
  }

  private updateKnocked(dt: number, game: Game): void {
    const c = this.char;
    let goalX = c.pos.x;
    let goalZ = c.pos.z;
    if (c.lastHitX !== 0 || c.lastHitZ !== 0) {
      const dx = c.pos.x - c.lastHitX;
      const dz = c.pos.z - c.lastHitZ;
      const d = Math.hypot(dx, dz) || 1;
      if (d < 14) {
        goalX += (dx / d) * 8;
        goalZ += (dz / d) * 8;
      }
    }
    if (game.zone.isOutside(c.pos.x, c.pos.z)) {
      goalX = game.zone.center.x;
      goalZ = game.zone.center.y;
    }
    if (game.bombardment.escapeVector(c.pos.x, c.pos.z, game.tmpV2)) {
      goalX = c.pos.x + game.tmpV2.x * 12;
      goalZ = c.pos.z + game.tmpV2.y * 12;
    }
    this.navigator.move(c, goalX, goalZ, 0.65, dt, game.world, {
      stopDistance: 0.5,
      turnRate: 3,
      allowWater: false,
      neighbors: game.chars,
    });
  }

  private swimToBank(dt: number, game: Game, player: PlayerController, maxSpeed: number): void {
    const c = this.char;
    const p = player.char.pos;
    if (!this.hasSwimBank) {
      const fwdX = Math.sin(player.yaw);
      const fwdZ = Math.cos(player.yaw);
      const preferX = player.char.swimming ? p.x + fwdX * 28 : p.x;
      const preferZ = player.char.swimming ? p.z + fwdZ * 28 : p.z;
      findSwimBank(this.swimBank, c.pos.x, c.pos.z, preferX, preferZ, game.world);
      this.hasSwimBank = true;
      this.swimRepathT = 0.7;
    }
    this.swimRepathT -= dt;
    if (this.swimRepathT <= 0) {
      const progress = Math.hypot(c.pos.x - this.swimLastX, c.pos.z - this.swimLastZ);
      this.swimLastX = c.pos.x;
      this.swimLastZ = c.pos.z;
      this.swimRepathT = 0.7;
      const bankDist = Math.hypot(this.swimBank.x - c.pos.x, this.swimBank.y - c.pos.z);
      const bankDepth = WATER_Y - game.world.getHeight(this.swimBank.x, this.swimBank.y);
      if (progress < 0.25 || (bankDist < 1.2 && bankDepth > 0.65)) {
        const oldX = this.swimBank.x;
        const oldZ = this.swimBank.y;
        const fwdX = Math.sin(player.yaw);
        const fwdZ = Math.cos(player.yaw);
        const preferX = player.char.swimming ? p.x + fwdX * 28 : p.x;
        const preferZ = player.char.swimming ? p.z + fwdZ * 28 : p.z;
        findSwimBank(this.swimBank, c.pos.x, c.pos.z, preferX, preferZ, game.world, oldX, oldZ);
      }
    }
    const dx = this.swimBank.x - c.pos.x;
    const dz = this.swimBank.y - c.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const speed = Math.min(maxSpeed, Math.max(c.knocked ? 0.35 : 0.55, d * 1.6));
    this.navigator.move(c, this.swimBank.x, this.swimBank.y, speed, dt, game.world, {
      stopDistance: 0.25,
      turnRate: 4.5,
      allowWater: true,
      neighbors: game.chars,
    });
    c.swimAcc += c.speed2d * dt;
    if (c.swimAcc > 1.7) {
      c.swimAcc = 0;
      game.soundAt(c.pos, (dd, p2) => game.audio.swimStrokeAt(dd, p2));
    }
  }

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

  // ---- 索敌: 可见敌人, 偏好玩家附近 ----
  private scan(game: Game): void {
    const c = this.char;
    const bestGun = c.bestGunSlot();
    c.curSlot = bestGun >= 0 ? bestGun : 3;
    c.eyePos(this.eye);
    let best: Character | null = null;
    let bestScore = ENGAGE_RANGE + 40;
    let bestVisible = false;
    const playerAttacker = game.playerCtl?.char.lastAttackerId ?? 0;
    const focusId = game.squadOrder.kind === 'focus' ? game.squadOrder.targetId : 0;
    const focus = focusId > 0
      ? game.chars.find((candidate) => candidate.id === focusId && candidate.alive && candidate.team === 'enemy') ?? null
      : null;
    if (focus && Math.hypot(focus.pos.x - c.pos.x, focus.pos.z - c.pos.z) <= FOCUS_RANGE) {
      focus.chestPos(this.tgt);
      best = focus;
      bestVisible = !game.isLOSBlocked(this.eye, this.tgt, this.dir);
    } else {
      for (const o of game.chars) {
        if (!o.alive || o.team !== 'enemy') continue;
        const d = Math.hypot(o.pos.x - c.pos.x, o.pos.z - c.pos.z);
        if (d > ENGAGE_RANGE) continue;
        const pd = game.playerCtl ? Math.hypot(o.pos.x - game.playerCtl.char.pos.x, o.pos.z - game.playerCtl.char.pos.z) : 99;
        let score = d + pd * 0.35;
        if (o === this.target) score -= 14;
        if (o.id === c.lastAttackerId) score -= 20;
        if (o.id === playerAttacker) score -= 16;
        if (score >= bestScore) continue;
        o.chestPos(this.tgt);
        if (game.isLOSBlocked(this.eye, this.tgt, this.dir)) continue;
        bestScore = score;
        best = o;
        bestVisible = true;
      }
    }
    if (best) {
      if (this.target !== best) {
        this.target = best;
        this.reactT = rand(0.2, 0.5);
        this.burstLeft = 0;
        this.burstCd = 0;
        this.tacticT = 0;
        this.navigator.reset(c);
      }
      this.lostT = 0;
      this.losOk = bestVisible;
      if (bestVisible) this.lastKnown.copy(best.pos);
    } else if (this.target) {
      this.lostT += 0.25;
      this.losOk = false;
      if (this.lostT > 3.2) {
        this.target = null;
        this.tacticT = 0;
      }
    }
  }

  // ---- 交战 ----
  private combat(dt: number, game: Game): void {
    const c = this.char;
    const t = this.target as Character;
    if (!t.alive) {
      this.target = null;
      this.navigator.reset(c);
      return;
    }
    const dx = t.pos.x - c.pos.x;
    const dz = t.pos.z - c.pos.z;
    const dist = Math.hypot(dx, dz);
    const focused = game.squadOrder.kind === 'focus' && game.squadOrder.targetId === t.id;
    if (dist > (focused ? FOCUS_RANGE + 10 : ENGAGE_RANGE + 20)) {
      this.target = null;
      this.navigator.reset(c);
      return;
    }
    const desiredYaw = Math.atan2(dx, dz);
    const gun = c.heldGun();
    let preferred = 2.1;
    if (gun) {
      switch (gun.def.id) {
        case 'shotgun': preferred = 9; break;
        case 'smg': preferred = 16; break;
        case 'pistol': preferred = 19; break;
        case 'dmr': preferred = 42; break;
        case 'sniper': preferred = 52; break;
        default: preferred = 29;
      }
    }
    this.tacticT -= dt;
    if (this.tacticT <= 0) {
      this.tacticT = rand(0.75, 1.25);
      if (random() < 0.35) this.strafeDir *= -1;
      if (gun && (this.reloadT > 0 || c.hp < 35) &&
        findCoverPoint(this.tacticPoint, c, t, game.world, 12) &&
        !game.zone.isOutside(this.tacticPoint.x, this.tacticPoint.y)) {
        this.tacticMode = 'cover';
      } else if (!this.losOk) {
        const nx = dx / (dist || 1);
        const nz = dz / (dist || 1);
        this.tacticPoint.set(
          this.lastKnown.x - nz * this.strafeDir * Math.min(9, dist * 0.3),
          this.lastKnown.z + nx * this.strafeDir * Math.min(9, dist * 0.3),
        );
        this.tacticMode = 'search';
      } else if (!gun || dist > preferred * 1.25) {
        this.tacticPoint.set(t.pos.x, t.pos.z);
        this.tacticMode = 'advance';
      } else if (dist < preferred * 0.55) {
        const nx = dx / (dist || 1);
        const nz = dz / (dist || 1);
        this.tacticPoint.set(c.pos.x - nx * 9, c.pos.z - nz * 9);
        this.tacticMode = 'retreat';
      } else {
        const nx = dx / (dist || 1);
        const nz = dz / (dist || 1);
        this.tacticPoint.set(c.pos.x - nz * this.strafeDir * 6, c.pos.z + nx * this.strafeDir * 6);
        this.tacticMode = 'strafe';
      }
    }
    const advancing = this.tacticMode === 'advance';
    const nav = this.navigator.move(
      c,
      advancing ? t.pos.x : this.tacticPoint.x,
      advancing ? t.pos.z : this.tacticPoint.y,
      !gun ? 5.3 : this.reloadT > 0 ? 5.0 : 3.8,
      dt,
      game.world,
      {
        stopDistance: advancing ? preferred : 1.0,
        turnRate: !gun ? 6.5 : 5,
        allowWater: false,
        neighbors: game.chars,
      },
    );
    if (this.losOk) c.yaw = turnToward(c.yaw, desiredYaw, 8 * dt);
    c.setStance(gun && nav.reached && dist > 20 && this.tacticMode !== 'advance' ? 'crouch' : 'stand');

    if (nav.reached && this.tacticMode === 'cover' && !this.losOk && this.healCd <= 0 && c.hp < 60) {
      if (c.heals.medkit > 0 && c.hp < 35) {
        c.heals.medkit--;
        c.hp = 100;
        this.healCd = 4;
      } else if (c.heals.bandage > 0) {
        c.heals.bandage--;
        c.hp = Math.min(75, c.hp + 15);
        this.healCd = 2;
      }
    }

    this.vaultProbeT -= dt;
    if (nav.blocked && this.vaultProbeT <= 0 && !c.vault && c.vaultCd <= 0) {
      this.vaultProbeT = 0.32;
      const gx = (advancing ? t.pos.x : this.tacticPoint.x) - c.pos.x;
      const gz = (advancing ? t.pos.z : this.tacticPoint.y) - c.pos.z;
      const probe = probeVault(c, gx, gz, game.world);
      if (probe) {
        if (probe.win?.alive) game.hitDestructible(probe.win, 999, c.pos);
        startVault(c, probe);
        game.soundAt(c.pos, (dd, p2) => game.audio.melee(dd, p2));
        return;
      }
    }

    if (!gun) {
      if (dist < c.melee.def.range * 1.05) {
        c.yaw = turnToward(c.yaw, desiredYaw, 10 * dt);
        if (angleDiff(c.yaw, desiredYaw) < 0.3) game.meleeAttack(c);
      }
      return;
    }
    // 开火
    if (this.reactT > 0) {
      this.reactT -= dt;
      return;
    }
    if (this.reloadT > 0 || !this.losOk || allyBlocksShot(c, t, game.chars)) return;
    if (angleDiff(c.yaw, desiredYaw) > 0.22) return;
    if (gun.def.id === 'shotgun' && dist > 26) return; // 霰弹仅限近距
    if (this.burstLeft > 0) {
      this.shotT -= dt;
      if (this.shotT <= 0 && this.fireTimer <= 0) {
        this.fireAt(t, dist, game);
        this.burstLeft--;
        this.shotT = gun.def.fireInterval * rand(1.4, 2.0);
        if (this.burstLeft <= 0) this.burstCd = rand(0.6, 1.2);
      }
    } else {
      this.burstCd -= dt;
      if (this.burstCd <= 0) this.burstLeft = gun.def.auto ? 3 + Math.floor(random() * 3) : 1;
    }
  }

  private fireAt(t: Character, dist: number, game: Game): void {
    const c = this.char;
    const gun = c.heldGun();
    if (!gun || gun.mag <= 0) return;
    c.eyePos(this.eye);
    t.chestPos(this.aim);
    // 略弱于敌方 bot 的精度
    const sigma = (0.028 + dist * 0.00055) * 1.3;
    const errR = dist * Math.tan(sigma) * Math.sqrt(random());
    const errA = random() * Math.PI * 2;
    this.aim.x += Math.cos(errA) * errR;
    this.aim.z += Math.sin(errA) * errR;
    this.aim.y += (random() - 0.5) * errR * 0.7;
    this.dir.subVectors(this.aim, this.eye).normalize();
    if (game.fireWeapon(c, this.eye, this.dir, 0)) {
      this.fireTimer = gun.def.fireInterval;
      if (gun.mag <= 0 && c.ammo[gun.def.ammo] > 0) this.reloadT = reloadDuration(gun, true);
    }
  }

  // ---- 跟随(松散队形 + 掉队救援) ----
  private follow(dt: number, game: Game, player: PlayerController): void {
    const c = this.char;
    const p = player.char.pos;
    const formationAng = player.yaw + Math.PI + this.followAng;
    const tx = p.x + Math.sin(formationAng) * this.followDist;
    const tz = p.z + Math.cos(formationAng) * this.followDist;
    const dx = tx - c.pos.x;
    const dz = tz - c.pos.z;
    const d = Math.hypot(dx, dz);
    const pd = Math.hypot(p.x - c.pos.x, p.z - c.pos.z);
    if (pd > 28 && c.speed2d < 0.25) this.stuckT += dt;
    else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    if (this.stuckT > 18 && pd > 55) {
      // 极端掉队兜底只在长时间完全无法移动时触发，并验证落点可用。
      this.stuckT = 0;
      for (let i = 0; i < 8; i++) {
        const a = player.yaw + Math.PI + (i - 3.5) * 0.25;
        const x = p.x + Math.sin(a) * (5 + i * 0.25);
        const z = p.z + Math.cos(a) * (5 + i * 0.25);
        if (!game.world.navPointFree(x, z, p.y, 0.55, false)) continue;
        c.pos.set(x, game.world.groundHeight(x, z, p.y + 0.2), z);
        this.navigator.reset(c);
        return;
      }
    }
    if (d > 2.2) {
      const sp = pd > 14 || player.char.speed2d > 5 ? 6.6 : 4.3;
      const nav = this.navigator.move(c, tx, tz, Math.min(sp, Math.max(2.2, d * 1.3)), dt, game.world, {
        stopDistance: 2,
        turnRate: 5.5,
        neighbors: game.chars,
      });
      // 跟随被可翻越障碍挡住且玩家在对面: 翻越(节流探测)
      this.vaultProbeT -= dt;
      if (nav.blocked && this.vaultProbeT <= 0) {
        this.vaultProbeT = 0.4;
        if (!c.vault && c.vaultCd <= 0) {
          const probe = probeVault(c, dx, dz, game.world);
          if (probe) {
            const dLand = Math.hypot(probe.landX - tx, probe.landZ - tz);
            if (dLand < d - 1) {
              if (probe.win && probe.win.alive) game.hitDestructible(probe.win, 999, c.pos);
              startVault(c, probe);
              game.soundAt(c.pos, (dd, p2) => game.audio.melee(dd, p2));
              return;
            }
          }
        }
      }
    } else {
      moveChar(c, 0, 0, dt, game.world);
      c.yaw = turnToward(c.yaw, player.yaw, 2.5 * dt);
    }
  }

  private updateDoorBreak(dt: number, game: Game, wantsMove: boolean): void {
    const c = this.char;
    this.blockCheckT -= dt;
    if (this.blockCheckT <= 0) {
      this.blockCheckT = 0.15;
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      this.blockedDoor = wantsMove ? game.findBlockingDoor(c, fx, fz) : null;
      if (!this.blockedDoor) this.blockT = 0;
    }
    const d = this.blockedDoor;
    if (!d || !d.alive || d.collider.off || !wantsMove) {
      this.blockT = 0;
      return;
    }
    this.blockT += dt;
    if (d.kind === 'door') {
      if (this.blockT > 0.3) {
        game.openDoor(d, c);
        this.blockedDoor = null;
        this.blockT = 0;
      }
      return;
    }
    if (this.blockT < 0.85) return;
    c.yaw = Math.atan2(d.cx - c.pos.x, d.cz - c.pos.z);
    const gun = c.heldGun();
    if (gun && gun.mag > 0 && this.fireTimer <= 0) {
      c.eyePos(this.eye);
      this.aim.set(d.cx, d.cy, d.cz);
      this.dir.subVectors(this.aim, this.eye).normalize();
      if (game.fireWeapon(c, this.eye, this.dir, 0)) this.fireTimer = gun.def.fireInterval * 1.6;
    } else if (!gun || gun.mag <= 0) {
      game.meleeAttack(c);
    }
    if (!d.alive) {
      this.blockedDoor = null;
      this.blockT = 0;
    }
  }

  private wantsLoot(item: LootItem): boolean {
    const c = this.char;
    const k = item.kind;
    if (isWeaponKind(k)) {
      if (!c.hasGun()) return true;
      if (!isGunKind(k)) return c.melee.def.id === 'fists';
      const slot = c.bestGunSlot();
      return WEAPONS[k].tier > (slot >= 0 ? (c.guns[slot]?.def.tier ?? 0) : 0);
    }
    if (isArmorKind(k)) {
      const info = armorFromLoot(k);
      if (!info) return false;
      const cur = info.kind === 'helmet' ? c.helmet : c.vest;
      return !cur || cur.level < info.level;
    }
    if (isPackKind(k)) {
      const level = packLevelFromLoot(k);
      return level !== null && (!c.pack || c.pack.level < level);
    }
    if (isAttachKind(k)) {
      const id = attachFromLoot(k);
      const gun = c.heldGun();
      if (!id || !gun || !canAttach(gun.def.id, id)) return false;
      return gun.att[ATTACHMENTS[id].slot] === null;
    }
    const ammo = ammoTypeFromLoot(k);
    if (ammo) return c.guns.some((g) => g?.def.ammo === ammo) && c.ammo[ammo] < 120;
    if (k === 'bandage') return c.heals.bandage < 5;
    if (k === 'medkit') return c.heals.medkit < 2;
    if (k === 'drink') return c.heals.drink < 3;
    if (k === 'frag' || k === 'smoke') return c.throwables[k] < THROWABLES[k].max;
    return false;
  }

  // ---- 顺路拾取(只选真正需要且没有更近队友负责的物品) ----
  private lootNear(dt: number, game: Game): boolean {
    const c = this.char;
    const player = game.playerCtl?.char;
    if (!player || Math.hypot(player.pos.x - c.pos.x, player.pos.z - c.pos.z) > 18) {
      this.lootTarget = null;
      return false;
    }
    this.lootScanT -= dt;
    if (!this.lootTarget?.active || !this.wantsLoot(this.lootTarget) || this.lootScanT <= 0) {
      this.lootTarget = null;
      this.lootScanT = 0.55;
      let bestScore = -Infinity;
      for (let i = 0; i < game.loot.items.length; i++) {
        const it = game.loot.items[i] as LootItem;
        if (!it.active || !this.wantsLoot(it)) continue;
        const dx = it.group.position.x - c.pos.x;
        const dy = it.group.position.y - c.pos.y - 1;
        const dz = it.group.position.z - c.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 13 || Math.abs(dy) > 3.2) continue;
        let claimed = false;
        for (const ally of game.chars) {
          if (ally === c || ally.isPlayer || !ally.alive || ally.team !== 'squad') continue;
          if (Math.hypot(it.group.position.x - ally.pos.x, it.group.position.z - ally.pos.z) + 1.2 < d) {
            claimed = true;
            break;
          }
        }
        if (claimed) continue;
        const priority = isWeaponKind(it.kind) && !c.hasGun() ? 18 :
          isArmorKind(it.kind) || isPackKind(it.kind) ? 8 :
            isAttachKind(it.kind) ? 6 : 3;
        const score = priority - d + ((c.id + i) % 5) * 0.08;
        if (score > bestScore) {
          bestScore = score;
          this.lootTarget = it;
        }
      }
    }
    const item = this.lootTarget;
    if (!item) return false;
    const k = item.kind;
    const d = Math.hypot(item.group.position.x - c.pos.x, item.group.position.z - c.pos.z);
    if (d > 1.7) {
      this.navigator.move(c, item.group.position.x, item.group.position.z, 4.6, dt, game.world, {
        stopDistance: 1.55,
        turnRate: 5,
        neighbors: game.chars,
      });
      return true;
    }
    let taken = false;
    if (isWeaponKind(k)) {
      const cur = c.bestGunSlot();
      const curTier = cur >= 0 ? (c.guns[cur]?.def.tier ?? 0) : 0;
      if (!c.hasGun() || (isGunKind(k) && WEAPONS[k].tier > curTier)) {
        taken = game.tryPickupWeapon(c, item);
      }
    } else if (isArmorKind(k)) {
      const info = armorFromLoot(k);
      if (info) {
        const cur = info.kind === 'helmet' ? c.helmet : c.vest;
        if (!cur || cur.level < info.level) {
          taken = game.tryPickupArmor(c, item);
        }
      }
    } else if (isPackKind(k)) {
      const lv = packLevelFromLoot(k);
      if (lv && (!c.pack || c.pack.level < lv)) taken = game.tryPickupPack(c, item);
    } else {
      taken = game.applyAutoPickup(c, item);
    }
    this.lootTarget = null;
    this.lootScanT = taken ? 0.1 : 0.8;
    return taken;
  }
}
