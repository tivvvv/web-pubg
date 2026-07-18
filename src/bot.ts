// Bot AI: 游走/拾取 ↔ 交战 状态机; 赤手空拳开局, 优先找枪, 近身用近战
import * as THREE from 'three';
import { Character } from './character';
import type { AmmoType, WeaponId } from './types';
import { WEAPONS } from './weapons';
import { WATER_Y } from './world';
import { isWeaponKind } from './loot';
import { armorFromLoot, isArmorKind } from './armor';
import { isPackKind, packLevelFromLoot } from './backpack';
import { angleDiff, clamp, rand, randInt, turnToward } from './utils';
import type { Game } from './game';

const ENGAGE_DIST = 92;

export class BotController {
  readonly char: Character;
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
  private strafeT = 0;
  private strafeDir = 1;
  private repathT = 0;
  private moveTarget = new THREE.Vector3();
  private hasMoveTarget = false;
  private lastKnown = new THREE.Vector3();
  // 破门: 被门/窗挡路计时
  private blockT = 0;
  private blockCheckT = 0;
  private blockedDoor: import('./types').DestructibleLike | null = null;
  // 手雷: 每局最多扔 1 颗; stillT 记录目标静止时长
  private fragUsed = false;
  private stillT = 0;
  private fragOut = { x: 0, z: 0 };
  private healCd = 0; // bot 恢复品使用冷却(即时结算, 冷却模拟读条间隔)

  private eye = new THREE.Vector3();
  private tgtPos = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private aim = new THREE.Vector3();

  constructor(name: string, shirtColor: number) {
    this.char = new Character(name, false, shirtColor);
    this.scanT = Math.random() * 0.3;
  }

  update(dt: number, game: Game): void {
    const c = this.char;
    if (!c.alive) return;
    this.fireTimer -= dt;

    // 换弹(仅枪械, 消耗对应类型弹药)
    const gun = c.heldGun();
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0 && gun) {
        const need = gun.def.magSize - gun.mag;
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
      this.scanT = 0.25 + Math.random() * 0.08;
      this.scan(game);
    }

    // 手雷威胁: 6m 内有活着的雷, 掉头全速跑
    if (this.fleeGrenade(dt, game)) return;

    if (this.state === 'engage' && this.target) {
      this.updateEngage(dt, game);
    } else {
      this.updateWander(dt, game);
      // 游走时安全则恢复: <60 绷带补到 75 / 危急用医疗包; 状态不错补饮料
      this.healCd -= dt;
      if (this.healCd <= 0 && this.state === 'wander') {
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
    }
  }

  // 是否想要这件护具: 空槽或更高等级
  private wantsArmor(kind: import('./types').LootKind): boolean {
    const info = armorFromLoot(kind);
    if (!info) return false;
    const cur = info.kind === 'helmet' ? this.char.helmet : this.char.vest;
    return !cur || cur.level < info.level;
  }

  // 最优枪空弹匣且无匹配备弹 → 返回所需弹种(bot 寻弹用)
  private needsAmmoType(): AmmoType | null {
    const c = this.char;
    const slot = c.bestGunSlot();
    if (slot < 0) return null;
    const g = c.guns[slot];
    if (!g) return null;
    const t = g.def.ammo;
    return g.mag > 0 || c.ammo[t] > 0 ? null : t;
  }

  // 附近有活手雷: 反向全速逃离
  private fleeGrenade(dt: number, game: Game): boolean {
    const c = this.char;
    if (!game.grenades.nearestLiveFrag(c.pos.x, c.pos.y, c.pos.z, 6, this.fragOut)) return false;
    const dx = c.pos.x - this.fragOut.x;
    const dz = c.pos.z - this.fragOut.z;
    const d = Math.hypot(dx, dz) || 1;
    c.yaw = Math.atan2(dx / d, dz / d);
    c.applyMove((dx / d) * 6.2, (dz / d) * 6.2, dt, game.world);
    return true;
  }

