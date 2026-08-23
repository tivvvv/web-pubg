// 动态环境: 昼夜时钟 + 天气转场 + 光照/雾/云/降雨/闪电
import * as THREE from 'three';
import { setSurfaceEnvironment } from './assets';
import type { Sky } from './sky';
import { clamp, lerp, mulberry32, smoothstep } from './utils';

export const WEATHER_KINDS = ['clear', 'cloudy', 'rain', 'snow', 'fog', 'storm'] as const;
export type WeatherKind = typeof WEATHER_KINDS[number];

export interface EnvironmentSnapshot {
  timeText: string;
  phaseLabel: string;
  weather: WeatherKind;
  weatherLabel: string;
  rainIntensity: number;
  snowIntensity: number;
  exposure: number;
  daylight: number;
  saturation: number;
  contrast: number;
  wetness: number;
  cloudiness: number;
  warmth: number;
}

interface WeatherProfile {
  cloud: number;
  rain: number;
  snow: number;
  fogNear: number;
  fogFar: number;
  light: number;
  wind: number;
  wet: number;
  storm: number;
}

export interface EnvironmentLighting {
  hemiIntensity: number;
  moonIntensity: number;
  exposure: number;
}

export interface EnvironmentSurfaceDetail {
  wetness: number;
  cloudiness: number;
  moteOpacity: number;
  lowMistOpacity: number;
}

export interface EnvironmentVisualProfile {
  lighting: EnvironmentLighting;
  surface: EnvironmentSurfaceDetail;
  sunIntensity: number;
  shadowRadius: number;
  fogNear: number;
  fogFar: number;
  rainOpacity: number;
  saturation: number;
  contrast: number;
  warmth: number;
}

export function environmentSurfaceDetail(
  rain: number,
  wet: number,
  cloud: number,
  daylight: number,
): EnvironmentSurfaceDetail {
  const rain01 = clamp(rain, 0, 1);
  const wet01 = clamp(wet, 0, 1);
  const cloud01 = clamp(cloud, 0, 1);
  const day01 = clamp(daylight, 0, 1);
  return {
    wetness: Math.max(wet01, rain01 * 0.88),
    cloudiness: cloud01,
    // 晴朗白天最容易看到空气中的微尘，降雨、厚云和夜晚都会自然压低它。
    moteOpacity: clamp(
      (1 - rain01) * (0.15 + day01 * 0.85) * (1 - cloud01 * 0.55) * 0.24,
      0,
      0.24,
    ),
    lowMistOpacity: clamp(
      0.008 + cloud01 * 0.06 + rain01 * 0.045 + wet01 * 0.028 + (1 - day01) * 0.045,
      0.008,
      0.16,
    ),
  };
}

export function environmentLighting(
  daylight: number,
  light: number,
  rain: number,
  storm: number,
): EnvironmentLighting {
  const rainFill = rain * (0.12 + daylight * 0.14) + storm * 0.05;
  return {
    // 白天亮度维持原水平，夜间和背光面增加环境补光，避免角色与建筑压成纯黑剪影。
    hemiIntensity: 1.04 + daylight * 0.18 * light + rainFill,
    moonIntensity: 0.74 * light + rain * 0.04,
    exposure: clamp(
      1.105 - daylight * 0.025 + (1 - light) * 0.07 + rain * 0.075 + storm * 0.025
        + (1 - daylight) * 0.18,
      1.08,
      1.34,
    ),
  };
}

