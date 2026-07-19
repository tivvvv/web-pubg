// ─────────────────────────────────────────────────────────────────────────────
// teammate.ts - 队友 AI: 跟随/交战/乘车/跳伞; 与 enemy BotController 共享战斗原语
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { Character, moveChar } from './character';
import type { Game } from './game';
import type { PlayerController } from './player';
import { isWeaponKind } from './loot';
import { armorFromLoot, isArmorKind } from './armor';
import { isPackKind } from './backpack';
import { seatWorldAt, type Vehicle } from './vehicles';
import { probeVault, startVault, updateVaultMotion } from './vault';
import { WEAPONS } from './weapons';
import { angleDiff, rand, turnToward } from './utils';

const ENGAGE_RANGE = 60;

export class TeammateController {
  readonly char: Character;
  descent: 'freefall' | 'canopy' | null = null;
  vy = 0;
  jumpDelay: number;   // 跳伞延迟(玩家起跳后跟进)
  riding: Vehicle | null = null;
  seatIdx = -1;
  private followAng: number;
  private followDist: number;
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
  private strafeT = 0;
  private strafeDir = 1;
  private eye = new THREE.Vector3();
  private tgt = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private aim = new THREE.Vector3();

  constructor(name: string, shirtColor: number) {
    this.char = new Character(name, false, shirtColor);
    this.char.team = 'squad';
    this.followAng = rand(0, Math.PI * 2);
    this.followDist = rand(4, 9);
    this.jumpDelay = rand(0.4, 1.3);
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

    // ---- 空降 ----
    if (this.descent) {
      this.updateDescent(dt, game);
      return;
    }

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
      } else {
        seatWorldAt(rv, this.seatIdx + 1, c.pos); // 0=驾驶位, 乘客从 1 起
        c.yaw = rv.yaw;
        return; // 乘车不开火
      }
    } else if (pv && !pv.dead && c.pos.distanceTo(pv.pos) < 25) {
      const seat = game.freeSeat(pv);
      if (seat >= 0) {
        seatWorldAt(pv, seat + 1, this.tgt);
        const d = Math.hypot(this.tgt.x - c.pos.x, this.tgt.z - c.pos.z);
        if (d > 2.0) {
          c.yaw = Math.atan2(this.tgt.x - c.pos.x, this.tgt.z - c.pos.z);
          moveChar(c, Math.sin(c.yaw) * 5.4, Math.cos(c.yaw) * 5.4, dt, game.world);
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
    game.updateSwim(c);
    if (c.swimming) {
      // 直接朝玩家位置游(跟随偏移点可能落在水里, 会原地踩水)
      const p = player.char.pos;
      const dx = p.x - c.pos.x;
      const dz = p.z - c.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      c.yaw = turnToward(c.yaw, Math.atan2(dx, dz), 4 * dt);
      moveChar(c, (dx / d) * 2.2, (dz / d) * 2.2, dt, game.world);
      c.swimAcc += c.speed2d * dt;
      if (c.swimAcc > 1.7) {
        c.swimAcc = 0;
        game.soundAt(c.pos, (dd, p2) => game.audio.swimStrokeAt(dd, p2));
      }
      this.fireTimer -= dt;
      return;
    }

    // ---- 倒地: 缓慢爬离伤害来源(圈外优先爬向圈心) ----
    if (c.knocked) {
      let mx = 0;
      let mz = 0;
      if (c.lastHitX !== 0 || c.lastHitZ !== 0) {
        const dx = c.pos.x - c.lastHitX;
        const dz = c.pos.z - c.lastHitZ;
        const d = Math.hypot(dx, dz) || 1;
        if (d < 14) {
          mx = dx / d;
          mz = dz / d;
        }
      }
      if (game.zone.isOutside(c.pos.x, c.pos.z)) {
        const dx = game.zone.center.x - c.pos.x;
        const dz = game.zone.center.y - c.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        mx = dx / d;
        mz = dz / d;
      }
      if (mx !== 0 || mz !== 0) moveChar(c, mx * 0.6, mz * 0.6, dt, game.world);
      return;
    }

    // ---- 救援友军(优先玩家, 25m 内有敌先战斗; 第二队友自然掩护) ----
    {
      let ally: Character | null = null;
      const pc = game.playerCtl?.char;
      if (pc?.knocked) ally = pc;
      if (!ally) ally = game.knock.nearestKnocked(c.pos.x, c.pos.z, 999, c);
      if (ally && (ally.rescuerId === 0 || ally.rescuerId === c.id)) {
        let enemyNear = false;
        for (const o of game.chars) {
          if (!o.alive || o.team !== 'enemy') continue;
          if (Math.hypot(o.pos.x - c.pos.x, o.pos.z - c.pos.z) < 25) {
            enemyNear = true;
            break;
          }
        }
        if (!enemyNear) {
          const dx = ally.pos.x - c.pos.x;
          const dz = ally.pos.z - c.pos.z;
          const d = Math.hypot(dx, dz) || 1;
          if (d > 2.0) {
            c.yaw = turnToward(c.yaw, Math.atan2(dx, dz), 5 * dt);
            moveChar(c, (dx / d) * 5.4, (dz / d) * 5.4, dt, game.world);
          } else if (!c.reviveTarget) {
            game.knock.startRevive(c, ally);
          }
          return;
        }
      }
    }

    // ---- 换弹/治疗 ----
    const gun = c.heldGun();
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0 && gun) {
        const take = Math.min(gun.def.magSize - gun.mag, c.ammo[gun.def.ammo]);
        gun.mag += take;
        c.ammo[gun.def.ammo] -= take;
      }
    } else if (gun && gun.mag <= 0 && c.ammo[gun.def.ammo] > 0) {
      this.reloadT = gun.def.reloadTime;
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
      this.combat(dt, game);
    } else {
      // 非交战: 顺路拾取 + 跟随
      if (!this.lootNear(dt, game)) this.follow(dt, game, player);
    }
    this.fireTimer -= dt;
  }

  // ---- 空降物理(跟随玩家落点) ----
  private updateDescent(dt: number, game: Game): void {
    const c = this.char;
    // 等待跳伞延迟: 还在"机舱"跟玩家(舱内隐藏, 玩家起跳后显形跟进)
    if (this.jumpDelay > 0) {
      this.jumpDelay -= dt;
      c.group.visible = game.playerCtl?.descent !== 'plane';
      const p = game.playerCtl?.char.pos;
      if (p) c.pos.set(p.x + this.followDist * 0.5, p.y, p.z + this.followDist * 0.5);
      if (this.jumpDelay > 0) return;
      this.vy = -2;
    }
    const vt = this.descent === 'freefall' ? -55 : -10;
    this.vy += (vt - this.vy) * (1 - Math.exp(-dt * 1.2));
    const p = game.playerCtl?.char.pos;
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
      c.airPose = 'canopy';
      c.attachCanopy(0x9ab86a);
    }
    const g = game.world.groundHeight(c.pos.x, c.pos.z, c.pos.y);
    if (c.pos.y <= g) this.finishDescent(g);
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
  }

  // ---- 索敌: 可见敌人, 偏好玩家附近 ----
  private scan(game: Game): void {
    const c = this.char;
    c.eyePos(this.eye);
    let best: Character | null = null;
    let bestScore = ENGAGE_RANGE + 40;
    for (const o of game.chars) {
      if (!o.alive || o.team !== 'enemy') continue;
      const d = Math.hypot(o.pos.x - c.pos.x, o.pos.z - c.pos.z);
      if (d > ENGAGE_RANGE) continue;
      const pd = game.playerCtl ? Math.hypot(o.pos.x - game.playerCtl.char.pos.x, o.pos.z - game.playerCtl.char.pos.z) : 99;
      const score = d + pd * 0.4;
      if (score >= bestScore) continue;
      o.chestPos(this.tgt);
      if (game.isLOSBlocked(this.eye, this.tgt, this.dir)) continue;
      bestScore = score;
      best = o;
    }
    if (best) {
      if (this.target !== best) {
        this.target = best;
        this.reactT = rand(0.2, 0.5);
        this.burstLeft = 0;
        this.burstCd = 0;
      }
      this.lostT = 0;
    } else if (this.target) {
      this.lostT += 0.25;
      if (this.lostT > 2.5) this.target = null;
    }
  }

  // ---- 交战 ----
  private combat(dt: number, game: Game): void {
    const c = this.char;
    const t = this.target as Character;
    if (!t.alive) {
      this.target = null;
      return;
    }
    const dx = t.pos.x - c.pos.x;
    const dz = t.pos.z - c.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > ENGAGE_RANGE + 20) {
      this.target = null;
      return;
    }
    const desiredYaw = Math.atan2(dx, dz);
    c.yaw = turnToward(c.yaw, desiredYaw, 5 * dt);
    // 小走位保持距离
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeT = rand(0.8, 1.6);
      this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    }
    const nx = dx / (dist || 1);
    const nz = dz / (dist || 1);
    const radial = dist > 30 ? 0.7 : dist < 10 ? -0.6 : 0;
    const mx = -nz * this.strafeDir * 0.7 + nx * radial;
    const mz = nx * this.strafeDir * 0.7 + nz * radial;
    const ml = Math.hypot(mx, mz) || 1;
    moveChar(c, (mx / ml) * 3.2, (mz / ml) * 3.2, dt, game.world);
    // 开火
    if (this.reactT > 0) {
      this.reactT -= dt;
      return;
    }
    const gun = c.heldGun();
    if (!gun || this.reloadT > 0) return;
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
      if (this.burstCd <= 0) this.burstLeft = gun.def.auto ? 3 + Math.floor(Math.random() * 3) : 1;
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
    const errR = dist * Math.tan(sigma) * Math.sqrt(Math.random());
    const errA = Math.random() * Math.PI * 2;
    this.aim.x += Math.cos(errA) * errR;
    this.aim.z += Math.sin(errA) * errR;
    this.aim.y += (Math.random() - 0.5) * errR * 0.7;
    this.dir.subVectors(this.aim, this.eye).normalize();
    if (game.fireWeapon(c, this.eye, this.dir, 0)) {
      this.fireTimer = gun.def.fireInterval;
      if (gun.mag <= 0 && c.ammo[gun.def.ammo] > 0) this.reloadT = gun.def.reloadTime;
    }
  }

  // ---- 跟随(松散队形 + 掉队救援) ----
  private follow(dt: number, game: Game, player: PlayerController): void {
    const c = this.char;
    const p = player.char.pos;
    const tx = p.x + Math.sin(this.followAng) * this.followDist;
    const tz = p.z + Math.cos(this.followAng) * this.followDist;
    const dx = tx - c.pos.x;
    const dz = tz - c.pos.z;
    const d = Math.hypot(dx, dz);
    const pd = Math.hypot(p.x - c.pos.x, p.z - c.pos.z);
    if (pd > 20) this.stuckT += dt;
    else this.stuckT = 0;
    if (this.stuckT > 8) {
      // 掉队救援: 最后手段传送到玩家身后
      this.stuckT = 0;
      c.pos.set(p.x - Math.sin(player.yaw) * 4, 0, p.z - Math.cos(player.yaw) * 4);
      c.pos.y = game.world.getHeight(c.pos.x, c.pos.z);
      return;
    }
    if (d > 2.2) {
      // 跟随被可翻越障碍挡住且玩家在对面: 翻越(节流探测)
      this.vaultProbeT -= dt;
      if (this.vaultProbeT <= 0) {
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
      const sp = pd > 14 || player.char.speed2d > 5 ? 6.6 : 4.3;
      c.yaw = turnToward(c.yaw, Math.atan2(dx, dz), 5 * dt);
      moveChar(c, (dx / d) * Math.min(sp, d * 1.5), (dz / d) * Math.min(sp, d * 1.5), dt, game.world);
    } else {
      moveChar(c, 0, 0, dt, game.world);
      c.yaw = turnToward(c.yaw, player.yaw, 2.5 * dt);
    }
  }

  // ---- 顺路拾取(跟随点附近 15m) ----
  private lootNear(dt: number, game: Game): boolean {
    const c = this.char;
    const item = game.loot.nearest(c.pos.x, c.pos.y, c.pos.z, 15);
    if (!item) return false;
    const k = item.kind;
    const d = Math.hypot(item.group.position.x - c.pos.x, item.group.position.z - c.pos.z);
    if (d > 1.6) {
      c.yaw = Math.atan2(item.group.position.x - c.pos.x, item.group.position.z - c.pos.z);
      moveChar(c, Math.sin(c.yaw) * 4.6, Math.cos(c.yaw) * 4.6, dt, game.world);
      return true;
    }
    if (isWeaponKind(k)) {
      const cur = c.bestGunSlot();
      const curTier = cur >= 0 ? (c.guns[cur]?.def.tier ?? 0) : 0;
      if (!c.hasGun() || (k !== 'knife' && WEAPONS[k].tier > curTier)) {
        game.tryPickupWeapon(c, item);
        return true;
      }
      return false;
    }
    if (isArmorKind(k)) {
      const info = armorFromLoot(k);
      if (info) {
        const cur = info.kind === 'helmet' ? c.helmet : c.vest;
        if (!cur || cur.level < info.level) {
          game.tryPickupArmor(c, item);
          return true;
        }
      }
      return false;
    }
    if (!isPackKind(k)) return game.applyAutoPickup(c, item);
    // 背包: 没有或更高级才拿
    const lv = k === 'pack1' ? 1 : k === 'pack2' ? 2 : 3;
    if (!c.pack || c.pack.level < lv) return game.tryPickupPack(c, item);
    return false;
  }
}
