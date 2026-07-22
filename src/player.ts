// 玩家: 第一/第三人称可切换(V) + 移动/跳跃 + 武器/近战操控 + 拾取提示 + 后坐力 + 投掷
import * as THREE from 'three';
import {
  CANOPY_DEPLOY_VELOCITY, Character, stepAirDescentVelocity, SWIM_SPEED, SWIM_SPRINT_SPEED,
} from './character';
import type { Input } from './input';
import { isGunKind, isMeleeKind, isWeaponKind } from './loot';
import { ARMORS, armorFromLoot } from './armor';
import { MELEE, WEAPONS } from './weapons';
import { WATER_Y, WORLD_HALF } from './world';
import { driveVehicleStep, VEHICLE_SPEC, seatWorld, type Vehicle } from './vehicles';
import { probeVault, startVault, updateVaultMotion } from './vault';
import { clamp, lerp, turnToward } from './utils';
import { ATTACHMENTS, attachFromLoot, isAttachKind, magSizeOf, recoilFactorOf, sightZoomOf } from './attachments';
import { random } from './random';
import type { Game } from './game';
import type { WeaponId } from './types';
import {
  aimBlend, baseWeaponSpread, calculateAimSway, calculateWeaponSpread, scopeModeOf, smoothAimProgress,
} from './gunplay';

const BASE_FOV = 75;
const THROW_SPEED = 15; // 满蓄力投掷速度
const FREEFALL_STEER_SPEED = 12; // 开伞前水平修正限速(m/s)
const FREEFALL_STEER_RESPONSE = 5; // 自由落体转向响应
const CANOPY_STEER_SPEED = 12;
const CANOPY_STEER_RESPONSE = 1.6;
const AIR_STEER_DRAG = 1.2; // 松开方向键后保留少量惯性

interface RecoilFeel {
  vertical: number;
  horizontal: number;
  bloom: number;
  gunKick: number;
}

const RECOIL_FEEL: Record<WeaponId, RecoilFeel> = {
  pistol: { vertical: 0.95, horizontal: 0.22, bloom: 0.32, gunKick: 0.045 },
  rifle: { vertical: 1.0, horizontal: 0.42, bloom: 0.46, gunKick: 0.055 },
  akm: { vertical: 1.18, horizontal: 0.5, bloom: 0.52, gunKick: 0.07 },
  smg: { vertical: 0.78, horizontal: 0.5, bloom: 0.52, gunKick: 0.045 },
  dmr: { vertical: 1.16, horizontal: 0.25, bloom: 0.3, gunKick: 0.085 },
  sniper: { vertical: 1.35, horizontal: 0.16, bloom: 0.2, gunKick: 0.12 },
  shotgun: { vertical: 1.2, horizontal: 0.3, bloom: 0.16, gunKick: 0.1 },
};

export class PlayerController {
  readonly char: Character;
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = 0.1;
  aiming = false;
  reloading = false;
  // 空降状态: 舱内航线 → 自由落体 → 开伞滑翔 → 落地(null)
  descent: 'plane' | 'freefall' | 'canopy' | null = null;
  planeS = 0;          // 航线里程(m)
  vy = 0;              // 垂直速度(m/s, 负=下降)
  driving: Vehicle | null = null; // 驾驶中的载具

  private recoilP = 0;
  private recoilY = 0;
  private recoilChain = 0;
  private recoilRestT = 0;
  private shotBloom = 0;
  private aimF = 0;
  private aimTime = 0;
  private aimSway = { pitch: 0, yaw: 0 };
  private fireTimer = 0;
  private reloadT = 0;
  private camDist = 3.4;
  private fov = BASE_FOV;
  private hv = new THREE.Vector2(); // 空降水平速度
  private moveVel = new THREE.Vector2(); // 玩家地面/游泳水平惯性
  private stepAcc = 0;
  private swimAcc = 0;      // 游泳划水距离累计
  private swimToastT = 0;   // '游泳中无法攻击'提示节流
  private throwHold = false; // 正在按住左键蓄力瞄准
  private holdT = 0;         // 蓄力时长
  private jumpHeld = false;
  private jumpBufferT = 0;
  private coyoteT = 0;
  private camBobPhase = 0;
  private camBob = 0;
  private camRoll = 0;
  private landDip = 0;
  spreadRad = 0.004;

  private viewDir = new THREE.Vector3();
  private pivot = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private camDir = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private throwDir = new THREE.Vector3();
  private throwOrigin = new THREE.Vector3();
  private tmpSwim = new THREE.Vector3();
  private planeNext = new THREE.Vector3();