// 材质, 主光, 环境光, 雾和后处理共用的唯一视觉配置入口。
export function environmentVisualProfile(input: {
  daylight: number;
  sunHeight: number;
  twilight: number;
  light: number;
  cloud: number;
  rain: number;
  snow?: number;
  wet: number;
  storm: number;
  fogNear: number;
  fogFar: number;
}): EnvironmentVisualProfile {
  const daylight = clamp(input.daylight, 0, 1);
  const sunHeight = clamp(input.sunHeight, -1, 1);
  const twilight = clamp(input.twilight, 0, 1);
  const light = clamp(input.light, 0, 1);
  const cloud = clamp(input.cloud, 0, 1);
  const rain = clamp(input.rain, 0, 1);
  const snow = clamp(input.snow ?? 0, 0, 1);
  const wet = clamp(input.wet, 0, 1);
  const storm = clamp(input.storm, 0, 1);
  const surface = environmentSurfaceDetail(rain, wet, cloud, daylight);
  const lighting = environmentLighting(daylight, light, rain, storm);
  // 暮色偏暖, 深夜和厚云偏冷。该值直接供全部表面材质和水面使用。
  const warmth = clamp(0.46 + twilight * 0.42 + Math.max(0, sunHeight) * 0.08 - cloud * 0.18, 0.2, 0.92);
  const weatherSoftness = cloud * 1.25 + rain * 0.7 + snow * 0.38;
  return {
    lighting,
    surface,
    // 厚云将光能从硬直射转移到上方的环境补光，雨天不会再出现亮天空配纯黑阴影。
    sunIntensity: (0.16 + daylight * 2.38) * light * (1 - cloud * 0.24),
    shadowRadius: clamp(1.8 + weatherSoftness, 1.8, 3.7),
    fogNear: Math.max(24, input.fogNear),
    fogFar: Math.max(input.fogNear + 120, input.fogFar),
    rainOpacity: clamp(rain * (0.54 + daylight * 0.1), 0, 0.64),
    saturation: clamp(1.15 - cloud * 0.04 - rain * 0.018 - snow * 0.014 + twilight * 0.012, 1.075, 1.15),
    contrast: clamp(1.058 - cloud * 0.012 - rain * 0.008 + (1 - daylight) * 0.006, 1.035, 1.064),
    warmth,
  };
}

const WEATHER: Record<WeatherKind, WeatherProfile> = {
  clear: { cloud: 0.18, rain: 0, snow: 0, fogNear: 185, fogFar: 690, light: 1, wind: 0.75, wet: 0, storm: 0 },
  cloudy: { cloud: 0.72, rain: 0, snow: 0, fogNear: 140, fogFar: 545, light: 0.84, wind: 1.25, wet: 0.08, storm: 0 },
  rain: { cloud: 0.9, rain: 0.76, snow: 0, fogNear: 110, fogFar: 500, light: 0.9, wind: 2.05, wet: 0.82, storm: 0.16 },
  snow: { cloud: 0.82, rain: 0, snow: 0.82, fogNear: 118, fogFar: 515, light: 0.92, wind: 1.45, wet: 0.3, storm: 0 },
  fog: { cloud: 0.62, rain: 0.04, snow: 0, fogNear: 34, fogFar: 255, light: 0.78, wind: 0.34, wet: 0.28, storm: 0 },
  storm: { cloud: 0.98, rain: 1, snow: 0, fogNear: 88, fogFar: 440, light: 0.8, wind: 3.1, wet: 1, storm: 1 },
};

const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: '晴朗', cloudy: '多云', rain: '降雨', snow: '降雪', fog: '大雾', storm: '雷暴',
};

const WEATHER_ICON: Record<WeatherKind, string> = {
  clear: '☀︎', cloudy: '☁︎', rain: '☂︎', snow: '❄', fog: '≡', storm: 'ϟ',
};

const NEXT_WEATHER: Record<WeatherKind, readonly WeatherKind[]> = {
  clear: ['cloudy', 'cloudy', 'fog'],
  cloudy: ['clear', 'rain', 'rain', 'snow', 'fog'],
  rain: ['cloudy', 'storm', 'cloudy'],
  snow: ['cloudy', 'clear', 'fog'],
  fog: ['clear', 'cloudy', 'snow'],
  storm: ['rain', 'cloudy'],
};

// 构造阶段先展示上午多云菜单，首场对局固定进入晴朗午前，确保玩家第一眼能看清完整场景资产。
const INITIAL_WEATHER: readonly WeatherKind[] = ['cloudy', 'clear', 'rain', 'snow', 'fog', 'storm'];
const START_HOURS = [9.5, 11.25, 16.8, 8.4, 20.4] as const;
const DAY_DURATION_SEC = 420;

function copyProfile(p: WeatherProfile): WeatherProfile {
  return { ...p };
}

