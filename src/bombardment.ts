// 小范围轰炸区: 预警选区 落弹轨迹 爆炸伤害 弹坑与 AI 避险查询
import * as THREE from 'three';
import type { Game } from './game';
import { rand } from './utils';
import { WATER_Y } from './world';

export type BombardmentState = 'idle' | 'warning' | 'active';

export interface BombardmentMapState {
  x: number;
  z: number;
  radius: number;
  state: Exclude<BombardmentState, 'idle'>;
}

interface Shell {
  group: THREE.Group;
  trail: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  active: boolean;
  elapsed: number;
  duration: number;
  start: THREE.Vector3;
  target: THREE.Vector3;
}

interface Crater {
  mesh: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

const RADIUS = 30;
const WARNING_DURATION = 8;
const ACTIVE_DURATION = 10;
const BLAST_RADIUS = 9;
const SHELL_CAP = 7;
const CRATER_CAP = 18;
const RING_SEGMENTS = 64;
const UP = new THREE.Vector3(0, 1, 0);
const CIRCLE_NORMAL = new THREE.Vector3(0, 0, 1);

export function bombardmentEscapeVector(
  state: BombardmentState,
  centerX: number,
  centerZ: number,
  radius: number,
  x: number,
  z: number,
  out: THREE.Vector2,
): boolean {
  if (state === 'idle') return false;
  const dx = x - centerX;
  const dz = z - centerZ;
  const d = Math.hypot(dx, dz);
  if (d > radius + 7) return false;
  if (d < 0.05) out.set(1, 0);
  else out.set(dx / d, dz / d);
  return true;
}

function makeCraterTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const grad = ctx.createRadialGradient(64, 64, 5, 64, 64, 60);
  grad.addColorStop(0, 'rgba(20,17,14,0.94)');
  grad.addColorStop(0.4, 'rgba(35,27,20,0.9)');
  grad.addColorStop(0.68, 'rgba(71,48,28,0.68)');
  grad.addColorStop(0.84, 'rgba(40,31,22,0.35)');
  grad.addColorStop(1, 'rgba(20,15,10,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  ctx.translate(64, 64);
  ctx.strokeStyle = 'rgba(17,13,10,0.52)';
  ctx.lineCap = 'round';
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + Math.sin(i * 9.7) * 0.2;
    const inner = 27 + (i % 3) * 3;
    const outer = 43 + (i % 4) * 3;
    ctx.lineWidth = 2 + (i % 2);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a + 0.06) * outer, Math.sin(a + 0.06) * outer);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class BombardmentSystem {
  readonly center = new THREE.Vector2();
  readonly radius = RADIUS;
  state: BombardmentState = 'idle';
  timer = 0;

  private cooldown = 0;
  private shellTimer = 0;
  private marker = new THREE.Group();
  private areaMat: THREE.MeshBasicMaterial;
  private outerMat: THREE.LineBasicMaterial;
  private innerMat: THREE.LineBasicMaterial;
  private postMat: THREE.MeshBasicMaterial;
  private outerPos = new Float32Array((RING_SEGMENTS + 1) * 3);
  private innerPos = new Float32Array((RING_SEGMENTS + 1) * 3);
  private posts: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>[] = [];
  private shells: Shell[] = [];
  private shellCursor = 0;
  private craters: Crater[] = [];
  private craterCursor = 0;
  private mapState: BombardmentMapState = { x: 0, z: 0, radius: RADIUS, state: 'warning' };
  private tmp = new THREE.Vector3();
  private tmpNormal = new THREE.Vector3();
  private testOverride: string | null;

  constructor(scene: THREE.Scene) {
    this.testOverride = new URLSearchParams(window.location.search).get('bombardment');

    this.areaMat = new THREE.MeshBasicMaterial({
      color: 0xff2d20,
      transparent: true,
      opacity: 0.025,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    });
    const area = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 64, 1, true), this.areaMat);
    area.position.y = 9;
    area.scale.set(RADIUS, 18, RADIUS);
    area.renderOrder = 3;
    this.marker.add(area);

    this.outerMat = new THREE.LineBasicMaterial({
      color: 0xff3a2c, transparent: true, opacity: 0.9,
      blending: THREE.NormalBlending, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
    });
    this.innerMat = this.outerMat.clone();
    this.innerMat.opacity = 0.45;
    const outerGeo = new THREE.BufferGeometry();
    outerGeo.setAttribute('position', new THREE.BufferAttribute(this.outerPos, 3));
    const innerGeo = new THREE.BufferGeometry();
    innerGeo.setAttribute('position', new THREE.BufferAttribute(this.innerPos, 3));
    const outer = new THREE.Line(outerGeo, this.outerMat);
    const inner = new THREE.Line(innerGeo, this.innerMat);
    outer.renderOrder = 4;
    inner.renderOrder = 4;
    this.marker.add(outer, inner);

    this.postMat = new THREE.MeshBasicMaterial({
      color: 0xff6a4e, transparent: true, opacity: 0.7,
      blending: THREE.NormalBlending, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
    });
    const postGeo = new THREE.CylinderGeometry(0.07, 0.12, 1, 6, 1, true);
    for (let i = 0; i < 12; i++) {
      const post = new THREE.Mesh(postGeo, this.postMat);
      post.renderOrder = 4;
      this.posts.push(post);
      this.marker.add(post);
    }
    this.marker.visible = false;
    scene.add(this.marker);

    const coreGeo = new THREE.IcosahedronGeometry(0.18, 0);
    const trailGeo = new THREE.CylinderGeometry(0.025, 0.15, 8, 6, 1, true);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffe2a0, fog: false });
    for (let i = 0; i < SHELL_CAP; i++) {
      const group = new THREE.Group();
      const core = new THREE.Mesh(coreGeo, coreMat);
      const trailMat = new THREE.MeshBasicMaterial({
        color: 0xff7b24, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const trail = new THREE.Mesh(trailGeo, trailMat);
      trail.position.y = 4;
      group.add(core, trail);
      group.visible = false;
      group.frustumCulled = false;
      scene.add(group);
      this.shells.push({
        group, trail, active: false, elapsed: 0, duration: 1,
        start: new THREE.Vector3(), target: new THREE.Vector3(),
      });
    }

    const craterTexture = makeCraterTexture();
    const craterGeo = new THREE.CircleGeometry(1, 28);
    for (let i = 0; i < CRATER_CAP; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: craterTexture, transparent: true, opacity: 0,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(craterGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 1;
      scene.add(mesh);
      this.craters.push({ mesh, life: 0 });
    }
    this.reset();
  }

  reset(): void {
    this.state = 'idle';
    this.timer = 0;
    this.cooldown = this.testOverride ? 0.35 : rand(18, 25);
    this.shellTimer = 0;
    this.marker.visible = false;
    for (const shell of this.shells) {
      shell.active = false;
      shell.group.visible = false;
    }
    for (const crater of this.craters) {
      crater.life = 0;
      crater.mesh.visible = false;
    }
  }

  update(dt: number, game: Game): void {
    this.updateShells(dt, game);
    this.updateCraters(dt);
    // 空降阶段不启动计时, 避免慢开伞时在半空消耗整段预警
    if (!game.zoneArmed || game.playerCtl?.descent) return;

    if (this.state === 'idle') {
      if (game.zone.radius < RADIUS * 2.35) return;
      this.cooldown -= dt;
      if (this.cooldown <= 0) this.beginWarning(game);
      return;
    }

    this.timer -= dt;
    this.updateMarker(game.nowSec);
    if (this.state === 'warning') {
      const warningDuration = this.testOverride === 'active' ? 0.25 : WARNING_DURATION;
      if (this.timer <= WARNING_DURATION - warningDuration) this.beginBombing(game);
      return;
    }

    this.shellTimer -= dt;
    while (this.shellTimer <= 0 && this.timer > 0) {
      this.spawnShell(game);
      this.shellTimer += rand(0.62, 1.05);
    }
    if (this.timer <= 0) {
      this.state = 'idle';
      this.marker.visible = false;
      this.cooldown = rand(34, 48);
    }
  }

  icon(): BombardmentMapState | null {
    if (this.state === 'idle') return null;
    this.mapState.x = this.center.x;
    this.mapState.z = this.center.y;
    this.mapState.state = this.state;
    return this.mapState;
  }

  hudText(): string | null {
    if (this.state === 'warning') return `轰炸区预警 ${Math.max(0, Math.ceil(this.timer))}s`;
    if (this.state === 'active') return '轰炸进行中';
    return null;
  }

  // 固定回归场景入口: 跳过随机选区, 直接展示指定位置的预警或落弹阶段.
  setTestArea(game: Game, x: number, z: number, state: Exclude<BombardmentState, 'idle'>): void {
    this.center.set(x, z);
    this.state = state;
    this.timer = state === 'warning' ? WARNING_DURATION : ACTIVE_DURATION;
    this.shellTimer = 0;
    this.marker.visible = true;
    this.syncMarkerToTerrain(game);
    this.updateMarker(game.nowSec);
  }

  // 位于预警区或轰炸区时返回向外逃生的单位方向
  escapeVector(x: number, z: number, out: THREE.Vector2): boolean {
    return bombardmentEscapeVector(this.state, this.center.x, this.center.y, RADIUS, x, z, out);
  }

  private beginWarning(game: Game): void {
    if (!this.pickCenter(game)) {
      this.cooldown = 8;
      return;
    }
    this.state = 'warning';
    this.timer = WARNING_DURATION;
    this.marker.visible = true;
    this.syncMarkerToTerrain(game);
    game.hud.toast('附近出现轰炸区');
    game.audio.warn();
  }

  private beginBombing(game: Game): void {
    this.state = 'active';
    this.timer = ACTIVE_DURATION;
    this.shellTimer = 0;
    game.hud.toast('轰炸开始');
  }

  private pickCenter(game: Game): boolean {
    const safeRadius = game.zone.radius - RADIUS - 6;
    if (safeRadius <= 8) return false;
    const player = game.playerCtl?.char;
    for (let i = 0; i < 48; i++) {
      let x: number;
      let z: number;
      if (player && i < 30) {
        const a = Math.random() * Math.PI * 2;
        const d = rand(42, 76);
        x = player.pos.x + Math.cos(a) * d;
        z = player.pos.z + Math.sin(a) * d;
      } else {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * safeRadius;
        x = game.zone.center.x + Math.cos(a) * d;
        z = game.zone.center.y + Math.sin(a) * d;
      }
      if (Math.hypot(x - game.zone.center.x, z - game.zone.center.y) > safeRadius) continue;
      if (!game.world.pointFree(x, z, 1.2, WATER_Y + 0.55, 22)) continue;
      this.center.set(x, z);
      return true;
    }
    return false;
  }

  private syncMarkerToTerrain(game: Game): void {
    const baseY = game.world.getHeight(this.center.x, this.center.y) + 0.1;
    this.marker.position.set(this.center.x, baseY, this.center.y);
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      this.setRingPoint(this.outerPos, i, Math.cos(a) * RADIUS, Math.sin(a) * RADIUS, baseY, game);
      this.setRingPoint(this.innerPos, i, Math.cos(a) * RADIUS * 0.58, Math.sin(a) * RADIUS * 0.58, baseY, game);
    }
    const outer = this.marker.children[1] as THREE.Line;
    const inner = this.marker.children[2] as THREE.Line;
    (outer.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (inner.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    for (let i = 0; i < this.posts.length; i++) {
      const a = (i / this.posts.length) * Math.PI * 2;
      const x = Math.cos(a) * RADIUS;
      const z = Math.sin(a) * RADIUS;
      const localGround = game.world.getHeight(this.center.x + x, this.center.y + z) - baseY;
      const h = 5.5 + (i % 3) * 1.4;
      const post = this.posts[i] as THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
      post.position.set(x, localGround + h * 0.5 + 0.1, z);
      post.scale.set(1, h, 1);
    }
  }

  private setRingPoint(array: Float32Array, i: number, x: number, z: number, baseY: number, game: Game): void {
    const j = i * 3;
    array[j] = x;
    array[j + 1] = game.world.getHeight(this.center.x + x, this.center.y + z) - baseY + 0.14;
    array[j + 2] = z;
  }

  private updateMarker(now: number): void {
    const pulse = 0.5 + Math.sin(now * (this.state === 'active' ? 8 : 4)) * 0.5;
    this.areaMat.opacity = (this.state === 'active' ? 0.035 : 0.018) + pulse * 0.014;
    this.outerMat.opacity = 0.58 + pulse * 0.42;
    this.innerMat.opacity = 0.24 + pulse * 0.3;
    this.postMat.opacity = 0.38 + pulse * 0.55;
  }

  private spawnShell(game: Game): void {
    let x = this.center.x;
    let z = this.center.y;
    let ground = game.world.getHeight(x, z);
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * RADIUS * 0.9;
      const tx = this.center.x + Math.cos(a) * d;
      const tz = this.center.y + Math.sin(a) * d;
      const h = game.world.getHeight(tx, tz);
      if (h <= WATER_Y + 0.25 || game.world.inPlot(tx, tz, 1.2)) continue;
      x = tx;
      z = tz;
      ground = h;
      break;
    }
    const shell = this.shells[this.shellCursor] as Shell;
    this.shellCursor = (this.shellCursor + 1) % this.shells.length;
    const a = Math.random() * Math.PI * 2;
    const offset = rand(5, 11);
    shell.start.set(x + Math.cos(a) * offset, ground + rand(52, 68), z + Math.sin(a) * offset);
    shell.target.set(x, ground + 0.2, z);
    shell.elapsed = 0;
    shell.duration = rand(0.72, 0.98);
    shell.active = true;
    shell.group.visible = true;
    shell.group.position.copy(shell.start);
    this.tmp.subVectors(shell.start, shell.target).normalize();
    shell.group.quaternion.setFromUnitVectors(UP, this.tmp);
    shell.trail.material.opacity = 0.85;
    game.soundAt(shell.target, (dist, pan) => game.audio.artilleryWhistle(dist, pan));
  }

  private updateShells(dt: number, game: Game): void {
    for (const shell of this.shells) {
      if (!shell.active) continue;
      shell.elapsed += dt;
      const p = Math.min(1, shell.elapsed / shell.duration);
      const fall = p * p;
      shell.group.position.lerpVectors(shell.start, shell.target, fall);
      shell.trail.material.opacity = 0.85 * Math.min(1, (1 - p) * 5);
      if (p < 1) continue;
      shell.active = false;
      shell.group.visible = false;
      this.impact(shell.target, game);
    }
  }

  private impact(point: THREE.Vector3, game: Game): void {
    game.effects.explosion(point);
    game.effects.burst(point, 34, 0.48, 0.34, 0.2, 9.5);
    game.effects.burst(point, 18, 0.16, 0.15, 0.14, 4.2);
    game.soundAt(point, (dist, pan) => game.audio.artilleryImpact(dist, pan));
    game.addShakeFrom(point);
    this.placeCrater(point, game);

    for (const c of game.chars) {
      if (!c.alive) continue;
      const d = Math.hypot(c.pos.x - point.x, c.pos.z - point.z);
      if (d > BLAST_RADIUS || Math.abs(c.pos.y - point.y) > 6) continue;
      const falloff = 1 - d / BLAST_RADIUS;
      game.damageChar(c, 18 + 132 * Math.pow(falloff, 1.35), false, null, '轰炸区', true);
    }
    for (const vehicle of game.vehicles.list) {
      if (vehicle.dead) continue;
      const d = Math.hypot(vehicle.pos.x - point.x, vehicle.pos.z - point.z);
      if (d < BLAST_RADIUS + 1) game.vehicles.damage(vehicle, 190 * (1 - d / (BLAST_RADIUS + 1)));
    }
    for (const destructible of game.world.buildings.destructibles) {
      if (!destructible.alive) continue;
      if (Math.hypot(destructible.cx - point.x, destructible.cz - point.z) > 4.8) continue;
      game.hitDestructible(destructible, 999, point);
    }
  }

  private placeCrater(point: THREE.Vector3, game: Game): void {
    if (point.y <= WATER_Y + 0.2) return;
    const crater = this.craters[this.craterCursor] as Crater;
    this.craterCursor = (this.craterCursor + 1) % this.craters.length;
    const hL = game.world.getHeight(point.x - 1, point.z);
    const hR = game.world.getHeight(point.x + 1, point.z);
    const hD = game.world.getHeight(point.x, point.z - 1);
    const hU = game.world.getHeight(point.x, point.z + 1);
    this.tmpNormal.set(hL - hR, 2, hD - hU).normalize();
    crater.mesh.position.set(point.x, point.y + 0.045, point.z);
    crater.mesh.quaternion.setFromUnitVectors(CIRCLE_NORMAL, this.tmpNormal);
    crater.mesh.rotateZ(Math.random() * Math.PI * 2);
    const scale = rand(1.8, 2.8);
    crater.mesh.scale.set(scale * rand(0.82, 1.18), scale, 1);
    crater.mesh.material.opacity = 0.82;
    crater.mesh.visible = true;
    crater.life = 48;
  }

  private updateCraters(dt: number): void {
    for (const crater of this.craters) {
      if (crater.life <= 0) continue;
      crater.life -= dt;
      crater.mesh.material.opacity = 0.82 * Math.min(1, Math.max(0, crater.life) / 10);
      if (crater.life <= 0) crater.mesh.visible = false;
    }
  }
}
