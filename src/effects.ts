// 统一特效系统: 枪火 / 弹道 / 材质命中 / 爆炸 / 水花 / 烟尘
// 所有高频对象均使用固定对象池, 对局过程中不创建 Three.js 渲染对象。
import * as THREE from 'three';
import type { SurfaceKind, WeaponId } from './types';
import { clamp } from './utils';
import { weaponPresentation } from './combatpresentation';

export const VFX_QUALITY = Object.freeze({
  tracerPool: 48,
  muzzlePool: 10,
  particlePool: 896,
  impactMarkPool: 64,
  puffPool: 36,
  shockRingPool: 12,
  splashRingPool: 16,
  blastPool: 6,
  smokeColumnPool: 10,
});

const TRACER_VISUAL_SPEED = 920;
const HIDDEN_Y = -999;
const FORWARD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

export function tracerVisualDuration(distance: number): number {
  return clamp(Math.max(0, distance) / TRACER_VISUAL_SPEED, 0.045, 0.13);
}

export function tracerStreakLength(distance: number): number {
  return clamp(Math.max(0, distance) * 0.16, 2.4, 18);
}

export function blastScreenStrength(distance: number): number {
  return clamp(1 - Math.max(0, distance) / 48, 0, 1);
}

function makeFlashTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.translate(48, 48);
  const spike = (rotation: number, length: number, width: number, alpha: number): void => {
    ctx.rotate(rotation);
    const gradient = ctx.createLinearGradient(0, -width, 0, width);
    gradient.addColorStop(0, 'rgba(255,236,184,0)');
    gradient.addColorStop(0.5, `rgba(255,220,132,${alpha})`);
    gradient.addColorStop(1, 'rgba(255,236,184,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, -width, length, width * 2);
    ctx.rotate(-rotation);
  };
  for (let i = 0; i < 4; i++) spike((Math.PI / 2) * i, 44, 3.8, 1);
  for (let i = 0; i < 4; i++) spike((Math.PI / 2) * i + Math.PI / 4, 28, 2.3, 0.72);
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 16);
  core.addColorStop(0, 'rgba(255,255,246,1)');
  core.addColorStop(0.32, 'rgba(255,224,142,0.95)');
  core.addColorStop(1, 'rgba(255,137,34,0)');
  ctx.fillStyle = core;
  ctx.fillRect(-18, -18, 36, 36);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeRadialTexture(
  inner: string,
  middle: string,
  outer: string,
  middleStop = 0.5,
): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const gradient = ctx.createRadialGradient(48, 48, 1, 48, 48, 46);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(middleStop, middle);
  gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 96, 96);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makePuffTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const lobes = [
    [47, 47, 34, 0.48],
    [32, 48, 24, 0.32],
    [60, 38, 25, 0.3],
    [55, 61, 23, 0.26],
  ] as const;
  for (const [x, y, radius, alpha] of lobes) {
    const gradient = ctx.createRadialGradient(x, y, 2, x, y, radius);
    gradient.addColorStop(0, `rgba(255,255,250,${alpha})`);
    gradient.addColorStop(0.55, `rgba(225,224,215,${alpha * 0.58})`);
    gradient.addColorStop(1, 'rgba(190,190,180,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 96, 96);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeTracerGeometry(): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(0.035, 0.035, 1);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const head = new THREE.Color(1, 0.98, 0.82);
  const tail = new THREE.Color(1, 0.38, 0.06);
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const amount = position.getZ(i) + 0.5;
    color.copy(tail).lerp(head, amount);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

interface Tracer {
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>;
  from: THREE.Vector3;
  direction: THREE.Vector3;
  distance: number;
  streak: number;
  elapsed: number;
  duration: number;
  width: number;
}

interface MuzzleFlash {
  core: THREE.Sprite;
  halo: THREE.Sprite;
  life: number;
  maxLife: number;
  scale: number;
}

interface ShockRing {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  life: number;
  maxLife: number;
  growth: number;
  baseScale: number;
}

interface SplashRing {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  life: number;
  maxLife: number;
  growth: number;
}

interface SmokeColumn {
  sprites: THREE.Sprite[];
  life: number;
  maxLife: number;
  verticalSpeed: number[];
}

interface SlashArc {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  life: number;
}

interface Puff {
  sprite: THREE.Sprite;
  life: number;
  maxLife: number;
  verticalSpeed: number;
  growth: number;
  baseScale: number;
  baseOpacity: number;
  driftX: number;
  driftZ: number;
}

interface Blast {
  core: THREE.Sprite;
  halo: THREE.Sprite;
  light: THREE.PointLight;
  life: number;
  maxLife: number;
  scale: number;
}

export class Effects {
  private readonly tracers: Tracer[] = [];
  private tracerIndex = 0;
  private readonly muzzleFlashes: MuzzleFlash[] = [];
  private muzzleIndex = 0;
  private readonly muzzleLight: THREE.PointLight;
  private readonly shockRings: ShockRing[] = [];
  private shockRingIndex = 0;
  private readonly splashRings: SplashRing[] = [];
  private splashRingIndex = 0;
  private readonly smokeColumns: SmokeColumn[] = [];
  private smokeColumnIndex = 0;
  private readonly slashArcs: SlashArc[] = [];
  private slashArcIndex = 0;
  private readonly puffs: Puff[] = [];
  private puffIndex = 0;
  private readonly blasts: Blast[] = [];
  private blastIndex = 0;

  private readonly points: THREE.Points;
  private readonly particlePosition: Float32Array;
  private readonly particleColor: Float32Array;
  private readonly particleVelocity: Float32Array;
  private readonly particleLife: Float32Array;
  private readonly particleMaxLife: Float32Array;
  private readonly particleBaseColor: Float32Array;
  private particleIndex = 0;
  private readonly particlePositionAttr: THREE.BufferAttribute;
  private readonly particleColorAttr: THREE.BufferAttribute;

  private readonly impactMarks: THREE.InstancedMesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private readonly impactMarkLife = new Float32Array(VFX_QUALITY.impactMarkPool);
  private impactMarkIndex = 0;

  private readonly tmpPoint = new THREE.Vector3();
  private readonly tmpEnd = new THREE.Vector3();
  private readonly tmpNormal = new THREE.Vector3();
  private readonly tmpQuaternion = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpColor = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const tracerGeometry = makeTracerGeometry();
    for (let i = 0; i < VFX_QUALITY.tracerPool; i++) {
      const material = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(tracerGeometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 7;
      scene.add(mesh);
      this.tracers.push({
        mesh,
        from: new THREE.Vector3(),
        direction: new THREE.Vector3(),
        distance: 0,
        streak: 0,
        elapsed: 0,
        duration: 0,
        width: 1,
      });
    }

    const flashTexture = makeFlashTexture();
    const haloTexture = makeRadialTexture(
      'rgba(255,251,220,1)',
      'rgba(255,164,52,0.5)',
      'rgba(255,105,10,0)',
      0.34,
    );
    for (let i = 0; i < VFX_QUALITY.muzzlePool; i++) {
      const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: flashTexture,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: haloTexture,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        toneMapped: false,
      }));
      core.visible = false;
      halo.visible = false;
      core.renderOrder = 9;
      halo.renderOrder = 8;
      scene.add(core, halo);
      this.muzzleFlashes.push({ core, halo, life: 0, maxLife: 0.062, scale: 1 });
    }
    this.muzzleLight = new THREE.PointLight(0xffb04a, 0, 13, 2);
    scene.add(this.muzzleLight);

    for (let i = 0; i < VFX_QUALITY.shockRingPool; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffcf90,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.43, 0.57, 40), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      scene.add(mesh);
      this.shockRings.push({ mesh, life: 0, maxLife: 0, growth: 0, baseScale: 1 });
    }

    for (let i = 0; i < VFX_QUALITY.splashRingPool; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xd7f3ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.43, 0.52, 36), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.splashRings.push({ mesh, life: 0, maxLife: 0, growth: 0 });
    }

    const puffTexture = makePuffTexture();
    for (let i = 0; i < VFX_QUALITY.smokeColumnPool; i++) {
      const sprites: THREE.Sprite[] = [];
      const verticalSpeed: number[] = [];
      for (let layer = 0; layer < 3; layer++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
          map: puffTexture,
          color: 0x777774,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          fog: true,
        }));
        sprite.visible = false;
        sprite.renderOrder = 4;
        scene.add(sprite);
        sprites.push(sprite);
        verticalSpeed.push(1.15 + layer * 0.48);
      }
      this.smokeColumns.push({ sprites, life: 0, maxLife: 3.2, verticalSpeed });
    }

    for (let i = 0; i < VFX_QUALITY.puffPool; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: puffTexture,
        color: 0xa8a39a,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: true,
      }));
      sprite.visible = false;
      sprite.renderOrder = 4;
      scene.add(sprite);
      this.puffs.push({
        sprite,
        life: 0,
        maxLife: 0,
        verticalSpeed: 0,
        growth: 0,
        baseScale: 0,
        baseOpacity: 0,
        driftX: 0,
        driftZ: 0,
      });
    }

    const blastCoreTexture = makeRadialTexture(
      'rgba(255,255,236,1)',
      'rgba(255,138,24,0.95)',
      'rgba(185,35,5,0)',
      0.42,
    );
    const blastHaloTexture = makeRadialTexture(
      'rgba(255,228,155,0.92)',
      'rgba(255,89,12,0.3)',
      'rgba(255,48,4,0)',
      0.3,
    );
    for (let i = 0; i < VFX_QUALITY.blastPool; i++) {
      const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: blastCoreTexture,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: blastHaloTexture,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }));
      const light = new THREE.PointLight(0xff6f24, 0, 28, 2);
      core.visible = false;
      halo.visible = false;
      core.renderOrder = 10;
      halo.renderOrder = 9;
      scene.add(core, halo, light);
      this.blasts.push({ core, halo, light, life: 0, maxLife: 0.42, scale: 1 });
    }

    for (let i = 0; i < 5; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.95, 18, 1, -0.6, 1.9), material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 7;
      scene.add(mesh);
      this.slashArcs.push({ mesh, life: 0 });
    }

    this.particlePosition = new Float32Array(VFX_QUALITY.particlePool * 3);
    this.particleColor = new Float32Array(VFX_QUALITY.particlePool * 3);
    this.particleVelocity = new Float32Array(VFX_QUALITY.particlePool * 3);
    this.particleLife = new Float32Array(VFX_QUALITY.particlePool);
    this.particleMaxLife = new Float32Array(VFX_QUALITY.particlePool);
    this.particleBaseColor = new Float32Array(VFX_QUALITY.particlePool * 3);
    for (let i = 0; i < VFX_QUALITY.particlePool; i++) this.particlePosition[i * 3 + 1] = HIDDEN_Y;
    const particleGeometry = new THREE.BufferGeometry();
    this.particlePositionAttr = new THREE.BufferAttribute(this.particlePosition, 3);
    this.particleColorAttr = new THREE.BufferAttribute(this.particleColor, 3);
    particleGeometry.setAttribute('position', this.particlePositionAttr);
    particleGeometry.setAttribute('color', this.particleColorAttr);
    this.points = new THREE.Points(particleGeometry, new THREE.PointsMaterial({
      size: 0.095,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      toneMapped: false,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    scene.add(this.points);

    const markGeometry = new THREE.CircleGeometry(0.5, 14);
    const markMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.impactMarks = new THREE.InstancedMesh(markGeometry, markMaterial, VFX_QUALITY.impactMarkPool);
    this.impactMarks.frustumCulled = false;
    this.impactMarks.renderOrder = 2;
    this.impactMarks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.impactMarks);
    this.hideAllImpactMarks();
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number, width = 1): void {
    const tracer = this.tracers[this.tracerIndex] as Tracer;
    this.tracerIndex = (this.tracerIndex + 1) % this.tracers.length;
    tracer.from.copy(from);
    tracer.direction.subVectors(to, from);
    tracer.distance = tracer.direction.length();
    if (tracer.distance < 0.05) return;
    tracer.direction.multiplyScalar(1 / tracer.distance);
    tracer.streak = tracerStreakLength(tracer.distance);
    tracer.elapsed = 0;
    tracer.duration = tracerVisualDuration(tracer.distance);
    tracer.width = clamp(width, 0.45, 1.6);
    tracer.mesh.material.color.setHex(color);
    tracer.mesh.material.opacity = 1;
    tracer.mesh.visible = true;
    this.syncTracer(tracer, 0.04);
  }

  muzzleFlash(position: THREE.Vector3, scale = 1, color = 0xffb04a, lightScale = 1): void {
    const flash = this.muzzleFlashes[this.muzzleIndex] as MuzzleFlash;
    this.muzzleIndex = (this.muzzleIndex + 1) % this.muzzleFlashes.length;
    flash.life = flash.maxLife;
    flash.scale = scale;
    flash.core.position.copy(position);
    flash.halo.position.copy(position);
    flash.core.scale.setScalar((0.48 + Math.random() * 0.24) * scale);
    flash.halo.scale.setScalar((0.82 + Math.random() * 0.25) * scale);
    flash.core.material.rotation = Math.random() * Math.PI * 2;
    flash.halo.material.rotation = Math.random() * Math.PI * 2;
    flash.core.material.color.setHex(color);
    flash.halo.material.color.setHex(color);
    flash.core.material.opacity = 1;
    flash.halo.material.opacity = 0.66;
    flash.core.visible = true;
    flash.halo.visible = true;
    this.muzzleLight.position.copy(position);
    this.muzzleLight.color.setHex(color);
    this.muzzleLight.intensity = 34 * Math.min(1.4, scale) * clamp(lightScale, 0, 1.6);
    this.muzzleLight.distance = 11 + scale * 4;
  }

  weaponFire(position: THREE.Vector3, weaponId: WeaponId, suppressed: boolean, modelScale = 1): void {
    const profile = weaponPresentation(weaponId, suppressed);
    this.muzzleFlash(
      position,
      modelScale * profile.muzzleScale,
      profile.muzzleColor,
      profile.muzzleLight,
    );
    this.casingEject(position, weaponId);
    this.spawnPuff(
      position,
      suppressed ? 0x9ca0a0 : 0x7f7770,
      0.1 + profile.smokeScale * 0.08,
      0.18 + profile.smokeScale * 0.12,
      0.2 + profile.smokeScale * 0.18,
      suppressed ? 0.2 : 0.13,
      suppressed ? 0.06 : 0.035,
    );
  }

  burst(point: THREE.Vector3, count: number, red: number, green: number, blue: number, speed: number): void {
    for (let particle = 0; particle < count; particle++) {
      const i = this.particleIndex;
      this.particleIndex = (this.particleIndex + 1) % VFX_QUALITY.particlePool;
      const offset = i * 3;
      this.particlePosition[offset] = point.x;
      this.particlePosition[offset + 1] = point.y;
      this.particlePosition[offset + 2] = point.z;
      const angle = Math.random() * Math.PI * 2;
      const vertical = Math.random() * 0.9 + 0.15;
      const velocity = speed * (0.4 + Math.random() * 0.8);
      const horizontal = Math.sqrt(Math.max(0, 1 - vertical * vertical));
      this.particleVelocity[offset] = Math.cos(angle) * horizontal * velocity;
      this.particleVelocity[offset + 1] = vertical * velocity;
      this.particleVelocity[offset + 2] = Math.sin(angle) * horizontal * velocity;
      const life = 0.3 + Math.random() * 0.35;
      this.particleLife[i] = life;
      this.particleMaxLife[i] = life;
      this.particleBaseColor[offset] = red * (0.7 + Math.random() * 0.5);
      this.particleBaseColor[offset + 1] = green * (0.7 + Math.random() * 0.5);
      this.particleBaseColor[offset + 2] = blue * (0.7 + Math.random() * 0.5);
    }
  }

  impactDust(point: THREE.Vector3): void {
    this.burst(point, 9, 0.62, 0.55, 0.42, 2.4);
    this.spawnPuff(point, 0xaaa08a, 0.52, 0.48, 0.8, 0.52, 0.16);
  }

  impactSpark(point: THREE.Vector3): void {
    this.burst(point, 8, 1, 0.78, 0.25, 4.8);
    this.spawnPuff(point, 0x6e7072, 0.3, 0.3, 0.45, 0.32, 0.05);
  }

  impactBlood(point: THREE.Vector3): void {
    this.burst(point, 11, 0.76, 0.055, 0.035, 2.8);
    this.spawnPuff(point, 0x8f1711, 0.28, 0.28, 0.36, 0.42, 0.04);
  }

  casingEject(point: THREE.Vector3, weaponId: WeaponId): void {
    const count = weaponId === 'shotgun' ? 2 : 1;
    const speed = weaponId === 'sniper' || weaponId === 'shotgun' ? 2.9 : 2.2;
    this.burst(point, count, 1, 0.66, 0.16, speed);
  }

  impactWood(point: THREE.Vector3): void {
    this.burst(point, 9, 0.58, 0.39, 0.18, 3);
    this.spawnPuff(point, 0x8b6840, 0.4, 0.4, 0.54, 0.46, 0.08);
  }

  impactGlass(point: THREE.Vector3): void {
    this.burst(point, 10, 0.72, 0.92, 1, 3.7);
  }

  debrisWood(point: THREE.Vector3): void {
    this.burst(point, 26, 0.52, 0.34, 0.16, 4.8);
    this.spawnPuff(point, 0x806344, 0.9, 0.72, 1.1, 0.52, 0.24);
  }

  debrisGlass(point: THREE.Vector3): void {
    this.burst(point, 28, 0.72, 0.92, 1, 5);
  }

  impactMark(point: THREE.Vector3, shotDirection: THREE.Vector3, surface: SurfaceKind): void {
    if (surface === 'char' || surface === 'door' || surface === 'window') return;
    let color = 0x24221d;
    let size = 0.19;
    if (surface === 'terrain' || surface === 'floor') {
      this.tmpNormal.copy(UP);
      color = 0x3b3021;
      size = 0.23;
    } else if (surface === 'roof') {
      this.tmpNormal.copy(DOWN);
      color = 0x292826;
      size = 0.2;
    } else {
      this.tmpNormal.set(-shotDirection.x, surface === 'wall' ? 0 : -shotDirection.y, -shotDirection.z);
      if (this.tmpNormal.lengthSq() < 0.01) this.tmpNormal.copy(UP);
      else this.tmpNormal.normalize();
      color = surface === 'tree' ? 0x3a2517 : 0x202224;
      size = surface === 'rock' ? 0.24 : 0.18;
    }
    this.spawnImpactMark(point, this.tmpNormal, color, size, 11);
  }

  explosion(point: THREE.Vector3, scale = 1): void {
    const blast = this.blasts[this.blastIndex] as Blast;
    this.blastIndex = (this.blastIndex + 1) % this.blasts.length;
    blast.life = blast.maxLife;
    blast.scale = scale;
    blast.core.position.set(point.x, point.y + 0.68 * scale, point.z);
    blast.halo.position.copy(blast.core.position);
    blast.core.scale.setScalar(2.6 * scale);
    blast.halo.scale.setScalar(5.2 * scale);
    blast.core.material.opacity = 1;
    blast.halo.material.opacity = 0.82;
    blast.core.material.rotation = Math.random() * Math.PI * 2;
    blast.halo.material.rotation = Math.random() * Math.PI * 2;
    blast.core.visible = true;
    blast.halo.visible = true;
    blast.light.position.copy(blast.core.position);
    blast.light.intensity = 120 * scale;
    blast.light.distance = 24 * scale;

    this.spawnShockRing(point, scale, 0xffd39a, 0.42, 14);
    this.spawnShockRing(point, scale * 0.72, 0xff6f32, 0.58, 20);
    this.spawnSmokeColumn(point, scale);
    this.spawnImpactMark(point, UP, 0x171411, 1.55 * scale, 18);
    this.burst(point, Math.round(30 * scale), 0.5, 0.34, 0.16, 7.5 * scale);
    this.burst(point, Math.round(18 * scale), 0.28, 0.28, 0.3, 3.4 * scale);
    this.burst(point, Math.round(14 * scale), 1, 0.68, 0.2, 9.5 * scale);
    this.spawnPuff(point, 0x514b46, 1.25 * scale, 1.05, 2.3 * scale, 0.54, 0.32);
    this.spawnPuff(point, 0x2e2d2d, 0.9 * scale, 1.3, 2 * scale, 0.48, 0.48);
  }

  // 炮弹落点使用更宽的冲击波, 土石喷射和分层烟柱, 与手雷爆炸形成明显层级差异.
  artilleryExplosion(point: THREE.Vector3): void {
    this.explosion(point, 1.62);
    this.tmpPoint.set(point.x, point.y + 0.5, point.z);
    this.burst(this.tmpPoint, 52, 1, 0.48, 0.09, 13.5);
    this.burst(this.tmpPoint, 46, 0.46, 0.32, 0.18, 10.8);
    this.burst(this.tmpPoint, 24, 0.14, 0.13, 0.12, 6.2);
    this.spawnShockRing(point, 1.9, 0xffbc5e, 0.52, 25);
    this.spawnShockRing(point, 1.3, 0xff4b24, 0.68, 18);
    this.spawnPuff(this.tmpPoint, 0x312b27, 1.65, 1.9, 3.8, 0.68, 0.9);
    this.spawnPuff(this.tmpPoint, 0x68584a, 1.25, 1.35, 3.1, 0.56, 1.3);
  }

  // 载具油箱殉爆比普通手雷拥有更厚的火球、金属碎片和持续黑烟。
  vehicleExplosion(point: THREE.Vector3, scale = 1): void {
    this.explosion(point, 1.28 * scale);
    this.tmpPoint.set(point.x, point.y + 0.82 * scale, point.z);
    this.burst(this.tmpPoint, Math.round(34 * scale), 1, 0.48, 0.12, 12 * scale);
    this.burst(this.tmpPoint, Math.round(22 * scale), 0.86, 0.9, 0.96, 8.5 * scale);
    this.spawnShockRing(this.tmpPoint, 1.18 * scale, 0xffb15a, 0.34, 18);
    this.spawnPuff(this.tmpPoint, 0x1c1b1b, 1.2 * scale, 1.45, 3.1 * scale, 0.58, 0.62);
  }

  smokePop(point: THREE.Vector3): void {
    this.spawnPuff(point, 0xc3c7c8, 0.7, 1.15, 1.7, 0.42, 0.28);
    this.spawnPuff(point, 0x9fa5a7, 0.8, 1.35, 1.9, 0.38, 0.36);
    this.spawnShockRing(point, 0.32, 0xdde4e6, 0.62, 8);
  }

  vehicleFire(point: THREE.Vector3): void {
    this.tmpPoint.set(point.x, point.y + 0.75, point.z);
    this.burst(this.tmpPoint, 6, 1, 0.42, 0.08, 3.8);
    this.spawnPuff(this.tmpPoint, 0x282727, 0.62, 0.92, 1.4, 0.34, 0.25);
  }

  slashArc(position: THREE.Vector3, yaw: number, side: number): void {
    const arc = this.slashArcs[this.slashArcIndex] as SlashArc;
    this.slashArcIndex = (this.slashArcIndex + 1) % this.slashArcs.length;
    arc.mesh.position.copy(position);
    arc.mesh.rotation.set(-0.85, yaw, side > 0 ? -0.4 : 2, 'YXZ');
    arc.mesh.scale.setScalar(1.1);
    arc.mesh.material.opacity = 0.9;
    arc.mesh.visible = true;
    arc.life = 0.16;
  }

  splash(point: THREE.Vector3): void {
    this.burst(point, 16, 0.82, 0.94, 1, 3.8);
    this.spawnSplashRing(point, 3.8, 0.68);
    this.spawnPuff(point, 0xcbe8f2, 0.4, 0.42, 0.5, 0.4, 0.08);
  }

  splashSmall(point: THREE.Vector3): void {
    this.burst(point, 5, 0.72, 0.88, 1, 1.9);
    this.spawnSplashRing(point, 1.5, 0.42);
  }

  landingDust(point: THREE.Vector3, strength: number): void {
    const impact = Math.max(0, Math.min(1, strength));
    this.burst(point, 3 + Math.round(impact * 7), 0.62, 0.55, 0.42, 0.8 + impact * 1.4);
    this.spawnPuff(point, 0x91846d, 0.2 + impact * 0.32, 0.38, 0.42 + impact * 0.34, 0.3, 0.08);
  }

  impactRock(point: THREE.Vector3): void {
    this.burst(point, 7, 0.7, 0.7, 0.68, 3.4);
    this.burst(point, 4, 1, 0.82, 0.36, 4.4);
    this.spawnPuff(point, 0x858582, 0.42, 0.42, 0.62, 0.44, 0.08);
  }

  update(dt: number): void {
    for (const tracer of this.tracers) {
      if (!tracer.mesh.visible) continue;
      tracer.elapsed += dt;
      if (tracer.elapsed >= tracer.duration) {
        tracer.mesh.visible = false;
        continue;
      }
      this.syncTracer(tracer, tracer.elapsed / tracer.duration);
    }

    for (const flash of this.muzzleFlashes) {
      if (flash.life <= 0) continue;
      flash.life -= dt;
      const remaining = Math.max(0, flash.life / flash.maxLife);
      flash.core.material.opacity = remaining;
      flash.halo.material.opacity = remaining * remaining * 0.62;
      flash.halo.scale.multiplyScalar(1 + dt * 5);
      if (flash.life <= 0) {
        flash.core.visible = false;
        flash.halo.visible = false;
      }
    }
    if (this.muzzleLight.intensity > 0) {
      this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 440);
    }

    for (const ring of this.shockRings) {
      if (ring.life <= 0) continue;
      ring.life -= dt;
      const progress = 1 - Math.max(0, ring.life) / ring.maxLife;
      ring.mesh.scale.setScalar(ring.baseScale * (1 + progress * ring.growth));
      ring.mesh.material.opacity = 0.82 * Math.pow(1 - progress, 1.4);
      if (ring.life <= 0) ring.mesh.visible = false;
    }

    for (const ring of this.splashRings) {
      if (ring.life <= 0) continue;
      ring.life -= dt;
      const progress = 1 - Math.max(0, ring.life) / ring.maxLife;
      ring.mesh.scale.setScalar(0.28 + progress * ring.growth);
      ring.mesh.material.opacity = 0.72 * Math.pow(1 - progress, 1.5);
      if (ring.life <= 0) ring.mesh.visible = false;
    }

    for (const column of this.smokeColumns) {
      if (column.life <= 0) continue;
      column.life -= dt;
      const remaining = Math.max(0, column.life / column.maxLife);
      const fade = Math.min(1, remaining * 3.2);
      column.sprites.forEach((sprite, layer) => {
        sprite.position.y += (column.verticalSpeed[layer] as number) * dt * 0.58;
        sprite.position.x += Math.sin(column.life * 1.4 + layer) * dt * 0.14;
        sprite.position.z += Math.cos(column.life * 1.1 + layer) * dt * 0.12;
        sprite.scale.addScalar(dt * (0.72 + layer * 0.1));
        sprite.material.rotation += dt * (layer % 2 === 0 ? 0.13 : -0.1);
        sprite.material.opacity = 0.54 * fade;
        if (column.life <= 0) sprite.visible = false;
      });
    }

    for (const puff of this.puffs) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      const remaining = Math.max(0, puff.life / puff.maxLife);
      const progress = 1 - remaining;
      puff.sprite.position.x += puff.driftX * dt;
      puff.sprite.position.y += puff.verticalSpeed * dt;
      puff.sprite.position.z += puff.driftZ * dt;
      puff.sprite.scale.setScalar(puff.baseScale + progress * puff.growth);
      puff.sprite.material.opacity = puff.baseOpacity * Math.sin(Math.min(1, progress * 2.2) * Math.PI / 2)
        * Math.pow(remaining, 0.72);
      puff.sprite.material.rotation += dt * puff.driftX * 0.35;
      if (puff.life <= 0) puff.sprite.visible = false;
    }

    for (const blast of this.blasts) {
      if (blast.life <= 0) continue;
      blast.life -= dt;
      const remaining = Math.max(0, blast.life / blast.maxLife);
      const progress = 1 - remaining;
      blast.core.scale.setScalar(blast.scale * (2.6 + progress * 4.2));
      blast.halo.scale.setScalar(blast.scale * (5.2 + progress * 7.5));
      blast.core.material.opacity = Math.pow(remaining, 1.8);
      blast.halo.material.opacity = 0.78 * Math.pow(remaining, 2.5);
      blast.light.intensity = 120 * blast.scale * Math.pow(remaining, 3);
      if (blast.life <= 0) {
        blast.core.visible = false;
        blast.halo.visible = false;
        blast.light.intensity = 0;
      }
    }

    for (const arc of this.slashArcs) {
      if (arc.life <= 0) continue;
      arc.life -= dt;
      const progress = 1 - Math.max(0, arc.life) / 0.16;
      arc.mesh.scale.setScalar(1 + progress * 0.66);
      arc.mesh.material.opacity = 0.82 * (1 - progress);
      if (arc.life <= 0) arc.mesh.visible = false;
    }

    let particleDirty = false;
    for (let i = 0; i < VFX_QUALITY.particlePool; i++) {
      if (this.particleLife[i] <= 0) continue;
      particleDirty = true;
      this.particleLife[i] = (this.particleLife[i] as number) - dt;
      const offset = i * 3;
      if (this.particleLife[i] <= 0) {
        this.particlePosition[offset + 1] = HIDDEN_Y;
        this.particleColor[offset] = 0;
        this.particleColor[offset + 1] = 0;
        this.particleColor[offset + 2] = 0;
        continue;
      }
      this.particleVelocity[offset + 1] = (this.particleVelocity[offset + 1] as number) - 7.5 * dt;
      this.particlePosition[offset] =
        (this.particlePosition[offset] as number) + (this.particleVelocity[offset] as number) * dt;
      this.particlePosition[offset + 1] =
        (this.particlePosition[offset + 1] as number) + (this.particleVelocity[offset + 1] as number) * dt;
      this.particlePosition[offset + 2] =
        (this.particlePosition[offset + 2] as number) + (this.particleVelocity[offset + 2] as number) * dt;
      const fade = (this.particleLife[i] as number) / (this.particleMaxLife[i] as number);
      this.particleColor[offset] = (this.particleBaseColor[offset] as number) * fade;
      this.particleColor[offset + 1] = (this.particleBaseColor[offset + 1] as number) * fade;
      this.particleColor[offset + 2] = (this.particleBaseColor[offset + 2] as number) * fade;
    }
    if (particleDirty) {
      this.particlePositionAttr.needsUpdate = true;
      this.particleColorAttr.needsUpdate = true;
    }

    let marksDirty = false;
    for (let i = 0; i < VFX_QUALITY.impactMarkPool; i++) {
      if (this.impactMarkLife[i] <= 0) continue;
      this.impactMarkLife[i] = (this.impactMarkLife[i] as number) - dt;
      if (this.impactMarkLife[i] > 0) continue;
      this.hideImpactMark(i);
      marksDirty = true;
    }
    if (marksDirty) this.impactMarks.instanceMatrix.needsUpdate = true;
  }

  reset(): void {
    for (const tracer of this.tracers) tracer.mesh.visible = false;
    for (const flash of this.muzzleFlashes) {
      flash.life = 0;
      flash.core.visible = false;
      flash.halo.visible = false;
    }
    for (const ring of this.shockRings) {
      ring.life = 0;
      ring.mesh.visible = false;
    }
    for (const ring of this.splashRings) {
      ring.life = 0;
      ring.mesh.visible = false;
    }
    for (const column of this.smokeColumns) {
      column.life = 0;
      for (const sprite of column.sprites) sprite.visible = false;
    }
    for (const puff of this.puffs) {
      puff.life = 0;
      puff.sprite.visible = false;
    }
    for (const blast of this.blasts) {
      blast.life = 0;
      blast.core.visible = false;
      blast.halo.visible = false;
      blast.light.intensity = 0;
    }
    for (const arc of this.slashArcs) {
      arc.life = 0;
      arc.mesh.visible = false;
    }
    this.muzzleLight.intensity = 0;
    for (let i = 0; i < VFX_QUALITY.particlePool; i++) {
      this.particleLife[i] = 0;
      const offset = i * 3;
      this.particlePosition[offset + 1] = HIDDEN_Y;
      this.particleColor[offset] = 0;
      this.particleColor[offset + 1] = 0;
      this.particleColor[offset + 2] = 0;
    }
    this.particlePositionAttr.needsUpdate = true;
    this.particleColorAttr.needsUpdate = true;
    this.hideAllImpactMarks();
  }

  private syncTracer(tracer: Tracer, progress: number): void {
    const headDistance = Math.max(0.15, tracer.distance * clamp(progress, 0, 1));
    const tailDistance = Math.max(0, headDistance - tracer.streak);
    const visualLength = Math.max(0.08, headDistance - tailDistance);
    this.tmpPoint.copy(tracer.from).addScaledVector(tracer.direction, (headDistance + tailDistance) * 0.5);
    this.tmpEnd.copy(tracer.from).addScaledVector(tracer.direction, headDistance);
    tracer.mesh.position.copy(this.tmpPoint);
    tracer.mesh.lookAt(this.tmpEnd);
    tracer.mesh.scale.set(tracer.width, tracer.width, visualLength);
    const fadeIn = clamp(progress / 0.12, 0, 1);
    const fadeOut = clamp((1 - progress) / 0.24, 0, 1);
    tracer.mesh.material.opacity = Math.min(fadeIn, fadeOut) * 0.96;
  }

  private spawnShockRing(
    point: THREE.Vector3,
    scale: number,
    color: number,
    duration: number,
    growth: number,
  ): void {
    const ring = this.shockRings[this.shockRingIndex] as ShockRing;
    this.shockRingIndex = (this.shockRingIndex + 1) % this.shockRings.length;
    ring.mesh.position.set(point.x, point.y + 0.06, point.z);
    ring.mesh.scale.setScalar(scale);
    ring.mesh.material.color.setHex(color);
    ring.mesh.material.opacity = 0.82;
    ring.mesh.visible = true;
    ring.life = duration;
    ring.maxLife = duration;
    ring.growth = growth;
    ring.baseScale = scale;
  }

  private spawnSplashRing(point: THREE.Vector3, growth: number, duration: number): void {
    const ring = this.splashRings[this.splashRingIndex] as SplashRing;
    this.splashRingIndex = (this.splashRingIndex + 1) % this.splashRings.length;
    ring.mesh.position.set(point.x, point.y + 0.025, point.z);
    ring.mesh.scale.setScalar(0.28);
    ring.mesh.material.opacity = 0.72;
    ring.mesh.visible = true;
    ring.life = duration;
    ring.maxLife = duration;
    ring.growth = growth;
  }

  private spawnSmokeColumn(point: THREE.Vector3, scale: number): void {
    const column = this.smokeColumns[this.smokeColumnIndex] as SmokeColumn;
    this.smokeColumnIndex = (this.smokeColumnIndex + 1) % this.smokeColumns.length;
    column.life = column.maxLife;
    column.sprites.forEach((sprite, layer) => {
      sprite.position.set(
        point.x + (Math.random() - 0.5) * 0.7 * scale,
        point.y + 0.55 + layer * 0.88 * scale,
        point.z + (Math.random() - 0.5) * 0.7 * scale,
      );
      sprite.scale.setScalar((1.15 + layer * 0.5) * scale);
      sprite.material.color.setHex(layer === 0 ? 0x5e5953 : 0x777572);
      sprite.material.opacity = 0.54;
      sprite.material.rotation = Math.random() * Math.PI * 2;
      sprite.visible = true;
    });
  }

  private spawnPuff(
    point: THREE.Vector3,
    color: number,
    scale: number,
    duration: number,
    growth: number,
    opacity: number,
    spread: number,
  ): void {
    const puff = this.puffs[this.puffIndex] as Puff;
    this.puffIndex = (this.puffIndex + 1) % this.puffs.length;
    puff.life = duration;
    puff.maxLife = duration;
    puff.verticalSpeed = 0.18 + Math.random() * 0.5;
    puff.growth = growth;
    puff.baseScale = scale;
    puff.baseOpacity = opacity;
    puff.driftX = (Math.random() - 0.5) * spread;
    puff.driftZ = (Math.random() - 0.5) * spread;
    puff.sprite.position.set(
      point.x + (Math.random() - 0.5) * spread,
      point.y + 0.08,
      point.z + (Math.random() - 0.5) * spread,
    );
    puff.sprite.scale.setScalar(scale);
    puff.sprite.material.color.setHex(color);
    puff.sprite.material.opacity = opacity;
    puff.sprite.material.rotation = Math.random() * Math.PI * 2;
    puff.sprite.visible = true;
  }

  private spawnImpactMark(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    color: number,
    size: number,
    lifetime: number,
  ): void {
    const index = this.impactMarkIndex;
    this.impactMarkIndex = (this.impactMarkIndex + 1) % VFX_QUALITY.impactMarkPool;
    this.tmpNormal.copy(normal).normalize();
    this.tmpPoint.copy(point).addScaledVector(this.tmpNormal, 0.026);
    this.tmpQuaternion.setFromUnitVectors(FORWARD, this.tmpNormal);
    this.tmpScale.set(size, size, size);
    this.tmpMatrix.compose(this.tmpPoint, this.tmpQuaternion, this.tmpScale);
    this.impactMarks.setMatrixAt(index, this.tmpMatrix);
    this.tmpColor.setHex(color);
    this.impactMarks.setColorAt(index, this.tmpColor);
    this.impactMarks.instanceMatrix.needsUpdate = true;
    if (this.impactMarks.instanceColor) this.impactMarks.instanceColor.needsUpdate = true;
    this.impactMarkLife[index] = lifetime;
  }

  private hideImpactMark(index: number): void {
    this.tmpScale.set(0, 0, 0);
    this.tmpMatrix.compose(this.tmpPoint.set(0, HIDDEN_Y, 0), this.tmpQuaternion.identity(), this.tmpScale);
    this.impactMarks.setMatrixAt(index, this.tmpMatrix);
    this.impactMarkLife[index] = 0;
  }

  private hideAllImpactMarks(): void {
    for (let i = 0; i < VFX_QUALITY.impactMarkPool; i++) this.hideImpactMark(i);
    this.impactMarks.instanceMatrix.needsUpdate = true;
  }
}