  constructor(shirtColor: number) {
    this.char = new Character('你', true, shirtColor);
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 900);
  }

  get alive(): boolean {
    return this.char.alive;
  }

  get aimProgress(): number {
    return this.aimF;
  }

  update(dt: number, input: Input, game: Game): void {
    const c = this.char;
    // 进入空降, 载具, 翻越或死亡时立即退出镜轴, 防止上一帧 ADS 覆盖层残留。
    if (!c.alive || this.descent || this.driving || c.vault) {
      this.aiming = false;
      this.aimF = 0;
      c.setFirstPerson(false);
    }
    if (!c.alive) {
      if (this.driving) this.exitVehicle(game, false);
      this.updateCamera(dt, game);
      return;
    }

    // ---- 视角 ----
    const { dx, dy } = input.consumeMouse();
    const zoomScale = this.fov / BASE_FOV;
    this.yaw -= dx * 0.0021 * zoomScale;
    this.pitch = clamp(this.pitch - dy * 0.0021 * zoomScale, -1.25, 1.35);
    this.recoilP *= Math.exp(-9 * dt);
    this.recoilY *= Math.exp(-12 * dt);
    this.shotBloom *= Math.exp(-(this.aiming ? 8.5 : 6) * dt);
    this.recoilRestT = Math.max(0, this.recoilRestT - dt);
    if (this.recoilRestT <= 0) this.recoilChain = Math.max(0, this.recoilChain - dt * 10);
    this.landDip *= Math.exp(-11 * dt);

    // ---- 空降阶段: 舱内/自由落体/开伞滑翔(全程禁射击/道具/姿态) ----
    if (this.descent) {
      this.updateDescent(dt, input, game);
      this.jumpHeld = input.keys.has('Space');
      if (this.descent === 'plane') this.planeCamera(dt, dx, dy, game);
      else this.updateCamera(dt, game);
      return;
    }

    // ---- 驾驶阶段: 载具运动学 + 追逐相机(禁射击/道具) ----
    if (this.driving) {
      if (this.driving.dead) {
        this.exitVehicle(game, false);
      } else {
        this.driveVehicle(dt, input, game);
        return;
      }
    }

    // ---- 翻越中: 锁定移动/攻击输入, 只保留视角 ----
    c.vaultCd = Math.max(0, c.vaultCd - dt);
    if (c.vault) {
      updateVaultMotion(c, dt);
      if (!c.vault) game.audio.jumpLand();
      c.yaw = this.yaw;
      this.updateCamera(dt, game);
      return;
    }

    const gun = c.heldGun();
    this.aiming = input.rmb && !this.reloading && gun !== null && !c.swimming && !c.knocked;
    if (gun) this.aimF = smoothAimProgress(this.aimF, this.aiming, gun.def.id, dt);
    else this.aimF = lerp(this.aimF, 0, 1 - Math.exp(-16 * dt));
    this.aimTime += dt;

    // ---- 移动 ----
    const fwdX = Math.sin(this.yaw);
    const fwdZ = Math.cos(this.yaw);
    const rightX = -fwdZ;
    const rightZ = fwdX;
    let wx = 0;
    let wz = 0;
    if (input.keys.has('KeyW')) { wx += fwdX; wz += fwdZ; }
    if (input.keys.has('KeyS')) { wx -= fwdX; wz -= fwdZ; }
    if (input.keys.has('KeyD')) { wx += rightX; wz += rightZ; }
    if (input.keys.has('KeyA')) { wx -= rightX; wz -= rightZ; }
    const wlen = Math.hypot(wx, wz);
    const sprint = input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');
    // 疾跑/跳跃自动站起(仅站立可疾跑, 站/蹲可跳)
    if (sprint && wlen > 0.001 && !c.knocked && !c.swimming && c.stance !== 'stand') c.setStance('stand');
    let targetVx = 0;
    let targetVz = 0;
    let sprintActive = false;
    let jumped = false;
    if (wlen > 0.001) {
      wx /= wlen;
      wz /= wlen;
      const forwardDot = wx * fwdX + wz * fwdZ;
      const strafeDot = wx * rightX + wz * rightZ;
      let speed = 4.55;
      if (c.knocked) speed = 0.6; // 倒地爬行(仅移动, 无其他动作)
      else if (c.swimming) {
        sprintActive = sprint && forwardDot > -0.15;
        speed = sprintActive ? SWIM_SPRINT_SPEED : SWIM_SPEED;
        speed *= forwardDot < -0.2 ? 0.72 : 1 - Math.abs(strafeDot) * 0.1;
      }
      else if (this.aiming) speed = 2.7;
      else if (sprint && forwardDot > 0.35 && c.stance === 'stand') {
        speed = 6.9;
        sprintActive = true;
      } else {
        speed *= forwardDot < -0.2 ? 0.78 : 1 - Math.abs(strafeDot) * 0.08;
      }
      if (!c.swimming && !c.knocked) {
        speed *= c.stance === 'crouch' ? 0.5 : c.stance === 'prone' ? 0.25 : 1; // 蹲 50% / 趴 25% 爬行
        const groundH = game.world.getHeight(c.pos.x, c.pos.z);
        const wadeDepth = WATER_Y - groundH;
        if (c.pos.y < WATER_Y + 0.15 && wadeDepth > 0) {
          speed *= lerp(0.84, 0.55, clamp(wadeDepth / 0.85, 0, 1));
        }
      }
      targetVx = wx * speed;
      targetVz = wz * speed;
    }
    // 地面起步快, 收步更利落; 空中和水中保留可控惯性
    const hasMoveInput = wlen > 0.001;
    const response = c.swimming
      ? hasMoveInput ? 5.2 : 3.8
      : c.knocked
        ? hasMoveInput ? 9 : 12
        : c.grounded
          ? hasMoveInput ? (sprintActive ? 10 : 14) : 18
          : hasMoveInput ? 3.6 : 1.2;
    const moveBlend = 1 - Math.exp(-response * dt);
    this.moveVel.x = lerp(this.moveVel.x, targetVx, moveBlend);
    this.moveVel.y = lerp(this.moveVel.y, targetVz, moveBlend);
    if (!hasMoveInput && this.moveVel.lengthSq() < 0.0025) this.moveVel.set(0, 0);

    const jumpDown = input.keys.has('Space');
    if (jumpDown && !this.jumpHeld) this.jumpBufferT = 0.12;
    this.jumpHeld = jumpDown;
    this.jumpBufferT = Math.max(0, this.jumpBufferT - dt);
    this.coyoteT = c.grounded ? 0.1 : Math.max(0, this.coyoteT - dt);
    if (this.jumpBufferT > 0 && this.coyoteT > 0 && !c.swimming && !c.knocked && c.vaultCd <= 0) {
      // 先尝试翻越: 站/蹲朝可翻越障碍(趴下/恢复读条中不可翻越)
      let vaulted = false;
      if (c.stance !== 'prone' && wlen > 0.001 && game.healT <= 0) {
        const probe = probeVault(c, wx, wz, game.world);
        if (probe) {
          if (probe.win && probe.win.alive) game.hitDestructible(probe.win, 999, c.pos);
          startVault(c, probe);
          this.moveVel.set(0, 0);
          game.audio.vault();
          vaulted = true;
        }
      }
      if (!vaulted) {
        if (c.stance !== 'stand') c.setStance('stand'); // 起身再跳
        c.vy = 7.4;
        c.grounded = false;
        jumped = true;
      }
      this.jumpBufferT = 0;
      this.coyoteT = 0;
    }
    const wasSwimming = c.swimming;
    const wasAir = !c.grounded;
    const fallSpeed = c.vy;
    if (c.swimming) {
      c.applySwim(this.moveVel.x, this.moveVel.y, dt, game.world);
      // 划水声 + 小水花(按划水距离节流)
      this.swimAcc += c.speed2d * dt;
      const strokeDist = sprintActive ? 1.05 : 1.65;
      if (this.swimAcc > strokeDist) {
        this.swimAcc = 0;
        game.audio.swimStroke();
        game.effects.splashSmall(this.tmpSwim.set(c.pos.x, WATER_Y + 0.04, c.pos.z));
      }
    } else {
      c.applyMove(this.moveVel.x, this.moveVel.y, dt, game.world);
      if (wasAir && c.grounded) {
        game.audio.jumpLand();
        this.landDip = Math.max(this.landDip, clamp(Math.abs(fallSpeed) * 0.012, 0.035, 0.14));
      }
    }
    game.updateSwim(c);
    if (!wasSwimming && c.swimming) {
      this.moveVel.multiplyScalar(0.55);
      this.swimAcc = 0;
    } else if (wasSwimming && !c.swimming) {
      this.moveVel.multiplyScalar(0.65);
      this.swimAcc = 0;
      this.landDip = Math.max(this.landDip, 0.045);
    }
    if (c.swimming && c.speed2d > 0.15) {
      c.yaw = turnToward(c.yaw, Math.atan2(this.moveVel.x, this.moveVel.y), dt * 4.8);
    } else {
      c.yaw = this.yaw;
    }
    const lateralSpeed = this.moveVel.x * rightX + this.moveVel.y * rightZ;
    c.moveLean = lerp(c.moveLean, c.swimming ? 0 : clamp(lateralSpeed / 6.9, -1, 1), Math.min(1, dt * 9));
    // 脚步按真实位移累计, 撞墙和加速阶段不会播放虚假高频脚步
    if (c.grounded && !c.swimming && c.speed2d > 0.15) {
      this.stepAcc += c.speed2d * dt;
      const stepDist = sprintActive ? 2.2 : c.stance === 'prone' ? 1.65 : c.stance === 'crouch' ? 2.1 : 2.55;
      if (this.stepAcc > stepDist) {
        this.stepAcc -= stepDist;
        game.audio.step(c.stance === 'prone' ? 0.35 : c.stance === 'crouch' ? 0.6 : sprintActive ? 1.12 : 1);
      }
    }
    // ADS: 枪械随视线俯仰(平滑); 换弹进度供模型下沉/弹匣脱落动画
    c.aimPitch = lerp(c.aimPitch, this.aiming ? this.pitch : 0, Math.min(1, dt * 12));

    // ---- 攻击(枪械 / 近战) ----
    this.fireTimer -= dt;
    let acted = false; // 开火或挥击(打断包扎)
    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0 && gun) {
        const need = magSizeOf(gun) - gun.mag;
        const take = Math.min(need, c.ammo[gun.def.ammo]);
        gun.mag += take;
        c.ammo[gun.def.ammo] -= take;
        this.reloading = false;
      }
    }
    c.reload01 = this.reloading && gun ? clamp(1 - this.reloadT / gun.def.reloadTime, 0.01, 1) : 0;
    const pressedEdge = input.consumeFirePressed();
    // 切离投掷栏时收起轨迹预览
    if (c.curSlot !== 4 && this.throwHold) {
      this.throwHold = false;
      game.grenades.hidePreview();
    }
    // 游泳中禁止攻击/投掷(节流提示)
    this.swimToastT -= dt;
    if (c.swimming) {
      if (this.throwHold) {
        this.throwHold = false;
        game.grenades.hidePreview();
      }
      if ((input.lmb || pressedEdge) && this.swimToastT <= 0) {
        this.swimToastT = 1.2;
        game.hud.toast('游泳中无法攻击');
      }
    }
    if (c.swimming) {
      this.spreadRad = lerp(this.spreadRad, 0.004, Math.min(1, dt * 10));
    } else if (c.knocked) {
      // 倒地不能攻击/投掷/近战
      this.spreadRad = lerp(this.spreadRad, 0.004, Math.min(1, dt * 10));
    } else if (c.curSlot === 3) {
      // 近战: 按住连挥, 冷却在 meleeAttack 内判定
      if (input.lmb && game.meleeAttack(c)) acted = true;
      this.spreadRad = lerp(this.spreadRad, 0.004, Math.min(1, dt * 10));
    } else if (c.curSlot === 4) {
      if (this.updateThrow(dt, input, game)) acted = true;
      this.spreadRad = lerp(this.spreadRad, 0.004, Math.min(1, dt * 10));
    } else if (gun) {
      const wantFire = gun.def.auto ? input.lmb : pressedEdge;
      if (wantFire && !this.reloading && this.fireTimer <= 0) {
        if (gun.mag <= 0) {
          game.audio.empty();
          if (c.ammo[gun.def.ammo] <= 0) game.dryFireToast(gun.def.ammo); // 空枪且无备弹: 报所需弹种
          this.startReload(game);
        } else if (game.playerShot()) {
          this.fireTimer = gun.def.fireInterval;
          const feel = RECOIL_FEEL[gun.def.id];
          const stanceControl = c.stance === 'crouch' ? 0.82 : c.stance === 'prone' ? 0.62 : 1;
          const aimControl = lerp(1, 0.88, aimBlend(this.aimF));
          const chainF = 1 + Math.min(this.recoilChain, 10) * 0.025;
          const recoil = gun.def.recoil * recoilFactorOf(gun) * stanceControl * aimControl;
          const verticalKick = recoil * feel.vertical * chainF;
          const horizontalKick = (random() * 2 - 1) * recoil * feel.horizontal * (0.75 + chainF * 0.25);
          this.recoilP += verticalKick;
          this.recoilY += horizontalKick;
          // 少量永久枪口上跳需要玩家压枪, 大部分瞬时反馈会自动回正
          this.pitch = clamp(this.pitch + verticalKick * 0.2, -1.25, 1.35);
          this.yaw += horizontalKick * 0.12;
          this.recoilChain++;
          this.recoilRestT = Math.max(0.2, gun.def.fireInterval * 1.7);
          const baseSpread = baseWeaponSpread(gun, this.aimF);
          this.shotBloom = Math.min(0.032, this.shotBloom + baseSpread * feel.bloom);
          c.gunKick = Math.max(c.gunKick, feel.gunKick * lerp(1, 0.8, aimBlend(this.aimF)));
          acted = true;
        }
      }
      this.spreadRad = lerp(this.spreadRad, calculateWeaponSpread({
        gun,
        aimProgress: this.aimF,
        stance: c.stance,
        speed: c.speed2d,
        grounded: c.grounded,
        bloom: this.shotBloom,
      }), Math.min(1, dt * 13));
    }

    // ---- 包扎打断(快于爬行的移动/跳跃/开火) ----
    if (game.healT > 0) {
      const tooFast = c.speed2d > 1.3;
      if (tooFast || jumped || acted) game.cancelHeal('包扎被打断');
    }

    // ---- 拾取提示(武器需按 F) ----
    this.updatePickupPrompt(game);
    // 弹药/医疗包/投掷物走近自动拾取
    const auto = game.loot.nearest(c.pos.x, c.pos.y, c.pos.z, 1.9);
    if (auto && !isWeaponKind(auto.kind) && !isAttachKind(auto.kind)) {
      game.applyAutoPickup(c, auto);
    }

    this.updateCamera(dt, game);
  }

  private updatePickupPrompt(game: Game): void {
    const c = this.char;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    // 物品候选: 最近的武器/护具/背包/配件且大致在前方
    let item = game.loot.nearestFPickup(c.pos.x, c.pos.y, c.pos.z, 2.6);
    let itemDot = -1;
    if (item) {
      const dx = item.group.position.x - c.pos.x;
      const dz = item.group.position.z - c.pos.z;
      const d = Math.hypot(dx, dz);
      itemDot = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
      if (itemDot < 0.35) item = null;
    }
    // 门候选: 2.2m 内看得最正的活门
    const door = game.findDoorInteraction(c.pos.x, c.pos.y, c.pos.z, fx, fz);
    game.promptItem = null;
    game.promptDoor = null;
    game.promptVehicle = null;
    game.promptCrate = null;
    game.promptDeathCrate = null;
    game.promptAlly = null;
    // 两者同时在场: 看得更正的优先
    if (door && (!item || door.dot >= itemDot)) {
      game.promptDoor = door.d;
      game.hud.setPickupPrompt(door.d.open ? '按 F 关门' : '按 F 开门');
      return;
    }
    // 救援候选: 2.2m 内倒地队友(自己非倒地)
    if (!c.knocked) {
      const ally = game.knock.nearestKnocked(c.pos.x, c.pos.z, 2.2);
      if (ally) {
        game.promptAlly = ally;
        game.hud.setPickupPrompt('按 F 救援');
        return;
      }
    }
    // 空投候选: 2.8m 内落地未开的空投
    const crate = game.airdrop.nearestClosedCrate(c.pos.x, c.pos.y, c.pos.z, 2.8);
    if (crate) {
      game.promptCrate = crate;
      game.hud.setPickupPrompt('按 F 打开空投');
      return;
    }
    const deathCrate = game.deathCrates.nearest(c.pos.x, c.pos.y, c.pos.z, 2.8);
    if (deathCrate) {
      game.promptDeathCrate = deathCrate;
      game.hud.setPickupPrompt(`按 F 搜索 ${deathCrate.owner} 的盒子`);
      return;
    }
    // 载具候选: 2.6m 内可驾驶载具
    const veh = game.vehicles.nearest(c.pos.x, c.pos.z, 2.6);
    if (veh) {
      game.promptVehicle = veh;
      game.hud.setPickupPrompt('按 F 驾驶');
      return;
    }
    if (!item) {
      game.hud.setPickupPrompt(null);
      return;
    }
    game.promptItem = item;
    const k = item.kind;
    if (isMeleeKind(k)) {
      game.hud.setPickupPrompt(`按 F 拾取 ${MELEE[k].name}`);
    } else if (isGunKind(k)) {
      const def = WEAPONS[k];
      const state = item.mag > 0 ? `${item.mag} 发` : item.ammo > 0 ? `无弹, 备弹 ${item.ammo}` : '无弹';
      game.hud.setPickupPrompt(`按 F 拾取 ${def.name}（${state}）`);
    } else if (isAttachKind(k)) {
      const id = attachFromLoot(k);
      if (id) game.hud.setPickupPrompt(`按 F 装配 ${ATTACHMENTS[id].name}`);
    } else {
      const info = armorFromLoot(k);
      if (info) game.hud.setPickupPrompt(`按 F 拾取 ${ARMORS[info.kind][info.level].name}`);
    }
  }

  // 投掷起点: TPP 从胸前出手, FPP 从眼位前方出手(不穿脸); 均随姿态高度
  private throwStart(c: Character, out: THREE.Vector3, dir: THREE.Vector3, fpp: boolean): void {
    if (fpp) {
      out.set(c.pos.x, c.pos.y + c.eyeHeight() - 0.07, c.pos.z).addScaledVector(dir, 0.35);
    } else {
      c.chestPos(out);
      out.addScaledVector(dir, 0.4);
    }
  }

  // 投掷物: 按住左键蓄力瞄准(轨迹预览), 松开投出; 蓄力 0.8s 达满速
  private updateThrow(dt: number, input: Input, game: Game): boolean {
    const c = this.char;
    const count = c.throwables[c.throwKind];
    if (input.lmb && count > 0) {
      if (!this.throwHold) {
        this.throwHold = true;
        this.holdT = 0;
      }
      this.holdT += dt;
      const speed = THROW_SPEED * (0.6 + 0.4 * Math.min(1, this.holdT / 0.8));
      this.getViewDir(this.throwDir);
      this.throwStart(c, this.throwOrigin, this.throwDir, game.viewFpp);
      game.grenades.showPreview(game.world, this.throwOrigin, this.throwDir, speed);
      return false;
    }
    if (this.throwHold) {
      // 松开: 投出
      this.throwHold = false;
      game.grenades.hidePreview();
      const speed = THROW_SPEED * (0.6 + 0.4 * Math.min(1, this.holdT / 0.8));
      this.getViewDir(this.throwDir);
      this.throwStart(c, this.throwOrigin, this.throwDir, game.viewFpp);
      game.throwGrenade(c, c.throwKind, this.throwOrigin, this.throwDir, speed);
      c.throwables[c.throwKind]--;
      c.swingT = 1; // 挥臂动作
      // 用尽后自动切到另一种
      const other = c.throwKind === 'frag' ? 'smoke' : 'frag';
      if (c.throwables[c.throwKind] === 0 && c.throwables[other] > 0) c.throwKind = other;
      return true;
    }
    game.grenades.hidePreview();
    return false;
  }

  // ---- 空降物理 ----

  // 跳伞(舱内按 F / 航线末端自动): 进入自由落体
  startFreefall(game: Game, forced = false): void {
    if (this.descent !== 'plane') return;
    if (!forced && !game.isInsideFlightJumpZone(this.char.pos.x, this.char.pos.z)) return;
    this.descent = 'freefall';
    this.vy = -2;
    this.char.airPose = 'fall';
    this.char.group.visible = true;
    game.audio.planeDroneStop();
    game.onPlayerJump();
  }

  // 开伞: 自动 70m 或手动 Space(<150m)
  private deployCanopy(game: Game): void {
    if (this.descent !== 'freefall') return;
    this.descent = 'canopy';
    this.vy = CANOPY_DEPLOY_VELOCITY;
    this.char.airPose = 'canopy';
    this.char.attachCanopy(0xd8843c);
    game.audio.canopyDeploy();
  }

  // 着陆: 恢复站立/操控, 卸伞
  private land(game: Game, groundY: number): void {
    const c = this.char;
    c.pos.y = groundY;
    c.vy = 0;
    this.vy = 0;
    this.hv.set(0, 0);
    this.moveVel.set(0, 0);
    this.landDip = 0.08;
    this.descent = null;
    c.airPose = null;
    c.airSteerRight = 0;
    c.airSteerForward = 0;
    c.stance = 'stand';
    c.stanceF = 0;
    c.moveLean = 0;
    c.removeCanopy();
    game.audio.windStop();
    game.audio.jumpLand();
  }

  private updateDescent(dt: number, input: Input, game: Game): void {
    const c = this.char;
    // 空降和游泳是互斥状态, 避免重开或测试场景残留水中姿态/HUD.
    c.swimming = false;
    c.swimDip = 0;
    c.grounded = false;
    if (this.descent === 'plane') {
      this.planeS += 92 * dt;
      game.flightPoint(c.pos, this.planeS);
      c.group.visible = false; // 舱内隐藏(机外追击机位看不到自己)
      game.audio.planeDroneSet(0.85);
      const insideJumpZone = game.isInsideFlightJumpZone(c.pos.x, c.pos.z);
      if (insideJumpZone) {
        game.flightPoint(this.planeNext, this.planeS + 92 * dt);
        if (!game.isInsideFlightJumpZone(this.planeNext.x, this.planeNext.z)) this.startFreefall(game, true);
      }
      return;
    }
    const phase = this.descent;
    if (!phase) return;
    // 水平操控: WASD 相对视线
    const fwdX = Math.sin(this.yaw);
    const fwdZ = Math.cos(this.yaw);
    const rightX = -fwdZ;
    const rightZ = fwdX;
    let wx = 0;
    let wz = 0;
    if (input.keys.has('KeyW')) { wx += fwdX; wz += fwdZ; }
    if (input.keys.has('KeyS')) { wx -= fwdX; wz -= fwdZ; }
    if (input.keys.has('KeyD')) { wx += rightX; wz += rightZ; }
    if (input.keys.has('KeyA')) { wx -= rightX; wz -= rightZ; }
    const wl = Math.hypot(wx, wz);
    const freefall = this.descent === 'freefall';
    const maxHv = freefall ? FREEFALL_STEER_SPEED : CANOPY_STEER_SPEED;
    const response = freefall ? FREEFALL_STEER_RESPONSE : CANOPY_STEER_RESPONSE;
    if (wl > 0.001) {
      wx /= wl;
      wz /= wl;
      const steer = 1 - Math.exp(-dt * response);
      this.hv.x = lerp(this.hv.x, wx * maxHv, steer);
      this.hv.y = lerp(this.hv.y, wz * maxHv, steer);
    } else {
      const drag = Math.exp(-AIR_STEER_DRAG * dt);
      this.hv.x *= drag;
      this.hv.y *= drag;
    }
    c.speed2d = this.hv.length();
    if (freefall) {
      c.airSteerRight = clamp((this.hv.x * rightX + this.hv.y * rightZ) / maxHv, -1, 1);
      c.airSteerForward = clamp((this.hv.x * fwdX + this.hv.y * fwdZ) / maxHv, -1, 1);
    }
    // 玩家与 AI 使用同一套自由落体/滑翔速度曲线。
    this.vy = stepAirDescentVelocity(this.vy, phase, dt);
    c.pos.x += this.hv.x * dt;
    c.pos.z += this.hv.y * dt;
    c.pos.x = clamp(c.pos.x, -WORLD_HALF + 1, WORLD_HALF - 1);
    c.pos.z = clamp(c.pos.z, -WORLD_HALF + 1, WORLD_HALF - 1);
    c.pos.y += this.vy * dt;
    c.yaw = this.yaw;
    game.audio.windSet(Math.min(1, Math.abs(this.vy) / 55));
    // 开伞: 自动 70m / 手动 <150m
    const agl = c.pos.y - game.world.getHeight(c.pos.x, c.pos.z);
    if (this.descent === 'freefall' && (agl <= 70 || (input.keys.has('Space') && agl < 150))) {
      this.deployCanopy(game);
    }
    // 着陆(groundHeight 含屋顶/桥面)
    const g = game.world.groundHeight(c.pos.x, c.pos.z, c.pos.y);
    if (c.pos.y <= g) this.land(game, g);
  }

  // ---- 载具驾驶 ----

  // 上车(F 近驾驶座)
  enterVehicle(v: Vehicle, game: Game): void {
    if (this.driving || this.descent || this.char.knocked || v.dead || v.burnT >= 0 || v.driver) return;
    v.claimedBy = null;
    this.driving = v;
    v.driver = this.char;
    const c = this.char;
    c.airPose = 'sit';
    c.stance = 'stand';
    c.stanceF = 0;
    c.moveLean = 0;
    this.moveVel.set(0, 0);
    seatWorld(v, c.pos);
    c.yaw = v.yaw;
    this.yaw = v.yaw;
    game.audio.vehicleDoor();
    game.hud.toast('W/S 油门刹车 · A/D 转向 · Space 手刹 · F 下车');
  }

  // 下车(F, 需低速)
  tryExitVehicle(game: Game): void {
    const v = this.driving;
    if (!v) return;
    if (Math.abs(v.speed) > 3) {
      game.hud.toast('速度太快, 无法下车');
      return;
    }
    this.exitVehicle(game, false);
  }

  // 落座右侧下车(强制下车也走这里)
  exitVehicle(game: Game, forced: boolean): void {
    const v = this.driving;
    if (!v) return;
    const c = this.char;
    const rx = Math.cos(v.yaw);
    const rz = -Math.sin(v.yaw);
    c.pos.set(v.pos.x + rx * 2.0, 0, v.pos.z + rz * 2.0);
    c.pos.y = game.world.groundHeight(c.pos.x, c.pos.z, v.pos.y + 1);
    c.airPose = null;
    c.stance = 'stand';
    c.stanceF = 0;
    c.vy = 0;
    c.moveLean = 0;
    this.moveVel.set(0, 0);
    v.driver = null;
    v.speed = 0;
    this.driving = null;
    game.audio.engineStop();
    if (!forced) game.audio.vehicleDoor();
  }

  // 载具运动学: 油门/刹车/倒车/手刹 + 转向(高速衰减) + 地形跟随 + 碰撞滑动
  private driveVehicle(dt: number, input: Input, game: Game): void {
    const v = this.driving as Vehicle;
    const spec = VEHICLE_SPEC[v.kind];
    const W = input.keys.has('KeyW');
    const S = input.keys.has('KeyS');
    const steerIn = (input.keys.has('KeyA') ? 1 : 0) - (input.keys.has('KeyD') ? 1 : 0);
    const result = driveVehicleStep(v, this.char, {
      throttle: W ? 1 : S ? -1 : 0,
      steer: steerIn,
      handbrake: input.keys.has('Space'),
    }, dt, game);
    if (result.stalled) return;
    this.yaw = v.yaw;
    this.driveCamera(dt, game, v);
    game.audio.engineSet(Math.abs(v.speed) / spec.vmax);
  }

  // 追逐相机(车后上方, 与 TPP 同款防穿)
  private driveCamera(dt: number, game: Game, v: Vehicle): void {
    const dirX = Math.sin(v.yaw);
    const dirZ = Math.cos(v.yaw);
    const dist = v.kind === 'car' ? 6.2 : v.kind === 'buggy' ? 5.7 : 5.0;
    this.pivot.set(v.pos.x, v.pos.y + 1.4, v.pos.z);
    this.camTarget.set(v.pos.x - dirX * dist, v.pos.y + 2.4, v.pos.z - dirZ * dist);
    this.camDir.subVectors(this.camTarget, this.pivot);
    const len = this.camDir.length();
    if (len > 0.001) {
      this.camDir.divideScalar(len);
      let allowed = len;
      const tTerr = game.world.raycastTerrain(this.pivot, this.camDir, len);
      if (tTerr < allowed) allowed = tTerr;
      if (game.world.raycastStatics(this.pivot, this.camDir, len, game.staticHit)) {
        allowed = Math.min(allowed, game.staticHit.t);
      }
      allowed = Math.max(allowed - 0.25, 0.4);
      const k = allowed < this.camDist ? 26 : 12;
      this.camDist = lerp(this.camDist, allowed, Math.min(1, dt * k));
    }
    this.camera.position.copy(this.pivot).addScaledVector(this.camDir, this.camDist);
    const minY = game.world.getHeight(this.camera.position.x, this.camera.position.z) + 0.3;
    if (this.camera.position.y < minY) this.camera.position.y = minY;
    if (game.shakeAmp > 0.002) {
      this.camera.position.x += (Math.random() - 0.5) * game.shakeAmp * 0.22;
      this.camera.position.y += (Math.random() - 0.5) * game.shakeAmp * 0.22;
      this.camera.position.z += (Math.random() - 0.5) * game.shakeAmp * 0.22;
    }
    this.lookAt.set(v.pos.x + dirX * 6, v.pos.y + 1.2, v.pos.z + dirZ * 6);
    this.camera.lookAt(this.lookAt);
    this.fov = lerp(this.fov, BASE_FOV + Math.abs(v.speed) * 0.5, Math.min(1, dt * 6));
    if (Math.abs(this.fov - this.camera.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  startReload(game: Game): void {
    const gun = this.char.heldGun();
    if (!gun || this.reloading || gun.mag >= magSizeOf(gun) || this.char.ammo[gun.def.ammo] <= 0) return;
    this.reloading = true;
    this.reloadT = gun.def.reloadTime;
    if (gun.def.id === 'shotgun') game.audio.reloadShotgun();
    else game.audio.reload();
  }

  switchSlot(i: number, game: Game): void {
    const c = this.char;
    if (i === c.curSlot) return;
    if (i < 3 && !c.guns[i]) return;
    c.curSlot = i;
    this.reloading = false;
    this.fireTimer = Math.max(this.fireTimer, 0.25);
    game.audio.reload();
  }

  // 当前视线方向(含后坐力)
  getViewDir(out: THREE.Vector3): THREE.Vector3 {
    const gun = this.char.heldGun();
    if (gun) calculateAimSway(this.aimSway, gun.def.id, this.aimF, this.char.stance, this.char.speed2d, this.aimTime);
    else {
      this.aimSway.pitch = 0;
      this.aimSway.yaw = 0;
    }
    const p = this.pitch + this.recoilP + this.aimSway.pitch;
    const y = this.yaw + this.recoilY + this.aimSway.yaw;
    const cp = Math.cos(p);
    out.set(Math.sin(y) * cp, Math.sin(p), Math.cos(y) * cp);
    return out;
  }

  // 舱内追击机位: 右后上方看运输机, 鼠标可小幅偏移视线
  private planeLookYaw = 0;
  private planeLookPitch = 0;
  private planeCamera(dt: number, dx: number, dy: number, game: Game): void {
    this.planeLookYaw = clamp(this.planeLookYaw - dx * 0.0021, -1.15, 1.15);
    this.planeLookPitch = clamp(this.planeLookPitch - dy * 0.0021, -0.5, 0.5);
    const A = game.flightAngle;
    const fx = Math.cos(A);
    const fz = Math.sin(A);
    const rx = -fz;
    const rz = fx;
    const p = this.char.pos;
    this.camera.position.set(p.x - fx * 17 + rx * 7.5, p.y + 4.6, p.z - fz * 17 + rz * 7.5);
    this.lookAt.set(p.x + fx * 6, p.y - 0.5, p.z + fz * 6);
    this.camera.lookAt(this.lookAt);
    this.camera.rotateY(this.planeLookYaw);
    this.camera.rotateX(this.planeLookPitch);
    const targetFov = BASE_FOV;
    this.fov = lerp(this.fov, targetFov, Math.min(1, dt * 10));
    if (Math.abs(this.fov - this.camera.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private updateCamera(dt: number, game: Game): void {
    const c = this.char;
    const dir = this.getViewDir(this.viewDir);
    const gun = c.heldGun();
    const zoom = gun ? lerp(1, sightZoomOf(gun), aimBlend(this.aimF)) : 1;
    // 装配瞄具完成开镜后让相机真正进入镜轴, 避免第三人称角色遮挡镜内视野。
    const fpp = game.viewFpp || scopeModeOf(gun, this.aimF) !== 'none';
    c.setFirstPerson(fpp);

    // 陆地脚步轻微起伏, 游泳随划水节奏浮动, 侧移产生小幅镜头侧倾
    let targetBob = 0;
    if (c.swimming) {
      const swimMoveF = clamp(c.speed2d / SWIM_SPRINT_SPEED, 0, 1);
      targetBob = Math.sin(c.swimT * 3.6) * (0.008 + swimMoveF * 0.025);
    } else if (c.grounded && c.speed2d > 0.2 && !c.knocked) {
      const speedF = clamp(c.speed2d / 6.9, 0, 1);
      this.camBobPhase += dt * (6.5 + c.speed2d * 1.05);
      targetBob = Math.sin(this.camBobPhase * 2) * (0.006 + speedF * 0.025);
    }
    this.camBob = lerp(this.camBob, targetBob, Math.min(1, dt * 12));
    const swimRoll = c.swimming
      ? Math.sin(c.swimT * 1.8) * clamp(c.speed2d / SWIM_SPRINT_SPEED, 0, 1) * 0.012
      : 0;
    const targetRoll = swimRoll - c.moveLean * (fpp ? 0.018 : 0.009);
    this.camRoll = lerp(this.camRoll, targetRoll, Math.min(1, dt * 9));
    const verticalFeel = this.camBob - this.landDip;

    if (fpp) {
      // 第一人称: 相机即眼位(随姿态 1.62/1.1/0.35), 直接看向, 无防穿拉近(camDist 保留供 TPP 恢复)
      this.camera.position.set(c.pos.x, c.pos.y + c.eyeHeight(), c.pos.z);
      this.camera.position.y += verticalFeel;
      if (game.shakeAmp > 0.002) {
        this.camera.position.x += (Math.random() - 0.5) * game.shakeAmp * 0.22;
        this.camera.position.y += (Math.random() - 0.5) * game.shakeAmp * 0.22;
        this.camera.position.z += (Math.random() - 0.5) * game.shakeAmp * 0.22;
      }
      this.lookAt.copy(this.camera.position).addScaledVector(dir, 14);
      this.camera.lookAt(this.lookAt);
    } else {
      this.pivot.set(c.pos.x, c.pos.y + c.eyeHeight() - 0.04, c.pos.z);
      this.pivot.y += verticalFeel * 0.42;
      if (this.descent === 'freefall') {
        // 保留少量相机滞后以呈现水平位移
        this.pivot.x -= this.hv.x * 0.07;
        this.pivot.z -= this.hv.y * 0.07;
      }

      const ads = aimBlend(this.aimF);
      const adsDist = gun?.def === WEAPONS.sniper ? 1.5 : 1.9;
      const targetDist = lerp(3.4, adsDist, ads);
      const shoulder = lerp(0.5, 0.55, ads);

      // 期望机位
      this.camDir.copy(dir).multiplyScalar(-1);
      this.camTarget.copy(this.pivot).addScaledVector(this.camDir, targetDist);
      // 肩部偏移(右 = cross(dir, up) 的水平分量)
      const rx = -dir.z;
      const rz = dir.x;
      const rl = Math.hypot(rx, rz) || 1;
      this.camTarget.x += (rx / rl) * shoulder;
      this.camTarget.z += (rz / rl) * shoulder;
      this.camTarget.y += 0.22;

      // 相机防穿: 从 pivot 向期望机位做射线
      this.camDir.subVectors(this.camTarget, this.pivot);
      const wantLen = this.camDir.length();
      if (wantLen > 0.001) {
        this.camDir.divideScalar(wantLen);
        let allowed = wantLen;
        const tTerr = game.world.raycastTerrain(this.pivot, this.camDir, wantLen);
        if (tTerr < allowed) allowed = tTerr;
        if (game.world.raycastStatics(this.pivot, this.camDir, wantLen, game.staticHit)) {
          if (game.staticHit.t < allowed) allowed = game.staticHit.t;
        }
        allowed = Math.max(allowed - 0.24, 0.25);
        // 被遮挡时快速拉近, 无遮挡缓慢恢复
        const k = allowed < this.camDist ? 26 : 10;
        this.camDist = lerp(this.camDist, allowed, Math.min(1, dt * k));
      }
      this.camera.position.copy(this.pivot).addScaledVector(this.camDir, this.camDist);
      // 不钻地
      const minY = game.world.getHeight(this.camera.position.x, this.camera.position.z) + 0.28;
      if (this.camera.position.y < minY) this.camera.position.y = minY;
      // 不没入水面(游泳时第三人称保持在水上)
      if (this.camera.position.y < WATER_Y + 0.16 &&
        game.world.getHeight(this.camera.position.x, this.camera.position.z) < WATER_Y) {
        this.camera.position.y = WATER_Y + 0.16;
      }
      // 爆炸震动
      if (game.shakeAmp > 0.002) {
        this.camera.position.x += (Math.random() - 0.5) * game.shakeAmp * 0.22;
        this.camera.position.y += (Math.random() - 0.5) * game.shakeAmp * 0.22;
        this.camera.position.z += (Math.random() - 0.5) * game.shakeAmp * 0.22;
      }
      this.lookAt.copy(this.pivot).addScaledVector(dir, 14);
      this.camera.lookAt(this.lookAt);
    }
    this.camera.rotateZ(this.camRoll);

    // FOV 缩放
    const swimSprintF = c.swimming
      ? clamp((c.speed2d - SWIM_SPEED) / (SWIM_SPRINT_SPEED - SWIM_SPEED), 0, 1)
      : 0;
    const groundSprintF = !c.swimming && !this.aiming && c.stance === 'stand'
      ? clamp((c.speed2d - 4.8) / (6.9 - 4.8), 0, 1)
      : 0;
    const targetFov = (BASE_FOV + groundSprintF * 2.8 + swimSprintF * 5) / zoom;
    this.fov = lerp(this.fov, targetFov, Math.min(1, dt * 10));
    if (Math.abs(this.fov - this.camera.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