export function phaseAt(hour: number): string {
  if (hour >= 5 && hour < 8) return '清晨';
  if (hour >= 8 && hour < 11) return '上午';
  if (hour >= 11 && hour < 14) return '正午';
  if (hour >= 14 && hour < 17) return '下午';
  if (hour >= 17 && hour < 19.5) return '黄昏';
  if (hour >= 19.5 && hour < 23.5) return '夜晚';
  return '深夜';
}

export function timeText(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.floor((hour - Math.floor(hour)) * 60) % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export class EnvironmentSystem {
  readonly snapshot: EnvironmentSnapshot = {
    timeText: '12:00', phaseLabel: '正午', weather: 'clear', weatherLabel: '晴朗',
    rainIntensity: 0, snowIntensity: 0, exposure: 1.08, daylight: 1,
    saturation: 1.06, contrast: 1.035, wetness: 0, cloudiness: 0.18, warmth: 0.54,
  };

  private readonly sky: Sky;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly fog: THREE.Fog;
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly waterMat: THREE.MeshPhongMaterial;
  private readonly rain: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly rainPos: Float32Array;
  private readonly rainSpeed: Float32Array;
  private readonly rainSeed: Float32Array;
  private readonly snow: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly snowPos: Float32Array;
  private readonly snowFall: Float32Array;
  private readonly snowDrift: Float32Array;
  private readonly airMotes: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly motePos: Float32Array;
  private readonly moteDrift: Float32Array;
  private readonly lowMist: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly zenith = new THREE.Color();
  private readonly horizon = new THREE.Color();
  private readonly fogColor = new THREE.Color();
  private readonly sunDir = new THREE.Vector3(0.7, 0.6, 0.35).normalize();
  private readonly lightDir = new THREE.Vector3();
  private readonly dayZenith = new THREE.Color(0x529dd8);
  private readonly dayHorizon = new THREE.Color(0xc9e0ec);
  private readonly dawnZenith = new THREE.Color(0x405f91);
  private readonly dawnHorizon = new THREE.Color(0xefa16c);
  private readonly nightZenith = new THREE.Color(0x0d203a);
  private readonly nightHorizon = new THREE.Color(0x29415b);
  private readonly dayWater = new THREE.Color(0x2c7898);
  private readonly nightWater = new THREE.Color(0x1a4162);
  private readonly cloudFog = new THREE.Color(0x8798a2);
  private readonly warmSun = new THREE.Color(0xffa268);
  private readonly daySun = new THREE.Color(0xffefcf);
  private readonly dayHemi = new THREE.Color(0x8ebbd9);
  private readonly nightHemi = new THREE.Color(0x9aabc4);
  private readonly dayGround = new THREE.Color(0x60774e);
  private readonly nightGround = new THREE.Color(0x718097);
  private readonly stormWater = new THREE.Color(0x294b5b);
  private current = copyProfile(WEATHER.clear);
  private target = copyProfile(WEATHER.clear);
  private weather: WeatherKind = 'clear';
  private timeHours = 12;
  private weatherTimer = 35;
  private lightningTimer = 7;
  private flash = 0;
  private notice: string | null = null;
  private thunderPending = false;
  private lastPhase = '正午';
  private roundIndex = -1;
  private rng = mulberry32(81027);

  constructor(
    scene: THREE.Scene,
    sky: Sky,
    sun: THREE.DirectionalLight,
    hemi: THREE.HemisphereLight,
    fog: THREE.Fog,
    terrainMat: THREE.MeshStandardMaterial,
    waterMat: THREE.MeshPhongMaterial,
  ) {
    this.sky = sky;
    this.sun = sun;
    this.hemi = hemi;
    this.fog = fog;
    this.terrainMat = terrainMat;
    this.waterMat = waterMat;

    const count = navigator.hardwareConcurrency <= 4 ? 360 : 680;
    this.rainPos = new Float32Array(count * 6);
    this.rainSpeed = new Float32Array(count);
    this.rainSeed = new Float32Array(count * 2);
    const rr = mulberry32(91373);
    for (let i = 0; i < count; i++) {
      this.rainSeed[i * 2] = (rr() * 2 - 1) * 38;
      this.rainSeed[i * 2 + 1] = (rr() * 2 - 1) * 38;
      this.rainSpeed[i] = 21 + rr() * 16;
      const y = -3 + rr() * 35;
      const o = i * 6;
      this.rainPos[o] = this.rainSeed[i * 2] as number;
      this.rainPos[o + 1] = y;
      this.rainPos[o + 2] = this.rainSeed[i * 2 + 1] as number;
      this.rainPos[o + 3] = this.rainPos[o];
      this.rainPos[o + 4] = y - 1.6;
      this.rainPos[o + 5] = this.rainPos[o + 2];
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    const rainMat = new THREE.LineBasicMaterial({
      color: 0xbad7e5, transparent: true, opacity: 0, depthWrite: false, fog: true,
    });
    this.rain = new THREE.LineSegments(rainGeo, rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 4;
    this.rain.visible = false;
    scene.add(this.rain);

    // 雪花使用独立的缓降粒子，横向漂移和大小都与高速雨线区分开。
    const snowCount = navigator.hardwareConcurrency <= 4 ? 240 : 440;
    this.snowPos = new Float32Array(snowCount * 3);
    this.snowFall = new Float32Array(snowCount);
    this.snowDrift = new Float32Array(snowCount * 2);
    const snowRng = mulberry32(62291);
    for (let i = 0; i < snowCount; i++) {
      const o = i * 3;
      this.snowPos[o] = (snowRng() * 2 - 1) * 34;
      this.snowPos[o + 1] = -3 + snowRng() * 32;
      this.snowPos[o + 2] = (snowRng() * 2 - 1) * 34;
      this.snowFall[i] = 2.2 + snowRng() * 3.7;
      this.snowDrift[i * 2] = 0.55 + snowRng() * 1.4;
      this.snowDrift[i * 2 + 1] = snowRng() * Math.PI * 2;
    }
    const snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3));
    let snowTexture: THREE.Texture;
    if (typeof document === 'undefined') {
      snowTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 245]), 1, 1);
      snowTexture.needsUpdate = true;
    } else {
      const snowCanvas = document.createElement('canvas');
      snowCanvas.width = 32;
      snowCanvas.height = 32;
      const snowCtx = snowCanvas.getContext('2d');
      if (snowCtx) {
        const flake = snowCtx.createRadialGradient(16, 16, 1, 16, 16, 15);
        flake.addColorStop(0, 'rgba(255,255,255,1)');
        flake.addColorStop(0.35, 'rgba(245,250,255,0.88)');
        flake.addColorStop(1, 'rgba(235,245,255,0)');
        snowCtx.fillStyle = flake;
        snowCtx.fillRect(0, 0, 32, 32);
      }
      snowTexture = new THREE.CanvasTexture(snowCanvas);
    }
    snowTexture.colorSpace = THREE.SRGBColorSpace;
    this.snow = new THREE.Points(
      snowGeo,
      new THREE.PointsMaterial({
        color: 0xf3f8ff,
        size: 0.19,
        map: snowTexture,
        transparent: true,
        opacity: 0,
        alphaTest: 0.025,
        depthWrite: false,
        sizeAttenuation: true,
        fog: true,
      }),
    );
    this.snow.name = 'weather-snow-particles';
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 4;
    this.snow.visible = false;
    scene.add(this.snow);

    // 单 draw-call 的近景空气微尘，补足清朗环境的空间纵深；雨天和夜间自动收敛。
    const moteCount = navigator.hardwareConcurrency <= 4 ? 80 : 140;
    this.motePos = new Float32Array(moteCount * 3);
    this.moteDrift = new Float32Array(moteCount * 2);
    const moteRng = mulberry32(49127);
    for (let i = 0; i < moteCount; i++) {
      const o = i * 3;
      this.motePos[o] = (moteRng() * 2 - 1) * 30;
      this.motePos[o + 1] = -3 + moteRng() * 17;
      this.motePos[o + 2] = (moteRng() * 2 - 1) * 30;
      this.moteDrift[i * 2] = 0.025 + moteRng() * 0.055;
      this.moteDrift[i * 2 + 1] = (moteRng() * 2 - 1) * 0.03;
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3));
    let moteTexture: THREE.Texture;
    if (typeof document === 'undefined') {
      moteTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 230]), 1, 1);
      moteTexture.needsUpdate = true;
    } else {
      const moteCanvas = document.createElement('canvas');
      moteCanvas.width = 32;
      moteCanvas.height = 32;
      const moteCtx = moteCanvas.getContext('2d');
      if (moteCtx) {
        const glow = moteCtx.createRadialGradient(16, 16, 0, 16, 16, 16);
        glow.addColorStop(0, 'rgba(255,255,255,0.9)');
        glow.addColorStop(0.28, 'rgba(255,255,255,0.42)');
        glow.addColorStop(1, 'rgba(255,255,255,0)');
        moteCtx.fillStyle = glow;
        moteCtx.fillRect(0, 0, 32, 32);
      }
      moteTexture = new THREE.CanvasTexture(moteCanvas);
    }
    moteTexture.colorSpace = THREE.SRGBColorSpace;
    const moteMat = new THREE.PointsMaterial({
      color: 0xffe4b5,
      size: 0.075,
      map: moteTexture,
      transparent: true,
      opacity: 0,
      alphaTest: 0.025,
      depthWrite: false,
      sizeAttenuation: true,
      fog: true,
      blending: THREE.AdditiveBlending,
    });
    this.airMotes = new THREE.Points(moteGeo, moteMat);
    this.airMotes.frustumCulled = false;
    this.airMotes.renderOrder = 3;
    this.airMotes.visible = false;
    scene.add(this.airMotes);

    const mistCount = navigator.hardwareConcurrency <= 4 ? 42 : 72;
    const mistPositions = new Float32Array(mistCount * 3);
    const mistRng = mulberry32(77131);
    for (let i = 0; i < mistCount; i++) {
      const o = i * 3;
      const angle = mistRng() * Math.PI * 2;
      const distance = 8 + Math.sqrt(mistRng()) * 82;
      mistPositions[o] = Math.cos(angle) * distance;
      mistPositions[o + 1] = 0.2 + mistRng() * 4.2;
      mistPositions[o + 2] = Math.sin(angle) * distance;
    }
    const mistGeometry = new THREE.BufferGeometry();
    mistGeometry.setAttribute('position', new THREE.BufferAttribute(mistPositions, 3));
    let mistTexture: THREE.Texture;
    if (typeof document === 'undefined') {
      mistTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 80]), 1, 1);
      mistTexture.needsUpdate = true;
    } else {
      const mistCanvas = document.createElement('canvas');
      mistCanvas.width = 96;
      mistCanvas.height = 32;
      const mistContext = mistCanvas.getContext('2d');
      if (mistContext) {
        const gradient = mistContext.createRadialGradient(48, 16, 2, 48, 16, 47);
        gradient.addColorStop(0, 'rgba(255,255,255,0.46)');
        gradient.addColorStop(0.52, 'rgba(255,255,255,0.18)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        mistContext.fillStyle = gradient;
        mistContext.fillRect(0, 0, 96, 32);
      }
      mistTexture = new THREE.CanvasTexture(mistCanvas);
    }
    mistTexture.colorSpace = THREE.SRGBColorSpace;
    this.lowMist = new THREE.Points(
      mistGeometry,
      new THREE.PointsMaterial({
        color: 0xc8d5d0,
        size: 10,
        map: mistTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        alphaTest: 0.015,
        sizeAttenuation: true,
        fog: true,
      }),
    );
    this.lowMist.frustumCulled = false;
    this.lowMist.renderOrder = 2;
    scene.add(this.lowMist);
    this.reset();
  }

  reset(): void {
    this.roundIndex++;
    this.rng = mulberry32(81027 + this.roundIndex * 7919);
    this.timeHours = START_HOURS[this.roundIndex % START_HOURS.length] as number;
    this.weather = INITIAL_WEATHER[this.roundIndex % INITIAL_WEATHER.length] as WeatherKind;
    if (typeof window !== 'undefined') {
      const query = new URLSearchParams(window.location.search);
      if (query.has('test')) {
        const weather = query.get('weather') as WeatherKind | null;
        if (weather && weather in WEATHER) this.weather = weather;
        const timeParam = query.get('time');
        if (timeParam !== null) {
          const hour = Number(timeParam);
          if (Number.isFinite(hour)) this.timeHours = ((hour % 24) + 24) % 24;
        }
      }
    }
    this.current = copyProfile(WEATHER[this.weather]);
    this.target = copyProfile(WEATHER[this.weather]);
    this.weatherTimer = 30 + this.rng() * 16;
    this.lightningTimer = 4 + this.rng() * 8;
    this.flash = 0;
    this.notice = null;
    this.thunderPending = false;
    this.lastPhase = phaseAt(this.timeHours);
    this.syncSnapshot(1);
  }

  update(dt: number, camPos: THREE.Vector3, shadowAnchor: THREE.Vector3, active: boolean): void {
    const simDt = active ? dt : 0;
    if (simDt > 0) {
      this.timeHours = (this.timeHours + simDt * (24 / DAY_DURATION_SEC)) % 24;
      this.weatherTimer -= simDt;
      if (this.weatherTimer <= 0) this.pickNextWeather();
      const phase = phaseAt(this.timeHours);
      if (phase !== this.lastPhase) {
        this.lastPhase = phase;
        if (!this.notice) this.notice = `天色渐入${phase}`;
      }
    }

    const blend = 1 - Math.exp(-simDt * 0.24);
    for (const key of Object.keys(this.current) as (keyof WeatherProfile)[]) {
      this.current[key] = lerp(this.current[key], this.target[key], blend);
    }
    this.updateLightning(simDt);
    this.applyAtmosphere(shadowAnchor);
    this.updateRain(dt, camPos);
    this.updateSnow(dt, camPos);
    this.updateAirMotes(dt, camPos);
    this.updateLowMist(camPos);
    this.syncSnapshot(this.snapshot.daylight);
  }

  consumeNotice(): string | null {
    const value = this.notice;
    this.notice = null;
    return value;
  }

  consumeThunder(): boolean {
    const value = this.thunderPending;
    this.thunderPending = false;
    return value;
  }

  private pickNextWeather(): void {
    const options = NEXT_WEATHER[this.weather];
    this.weather = options[Math.floor(this.rng() * options.length)] as WeatherKind;
    this.target = copyProfile(WEATHER[this.weather]);
    this.weatherTimer = 30 + this.rng() * 18;
    this.notice = `${WEATHER_ICON[this.weather]} 天气转为${WEATHER_LABEL[this.weather]}`;
  }

  private updateLightning(dt: number): void {
    this.flash = Math.max(0, this.flash - dt * 4.8);
    if (dt <= 0 || this.current.storm < 0.42) return;
    this.lightningTimer -= dt;
    if (this.lightningTimer > 0) return;
    this.flash = 1;
    this.lightningTimer = 5 + this.rng() * 10;
    this.thunderPending = true;
  }

  private applyAtmosphere(anchor: THREE.Vector3): void {
    const solar = ((this.timeHours - 6) / 24) * Math.PI * 2;
    const sunY = Math.sin(solar);
    const horizontal = Math.cos(solar);
    this.sunDir.set(horizontal * 0.86, sunY, Math.sin(solar * 0.58 + 0.7) * 0.42).normalize();
    const daylight = smoothstep(-0.15, 0.22, sunY);
    const twilight = (1 - smoothstep(0.03, 0.68, Math.abs(sunY))) * smoothstep(-0.2, 0.04, sunY);
    const visual = environmentVisualProfile({
      daylight,
      sunHeight: sunY,
      twilight,
      light: this.current.light,
      cloud: this.current.cloud,
      rain: this.current.rain,
      snow: this.current.snow,
      wet: this.current.wet,
      storm: this.current.storm,
      fogNear: this.current.fogNear,
      fogFar: this.current.fogFar,
    });

    this.zenith.copy(this.nightZenith).lerp(this.dayZenith, daylight).lerp(this.dawnZenith, twilight * 0.55);
    this.horizon.copy(this.nightHorizon).lerp(this.dayHorizon, daylight).lerp(this.dawnHorizon, twilight * 0.82);
    this.sky.setAtmosphere(
      this.zenith, this.horizon, this.sunDir, daylight, this.current.cloud, this.current.wind, this.flash,
    );

    this.fogColor.copy(this.horizon).lerp(this.cloudFog, this.current.cloud * 0.34);
    this.fog.color.copy(this.fogColor);
    this.fog.near = visual.fogNear;
    this.fog.far = visual.fogFar;

    const moon = sunY < -0.08;
    this.lightDir.copy(this.sunDir);
    if (moon) this.lightDir.negate();
    if (this.lightDir.y < 0.12) this.lightDir.y = 0.12;
    this.lightDir.normalize();
    const lightDistance = 112;
    this.sun.position.set(
      anchor.x + this.lightDir.x * lightDistance,
      18 + this.lightDir.y * lightDistance,
      anchor.z + this.lightDir.z * lightDistance,
    );
    this.sun.target.position.set(anchor.x, 0, anchor.z);
    this.sun.target.updateMatrixWorld();
    const lighting = visual.lighting;
    if (moon) {
      this.sun.color.setHex(0x9ab8e6);
      this.sun.intensity = lighting.moonIntensity + this.flash * 2.6;
    } else {
      this.sun.color.copy(this.warmSun).lerp(this.daySun, smoothstep(0.04, 0.58, sunY));
      this.sun.intensity = visual.sunIntensity + this.flash * 2.8;
    }
    this.sun.shadow.radius = visual.shadowRadius;
    this.hemi.color.copy(this.nightHemi).lerp(this.dayHemi, daylight);
    this.hemi.groundColor.copy(this.nightGround).lerp(this.dayGround, daylight);
    this.hemi.intensity = lighting.hemiIntensity + this.flash * 1.7;

    const groundDay = lerp(0.86, 1, daylight) * lerp(0.94, 1, this.current.light);
    this.terrainMat.color.setRGB(
      groundDay * (0.93 + daylight * 0.07),
      groundDay * (0.96 + daylight * 0.04),
      groundDay * (0.94 + daylight * 0.06),
    );
    this.terrainMat.roughness = 0.96 - this.current.wet * 0.16;
    const surface = visual.surface;
    setSurfaceEnvironment(
      surface.wetness,
      surface.cloudiness,
      daylight,
      Math.max(this.current.rain, this.current.snow * 0.18),
      visual.warmth,
    );
    const surfaceUniforms = this.terrainMat.userData.surfaceUniforms as {
      wetness: { value: number };
      cloudiness: { value: number };
    } | undefined;
    if (surfaceUniforms) {
      surfaceUniforms.wetness.value = surface.wetness;
      surfaceUniforms.cloudiness.value = surface.cloudiness;
    }
    this.waterMat.color.copy(this.nightWater).lerp(this.dayWater, daylight).lerp(this.stormWater, this.current.cloud * 0.34);
    this.waterMat.specular.setHex(moon ? 0x6f91b7 : 0xbde8ef);
    this.waterMat.shininess = 90 + this.current.wet * 45;
    this.waterMat.opacity = 0.73 + this.current.rain * 0.045;
    const rainUniform = this.waterMat.userData.rainUniform as { value: number } | undefined;
    if (rainUniform) rainUniform.value = this.current.rain;

    this.snapshot.daylight = daylight;
    this.snapshot.exposure = lighting.exposure;
    this.snapshot.saturation = visual.saturation;
    this.snapshot.contrast = visual.contrast;
    this.snapshot.wetness = surface.wetness;
    this.snapshot.cloudiness = surface.cloudiness;
    this.snapshot.warmth = visual.warmth;
  }

  private updateAirMotes(dt: number, camPos: THREE.Vector3): void {
    const surface = environmentSurfaceDetail(
      this.current.rain,
      this.current.wet,
      this.current.cloud,
      this.snapshot.daylight,
    );
    this.airMotes.visible = surface.moteOpacity > 0.012;
    this.airMotes.material.opacity = surface.moteOpacity;
    this.airMotes.material.color.setHex(this.snapshot.daylight > 0.28 ? 0xffe4b5 : 0xaec8e8);
    this.airMotes.position.copy(camPos);
    if (!this.airMotes.visible) return;
    for (let i = 0; i < this.moteDrift.length / 2; i++) {
      const o = i * 3;
      let y = (this.motePos[o + 1] as number) + (this.moteDrift[i * 2] as number) * dt;
      let x = (this.motePos[o] as number) + (this.moteDrift[i * 2 + 1] as number) * dt;
      if (y > 14) y = -3;
      if (x > 30) x = -30;
      else if (x < -30) x = 30;
      this.motePos[o] = x;
      this.motePos[o + 1] = y;
    }
    const attr = this.airMotes.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }

  private updateLowMist(camPos: THREE.Vector3): void {
    const surface = environmentSurfaceDetail(
      this.current.rain,
      this.current.wet,
      this.current.cloud,
      this.snapshot.daylight,
    );
    this.lowMist.position.set(camPos.x, 0.45, camPos.z);
    this.lowMist.material.opacity = surface.lowMistOpacity;
    this.lowMist.material.color.copy(this.fogColor).lerp(this.horizon, 0.28);
    this.lowMist.visible = surface.lowMistOpacity > 0.01;
  }

  private updateRain(dt: number, camPos: THREE.Vector3): void {
    const amount = this.current.rain;
    this.rain.visible = amount > 0.025;
    const visual = environmentVisualProfile({
      daylight: this.snapshot.daylight,
      sunHeight: 0,
      twilight: 0,
      light: this.current.light,
      cloud: this.current.cloud,
      rain: amount,
      snow: this.current.snow,
      wet: this.current.wet,
      storm: this.current.storm,
      fogNear: this.current.fogNear,
      fogFar: this.current.fogFar,
    });
    this.rain.material.opacity = visual.rainOpacity;
    this.rain.material.color.setHex(this.snapshot.daylight > 0.3 ? 0xbad7e5 : 0x7b9bbb);
    this.rain.position.copy(camPos);
    if (!this.rain.visible) return;
    const windX = this.current.wind * 0.2;
    const windZ = this.current.wind * -0.08;
    for (let i = 0; i < this.rainSpeed.length; i++) {
      const o = i * 6;
      let y = (this.rainPos[o + 1] as number) - (this.rainSpeed[i] as number) * dt;
      if (y < -4) y += 36;
      const x = this.rainSeed[i * 2] as number;
      const z = this.rainSeed[i * 2 + 1] as number;
      this.rainPos[o] = x;
      this.rainPos[o + 1] = y;
      this.rainPos[o + 2] = z;
      this.rainPos[o + 3] = x - windX;
      this.rainPos[o + 4] = y - 1.75;
      this.rainPos[o + 5] = z - windZ;
    }
    const attr = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }

  private updateSnow(dt: number, camPos: THREE.Vector3): void {
    const amount = this.current.snow;
    this.snow.visible = amount > 0.025;
    this.snow.material.opacity = clamp(amount * (0.64 + this.snapshot.daylight * 0.16), 0, 0.78);
    this.snow.material.size = 0.16 + amount * 0.08;
    this.snow.position.copy(camPos);
    if (!this.snow.visible) return;
    for (let i = 0; i < this.snowFall.length; i++) {
      const o = i * 3;
      let x = this.snowPos[o] as number;
      let y = (this.snowPos[o + 1] as number) - (this.snowFall[i] as number) * dt;
      let z = this.snowPos[o + 2] as number;
      const phase = (this.snowDrift[i * 2 + 1] as number) + y * 0.16;
      const sway = (this.snowDrift[i * 2] as number) * dt;
      x += (Math.sin(phase) * 0.42 + this.current.wind * 0.16) * sway;
      z += Math.cos(phase * 0.82) * sway * 0.34;
      if (y < -4) y += 34;
      if (x > 35) x -= 70;
      else if (x < -35) x += 70;
      if (z > 35) z -= 70;
      else if (z < -35) z += 70;
      this.snowPos[o] = x;
      this.snowPos[o + 1] = y;
      this.snowPos[o + 2] = z;
    }
    const attr = this.snow.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
  }

  private syncSnapshot(daylight: number): void {
    this.snapshot.timeText = timeText(this.timeHours);
    this.snapshot.phaseLabel = phaseAt(this.timeHours);
    this.snapshot.weather = this.weather;
    this.snapshot.weatherLabel = WEATHER_LABEL[this.weather];
    this.snapshot.rainIntensity = this.current.rain;
    this.snapshot.snowIntensity = this.current.snow;
    this.snapshot.daylight = daylight;
  }
}