  // 是否想要地上这件武器
  private wantsWeapon(kind: WeaponId | 'knife'): boolean {
    const c = this.char;
    if (kind === 'knife') return !c.hasGun() && c.melee.def.id === 'fists';
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
    // 换用最好的枪, 没枪用近战
    const best = c.bestGunSlot();
    c.curSlot = best >= 0 ? best : 3;

    c.eyePos(this.eye);
    let nearest: Character | null = null;
    let nearestD = ENGAGE_DIST;
    for (const other of game.chars) {
      if (!other.alive || other === c) continue;
      const d = Math.hypot(other.pos.x - c.pos.x, other.pos.z - c.pos.z);
      if (d >= nearestD) continue;
      other.chestPos(this.tgtPos);
      if (game.isLOSBlocked(this.eye, this.tgtPos, this.dir)) continue;
      nearest = other;
      nearestD = d;
    }
    if (nearest) {
      if (this.target !== nearest) {
        this.target = nearest;
        this.reactT = rand(0.3, 0.8);
        this.burstLeft = 0;
        this.burstCd = 0;
      }
      this.state = 'engage';
      this.losOk = true;
      this.lostT = 0;
    } else if (this.state === 'engage') {
      // 目标暂不可见, 交给 lostT 逻辑
      this.losOk = false;
    }
  }

