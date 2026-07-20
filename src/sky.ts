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
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float t = pow(clamp(d.y, 0.0, 1.0), 0.55);
  vec3 col = mix(uHorizon, uZenith, t);
  float haze = pow(1.0 - clamp(d.y, 0.0, 1.0), 5.0);
  col = mix(col, vec3(0.84, 0.83, 0.72), haze * 0.2);
  float s = max(dot(d, uSunDir), 0.0);
  col += vec3(1.0, 0.68, 0.38) * pow(s, 6.0) * 0.24;   // 大范围暖晕(金色时刻)
  col += vec3(1.0, 0.82, 0.58) * pow(s, 90.0) * 0.82;  // 近太阳亮晕
  col += vec3(1.0, 0.95, 0.85) * smoothstep(0.9993, 0.9997, s); // 日盘
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// canvas 手绘蓬松云纹理(确定性种子)
function makeCloudTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 384;
  cv.height = 192;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(777);
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
  private clouds: { spr: THREE.Sprite; speed: number }[] = [];
  private dome: THREE.Mesh;

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
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
      }),
    );
    dome.frustumCulled = false;
    dome.renderOrder = -10;
    scene.add(dome);
    this.dome = dome;

    // 漂移云
    const tex = makeCloudTexture();
    const rng = mulberry32(20250);
    for (let i = 0; i < 20; i++) {
      const high = i >= 14;
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: high ? 0.28 + rng() * 0.14 : 0.46 + rng() * 0.24,
        depthWrite: false,
        fog: false,
        rotation: (rng() - 0.5) * 0.6,
      });
      const spr = new THREE.Sprite(mat);
      spr.position.set((rng() * 2 - 1) * 550, high ? 150 + rng() * 45 : 92 + rng() * 54, (rng() * 2 - 1) * 550);
      spr.scale.set(high ? 120 + rng() * 90 : 68 + rng() * 75, high ? 24 + rng() * 14 : 28 + rng() * 24, 1);
      scene.add(spr);
      this.clouds.push({ spr, speed: high ? 0.3 + rng() * 0.45 : 0.7 + rng() * 1.1 });
    }
  }

  update(dt: number, camPos: THREE.Vector3): void {
    // 穹顶跟随相机: 否则远处球面会超出相机 far 平面被裁出黑洞
    this.dome.position.copy(camPos);
    for (const c of this.clouds) {
      c.spr.position.x += c.speed * dt;
      if (c.spr.position.x > 560) c.spr.position.x -= 1120;
    }
  }
}
