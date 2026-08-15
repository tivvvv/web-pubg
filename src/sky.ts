// 天空: 渐变穹顶(着色器) + 太阳光晕/日盘 + 漂移云Sprite
import * as THREE from 'three';
import { mulberry32 } from './utils';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uDaylight;
uniform float uCloudCover;
uniform float uFlash;
uniform float uTime;
varying vec3 vDir;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 d = normalize(vDir);
  float t = pow(clamp(d.y, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizon, uZenith, t);
  float haze = pow(1.0 - clamp(d.y, 0.0, 1.0), 5.0);
  col = mix(col, vec3(0.82, 0.86, 0.84), haze * 0.12);
  col = mix(col, vec3(0.29, 0.35, 0.4), uCloudCover * (0.1 + haze * 0.16));
  float s = max(dot(d, uSunDir), 0.0);
  col += vec3(1.0, 0.65, 0.32) * pow(s, 4.0) * 0.2 * uDaylight;
  col += vec3(1.0, 0.82, 0.58) * pow(s, 34.0) * 0.36 * uDaylight;
  col += vec3(1.0, 0.88, 0.7) * pow(s, 110.0) * 0.72 * uDaylight;
  col += vec3(1.0, 0.95, 0.85) * smoothstep(0.9993, 0.9997, s) * uDaylight;
  float moon = max(dot(d, uMoonDir), 0.0);
  float night = 1.0 - uDaylight;
  col += vec3(0.55, 0.68, 0.9) * pow(moon, 55.0) * 0.22 * night;
  col += vec3(0.78, 0.86, 1.0) * smoothstep(0.9991, 0.99962, moon) * night;
  vec3 starCell = floor(d * 520.0);
  float starSeed = hash31(starCell);
  float star = step(0.9955, starSeed) * pow(max(d.y, 0.0), 0.3);
  float fineStar = step(0.9982, hash31(floor(d * 940.0) + 17.0)) * pow(max(d.y, 0.0), 0.45);
  float twinkle = 0.72 + 0.28 * sin(uTime * (1.1 + starSeed * 2.4) + starSeed * 41.0);
  float milkyBand = exp(-abs(dot(d, normalize(vec3(0.22, 0.66, 0.72)))) * 14.0);
  float clearNight = night * (1.0 - smoothstep(0.28, 0.9, uCloudCover));
  col += vec3(0.7, 0.82, 1.0) * (star * twinkle + fineStar * 0.72) * clearNight;
  col += vec3(0.19, 0.25, 0.4) * milkyBand * clearNight * 0.18;
  col += vec3(0.72, 0.82, 0.95) * uFlash * 0.62;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// canvas 手绘蓬松云纹理(确定性种子)
function makeCloudTexture(seed: number): THREE.Texture {
  // 无 DOM 的自动化巡检只需要可构造的占位纹理，浏览器仍使用完整手绘云层。
  if (typeof document === 'undefined') {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 210]), 1, 1);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const cv = document.createElement('canvas');
  cv.width = 384;
  cv.height = 192;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(seed);
  if (ctx) {
    // 底部冷灰阴影让云层不再是纯白平面。
    for (let i = 0; i < 13; i++) {
      const cx = 42 + rng() * 300;
      const cy = 80 + rng() * 40;
      const r = 25 + rng() * 43;
      const shadow = ctx.createRadialGradient(cx, cy + r * 0.18, 0, cx, cy + r * 0.18, r);
      shadow.addColorStop(0, 'rgba(126,146,160,0.24)');
      shadow.addColorStop(0.68, 'rgba(145,158,167,0.1)');
      shadow.addColorStop(1, 'rgba(160,170,176,0)');
      ctx.fillStyle = shadow;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    for (let i = 0; i < 15; i++) {
      const cx = 36 + rng() * 310;
      const cy = 55 + rng() * 58;
      const r = 22 + rng() * 48;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,252,243,0.78)');
      g.addColorStop(0.52, 'rgba(255,255,255,0.34)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Sky {
  private clouds: { spr: THREE.Sprite; speed: number; baseOpacity: number }[] = [];
  private dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private cloudCover = 0.3;
  private wind = 1;
  private daylight = 1;
  private elapsed = 0;
  private meteorTimer = 4.5;
  private meteorCursor = 0;
  private readonly meteorRng = mulberry32(88431);
  private readonly meteors: {
    line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    velocity: THREE.Vector3;
    life: number;
    maxLife: number;
  }[] = [];

  constructor(scene: THREE.Scene) {
    // 穹顶(与 updateShadow 的太阳偏移方向一致: +85,+72,+42)
    const sunDir = new THREE.Vector3(85, 72, 42).normalize();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(820, 24, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: new THREE.Color(0x5a92cf) },
          uHorizon: { value: new THREE.Color(0xead9c4) },
          uSunDir: { value: sunDir },
          uMoonDir: { value: sunDir.clone().negate() },
          uDaylight: { value: 1 },
          uCloudCover: { value: 0.3 },
          uFlash: { value: 0 },
          uTime: { value: 0 },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
      }),
    );
    dome.frustumCulled = false;
    dome.name = 'sky-atmosphere-dome';
    dome.renderOrder = -10;
    scene.add(dome);
    this.dome = dome;

    // 漂移云
    const textures = [makeCloudTexture(777), makeCloudTexture(3181)];
    const rng = mulberry32(20250);
    for (let i = 0; i < 28; i++) {
      const high = i >= 19;
      const mat = new THREE.SpriteMaterial({
        map: textures[i % textures.length],
        transparent: true,
        opacity: high ? 0.28 + rng() * 0.14 : 0.46 + rng() * 0.24,
        depthWrite: false,
        fog: false,
        rotation: (rng() - 0.5) * 0.6,
      });
      const spr = new THREE.Sprite(mat);
      spr.name = 'sky-cloud';
      spr.position.set((rng() * 2 - 1) * 550, high ? 150 + rng() * 45 : 92 + rng() * 54, (rng() * 2 - 1) * 550);
      spr.scale.set(high ? 120 + rng() * 90 : 68 + rng() * 75, high ? 24 + rng() * 14 : 28 + rng() * 24, 1);
      scene.add(spr);
      this.clouds.push({
        spr,
        speed: high ? 0.3 + rng() * 0.45 : 0.7 + rng() * 1.1,
        baseOpacity: mat.opacity,
      });
    }

    const meteorGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(-24, 8, 3),
    ]);
    for (let i = 0; i < 3; i++) {
      const line = new THREE.Line(
        meteorGeometry.clone(),
        new THREE.LineBasicMaterial({
          color: i === 0 ? 0xfff2c6 : 0xbfdcff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: false,
          fog: false,
          toneMapped: false,
        }),
      );
      line.name = 'night-meteor';
      line.visible = false;
      line.frustumCulled = false;
      line.renderOrder = 9;
      scene.add(line);
      this.meteors.push({ line, velocity: new THREE.Vector3(), life: 0, maxLife: 0.8 });
    }
    if (typeof window !== 'undefined') {
      const query = new URLSearchParams(window.location.search);
      if (query.has('test') && query.get('meteor') === '1') this.meteorTimer = 0.05;
    }
  }

  setAtmosphere(
    zenith: THREE.Color,
    horizon: THREE.Color,
    sunDir: THREE.Vector3,
    daylight: number,
    cloudCover: number,
    wind: number,
    flash: number,
  ): void {
    const u = this.dome.material.uniforms;
    (u.uZenith?.value as THREE.Color).copy(zenith);
    (u.uHorizon?.value as THREE.Color).copy(horizon);
    (u.uSunDir?.value as THREE.Vector3).copy(sunDir);
    (u.uMoonDir?.value as THREE.Vector3).copy(sunDir).negate();
    if (u.uDaylight) u.uDaylight.value = daylight;
    if (u.uCloudCover) u.uCloudCover.value = cloudCover;
    if (u.uFlash) u.uFlash.value = flash;
    this.daylight = daylight;
    this.cloudCover = cloudCover;
    this.wind = wind;
  }

  update(dt: number, camPos: THREE.Vector3): void {
    this.elapsed += dt;
    const timeUniform = this.dome.material.uniforms.uTime;
    if (timeUniform) timeUniform.value = this.elapsed;
    // 穹顶跟随相机: 否则远处球面会超出相机 far 平面被裁出黑洞
    this.dome.position.copy(camPos);
    for (const c of this.clouds) {
      c.spr.position.x += c.speed * this.wind * dt;
      if (c.spr.position.x > 560) c.spr.position.x -= 1120;
      const mat = c.spr.material;
      mat.opacity = c.baseOpacity * (0.22 + this.cloudCover * 1.22) * (0.58 + this.daylight * 0.42);
      const stormShade = this.cloudCover * this.cloudCover;
      mat.color.setRGB(
        0.5 + this.daylight * (0.5 - stormShade * 0.28),
        0.57 + this.daylight * (0.43 - stormShade * 0.22),
        0.66 + this.daylight * (0.34 - stormShade * 0.14),
      );
    }
    this.updateMeteors(dt, camPos);
  }

  private updateMeteors(dt: number, camPos: THREE.Vector3): void {
    const nightVisibility = (1 - this.daylight) * (1 - this.cloudCover * 0.78);
    if (nightVisibility > 0.42) {
      this.meteorTimer -= dt;
      if (this.meteorTimer <= 0) {
        const meteor = this.meteors[this.meteorCursor] as (typeof this.meteors)[number];
        this.meteorCursor = (this.meteorCursor + 1) % this.meteors.length;
        const side = this.meteorRng() < 0.5 ? -1 : 1;
        meteor.maxLife = 0.58 + this.meteorRng() * 0.42;
        meteor.life = meteor.maxLife;
        meteor.line.position.set(
          camPos.x + (this.meteorRng() * 2 - 1) * 180,
          camPos.y + 100 + this.meteorRng() * 75,
          camPos.z - 170 - this.meteorRng() * 130,
        );
        meteor.line.rotation.z = side * (0.08 + this.meteorRng() * 0.2);
        meteor.velocity.set(side * (38 + this.meteorRng() * 28), -20 - this.meteorRng() * 15, 8);
        meteor.line.material.opacity = nightVisibility;
        meteor.line.visible = true;
        this.meteorTimer = 5 + this.meteorRng() * 13;
      }
    }
    for (const meteor of this.meteors) {
      if (!meteor.line.visible) continue;
      meteor.life -= dt;
      if (meteor.life <= 0 || nightVisibility <= 0.18) {
        meteor.line.visible = false;
        meteor.line.material.opacity = 0;
        continue;
      }
      meteor.line.position.addScaledVector(meteor.velocity, dt);
      const progress = meteor.life / meteor.maxLife;
      meteor.line.material.opacity = nightVisibility * Math.sin(progress * Math.PI) * 0.95;
    }
  }
}