  private updateEngage(dt: number, game: Game): void {
    const c = this.char;
    const t = this.target as Character;
    if (!t.alive) {
      this.target = null;
      this.state = 'wander';
      this.hasMoveTarget = false;
      return;
    }
    const dx = t.pos.x - c.pos.x;
    const dz = t.pos.z - c.pos.z;
    const dist = Math.hypot(dx, dz);
    const desiredYaw = Math.atan2(dx, dz);
    const meleeOnly = !c.heldGun();
    // 近战要更快转向贴身
    c.yaw = turnToward(c.yaw, desiredYaw, (meleeOnly ? 6 : 4.5) * dt);

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
        this.moveTarget.copy(this.lastKnown);
        this.hasMoveTarget = true;
        this.repathT = rand(2, 4);
        return;
      }
    }

    // 扔雷: 持步枪/冲锋枪、目标在 8-30m 且几乎静止超过 2.5s, 扔出唯一一颗手雷
    const gunId = c.heldGun()?.def.id;
    if (!this.fragUsed && c.throwables.frag > 0 && this.losOk &&
      (gunId === 'rifle' || gunId === 'smg') && dist >= 8 && dist <= 30) {
      if (t.speed2d < 0.6) this.stillT += dt; else this.stillT = 0;
      if (this.stillT > 2.5) {
        this.throwFrag(t, dist, game);
        return;
      }
    } else {
      this.stillT = 0;
    }

    // 移动: 近战全速贴近; 有枪则侧向走位 + 距离控制; 圈外优先进圈
    let vx = 0;
    let vz = 0;
    if (game.zone.isOutside(c.pos.x, c.pos.z)) {
      const zx = game.zone.center.x - c.pos.x;
      const zz = game.zone.center.y - c.pos.z;
      const zl = Math.hypot(zx, zz) || 1;
      vx = (zx / zl) * 5.2;
      vz = (zz / zl) * 5.2;
    } else if (meleeOnly) {
      const nx = dx / (dist || 1);
      const nz = dz / (dist || 1);
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = rand(0.6, 1.4);
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      }
      vx = (nx - nz * this.strafeDir * 0.35) * 5.0;
      vz = (nz + nx * this.strafeDir * 0.35) * 5.0;
    } else {
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = rand(0.8, 2.0);
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
      }
      const nx = dx / (dist || 1);
      const nz = dz / (dist || 1);
      let radial = 0;
      if (dist > 42) radial = 0.8;
      else if (dist < 12) radial = -0.7;
      const px = -nz * this.strafeDir;
      const pz = nx * this.strafeDir;
      let mx = px * 0.85 + nx * radial;
      let mz = pz * 0.85 + nz * radial;
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml;
      mz /= ml;
      const speed = this.reloadT > 0 ? 4.2 : 3.4;
      vx = mx * speed;
      vz = mz * speed;
    }
    c.applyMove(vx, vz, dt, game.world);

    // 攻击
    if (this.reactT > 0) {
      this.reactT -= dt;
      return;
    }
    if (meleeOnly) {
      if (dist < c.melee.def.range * 0.92) game.meleeAttack(c);
      return;
    }
    const gun = c.heldGun();
    if (!gun || this.reloadT > 0 || !this.losOk) return;
    if (angleDiff(c.yaw, desiredYaw) > 0.22) return;

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
    const tx = t.pos.x + (Math.random() - 0.5) * 5;
    const tz = t.pos.z + (Math.random() - 0.5) * 5;
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

  private fireAt(t: Character, dist: number, game: Game): void {
    const c = this.char;
    const gun = c.heldGun();
    if (!gun || gun.mag <= 0) return;
    c.eyePos(this.eye);
    t.chestPos(this.aim);
    // 距离/移动相关误差
    const sigma = 0.028 + dist * 0.00055 + (t.speed2d > 5 ? 0.024 : 0) + (t.isPlayer ? 0.007 : 0);
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

  // 被门/窗挡路: 关着的门停顿 ~0.4s 后开门通过; 窗(或近战冲锋时)累计 1s 直接破坏
  private updateDoorBreak(dt: number, game: Game): void {
    const c = this.char;
    const rage = this.state === 'engage' && !c.heldGun(); // 近战冲锋: 直接砸
    const wantsMove =
      (this.state === 'wander' && this.hasMoveTarget) || rage;
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
    this.repathT -= dt;
    const outside = game.zone.isOutside(c.pos.x, c.pos.z);

    if (outside) {
      game.zone.randomPointInside(game.tmpV2, 0.45);
      this.moveTarget.set(game.tmpV2.x, 0, game.tmpV2.y);
      this.hasMoveTarget = true;
      this.repathT = rand(3, 6);
    } else if (!this.hasMoveTarget || this.repathT <= 0 ||
      (Math.hypot(this.moveTarget.x - c.pos.x, this.moveTarget.z - c.pos.z) < 2.5)) {
      this.repathT = rand(4, 9);
      this.pickWanderPoint(game);
    }

    // 没枪时强烈优先找武器; 有枪无弹时强烈优先寻匹配弹药; 枪差时捡顺路的; 缺甲时找更好的甲
    const bestSlot = c.bestGunSlot();
    const tier = bestSlot >= 0 ? (c.guns[bestSlot]?.def.tier ?? 0) : 0;
    let gearFound = false;
    const needT = this.needsAmmoType();
    if (!outside && needT) {
      const ai = game.loot.nearestAmmoOfType(c.pos.x, c.pos.y, c.pos.z, 45, needT);
      if (ai) {
        this.moveTarget.copy(ai.group.position);
        this.hasMoveTarget = true;
        gearFound = true;
      }
    }
    if (!outside && !gearFound && tier < 3) {
      const item = game.loot.nearestWeapon(c.pos.x, c.pos.y, c.pos.z, tier === 0 ? 50 : 16);
      if (item) {
        const k = item.kind;
        if (isWeaponKind(k) && this.wantsWeapon(k)) {
          this.moveTarget.copy(item.group.position);
          this.hasMoveTarget = true;
          gearFound = true;
        }
      }
    }
    if (!outside && !gearFound && (!c.helmet || !c.vest || c.helmet.level < 3 || c.vest.level < 3)) {
      const ai = game.loot.nearestArmor(c.pos.x, c.pos.y, c.pos.z, 26);
      if (ai && this.wantsArmor(ai.kind)) {
        this.moveTarget.copy(ai.group.position);
        this.hasMoveTarget = true;
      }
    }

    const dx = this.moveTarget.x - c.pos.x;
    const dz = this.moveTarget.z - c.pos.z;
    const d = Math.hypot(dx, dz);
    let vx = 0;
    let vz = 0;
    if (this.hasMoveTarget && d > 1.2) {
      const speed = outside ? 5.4 : tier === 0 ? 4.6 : 4.0;
      vx = (dx / d) * speed;
      vz = (dz / d) * speed;
      c.yaw = turnToward(c.yaw, Math.atan2(dx, dz), 3.4 * dt);
    }
    c.applyMove(vx, vz, dt, game.world);
  }

  private pickWanderPoint(game: Game): void {
    const c = this.char;
    // 随圈缩紧, 点位逐渐偏向圈中心
    const pull = Math.min(0.75, Math.max(0, 1 - game.zone.radius / 300));
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = rand(15, 55);
      let x = c.pos.x + Math.cos(a) * d;
      let z = c.pos.z + Math.sin(a) * d;
      x += (game.zone.center.x - x) * pull * Math.random();
      z += (game.zone.center.y - z) * pull * Math.random();
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
  '伏地魔', '老六', '刚枪王', '快递员', '盒子精', '跑毒仔', '苟分佬', '枪神',
  '萌新', '大佬', '草丛伦', '天命圈', '平底锅', '三级头', '空投猎手', '幻影坦克',
  '雷神', '鹰眼', '毒奶', '吃鸡少年', '人体描边', '万事屋', '夜猫子',
];
