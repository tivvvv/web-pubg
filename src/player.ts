// 玩家: 第三人称越肩视角 + 移动/跳跃 + 武器/近战操控 + 拾取提示 + 后坐力
import * as THREE from 'three';
import { Character } from './character';
import type { Input } from './input';
import { MELEE, WEAPONS } from './weapons';
import { WATER_Y } from './world';
import { clamp, lerp } from './utils';
import type { Game } from './game';

const BASE_FOV = 75;

export class PlayerController {
  readonly char: Character;
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = 0.1;
  aiming = false;
  reloading = false;

  private recoilP = 0;
  private fireTimer = 0;
  private reloadT = 0;
  private camDist = 3.4;
  private fov = BASE_FOV;
  private stepAcc = 0;
  spreadRad = 0.004;

  private viewDir = new THREE.Vector3();
  private pivot = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private camDir = new THREE.Vector3();
  private lookAt = new THREE.Vector3();

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
      this.updateCamera(dt, game);
      return;
    }

    // ---- 视角 ----
    const { dx, dy } = input.consumeMouse();
    const zoomScale = this.fov / BASE_FOV;
    this.yaw -= dx * 0.0021 * zoomScale;
    this.pitch = clamp(this.pitch - dy * 0.0021 * zoomScale, -1.25, 1.35);
    this.recoilP *= Math.exp(-8 * dt);

    const gun = c.heldGun();
    this.aiming = input.rmb && !this.reloading && gun !== null;

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
    let jumped = false;
    if (wlen > 0.001) {
      wx /= wlen;
      wz /= wlen;
      const forwardish = (wx * fwdX + wz * fwdZ) > 0.3;
      let speed = 4.3;
      if (this.aiming) speed = 2.7;
      else if (sprint && forwardish) speed = 6.6;
      const groundH = game.world.getHeight(c.pos.x, c.pos.z);
      if (c.pos.y < WATER_Y + 0.15 && groundH < WATER_Y) speed *= 0.55; // 涉水
      vx = wx * speed;
      vz = wz * speed;
      // 脚步声
      if (c.grounded) {
        this.stepAcc += speed * dt;
        if (this.stepAcc > 2.7) {
          this.stepAcc = 0;
          game.audio.step();
        }
      }
    }
    if (input.keys.has('Space') && c.grounded) {
      c.vy = 7.4;
      c.grounded = false;
      jumped = true;
    }
    const wasAir = !c.grounded;
    c.applyMove(vx, vz, dt, game.world);
    if (wasAir && c.grounded) game.audio.jumpLand();
    c.yaw = this.yaw;

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
    const pressedEdge = input.consumeFirePressed();
    if (c.curSlot === 3) {
      // 近战: 按住连挥, 冷却在 meleeAttack 内判定
      if (input.lmb && game.meleeAttack(c)) acted = true;
      this.spreadRad = lerp(this.spreadRad, 0.004, Math.min(1, dt * 10));
    } else if (gun) {
      const wantFire = gun.def.auto ? input.lmb : pressedEdge;
      if (wantFire && !this.reloading && this.fireTimer <= 0) {
        if (gun.mag <= 0) {
          game.audio.empty();
          this.startReload(game);
        } else if (game.playerShot()) {
          this.fireTimer = gun.def.fireInterval;
          this.recoilP += gun.def.recoil;
          this.pitch = clamp(this.pitch + gun.def.recoil * 0.3, -1.25, 1.35);
          acted = true;
        }
      }
      // 散布(供射击与准星)
      const base = this.aiming ? gun.def.spreadAim : gun.def.spreadHip;
      const moveF = 1 + (c.speed2d / 6.6) * 0.9 + (c.grounded ? 0 : 0.7);
      this.spreadRad = lerp(this.spreadRad, base * moveF, Math.min(1, dt * 12));
    }

    // ---- 包扎打断 ----
    if (game.healT > 0) {
      const sprinting = sprint && wlen > 0.001;
      if (sprinting || jumped || acted) game.cancelHeal('包扎被打断');
    }

    // ---- 拾取提示(武器需按 F) ----
    this.updatePickupPrompt(game);
    // 弹药/医疗包走近自动拾取
    const auto = game.loot.nearest(c.pos.x, c.pos.y, c.pos.z, 1.9);
    if (auto && (auto.kind === 'ammo' || auto.kind === 'medkit')) {
      game.applyAutoPickup(c, auto);
    }

    this.updateCamera(dt, game);
  }

  private updatePickupPrompt(game: Game): void {
    const c = this.char;
    const item = game.loot.nearestWeapon(c.pos.x, c.pos.y, c.pos.z, 2.6);
    if (!item) {
      game.promptItem = null;
      game.hud.setPickupPrompt(null);
      return;
    }
    // 需大致在视野前方
    const dx = item.group.position.x - c.pos.x;
    const dz = item.group.position.z - c.pos.z;
    const d = Math.hypot(dx, dz);
    const dot = d > 0.01 ? (dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw)) / d : 1;
    if (dot < 0.35) {
      game.promptItem = null;
      game.hud.setPickupPrompt(null);
      return;
    }
    game.promptItem = item;
    const k = item.kind;
    if (k === 'knife') {
      game.hud.setPickupPrompt(`按 F 拾取 ${MELEE.knife.name}`);
    } else if (k !== 'ammo' && k !== 'medkit') {
      const def = WEAPONS[k];
      game.hud.setPickupPrompt(`按 F 拾取 ${def.name}（${item.mag}+${item.ammo}）`);
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

  private updateCamera(dt: number, game: Game): void {
    const c = this.char;
    const dir = this.getViewDir(this.viewDir);
    this.pivot.set(c.pos.x, c.pos.y + 1.58, c.pos.z);

    const gun = c.heldGun();
    const zoom = this.aiming && gun ? gun.def.zoom : 1;
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
    this.lookAt.copy(this.pivot).addScaledVector(dir, 14);
    this.camera.lookAt(this.lookAt);

    // FOV 缩放
    const targetFov = BASE_FOV / zoom;
    this.fov = lerp(this.fov, targetFov, Math.min(1, dt * 10));
    if (Math.abs(this.fov - this.camera.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
