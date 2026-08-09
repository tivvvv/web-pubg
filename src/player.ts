// 玩家: 第一/第三人称可切换(V) + 移动/跳跃 + 武器/近战操控 + 拾取提示 + 后坐力 + 投掷
import * as THREE from 'three';
import {
  CANOPY_DEPLOY_VELOCITY, Character, moveAirDescentHorizontal, stepAirDescentVelocity, SWIM_SPEED, SWIM_SPRINT_SPEED,
} from './character';
import type { Input } from './input';
import { isGunKind, isMeleeKind, isWeaponKind } from './loot';
import { ARMORS, armorFromLoot } from './armor';
import { PACKS, isPackKind, packLevelFromLoot } from './backpack';
import { AMMO_NAME, MELEE, THROWABLES, THROWABLE_IDS, WEAPONS, ammoTypeFromLoot } from './weapons';
import { HEALS } from './heals';
import { WATER_Y, WORLD_HALF } from './world';
import { driveVehicleStep, VEHICLE_SPEC, seatWorld, vehicleExitCandidates, type Vehicle } from './vehicles';
import { probeVault, startVault, updateVaultMotion } from './vault';
import { clamp, lerp, turnToward } from './utils';
import { ATTACHMENTS, attachFromLoot, canAttach, isAttachKind, magSizeOf, sightZoomOf } from './attachments';
import { random } from './random';
import type { Game } from './game';
import {
  aimBlend, calculateAimSway, calculateRecoilImpulse, calculateWeaponSpread, fireModeOf, reloadDuration,
  smoothAimProgress, WEAPON_RECOIL,
} from './gunplay';
import {
  advanceCameraMode, advanceCameraSpring, advanceShoulderBlend, cameraFovTarget, cameraModeTarget,
  cameraMotionTarget, sampleCameraShake,
  smoothCameraDistance, type CameraShakeSample,
} from './camera';
import {
  chooseInteractionCandidate, equipmentComparison, interactionDistanceText, isAutomaticPickupKind,
  type ComparisonTone, type InteractionCandidate,
  type InteractionKind,
} from './interaction';
import type { Destructible } from './buildings';
import type { Crate } from './airdrop';
import type { DeathCrate } from './deathcrate';
import type { LootItem } from './loot';
import { resolveMovementDirection, wadingSpeedMultiplier } from './movement';

const BASE_FOV = 75;
const THROW_SPEED = 15; // 满蓄力投掷速度
const FREEFALL_STEER_SPEED = 12; // 开伞前水平修正限速(m/s)
const FREEFALL_STEER_RESPONSE = 5; // 自由落体转向响应
const CANOPY_STEER_SPEED = 12;
const CANOPY_STEER_RESPONSE = 1.6;
const AIR_STEER_DRAG = 1.2; // 松开方向键后保留少量惯性
const CAMERA_PROBE_OFFSETS = [0, -0.14, 0.14] as const;

// 在水中按住开火键时锁住扳机，离水后必须先松开再按，避免边界帧误开枪。
export function updateSwimFireLatch(latched: boolean, swimming: boolean, fireHeld: boolean): boolean {
  return fireHeld ? latched || swimming : false;
}

