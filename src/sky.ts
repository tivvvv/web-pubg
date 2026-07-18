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
  float s = max(dot(d, uSunDir), 0.0);
  col += vec3(1.0, 0.72, 0.42) * pow(s, 6.0) * 0.25;   // 大范围暖晕
  col += vec3(1.0, 0.88, 0.66) * pow(s, 90.0) * 0.9;   // 近太阳亮晕
  col += vec3(1.0, 0.97, 0.90) * smoothstep(0.9993, 0.9997, s); // 日盘
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// canvas 手绘蓬松云纹理(确定性种子)
function makeCloudTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 128;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(777);
  if (ctx) {
    for (let i = 0; i < 10; i++) {
      const cx = 28 + rng() * 200;
      const cy = 42 + rng() * 44;
      const r = 16 + rng() * 30;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.60)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.28)');
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
    // 穹顶(与 updateShadow 的太阳偏移方向一致)
    const sunDir = new THREE.Vector3(70, 100, 40).normalize();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(820, 24, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: new THREE.Color(0x5f97d4) },
          uHorizon: { value: new THREE.Color(0xcfe0ee) },
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
    for (let i = 0; i < 14; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.5 + rng() * 0.25,
        depthWrite: false,
        fog: false,
        rotation: (rng() - 0.5) * 0.6,
      });
      const spr = new THREE.Sprite(mat);
      spr.position.set((rng() * 2 - 1) * 550, 90 + rng() * 50, (rng() * 2 - 1) * 550);
      spr.scale.set(60 + rng() * 60, 25 + rng() * 20, 1);
      scene.add(spr);
      this.clouds.push({ spr, speed: 0.8 + rng() * 1.2 });
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
