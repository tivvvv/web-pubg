// 玩家: 第一/第三人称可切换(V) + 移动/跳跃 + 武器/近战操控 + 拾取提示 + 后坐力 + 投掷
import * as THREE from 'three';
import { Character } from './character';
import type { Input } from './input';
import { isWeaponKind } from './loot';
import { ARMORS, armorFromLoot } from './armor';
import { MELEE, WEAPONS } from './weapons';
import { WATER_Y, WORLD_HALF } from './world';
import { VEHICLE_SPEC, seatWorld, type Vehicle } from './vehicles';
import { clamp, lerp } from './utils';
import type { Game } from './game';

const BASE_FOV = 75;
const THROW_SPEED = 15; // 满蓄力投掷速度

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
  private fireTimer = 0;
  private reloadT = 0;
  private camDist = 3.4;
  private fov = BASE_FOV;
  private hv = new THREE.Vector2(); // 空降水平速度
  private stepAcc = 0;
  private swimAcc = 0;      // 游泳划水距离累计
  private swimToastT = 0;   // 「游泳中无法攻击」提示节流
  private throwHold = false; // 正在按住左键蓄力瞄准
  private holdT = 0;         // 蓄力时长
  spreadRad = 0.004;

  private viewDir = new THREE.Vector3();
  private pivot = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private camDir = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private throwDir = new THREE.Vector3();
  private throwOrigin = new THREE.Vector3();
  private tmpSwim = new THREE.Vector3();

  constructor(shirtColor: number) {
    this.char = new Character('你', true, shirtColor);
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 900);
  }

  get alive(): boolean {
    return this.char.alive;
  }

  update(dt: number, input: Input, game: Game): void {
    const c = this.char;
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
    this.recoilP *= Math.exp(-8 * dt);

    // ---- 空降阶段: 舱内/自由落体/开伞滑翔(全程禁射击/道具/姿态) ----
    if (this.descent) {
      this.updateDescent(dt, input, game);
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

    const gun = c.heldGun();
    this.aiming = input.rmb && !this.reloading && gun !== null && !c.swimming;

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
    let vx = 0;
    let vz = 0;
    const sprint = input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');
    // 疾跑/跳跃自动站起(仅站立可疾跑, 站/蹲可跳)
    if (sprint && wlen > 0.001 && c.stance !== 'stand') c.setStance('stand');
    let jumped = false;
    if (wlen > 0.001) {
      wx /= wlen;
      wz /= wlen;
      const forwardish = (wx * fwdX + wz * fwdZ) > 0.3;
      let speed = 4.3;
      if (c.swimming) speed = 2.2; // 游泳低速, 无冲刺
      else if (this.aiming) speed = 2.7;
      else if (sprint && forwardish && c.stance === 'stand') speed = 6.6;
      if (!c.swimming) {
        speed *= c.stance === 'crouch' ? 0.5 : c.stance === 'prone' ? 0.25 : 1; // 蹲 50% / 趴 25% 爬行
        const groundH = game.world.getHeight(c.pos.x, c.pos.z);
        if (c.pos.y < WATER_Y + 0.15 && groundH < WATER_Y) speed *= 0.55; // 涉水
      }
      vx = wx * speed;
      vz = wz * speed;
      // 脚步声(趴下显著变轻)
      if (c.grounded && !c.swimming) {
        this.stepAcc += speed * dt;
        if (this.stepAcc > 2.7) {
          this.stepAcc = 0;
          game.audio.step(c.stance === 'prone' ? 0.35 : c.stance === 'crouch' ? 0.6 : 1);
        }
      }
    }
    if (input.keys.has('Space') && c.grounded && !c.swimming) {
      if (c.stance !== 'stand') c.setStance('stand'); // 起身再跳
      c.vy = 7.4;
      c.grounded = false;
      jumped = true;
    }
    const wasAir = !c.grounded;
    if (c.swimming) {
      c.applySwim(vx, vz, dt, game.world);
      // 划水声 + 小水花(按划水距离节流)
      this.swimAcc += c.speed2d * dt;
      if (this.swimAcc > 1.7) {
        this.swimAcc = 0;
        game.audio.swimStroke();
        game.effects.splashSmall(this.tmpSwim.set(c.pos.x, WATER_Y + 0.04, c.pos.z));
      }
    } else {
      c.applyMove(vx, vz, dt, game.world);
      if (wasAir && c.grounded) game.audio.jumpLand();
    }
    game.updateSwim(c);
    c.yaw = this.yaw;
    // ADS: 枪械随视线俯仰(平滑); 换弹进度供模型下沉/弹匣脱落动画
    c.aimPitch = lerp(c.aimPitch, this.aiming ? this.pitch : 0, Math.min(1, dt * 12));

    // ---- 攻击(枪械 / 近战) ----
    this.fireTimer -= dt;
    let acted = false; // 开火或挥击(打断包扎)
    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0 && gun) {
        const need = gun.def.magSize - gun.mag;
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
          this.recoilP += gun.def.recoil * (c.stance === 'crouch' ? 0.85 : c.stance === 'prone' ? 0.65 : 1);
          this.pitch = clamp(this.pitch + gun.def.recoil * 0.3, -1.25, 1.35);
          acted = true;
        }
      }
      // 散布(供射击与准星); 蹲 -20% / 趴 -40%
      const stanceAcc = c.stance === 'crouch' ? 0.8 : c.stance === 'prone' ? 0.6 : 1;
      const base = (this.aiming ? gun.def.spreadAim : gun.def.spreadHip) * stanceAcc;
      const moveF = 1 + (c.speed2d / 6.6) * 0.9 + (c.grounded ? 0 : 0.7);
      this.spreadRad = lerp(this.spreadRad, base * moveF, Math.min(1, dt * 12));
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
    if (auto && !isWeaponKind(auto.kind)) {
      game.applyAutoPickup(c, auto);
    }

    this.updateCamera(dt, game);
  }

  private updatePickupPrompt(game: Game): void {
    const c = this.char;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    // 物品候选: 最近的武器/护具且大致在前方
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
    // 两者同时在场: 看得更正的优先
    if (door && (!item || door.dot >= itemDot)) {
      game.promptDoor = door.d;
      game.hud.setPickupPrompt(door.d.open ? '按 F 关门' : '按 F 开门');
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
    if (k === 'knife') {
      game.hud.setPickupPrompt(`按 F 拾取 ${MELEE.knife.name}`);
    } else if (isWeaponKind(k)) {
      const def = WEAPONS[k];
      const state = item.mag > 0 ? `${item.mag} 发` : item.ammo > 0 ? `无弹, 备弹 ${item.ammo}` : '无弹';
      game.hud.setPickupPrompt(`按 F 拾取 ${def.name}（${state}）`);
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
  startFreefall(game: Game): void {
    if (this.descent !== 'plane') return;
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
    this.vy = -9;
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
    this.descent = null;
    c.airPose = null;
    c.stance = 'stand';
    c.stanceF = 0;
    c.removeCanopy();
    game.audio.windStop();
    game.audio.jumpLand();
  }

  private updateDescent(dt: number, input: Input, game: Game): void {
    const c = this.char;
    if (this.descent === 'plane') {
      this.planeS += 92 * dt;
      game.flightPoint(c.pos, this.planeS);
      c.group.visible = false; // 舱内隐藏(机外追击机位看不到自己)
      game.audio.planeDroneSet(0.85);
      if (this.planeS > 980) this.startFreefall(game); // 航线末端自动跳伞
      return;
    }
    // 水平操控(WASD 相对视线)
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
    const maxHv = this.descent === 'freefall' ? 18 : 12;
    if (wl > 0.001) {
      wx /= wl;
      wz /= wl;
      this.hv.x = lerp(this.hv.x, wx * maxHv, Math.min(1, dt * 1.6));
      this.hv.y = lerp(this.hv.y, wz * maxHv, Math.min(1, dt * 1.6));
    } else {
      this.hv.x *= Math.exp(-0.5 * dt);
      this.hv.y *= Math.exp(-0.5 * dt);
    }
    // 垂直逼近终端速度(自由落体 55 / 滑翔 10)
    const vt = this.descent === 'freefall' ? -55 : -10;
    const k = this.descent === 'freefall' ? 1.1 : 2.2;
    this.vy += (vt - this.vy) * (1 - Math.exp(-dt * k));
    c.pos.x += this.hv.x * dt;
    c.pos.z += this.hv.y * dt;
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
    if (this.driving || this.descent) return;
    this.driving = v;
    v.driver = this.char;
    const c = this.char;
    c.airPose = 'sit';
    c.stance = 'stand';
    c.stanceF = 0;
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
    v.driver = null;
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
    const hb = input.keys.has('Space');
    // 油门/刹车/倒车
    if (W) v.speed += spec.accel * dt;
    else if (S) {
      if (v.speed > 0.5) v.speed -= spec.brake * dt;
      else v.speed -= spec.accel * 0.5 * dt;
    }
    // 自然阻力 + 滚动摩擦 + 手刹
    v.speed -= v.speed * 0.4 * dt;
    if (!W && !S) v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), 1.0 * dt);
    if (hb) v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), 20 * dt);
    v.speed = clamp(v.speed, -spec.revMax, spec.vmax);
    // 转向(随速度衰减, 倒车反向)
    const steerIn = (input.keys.has('KeyA') ? 1 : 0) - (input.keys.has('KeyD') ? 1 : 0);
    const auth = 1 - Math.min(0.75, (Math.abs(v.speed) / spec.vmax) * 0.75);
    v.yaw += steerIn * spec.steer * auth * (v.speed >= 0 ? 1 : -1) * dt;
    // 位移 + 碰撞(圆)
    v.pos.x += Math.sin(v.yaw) * v.speed * dt;
    v.pos.z += Math.cos(v.yaw) * v.speed * dt;
    const hit = game.world.resolveVehicle(v.pos, spec.radius);
    if (hit) {
      const impact = Math.abs(v.speed);
      if (impact > 12) {
        game.vehicles.damage(v, impact * 6);
        game.soundAt(v.pos, (d2, p2) => game.audio.vehicleImpact(d2, p2));
        game.addShakeFrom(v.pos);
      }
      v.speed *= 0.55;
    }
    v.pos.x = clamp(v.pos.x, -WORLD_HALF + 2, WORLD_HALF - 2);
    v.pos.z = clamp(v.pos.z, -WORLD_HALF + 2, WORLD_HALF - 2);
    // 地形跟随(桥面/屋顶可走) + 坡度姿态
    const gh = game.world.groundHeight(v.pos.x, v.pos.z, v.pos.y + 1);
    v.pos.y = gh;
    const sin = Math.sin(v.yaw);
    const cos = Math.cos(v.yaw);
    const r = spec.radius;
    const ghF = game.world.getHeight(v.pos.x + sin * r, v.pos.z + cos * r);
    const ghB = game.world.getHeight(v.pos.x - sin * r, v.pos.z - cos * r);
    const ghL = game.world.getHeight(v.pos.x + cos * r, v.pos.z - sin * r);
    const ghR = game.world.getHeight(v.pos.x - cos * r, v.pos.z + sin * r);
    const targetPitch = Math.atan2(ghB - ghF, 2 * r);
    const targetRoll = Math.atan2(ghR - ghL, 2 * r);
    v.pitch = lerp(v.pitch, clamp(targetPitch, -0.4, 0.4), Math.min(1, dt * 8));
    v.roll = lerp(v.roll, clamp(targetRoll, -0.4, 0.4), Math.min(1, dt * 8));
    v.spinWheels(dt, steerIn);
    // 涉水熄火
    if (gh < WATER_Y - 0.05) {
      game.vehicles.stall(v, game);
      this.driving = null;
      return;
    }
    // 碾压(>6m/s)
    if (Math.abs(v.speed) > 6) game.runOverCheck(v, this.char);
    // 角色随座
    seatWorld(v, this.char.pos);
    this.char.yaw = v.yaw;
    this.yaw = v.yaw;
    this.driveCamera(dt, game, v);
    game.audio.engineSet(Math.abs(v.speed) / spec.vmax);
  }

  // 追逐相机(车后上方, 与 TPP 同款防穿)
  private driveCamera(dt: number, game: Game, v: Vehicle): void {
    const dirX = Math.sin(v.yaw);
    const dirZ = Math.cos(v.yaw);
    const dist = v.kind === 'car' ? 6.2 : 5.0;
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
    if (!gun || this.reloading || gun.mag >= gun.def.magSize || this.char.ammo[gun.def.ammo] <= 0) return;
    this.reloading = true;
    this.reloadT = gun.def.reloadTime;
    game.audio.reload();
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
    const p = this.pitch + this.recoilP;
    const cp = Math.cos(p);
    out.set(Math.sin(this.yaw) * cp, Math.sin(p), Math.cos(this.yaw) * cp);
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
    const zoom = this.aiming && gun ? gun.def.zoom : 1;
    const fpp = game.viewFpp;
    c.setFirstPerson(fpp);

    if (fpp) {
      // 第一人称: 相机即眼位(随姿态 1.62/1.1/0.35), 直接看向, 无防穿拉近(camDist 保留供 TPP 恢复)
      this.camera.position.set(c.pos.x, c.pos.y + c.eyeHeight(), c.pos.z);
      if (game.shakeAmp > 0.002) {
        this.camera.position.x += (Math.random() - 0.5) * game.shakeAmp * 0.22;
        this.camera.position.y += (Math.random() - 0.5) * game.shakeAmp * 0.22;
        this.camera.position.z += (Math.random() - 0.5) * game.shakeAmp * 0.22;
      }
      this.lookAt.copy(this.camera.position).addScaledVector(dir, 14);
      this.camera.lookAt(this.lookAt);
    } else {
      this.pivot.set(c.pos.x, c.pos.y + c.eyeHeight() - 0.04, c.pos.z);

      const targetDist = this.aiming ? (gun?.def === WEAPONS.sniper ? 1.5 : 1.9) : 3.4;
      const shoulder = this.aiming ? 0.55 : 0.5;

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

    // FOV 缩放
    const targetFov = BASE_FOV / zoom;
    this.fov = lerp(this.fov, targetFov, Math.min(1, dt * 10));
    if (Math.abs(this.fov - this.camera.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