type InteractionTarget = LootItem | Destructible | Vehicle | Crate | DeathCrate | Character;

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
  private recoilImpulse = { vertical: 0, horizontal: 0, bloom: 0, gunKick: 0 };
  private fireTimer = 0;
  private reloadT = 0;
  private reloadTotal = 0;
  private camDist = 3.4;
  private fov = BASE_FOV;
  private hv = new THREE.Vector2(); // 空降水平速度
  private moveVel = new THREE.Vector2(); // 玩家地面/游泳水平惯性
  private stepAcc = 0;
  private swimAcc = 0;      // 游泳划水距离累计
  private swimToastT = 0;   // '游泳中无法攻击'提示节流
  private swimFireLatch = false; // 水中按住左键时禁止跨状态边界补发一枪
  private throwHold = false; // 正在按住左键蓄力瞄准
  private holdT = 0;         // 蓄力时长
  private jumpHeld = false;
  private jumpBufferT = 0;
  private coyoteT = 0;
  private camBobPhase = 0;
  private camBob = 0;
  private camRoll = 0;
  private landDip = 0;
  private landVelocity = 0;
  private shotFovKick = 0;
  private cameraModeF = 0;
  private shoulderSide: -1 | 1 = 1;
  private shoulderBlend = 1;
  private cameraShakeT = 0;
  private cameraShake: CameraShakeSample = { x: 0, y: 0, z: 0, roll: 0 };
  private vehicleLookYaw = 0;
  private vehicleLookPitch = 0.08;
  private vehicleLookIdleT = 0;
  private interactionLockT = 0;
  private interactionFocusT = 0;
  private interactionFocusF = 0;
  private interactionTarget: InteractionTarget | null = null;
  private interactionKind: InteractionKind | null = null;
  private interactionDistance = 0;
  private cameraMotionForward = 0;
  private cameraMotionLateral = 0;
  private cameraMotionVertical = 0;
  private cameraMotionRoll = 0;
  private lastCameraSpeed = 0;
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
  private fppCameraPos = new THREE.Vector3();
  private tppCameraPos = new THREE.Vector3();
  private camProbe = new THREE.Vector3();
  private camProbeDir = new THREE.Vector3();
  private interactionOrigin = new THREE.Vector3();
  private interactionPos = new THREE.Vector3();
  private interactionFocus = new THREE.Vector3();

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

  get cameraBlend(): number {
    return this.cameraModeF;
  }

  get cameraDistance(): number {
    return this.camDist;
  }

  get interactionTargetKind(): InteractionKind | null {
    return this.interactionKind;
  }

  get interactionTargetDistance(): number {
    return this.interactionTarget ? this.interactionDistance : -1;
  }

  swapShoulder(game: Game): void {
    if (game.viewFpp || this.cameraModeF > 0.92 || this.driving || this.descent) return;
    this.shoulderSide = this.shoulderSide === 1 ? -1 : 1;
    game.hud.toast(this.shoulderSide === 1 ? '右肩视角' : '左肩视角');
  }

  update(dt: number, input: Input, game: Game): void {
    const c = this.char;
    this.interactionLockT = Math.max(0, this.interactionLockT - dt);
    this.interactionFocusT = Math.max(0, this.interactionFocusT - dt);
    if ((!c.alive || c.knocked) && (this.reloading || this.throwHold)) {
      this.cancelTransientActions(game);
    }
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
    c.flashT = Math.max(0, c.flashT - dt);

    // ---- 视角 ----
    const { dx, dy } = input.consumeMouse();
    const zoomScale = this.fov / BASE_FOV;
    if (this.driving) {
      this.vehicleLookYaw = clamp(this.vehicleLookYaw - dx * 0.0021 * zoomScale, -1.75, 1.75);
      this.vehicleLookPitch = clamp(this.vehicleLookPitch - dy * 0.0021 * zoomScale, -0.42, 0.72);
      if (Math.abs(dx) + Math.abs(dy) > 0.01) this.vehicleLookIdleT = 0;
      else this.vehicleLookIdleT += dt;
    } else {
      this.yaw -= dx * 0.0021 * zoomScale;
      this.pitch = clamp(this.pitch - dy * 0.0021 * zoomScale, -1.25, 1.35);
    }
    const heldForRecovery = c.heldGun();
    const recovery = heldForRecovery ? WEAPON_RECOIL[heldForRecovery.def.id] : WEAPON_RECOIL.rifle;
    this.recoilP *= Math.exp(-recovery.pitchRecovery * dt);
    this.recoilY *= Math.exp(-recovery.yawRecovery * dt);
    this.shotBloom *= Math.exp(-recovery.bloomRecovery * (this.aiming ? 1 : 0.76) * dt);
    this.recoilRestT = Math.max(0, this.recoilRestT - dt);
    if (this.recoilRestT <= 0) this.recoilChain = Math.max(0, this.recoilChain - dt * 10);
    const landingSpring = advanceCameraSpring(this.landDip, this.landVelocity, 0, 17, 0.72, dt);
    this.landDip = landingSpring.value;
    this.landVelocity = landingSpring.velocity;
    this.shotFovKick *= Math.exp(-18 * dt);

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
        this.exitVehicle(game, true);
      } else {
        this.driveVehicle(dt, input, game);
        return;
      }
    }

    // ---- 翻越中: 锁定移动/攻击输入, 只保留视角 ----
    c.vaultCd = Math.max(0, c.vaultCd - dt);
    if (c.vault) {
      updateVaultMotion(c, dt);
      if (!c.vault) game.audio.jumpLand(game.world.footstepSurfaceAt(c.pos.x, c.pos.z, c.pos.y));
      c.yaw = this.yaw;
      this.updateCamera(dt, game);
      return;
    }

    const gun = c.heldGun();
    const interactionBusy = this.interactionLockT > 0 || c.reviveTarget !== null || c.flashT > 0;
    this.aiming = input.rmb && !this.reloading && !interactionBusy &&
      gun !== null && !c.swimming && !c.knocked;
    if (gun) this.aimF = smoothAimProgress(this.aimF, this.aiming, gun.def.id, dt);
    else this.aimF = lerp(this.aimF, 0, 1 - Math.exp(-16 * dt));
    this.aimTime += dt;

    // ---- 移动 ----
    const fwdX = Math.sin(this.yaw);
    const fwdZ = Math.cos(this.yaw);
    const rightX = -fwdZ;
    const rightZ = fwdX;
    const movement = resolveMovementDirection(this.yaw, {
      forward: input.keys.has('KeyW'),
      backward: input.keys.has('KeyS'),
      left: input.keys.has('KeyA'),
      right: input.keys.has('KeyD'),
    });
    const wx = movement.x;
    const wz = movement.z;
    const wlen = movement.length;
    const sprint = input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');
    // 疾跑/跳跃自动站起(仅站立可疾跑, 站/蹲可跳)
    if (sprint && wlen > 0.001 && !c.knocked && !c.swimming && c.stance !== 'stand') c.setStance('stand');
    let targetVx = 0;
    let targetVz = 0;
    let sprintActive = false;
    let jumped = false;
    if (wlen > 0.001) {
      const forwardDot = movement.forward;
      const strafeDot = movement.strafe;
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
          speed *= wadingSpeedMultiplier(wadeDepth);
        }
      }
      if (c.flashT > 0) speed *= 0.35;
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
    if (this.jumpBufferT > 0 && this.coyoteT > 0 && !c.swimming && !c.knocked && c.flashT <= 0 && c.vaultCd <= 0) {
      // 先尝试翻越: 站/蹲朝可翻越障碍(趴下/恢复读条中不可翻越)
      let vaulted = false;
      if (c.stance !== 'prone' && wlen > 0.001 && game.healT <= 0) {
        const probe = probeVault(c, wx, wz, game.world);
        if (probe) {
          if (probe.win && probe.win.alive) game.hitDestructible(probe.win, 999, c.pos);
          this.cancelTransientActions(game);
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
        game.audio.jumpLand(game.world.footstepSurfaceAt(c.pos.x, c.pos.z, c.pos.y));
        const landingImpact = clamp((-fallSpeed - 2.4) / 7, 0, 1);
        this.landDip = Math.max(this.landDip, clamp(Math.abs(fallSpeed) * 0.012, 0.035, 0.14));
        this.landVelocity += landingImpact * 0.42;
        if (landingImpact > 0.05) {
          game.effects.landingDust(this.tmpSwim.set(c.pos.x, c.pos.y + 0.03, c.pos.z), landingImpact);
        }
      }
    }
    game.updateSwim(c);
    if (!wasSwimming && c.swimming) {
      this.cancelTransientActions(game);
      this.moveVel.multiplyScalar(0.55);
      this.swimAcc = 0;
    } else if (wasSwimming && !c.swimming) {
      this.moveVel.multiplyScalar(0.65);
      this.swimAcc = 0;
      this.landDip = Math.max(this.landDip, 0.045);
    }
    if (c.swimming && c.speed2d > 0.15) {
      c.yaw = turnToward(c.yaw, Math.atan2(this.moveVel.x, this.moveVel.y), dt * 4.8);
    } else if (interactionBusy) {
      const targetYaw = Math.atan2(
        this.interactionFocus.x - c.pos.x,
        this.interactionFocus.z - c.pos.z,
      );
      c.yaw = turnToward(c.yaw, targetYaw, dt * 8);
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
        game.audio.step(
          c.stance === 'prone' ? 0.35 : c.stance === 'crouch' ? 0.6 : sprintActive ? 1.12 : 1,
          game.world.footstepSurfaceAt(c.pos.x, c.pos.z, c.pos.y),
        );
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
        this.reloadTotal = 0;
      }
    }
    c.reload01 = this.reloading && gun && this.reloadTotal > 0
      ? clamp(1 - this.reloadT / this.reloadTotal, 0.01, 1)
      : 0;
    const pressedEdge = input.consumeFirePressed();
    this.swimFireLatch = updateSwimFireLatch(this.swimFireLatch, c.swimming, input.lmb);
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
    } else if (c.knocked || interactionBusy) {
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
      const wantFire = !this.swimFireLatch && (fireModeOf(gun) === 'auto' ? input.lmb : pressedEdge);
      if (wantFire && !this.reloading && this.fireTimer <= 0) {
        if (gun.mag <= 0) {
          game.audio.empty();
          if (c.ammo[gun.def.ammo] <= 0) game.dryFireToast(gun.def.ammo); // 空枪且无备弹: 报所需弹种
          this.startReload(game);
        } else if (game.playerShot()) {
          this.fireTimer = gun.def.fireInterval;
          const impulse = calculateRecoilImpulse(
            this.recoilImpulse,
            gun,
            this.aimF,
            c.stance,
            this.recoilChain,
            random() * 2 - 1,
          );
          this.recoilP += impulse.vertical;
          this.recoilY += impulse.horizontal;
          // 少量永久枪口上跳需要玩家压枪, 大部分瞬时反馈会自动回正
          this.pitch = clamp(this.pitch + impulse.vertical * 0.2, -1.25, 1.35);
          this.yaw += impulse.horizontal * 0.12;
          this.recoilChain++;
          this.recoilRestT = Math.max(0.2, gun.def.fireInterval * 1.7);
          this.shotBloom = Math.min(0.032, this.shotBloom + impulse.bloom);
          c.gunKick = Math.max(c.gunKick, impulse.gunKick);
          this.shotFovKick = Math.max(this.shotFovKick, impulse.gunKick * 11);
          if (gun.mag <= 0 && c.ammo[gun.def.ammo] > 0) this.startReload(game);
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
    this.refreshInteractionPrompt(game);
    // 弹药/医疗品/投掷物走近自动拾取。必须同楼层且视线可达，避免隔墙或穿楼板吸取。
    const auto = this.nearestVisibleAutoPickup(game);
    if (auto) game.applyAutoPickup(c, auto);

    this.updateCamera(dt, game);
  }

  refreshInteractionPrompt(game: Game): void {
    const c = this.char;
    game.promptItem = null;
    game.promptDoor = null;
    game.promptVehicle = null;
    game.promptCrate = null;
    game.promptDeathCrate = null;
    game.promptAlly = null;
    if (c.reviveTarget || c.knocked || c.swimming || this.descent || this.driving || this.interactionLockT > 0) {
      this.interactionTarget = null;
      this.interactionKind = null;
      this.interactionDistance = 0;
      game.hud.setPickupPrompt(null);
      return;
    }

    const cp = Math.cos(this.pitch);
    const vx = Math.sin(this.yaw) * cp;
    const vy = Math.sin(this.pitch);
    const vz = Math.cos(this.yaw) * cp;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    c.eyePos(this.interactionOrigin);
    const candidates: InteractionCandidate<InteractionTarget>[] = [];
    const push = (
      kind: InteractionKind,
      target: InteractionTarget,
      x: number,
      y: number,
      z: number,
      maxDistance: number,
      minDot: number,
      priority: number,
    ): void => {
      const dx = x - this.interactionOrigin.x;
      const dy = y - this.interactionOrigin.y;
      const dz = z - this.interactionOrigin.z;
      const horizontal = Math.hypot(dx, dz);
      const sightDistance = Math.hypot(dx, dy, dz);
      if (sightDistance < 0.01) return;
      const distance = Math.hypot(horizontal, dy * 0.4);
      if (distance > maxDistance + 0.18) return;
      const dot = (dx * vx + dy * vy + dz * vz) / sightDistance;
      this.interactionPos.set(x, y, z);
      if (!this.interactionVisible(game, kind, this.interactionPos, sightDistance)) return;
      candidates.push({ kind, target, distance, dot, maxDistance, minDot, priority });
    };
    const pushTarget = (kind: InteractionKind, target: InteractionTarget): void => {
      if (kind === 'item') {
        const item = target as LootItem;
        if (item.active) push(kind, item, item.group.position.x, item.baseY + 0.38, item.group.position.z, 2.65, 0.08, 0);
      } else if (kind === 'door') {
        const door = target as Destructible;
        if (door.alive) push(kind, door, door.cx, door.cy, door.cz, 2.3, 0.06, 0.11);
      } else if (kind === 'ally') {
        const ally = target as Character;
        if (ally.alive && ally.knocked) {
          push(kind, ally, ally.pos.x, ally.pos.y + ally.chestHeight(), ally.pos.z, 2.35, -0.02, 0.24);
        }
      } else if (kind === 'airdrop') {
        const crate = target as Crate;
        if (crate.state === 'landed') push(kind, crate, crate.pos.x, crate.pos.y + 0.55, crate.pos.z, 2.9, -0.02, 0.08);
      } else if (kind === 'deathcrate') {
        const crate = target as DeathCrate;
        if (crate.active) {
          push(kind, crate, crate.group.position.x, crate.group.position.y + 0.35, crate.group.position.z, 2.9, 0, 0.07);
        }
      } else {
        const vehicle = target as Vehicle;
        if (!vehicle.dead && vehicle.burnT < 0 && !vehicle.driver) {
          push(kind, vehicle, vehicle.pos.x, vehicle.pos.y + 0.9, vehicle.pos.z, 2.75, -0.04, 0.04);
        }
      }
    };

    // 同一堆物资逐个参与统一评分, 让准星指向优先于单纯最近距离。
    for (const nearbyItem of game.loot.items) {
      if (!nearbyItem.active ||
        (!isWeaponKind(nearbyItem.kind) && !isAutomaticPickupKind(nearbyItem.kind) && !isAttachKind(nearbyItem.kind) &&
          !isPackKind(nearbyItem.kind) && !armorFromLoot(nearbyItem.kind))) continue;
      pushTarget('item', nearbyItem);
    }
    const door = game.findDoorInteraction(c.pos.x, c.pos.y, c.pos.z, fx, fz);
    if (door) pushTarget('door', door.d);
    const ally = game.knock.nearestKnocked(c.pos.x, c.pos.z, 2.55, c);
    if (ally) pushTarget('ally', ally);
    const crate = game.airdrop.nearestClosedCrate(c.pos.x, c.pos.y, c.pos.z, 3.15);
    if (crate) pushTarget('airdrop', crate);
    const deathCrate = game.deathCrates.nearest(c.pos.x, c.pos.y, c.pos.z, 3.15);
    if (deathCrate) pushTarget('deathcrate', deathCrate);
    const vehicle = game.vehicles.nearest(c.pos.x, c.pos.z, 3.05);
    if (vehicle) pushTarget('vehicle', vehicle);
    // 最近查询换到相邻目标时仍保留上一目标参与一帧评分, 再由距离和视线自然淘汰。
    if (this.interactionTarget && !candidates.some((candidate) => candidate.target === this.interactionTarget) &&
      this.interactionKind) {
      pushTarget(this.interactionKind, this.interactionTarget);
    }

    const selected = chooseInteractionCandidate(candidates, this.interactionTarget);
    if (!selected) {
      this.interactionTarget = null;
      this.interactionKind = null;
      this.interactionDistance = 0;
      game.hud.setPickupPrompt(null);
      return;
    }
    this.interactionTarget = selected.target;
    this.interactionKind = selected.kind;
    this.interactionDistance = selected.distance;
    const contextualDetail = (
      detail = '',
      tone: ComparisonTone = 'neutral',
    ): { detail: string; tone: ComparisonTone } => {
      const parts = [interactionDistanceText(selected.distance)];
      if (detail) parts.push(detail);
      if (game.healT > 0) parts.push('会打断恢复');
      return { detail: parts.join(' · '), tone: game.healT > 0 ? 'warning' : tone };
    };
    if (selected.kind === 'ally') {
      const selectedAlly = selected.target as Character;
      const context = contextualDetail('8 秒 · 移动, 受伤或距离过远会打断', 'positive');
      game.promptAlly = selectedAlly;
      game.hud.setPickupPrompt(`按 F 救援 ${selectedAlly.name}`, 'ally', context.detail, context.tone);
      return;
    }
    if (selected.kind === 'door') {
      const selectedDoor = selected.target as Destructible;
      const context = contextualDetail(selectedDoor.open ? '门口有人时无法关闭' : '门扇向远离你的一侧打开');
      game.promptDoor = selectedDoor;
      game.hud.setPickupPrompt(selectedDoor.open ? '按 F 关门' : '按 F 开门', 'door', context.detail, context.tone);
      return;
    }
    if (selected.kind === 'airdrop') {
      const context = contextualDetail('开启后物资散落在补给箱周围', 'positive');
      game.promptCrate = selected.target as Crate;
      game.hud.setPickupPrompt('按 F 打开空投', 'airdrop', context.detail, context.tone);
      return;
    }
    if (selected.kind === 'deathcrate') {
      const selectedCrate = selected.target as DeathCrate;
      const context = contextualDetail('自动装备升级并按负重拾取', 'positive');
      game.promptDeathCrate = selectedCrate;
      game.hud.setPickupPrompt(`按 F 搜索 ${selectedCrate.owner} 的盒子`, 'deathcrate', context.detail, context.tone);
      return;
    }
    if (selected.kind === 'vehicle') {
      const selectedVehicle = selected.target as Vehicle;
      const spec = VEHICLE_SPEC[selectedVehicle.kind];
      const vehicleName = selectedVehicle.kind === 'car' ? '越野车' : selectedVehicle.kind === 'moto' ? '摩托车' : '沙滩车';
      const context = contextualDetail(`${spec.seats} 座 · 耐久 ${Math.ceil(selectedVehicle.hp / spec.hp * 100)}%`);
      game.promptVehicle = selectedVehicle;
      game.hud.setPickupPrompt(`按 F 驾驶 ${vehicleName}`, 'vehicle', context.detail, context.tone);
      return;
    }

    const selectedItem = selected.target as LootItem;
    game.promptItem = selectedItem;
    const k = selectedItem.kind;
    if (isMeleeKind(k)) {
      const current = c.melee.def.id === 'fists' ? null : c.melee.def.name;
      const context = contextualDetail(current ? `将替换 ${current}` : '空栏位 · 直接装备', current ? 'neutral' : 'positive');
      game.hud.setPickupPrompt(
        `按 F 拾取 ${MELEE[k].name}`,
        'item',
        context.detail,
        context.tone,
      );
    } else if (isGunKind(k)) {
      const def = WEAPONS[k];
      const state = selectedItem.mag > 0
        ? `${selectedItem.mag} 发`
        : selectedItem.ammo > 0 ? `无弹, 备弹 ${selectedItem.ammo}` : '无弹';
      const emptySlot = def.id === 'pistol' ? !c.guns[2] : !c.guns[0] || !c.guns[1];
      let compared = c.heldGun();
      if (!emptySlot && def.id !== 'pistol' && (!compared || compared.def.id === 'pistol')) {
        compared = (c.guns[0]?.def.tier ?? 99) <= (c.guns[1]?.def.tier ?? 99) ? c.guns[0] : c.guns[1];
      }
      if (def.id === 'pistol') compared = c.guns[2];
      const comparison = emptySlot
        ? equipmentComparison(null, null, def.tier)
        : equipmentComparison(compared?.def.name ?? null, compared?.def.tier ?? null, def.tier);
      const context = contextualDetail(`${state} · ${comparison.text}`, comparison.tone);
      game.hud.setPickupPrompt(`按 F 拾取 ${def.name}`, 'item', context.detail, context.tone);
    } else if (isAttachKind(k)) {
      const id = attachFromLoot(k);
      if (id) {
        const gun = c.heldGun();
        let detail = '需先手持兼容枪械';
        let tone: ComparisonTone = 'warning';
        if (gun && canAttach(gun.def.id, id)) {
          const old = gun.att[ATTACHMENTS[id].slot];
          detail = old === id ? '当前已装配' : old ? `将替换 ${ATTACHMENTS[old].name}` : `适配 ${gun.def.name}`;
          tone = old === id ? 'neutral' : 'positive';
        } else if (gun) {
          detail = `不适配 ${gun.def.name}`;
        }
        const context = contextualDetail(detail, tone);
        game.hud.setPickupPrompt(`按 F 装配 ${ATTACHMENTS[id].name}`, 'item', context.detail, context.tone);
      }
    } else if (isAutomaticPickupKind(k)) {
      const ammoType = ammoTypeFromLoot(k);
      if (ammoType) {
        const rounds = selectedItem.ammo > 0 ? selectedItem.ammo : 0;
        const context = contextualDetail(rounds > 0 ? `${rounds} 发 · 走近也可自动拾取` : '走近也可自动拾取', 'positive');
        game.hud.setPickupPrompt(`按 F 拾取 ${AMMO_NAME[ammoType]}`, 'item', context.detail, context.tone);
      } else if (k === 'frag' || k === 'smoke' || k === 'flash') {
        const context = contextualDetail('走近也可自动拾取', 'positive');
        game.hud.setPickupPrompt(`按 F 拾取 ${THROWABLES[k].name}`, 'item', context.detail, context.tone);
      } else if (k === 'bandage' || k === 'medkit' || k === 'drink') {
        const context = contextualDetail('走近也可自动拾取', 'positive');
        game.hud.setPickupPrompt(`按 F 拾取 ${HEALS[k].name}`, 'item', context.detail, context.tone);
      }
    } else if (isPackKind(k)) {
      const level = packLevelFromLoot(k);
      if (level) {
        const comparison = equipmentComparison(
          c.pack ? PACKS[c.pack.level].name : null,
          c.pack?.level ?? null,
          level,
        );
        const context = contextualDetail(comparison.text, comparison.tone);
        game.hud.setPickupPrompt(`按 F 拾取 ${PACKS[level].name}`, 'item', context.detail, context.tone);
      }
    } else {
      const info = armorFromLoot(k);
      if (info) {
        const current = info.kind === 'helmet' ? c.helmet : c.vest;
        const comparison = equipmentComparison(
          current ? ARMORS[info.kind][current.level].name : null,
          current?.level ?? null,
          info.level,
        );
        const context = contextualDetail(comparison.text, comparison.tone);
        game.hud.setPickupPrompt(
          `按 F 拾取 ${ARMORS[info.kind][info.level].name}`,
          'item',
          context.detail,
          context.tone,
        );
      }
    }
  }

  private interactionVisible(
    game: Game,
    kind: InteractionKind,
    target: THREE.Vector3,
    distance: number,
  ): boolean {
    if (distance < 0.4) return true;
    this.camProbeDir.subVectors(target, this.interactionOrigin).normalize();
    let blockedAt = game.world.raycastTerrain(this.interactionOrigin, this.camProbeDir, distance);
    if (game.world.raycastStatics(this.interactionOrigin, this.camProbeDir, distance, game.staticHit)) {
      blockedAt = Math.min(blockedAt, game.staticHit.t);
    }
    return blockedAt >= distance - (kind === 'door' ? 0.45 : 0.32);
  }

  private nearestVisibleAutoPickup(game: Game): LootItem | null {
    const c = this.char;
    let best: LootItem | null = null;
    let bestDistanceSq = 1.9 * 1.9;
    c.eyePos(this.interactionOrigin);
    for (const item of game.loot.items) {
      if (!item.active || !isAutomaticPickupKind(item.kind)) continue;
      const dx = item.group.position.x - c.pos.x;
      const dy = item.baseY - c.pos.y;
      const dz = item.group.position.z - c.pos.z;
      if (Math.abs(dy) > 1.15) continue;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq >= bestDistanceSq) continue;
      this.interactionPos.set(item.group.position.x, item.baseY + 0.3, item.group.position.z);
      const sightDistance = this.interactionPos.distanceTo(this.interactionOrigin);
      if (!this.interactionVisible(game, 'item', this.interactionPos, sightDistance)) continue;
      best = item;
      bestDistanceSq = distanceSq;
    }
    return best;
  }

  canStartInteraction(): boolean {
    return this.interactionLockT <= 0 && !this.char.reviveTarget && !this.char.knocked &&
      !this.char.swimming && !this.descent && !this.driving;
  }

  beginInteractionFeedback(
    game: Game,
    target: { x: number; y: number; z: number },
    pose: 'interact' | 'pickup' | null,
    duration: number,
  ): void {
    this.cancelTransientActions(game);
    if (pose) this.char.beginAction(pose, duration);
    game.hud.flashInteraction(pose === 'pickup' ? 'pickup' : 'interact');
    this.interactionLockT = Math.max(this.interactionLockT, Math.min(duration, 0.46));
    this.interactionFocusT = Math.max(this.interactionFocusT, duration + 0.16);
    this.interactionFocus.set(target.x, target.y, target.z);
    this.interactionTarget = null;
    this.interactionKind = null;
    this.interactionDistance = 0;
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
      // 用尽后自动切到下一种可用投掷物。
      if (c.throwables[c.throwKind] === 0) {
        const next = THROWABLE_IDS.find((id) => c.throwables[id] > 0);
        if (next) c.throwKind = next;
      }
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
    this.cancelTransientActions(game);
    this.descent = 'freefall';
    this.vy = -2;
    this.char.grounded = false;
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
    c.grounded = true;
    c.airPose = null;
    c.airSteerRight = 0;
    c.airSteerForward = 0;
    c.stance = 'stand';
    c.stanceF = 0;
    c.moveLean = 0;
    c.removeCanopy();
    game.audio.windStop();
    game.audio.jumpLand(game.world.footstepSurfaceAt(c.pos.x, c.pos.z, c.pos.y));
    game.onPlayerLanded();
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
    const airCollisionRadius = phase === 'canopy' ? Math.max(c.radius, 0.72) : c.radius;
    if (moveAirDescentHorizontal(c.pos, this.hv.x * dt, this.hv.y * dt, airCollisionRadius, game.world)) {
      // 撞墙后迅速卸掉水平惯性，避免持续贴墙抖动或下一帧再次向墙内推进。
      this.hv.multiplyScalar(0.22);
    }
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
    if (game.healT > 0) game.cancelHeal('恢复被打断');
    this.cancelTransientActions(game);
    v.claimedBy = null;
    this.driving = v;
    v.driver = this.char;
    const c = this.char;
    c.airPose = v.kind === 'moto' ? 'moto' : 'sit';
    c.stance = 'stand';
    c.stanceF = 0;
    c.moveLean = 0;
    this.moveVel.set(0, 0);
    this.vehicleLookYaw = 0;
    this.vehicleLookPitch = 0.08;
    this.vehicleLookIdleT = 0;
    this.cameraModeF = 0;
    seatWorld(v, c.pos);
    c.yaw = v.yaw;
    this.yaw = v.yaw;
    game.audio.vehicleDoor();
    game.hud.flashInteraction('vehicle');
    game.hud.toast('W/S 油门刹车 · A/D 转向 · Space 手刹 · F 下车');
  }

  // 下车(F, 需低速)
  tryExitVehicle(game: Game): void {
    const v = this.driving;
    if (!v) return;
    if (Math.abs(v.speed) > 3) {
      game.hud.toast('速度太快, 无法下车');
      game.hud.flashInteraction('blocked');
      return;
    }
    this.exitVehicle(game, false);
  }

  // 依次尝试驾驶侧, 副驾侧, 车尾和车头，避免下车落进墙体或深水。
  exitVehicle(game: Game, forced: boolean): void {
    const v = this.driving;
    if (!v) return;
    const c = this.char;
    const candidates = vehicleExitCandidates(v);
    let exit = candidates.find((candidate) => {
      const ground = game.world.groundHeight(candidate.x, candidate.z, v.pos.y + 1.4);
      return ground >= WATER_Y - 0.05 &&
        game.world.navPointFree(candidate.x, candidate.z, v.pos.y, c.radius, false, false, true);
    }) ?? null;
    if (!exit && !forced) {
      game.hud.toast('周围没有安全下车空间', 'warning');
      game.hud.flashInteraction('blocked');
      return;
    }
    exit ??= candidates[0] as (typeof candidates)[number];
    c.pos.set(exit.x, 0, exit.z);
    c.pos.y = game.world.groundHeight(c.pos.x, c.pos.z, v.pos.y + 1.4);
    c.airPose = null;
    c.stance = 'stand';
    c.stanceF = 0;
    c.vy = 0;
    c.moveLean = 0;
    this.moveVel.set(0, 0);
    this.yaw = v.yaw;
    this.pitch = 0.08;
    this.vehicleLookYaw = 0;
    this.vehicleLookPitch = 0.08;
    this.vehicleLookIdleT = 0;
    v.driver = null;
    game.hud.flashInteraction('vehicle');
    v.speed = 0;
    this.driving = null;
    // 给下车后的再次交互留出短暂防误触窗口，并让追车镜头自然回到角色。
    if (!forced) {
      this.interactionLockT = Math.max(this.interactionLockT, 0.3);
      this.interactionFocusT = Math.max(this.interactionFocusT, 0.38);
      this.interactionFocus.set(v.pos.x, v.pos.y + 0.8, v.pos.z);
    }
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
    if (this.vehicleLookIdleT > 1.1 && Math.abs(v.speed) > 0.5) {
      const recenter = 1 - Math.exp(-dt * 1.45);
      this.vehicleLookYaw = lerp(this.vehicleLookYaw, 0, recenter);
      this.vehicleLookPitch = lerp(this.vehicleLookPitch, 0.08, recenter);
    }
    this.driveCamera(dt, game, v);
    game.audio.engineSet(Math.abs(v.speed) / spec.vmax);
  }

  // 追逐相机(车后上方, 与 TPP 同款防穿)
  private driveCamera(dt: number, game: Game, v: Vehicle): void {
    const viewYaw = v.yaw + this.vehicleLookYaw;
    const cp = Math.cos(this.vehicleLookPitch);
    const dirX = Math.sin(viewYaw) * cp;
    const dirY = Math.sin(this.vehicleLookPitch);
    const dirZ = Math.cos(viewYaw) * cp;
    const dist = v.kind === 'car' ? 6.2 : v.kind === 'buggy' ? 5.7 : 5.0;
    this.pivot.set(v.pos.x, v.pos.y + 1.4, v.pos.z);
    this.camTarget.set(
      this.pivot.x - dirX * dist,
      this.pivot.y + 0.72 - dirY * dist,
      this.pivot.z - dirZ * dist,
    );
    this.camDir.subVectors(this.camTarget, this.pivot);
    const len = this.camDir.length();
    if (len > 0.001) {
      this.camDir.divideScalar(len);
      const allowed = this.cameraAllowedDistance(game, this.pivot, this.camDir, len, 0.28);
      this.camDist = smoothCameraDistance(this.camDist, allowed, len, dt);
    }
    this.camera.position.copy(this.pivot).addScaledVector(this.camDir, this.camDist);
    const minY = game.world.getHeight(this.camera.position.x, this.camera.position.z) + 0.3;
    if (this.camera.position.y < minY) this.camera.position.y = minY;
    this.cameraShakeT += dt;
    sampleCameraShake(this.cameraShake, this.cameraShakeT, game.shakeAmp * 0.16);
    this.camera.position.x += this.cameraShake.x;
    this.camera.position.y += this.cameraShake.y;
    this.camera.position.z += this.cameraShake.z;
    this.lookAt.set(
      this.pivot.x + dirX * 8,
      this.pivot.y + dirY * 8,
      this.pivot.z + dirZ * 8,
    );
    this.camera.lookAt(this.lookAt);
    this.camera.rotateZ(this.cameraShake.roll);
    this.fov = lerp(this.fov, BASE_FOV + Math.abs(v.speed) * 0.5, Math.min(1, dt * 6));
    if (Math.abs(this.fov - this.camera.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  startReload(game: Game, explainFailure = false): void {
    const gun = this.char.heldGun();
    if (!gun) {
      if (explainFailure) game.hud.toast('当前未持有枪械');
      return;
    }
    if (this.reloading) return;
    if (gun.mag >= magSizeOf(gun)) {
      if (explainFailure) game.hud.toast('弹匣已满');
      return;
    }
    if (this.char.ammo[gun.def.ammo] <= 0) {
      if (explainFailure) game.dryFireToast(gun.def.ammo);
      return;
    }
    if (game.healT > 0) game.cancelHeal('恢复被打断');
    this.reloading = true;
    this.reloadTotal = reloadDuration(gun, gun.mag <= 0);
    this.reloadT = this.reloadTotal;
    if (gun.def.id === 'shotgun') game.audio.reloadShotgun();
    else game.audio.reload();
  }

  switchSlot(i: number, game: Game): void {
    const c = this.char;
    if (i === c.curSlot) return;
    if (i < 3 && !c.guns[i]) return;
    if (game.healT > 0) game.cancelHeal('恢复被打断');
    c.curSlot = i;
    this.cancelTransientActions(game);
    this.recoilChain = 0;
    this.recoilRestT = 0;
    this.shotBloom = 0;
    this.fireTimer = Math.max(this.fireTimer, 0.25);
    c.beginAction('equip', 0.28);
    game.audio.equip();
  }

  cancelTransientActions(game?: Game): void {
    this.reloading = false;
    this.reloadT = 0;
    this.reloadTotal = 0;
    this.char.reload01 = 0;
    this.aiming = false;
    this.interactionLockT = 0;
    this.interactionFocusT = 0;
    this.interactionTarget = null;
    this.interactionKind = null;
    if (this.char.actionPose === 'interact' || this.char.actionPose === 'pickup' ||
      this.char.actionPose === 'equip') {
      this.char.cancelAction();
    }
    if (this.throwHold) {
      this.throwHold = false;
      game?.grenades.hidePreview();
    }
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
    const optic = !!gun && (gun.def.id === 'sniper' || gun.att.sight !== null);
    const cameraTargetF = cameraModeTarget(game.viewFpp, optic, this.aimF);
    this.cameraModeF = advanceCameraMode(this.cameraModeF, cameraTargetF, dt);
    // 镜头开始向眼位靠近时先隐藏头身, 避免过渡中穿过自身模型。
    c.setFirstPerson(this.cameraModeF > 0.12);

    if (c.reviveTarget) {
      this.interactionFocus.set(
        c.reviveTarget.pos.x,
        c.reviveTarget.pos.y + c.reviveTarget.chestHeight(),
        c.reviveTarget.pos.z,
      );
    }
    const focusActive = this.interactionFocusT > 0 || c.reviveTarget !== null;
    this.interactionFocusF = lerp(
      this.interactionFocusF,
      focusActive ? 1 : 0,
      1 - Math.exp(-(focusActive ? 9 : 6) * dt),
    );

    const ads = aimBlend(this.aimF);
    const cameraAcceleration = c.grounded && !c.swimming && dt > 0
      ? clamp((c.speed2d - this.lastCameraSpeed) / dt, -18, 18)
      : 0;
    this.lastCameraSpeed = c.speed2d;
    const cameraMotion = cameraMotionTarget(
      c.speed2d,
      c.moveLean,
      cameraAcceleration,
      ads,
      this.cameraModeF,
    );
    const motionRate = 1 - Math.exp(-dt * (this.cameraModeF > 0.8 ? 13 : 8.5));
    this.cameraMotionForward = lerp(this.cameraMotionForward, cameraMotion.forward, motionRate);
    this.cameraMotionLateral = lerp(this.cameraMotionLateral, cameraMotion.lateral, motionRate);
    this.cameraMotionVertical = lerp(this.cameraMotionVertical, cameraMotion.vertical, motionRate);
    this.cameraMotionRoll = lerp(this.cameraMotionRoll, cameraMotion.roll, motionRate);

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
    targetBob *= 1 - this.interactionFocusF * 0.7;
    this.camBob = lerp(this.camBob, targetBob, Math.min(1, dt * 12));
    const swimRoll = c.swimming
      ? Math.sin(c.swimT * 1.8) * clamp(c.speed2d / SWIM_SPRINT_SPEED, 0, 1) * 0.012
      : 0;
    const targetRoll = swimRoll - c.moveLean * lerp(0.009, 0.018, this.cameraModeF) + this.cameraMotionRoll;
    this.camRoll = lerp(this.camRoll, targetRoll, Math.min(1, dt * 9));
    const verticalFeel = this.camBob - this.landDip;

    // 同时计算第三人称和眼位机位, 再按镜轴进度混合, 消除 ADS 和 V 切换时的瞬移。
    this.fppCameraPos.set(c.pos.x, c.pos.y + c.eyeHeight() + verticalFeel, c.pos.z);
    this.pivot.set(c.pos.x, c.pos.y + c.eyeHeight() - 0.04, c.pos.z);
    this.pivot.y += verticalFeel * 0.42;
    const horizontalForwardX = Math.sin(this.yaw);
    const horizontalForwardZ = Math.cos(this.yaw);
    const horizontalRightX = -horizontalForwardZ;
    const horizontalRightZ = horizontalForwardX;
    for (const cameraAnchor of [this.fppCameraPos, this.pivot]) {
      cameraAnchor.x += horizontalForwardX * this.cameraMotionForward + horizontalRightX * this.cameraMotionLateral;
      cameraAnchor.y += this.cameraMotionVertical;
      cameraAnchor.z += horizontalForwardZ * this.cameraMotionForward + horizontalRightZ * this.cameraMotionLateral;
    }
    if (this.descent === 'freefall') {
      this.pivot.x -= this.hv.x * 0.07;
      this.pivot.z -= this.hv.y * 0.07;
    }

    const indoor = game.world.inPlot(c.pos.x, c.pos.z, -1.65);
    const adsDist = gun?.def === WEAPONS.sniper ? 1.5 : 1.9;
    const baseDistance = lerp(indoor ? 2.5 : 3.4, adsDist, ads);
    const targetDist = Math.max(1.35, baseDistance - this.interactionFocusF * 0.28);
    const shoulder = lerp(indoor ? 0.4 : 0.5, 0.55, ads) * (1 - this.interactionFocusF * 0.18);
    this.shoulderBlend = advanceShoulderBlend(this.shoulderBlend, this.shoulderSide, dt);

    this.camDir.copy(dir).multiplyScalar(-1);
    this.camTarget.copy(this.pivot).addScaledVector(this.camDir, targetDist);
    const rx = -dir.z;
    const rz = dir.x;
    const rl = Math.hypot(rx, rz) || 1;
    this.camTarget.x += (rx / rl) * shoulder * this.shoulderBlend;
    this.camTarget.z += (rz / rl) * shoulder * this.shoulderBlend;
    this.camTarget.y += indoor ? 0.07 : 0.22;

    this.camDir.subVectors(this.camTarget, this.pivot);
    const wantLen = this.camDir.length();
    if (wantLen > 0.001) {
      this.camDir.divideScalar(wantLen);
      const allowed = this.cameraAllowedDistance(game, this.pivot, this.camDir, wantLen, 0.22);
      this.camDist = smoothCameraDistance(this.camDist, allowed, wantLen, dt);
    }
    this.tppCameraPos.copy(this.pivot).addScaledVector(this.camDir, this.camDist);
    this.camera.position.lerpVectors(this.tppCameraPos, this.fppCameraPos, this.cameraModeF);

    const minY = game.world.getHeight(this.camera.position.x, this.camera.position.z) + 0.28;
    if (this.cameraModeF < 0.98 && this.camera.position.y < minY) this.camera.position.y = minY;
    if (this.cameraModeF < 0.98 && this.camera.position.y < WATER_Y + 0.16 &&
      game.world.getHeight(this.camera.position.x, this.camera.position.z) < WATER_Y) {
      this.camera.position.y = WATER_Y + 0.16;
    }
    this.cameraShakeT += dt;
    sampleCameraShake(this.cameraShake, this.cameraShakeT, game.shakeAmp * 0.16);
    this.camera.position.x += this.cameraShake.x;
    this.camera.position.y += this.cameraShake.y;
    this.camera.position.z += this.cameraShake.z;
    // 射击时保持镜轴严格一致，非战斗交互时轻微看向目标，强化开门、拾取和救援反馈。
    this.lookAt.copy(this.camera.position).addScaledVector(dir, 14);
    if (this.interactionFocusF > 0.001 && !this.aiming) {
      this.lookAt.lerp(this.interactionFocus, this.interactionFocusF * (1 - this.cameraModeF * 0.45) * 0.2);
    }
    this.camera.lookAt(this.lookAt);
    this.camera.rotateZ(this.camRoll + this.cameraShake.roll);

    // FOV 缩放
    const swimSprintF = c.swimming
      ? clamp((c.speed2d - SWIM_SPEED) / (SWIM_SPRINT_SPEED - SWIM_SPEED), 0, 1)
      : 0;
    const groundSprintF = !c.swimming && !this.aiming && c.stance === 'stand'
      ? clamp((c.speed2d - 4.8) / (6.9 - 4.8), 0, 1)
      : 0;
    const targetFov = cameraFovTarget(
      BASE_FOV,
      zoom,
      groundSprintF,
      swimSprintF,
      this.shotFovKick,
      ads,
    );
    this.fov = lerp(this.fov, targetFov, Math.min(1, dt * 10));
    if (Math.abs(this.fov - this.camera.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private cameraAllowedDistance(
    game: Game,
    pivot: THREE.Vector3,
    direction: THREE.Vector3,
    desired: number,
    padding: number,
  ): number {
    let allowed = desired;
    const rx = -direction.z;
    const rz = direction.x;
    const rl = Math.hypot(rx, rz) || 1;
    for (const offset of CAMERA_PROBE_OFFSETS) {
      this.camProbe.copy(pivot);
      this.camProbe.x += rx / rl * offset;
      this.camProbe.z += rz / rl * offset;
      const terrainT = game.world.raycastTerrain(this.camProbe, direction, desired);
      if (terrainT < allowed) allowed = terrainT;
      if (game.world.raycastStatics(this.camProbe, direction, desired, game.staticHit)) {
        allowed = Math.min(allowed, game.staticHit.t);
      }
    }
    return Math.max(0.25, allowed - padding);
  }
}
